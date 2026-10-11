// Node-only temporary storage for complete HMLR authority partitions.
// Geometry stays in append-only files; memory holds only authority state, bbox rows, and byte offsets.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots = new Set();
const sharedStores = new Map();
let exitHookInstalled = false;

function cleanupRoots() {
    for (const root of roots) {
        try { rmSync(root, { recursive: true, force: true }); } catch {}
    }
    roots.clear();
}

function ensureExitHook() {
    if (exitHookInstalled) return;
    process.once('exit', cleanupRoots);
    exitHookInstalled = true;
}

function validateKey(releaseId, authorityIndex) {
    if (typeof releaseId !== 'string' || !/^[a-f0-9]{64}$/.test(releaseId)
        || !Number.isSafeInteger(authorityIndex) || authorityIndex < 0) {
        throw new TypeError('Invalid HMLR feature-store authority key.');
    }
}

function validateRecord(record) {
    if (!record || typeof record !== 'object' || typeof record.nativeId !== 'string'
        || !/^[0-9]{1,64}$/.test(record.nativeId) || !record.feature || typeof record.feature !== 'object'
        || !Array.isArray(record.bboxWgs) || record.bboxWgs.length !== 4
        || !Array.isArray(record.bboxNative) || record.bboxNative.length !== 4) {
        throw new TypeError('Invalid HMLR feature-store record.');
    }
}

async function writeAll(handle, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
        if (bytesWritten <= 0) throw new Error('Could not append HMLR feature record.');
        offset += bytesWritten;
    }
}

/**
 * Creates an ephemeral disk-backed HMLR feature store for Node qualification runs.
 * `baseDir` is intended for isolated tests; production callers should omit it.
 */
export function createNodeHmlrFeatureStore({ baseDir = tmpdir() } = {}) {
    const parent = resolve(baseDir);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'hmlr-features-'));
    roots.add(root);
    ensureExitHook();

    const authorities = new Map();
    const writeQueues = new Map();
    const authorityLoads = new Map();
    let disposed = false;

    const keyFor = (releaseId, index) => {
        validateKey(releaseId, index);
        return `${releaseId}:${index}`;
    };
    const fileFor = (releaseId, index) => join(root, `${releaseId}-${index}.features.jsonl`);
    const stateFor = (releaseId, index, create = false) => {
        const key = keyFor(releaseId, index);
        let state = authorities.get(key);
        if (!state && create) {
            state = { releaseId, index, metadata: null, rows: [], offsets: new Map(), filePath: fileFor(releaseId, index), fileSize: 0 };
            authorities.set(key, state);
        }
        return state;
    };
    const assertOpen = () => { if (disposed) throw new Error('HMLR feature store has been disposed.'); };
    function enqueue(key, operation) {
        assertOpen();
        const prior = writeQueues.get(key) || Promise.resolve();
        const result = prior.then(operation);
        writeQueues.set(key, result.catch(() => {}));
        return result;
    }
    async function readFeature(state, nativeId) {
        const position = state.offsets.get(nativeId);
        if (!position) return null;
        const handle = await open(state.filePath, 'r');
        try {
            const bytes = Buffer.allocUnsafe(position.length);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position.offset + offset);
                if (bytesRead === 0) throw new Error(`Truncated HMLR feature record ${nativeId}.`);
                offset += bytesRead;
            }
            const stored = JSON.parse(bytes.toString('utf8'));
            if (!stored || stored.nativeId !== nativeId || !stored.feature) throw new Error(`Invalid HMLR feature record ${nativeId}.`);
            return stored.feature;
        } finally { await handle.close(); }
    }

    const store = {
        async getAuthority(releaseId, index) {
            assertOpen();
            const state = stateFor(releaseId, index);
            return state?.metadata ? { ...state.metadata } : null;
        },
        setAuthority(releaseId, index, metadata) {
            const key = keyFor(releaseId, index);
            return enqueue(key, () => {
                const state = stateFor(releaseId, index, true);
                if (state.metadata?.ready) throw new Error('A ready HMLR authority partition is immutable.');
                if (metadata?.ready && state.offsets.size !== metadata.featureCount) {
                    throw new Error('Cannot mark an incomplete HMLR authority partition ready.');
                }
                state.metadata = metadata ? { ...metadata } : null;
            });
        },
        withAuthorityLoad(releaseId, index, operation) {
            assertOpen();
            if (typeof operation !== 'function') throw new TypeError('Expected an HMLR authority load operation.');
            const key = keyFor(releaseId, index), existing = authorityLoads.get(key);
            if (existing) return existing;
            const pending = Promise.resolve().then(operation);
            authorityLoads.set(key, pending);
            const clearPending = () => { if (authorityLoads.get(key) === pending) authorityLoads.delete(key); };
            pending.then(clearPending, clearPending);
            return pending;
        },
        clearAuthority(releaseId, index) {
            const key = keyFor(releaseId, index);
            return enqueue(key, () => {
                const state = stateFor(releaseId, index);
                if (state) {
                    rmSync(state.filePath, { force: true });
                    authorities.delete(key);
                }
            });
        },
        putBatch(releaseId, index, records) {
            const key = keyFor(releaseId, index);
            if (!Array.isArray(records)) return Promise.reject(new TypeError('Expected an HMLR feature batch.'));
            records.forEach(validateRecord);
            return enqueue(key, async () => {
                const state = stateFor(releaseId, index, true);
                if (state.metadata?.ready) throw new Error('A ready HMLR authority partition is immutable.');
                const batchIds = new Set();
                for (const record of records) {
                    if (state.offsets.has(record.nativeId) || batchIds.has(record.nativeId)) {
                        throw new Error('Repeated HMLR feature in authority partition.');
                    }
                    batchIds.add(record.nativeId);
                }
                let handle;
                try {
                    handle = await open(state.filePath, 'a', 0o600);
                    for (const record of records) {
                        const bytes = Buffer.from(JSON.stringify({ nativeId: record.nativeId, feature: record.feature }));
                        const offset = state.fileSize;
                        const line = Buffer.concat([bytes, Buffer.from('\n')]);
                        await writeAll(handle, line);
                        state.fileSize += line.length;
                        state.offsets.set(record.nativeId, { offset, length: bytes.length });
                        state.rows.push({ nativeId: record.nativeId, bboxWgs: [...record.bboxWgs], bboxNative: [...record.bboxNative] });
                    }
                } catch (error) {
                    // A partial authority is never queryable; the caller clears it on failure.
                    throw error;
                } finally { await handle?.close(); }
            });
        },
        async getIndex(releaseId, index) {
            assertOpen();
            const state = stateFor(releaseId, index);
            await (writeQueues.get(keyFor(releaseId, index)) || Promise.resolve());
            return state ? state.rows.map(row => ({ nativeId: row.nativeId, bboxWgs: [...row.bboxWgs], bboxNative: [...row.bboxNative] })) : [];
        },
        async getFeature(releaseId, index, nativeId) {
            assertOpen();
            const state = stateFor(releaseId, index);
            await (writeQueues.get(keyFor(releaseId, index)) || Promise.resolve());
            return state ? readFeature(state, nativeId) : null;
        },
        async dispose() {
            if (disposed) return;
            await Promise.all([...writeQueues.values()]);
            disposed = true;
            authorities.clear(); writeQueues.clear(); authorityLoads.clear(); roots.delete(root);
            rmSync(root, { recursive: true, force: true });
        }
    };
    return Object.freeze(store);
}

/** Shares a temporary authority cache across node adapters for the same HMLR release source. */
export function getSharedNodeHmlrFeatureStore(manifestUrl, snapshotId = '') {
    if (typeof manifestUrl !== 'string' || !manifestUrl) throw new TypeError('Expected an HMLR manifest URL.');
    const key = JSON.stringify([manifestUrl, snapshotId || '']);
    if (!sharedStores.has(key)) sharedStores.set(key, createNodeHmlrFeatureStore());
    return sharedStores.get(key);
}

export async function disposeSharedNodeHmlrFeatureStores() {
    const stores = [...sharedStores.values()];
    sharedStores.clear();
    await Promise.all(stores.map(store => store.dispose()));
}
