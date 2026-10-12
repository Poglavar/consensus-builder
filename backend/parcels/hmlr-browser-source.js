// Offline-first browser adapter for locally cached, SHA-verified HMLR authority snapshots.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { HttpError } from '../utils/helpers.js';
import { providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { sha256Hex } from './portable-hash.js';
import { readGmlZipMember } from './gml-zip-reader.js';
import { parseGmlParcels } from './gml-parcel-reader.js';
import { createHmlrArchiveScopeBuilder, validateHmlrArchiveScope, hmlrArchiveScopeIntersects, hmlrArchiveScopesShareCell } from './hmlr-archive-scope.js';
import { HMLR_BROWSER_GROUND_POLICY, HMLR_BROWSER_GROUND_PREFIX, HMLR_BROWSER_GROUND_SOURCE,
    createHmlrBrowserGroundEngine } from './hmlr-browser-ground.js';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_GML_BYTES = 1024 * 1024 * 1024;
const MAX_AUTHORITY_FEATURES = 1_500_000;
const MAX_QUERY_FEATURES = 5000;
const MAX_CONTEXT_FEATURES = 250_000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_AUTHORITIES = 32;
const ARCHIVE_TIMEOUT_MS = 180_000;
const PARSE_TIMEOUT_MS = 300_000;
// A superseded view's cancellations reach the worker just before the next view's queries, which
// then need a moment (scope reads, the per-source query queue) to claim the archives they share.
const ORPHANED_LOAD_GRACE_MS = 2000;
const ID_PREFIX = HMLR_BROWSER_GROUND_PREFIX;
const ARCHIVE_HOST = 'use-land-property-data.service.gov.uk';
const ALLOWED_ARCHIVE_REDIRECT_HOST = 'datapub-prd-s3-bucket.s3.amazonaws.com';
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function decimalId(value, canonical = false) {
    if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value)) return null;
    const normalized = value.replace(/^0+(?=\d)/, '');
    return canonical && normalized !== value ? null : normalized;
}
function box(value, label) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
        || value[0] >= value[2] || value[1] >= value[3]) throw new Error(`Invalid HMLR ${label} bounds.`);
    return value;
}
function validWgsBounds(value, label) {
    box(value, label);
    if (value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90) throw new Error(`Invalid HMLR ${label} bounds.`);
    return value;
}
function archiveEndpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid HMLR authority endpoint.'); }
    if (url.protocol !== 'https:' || url.hostname !== ARCHIVE_HOST || url.port || url.username || url.password || url.search || url.hash
        || !/^\/datasets\/inspire\/download\/[A-Za-z][A-Za-z0-9_-]{0,63}\.zip$/.test(url.pathname)) {
        throw new Error('Unsupported HMLR authority endpoint.');
    }
    return url.href;
}
function expectedAuthority(metadata, index) {
    if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 128) throw new Error(`Invalid HMLR authority ${index}.`);
    const etag = metadata.etag;
    if (typeof etag !== 'string' || !/^"[^"\r\n]+"$/.test(etag)) throw new Error(`Invalid HMLR authority ETag ${index}.`);
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > MAX_ARCHIVE_BYTES
        || !/^[a-f0-9]{64}$/.test(metadata.archiveSha256 || '')
        || !Number.isSafeInteger(metadata.featureCount) || metadata.featureCount < 1 || metadata.featureCount > MAX_AUTHORITY_FEATURES) {
        throw new Error(`Invalid HMLR authority size or revision ${index}.`);
    }
    if (!metadata.scope || !/^[a-f0-9]{64}$/.test(metadata.scope.sha256 || '')
        || !Number.isSafeInteger(metadata.scope.bytes) || metadata.scope.bytes < 1 || metadata.scope.bytes > MAX_METADATA_BYTES
        || typeof metadata.scope.url !== 'string') throw new Error(`Invalid HMLR authority land scope ${index}.`);
    return { name: metadata.name, endpoint: archiveEndpoint(metadata.endpoint), etag, bytes: metadata.bytes,
        archiveSha256: metadata.archiveSha256, featureCount: metadata.featureCount,
        nativeBounds: box(metadata.nativeBounds, `authority ${index} native`), bounds: validWgsBounds(metadata.bounds, `authority ${index}`),
        scope: { sha256: metadata.scope.sha256, bytes: metadata.scope.bytes, url: metadata.scope.url } };
}
function withinBounds(inner, outer) {
    return Array.isArray(inner) && inner.length === 4 && inner.every(Number.isFinite)
        && inner[0] < inner[2] && inner[1] < inner[3]
        && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
function validateManifest(manifest, manifestUrl, { allowSample, snapshotId }) {
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(manifest?.sourceDate || '') ? new Date(`${manifest.sourceDate}T00:00:00Z`) : null;
    if (!manifest || manifest.schemaVersion !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.sourceDate || '')
        || !parsedDate || !Number.isFinite(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== manifest.sourceDate
        || manifest.policy !== HMLR_BROWSER_GROUND_POLICY
        || !/^[a-f0-9]{64}$/.test(manifest.releaseId || '') || !Array.isArray(manifest.authorities)
        || (!allowSample && manifest.authorities.length < 250) || manifest.authorities.length > 1000) {
        throw upstreamError('Invalid HMLR browser release manifest.');
    }
    if (snapshotId !== undefined && snapshotId !== manifest.releaseId) throw upstreamError('HMLR browser release edition does not match the requested snapshot.');
    const names = new Set(), endpoints = new Set(); let previousName = '';
    const authorities = manifest.authorities.map((authority, index) => {
        const verified = expectedAuthority(authority, index);
        if (names.has(verified.name) || endpoints.has(verified.endpoint) || (previousName && verified.name <= previousName)) {
            throw upstreamError('HMLR manifest repeats or misorders an authority.');
        }
        previousName = verified.name;
        names.add(verified.name); endpoints.add(verified.endpoint); return verified;
    });
    if (!manifest.idDirectory || typeof manifest.idDirectory !== 'object' || Array.isArray(manifest.idDirectory)
        || !Object.keys(manifest.idDirectory).length) throw upstreamError('Invalid HMLR ID shard directory.');
    const manifestPath = new URL(manifestUrl).pathname;
    let releaseRoot = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
    if (releaseRoot.endsWith(`/${manifest.releaseId}/`)) releaseRoot = releaseRoot.slice(0, -manifest.releaseId.length - 1);
    for (const [index, authority] of authorities.entries()) {
        const item = authority.scope, url = new URL(item.url, manifestUrl);
        const expectedPath = `${releaseRoot}${manifest.releaseId}/scopes/${index}.${item.sha256}.json`;
        if (url.protocol !== 'https:' || url.origin !== new URL(manifestUrl).origin || url.search || url.hash
            || url.href !== item.url || url.pathname !== expectedPath) throw upstreamError('HMLR land scope URL escapes its immutable metadata release.');
    }
    const directory = new Map();
    for (const [bucket, item] of Object.entries(manifest.idDirectory)) {
        if (!/^[0-9]{1,4}$/.test(bucket) || !item || typeof item.url !== 'string'
            || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_METADATA_BYTES) {
            throw upstreamError('Invalid HMLR ID shard entry.');
        }
        const url = new URL(item.url, manifestUrl);
        const expectedPath = `${releaseRoot}${manifest.releaseId}/ids/${bucket}.${item.sha256}.json`;
        if (url.protocol !== 'https:' || url.origin !== new URL(manifestUrl).origin || url.search || url.hash
            || url.href !== item.url || url.pathname !== expectedPath) throw upstreamError('HMLR ID shard URL escapes its immutable metadata release.');
        directory.set(bucket, { url: url.href, sha256: item.sha256, bytes: item.bytes });
    }
    const coreAuthorities = authorities.map(({ name, endpoint, etag, bytes, archiveSha256, featureCount, nativeBounds, bounds, scope }) =>
        ({ name, endpoint, etag, bytes, archiveSha256, featureCount, nativeBounds, bounds, scope: { sha256: scope.sha256, bytes: scope.bytes } }));
    const coreDirectory = Object.fromEntries([...directory.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([bucket, { sha256, bytes }]) => [bucket, { sha256, bytes }]));
    const core = { schemaVersion: 2, sourceDate: manifest.sourceDate, policy: manifest.policy,
        authorities: coreAuthorities, idDirectory: coreDirectory };
    const versionedRelease = new URL(manifestUrl).pathname.split('/').at(-2);
    if ((/^[a-f0-9]{64}$/.test(versionedRelease || '') && versionedRelease !== manifest.releaseId)
        || sha256Hex(JSON.stringify(core)) !== manifest.releaseId) throw upstreamError('HMLR release manifest ID does not match its canonical content.');
    return { schemaVersion: 2, sourceDate: manifest.sourceDate, policy: manifest.policy, releaseId: manifest.releaseId, authorities, directory };
}

function packIndex(ids, bboxWgs84, bboxNative) {
    const entries = ids.map((nativeId, index) => ({ nativeId, index,
        box: Array.from(bboxWgs84.subarray(index * 4, index * 4 + 4)) }));
    const build = list => {
        const bounds = [Infinity, Infinity, -Infinity, -Infinity];
        for (const entry of list) for (let axis = 0; axis < 4; axis++) bounds[axis] = axis < 2
            ? Math.min(bounds[axis], entry.box[axis]) : Math.max(bounds[axis], entry.box[axis]);
        if (list.length <= 16) return { bounds, entries: list };
        const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
        list.sort((a, b) => a.box[axis] + a.box[axis + 2] - b.box[axis] - b.box[axis + 2]);
        const middle = list.length >>> 1;
        return { bounds, left: build(list.slice(0, middle)), right: build(list.slice(middle)) };
    };
    const tree = entries.length ? build(entries) : null, positions = new Map(ids.map((id, index) => [id, index]));
    return { ids, bboxWgs84, bboxNative, tree, positions };
}
function findRows(tree, query, output = []) {
    if (!tree || !overlaps(tree.bounds, query)) return output;
    if (tree.entries) {
        for (const entry of tree.entries) if (overlaps(entry.box, query)) output.push(entry.index);
    } else { findRows(tree.left, query, output); findRows(tree.right, query, output); }
    return output;
}
function collectBoxes(geometry, project) {
    const bboxWgs = [Infinity, Infinity, -Infinity, -Infinity];
    const bboxNative = [Infinity, Infinity, -Infinity, -Infinity];
    const projectPoint = point => {
        const projected = project.forward(point);
        if (!projected.every(Number.isFinite)) throw new Error('Invalid projected HMLR geometry.');
        bboxWgs[0] = Math.min(bboxWgs[0], projected[0]); bboxWgs[1] = Math.min(bboxWgs[1], projected[1]);
        bboxWgs[2] = Math.max(bboxWgs[2], projected[0]); bboxWgs[3] = Math.max(bboxWgs[3], projected[1]);
    };
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) for (let index = 0; index < ring.length; index++) {
        const point = ring[index], next = ring[(index + 1) % ring.length];
        bboxNative[0] = Math.min(bboxNative[0], point[0]); bboxNative[1] = Math.min(bboxNative[1], point[1]);
        bboxNative[2] = Math.max(bboxNative[2], point[0]); bboxNative[3] = Math.max(bboxNative[3], point[1]);
        projectPoint(point);
        const steps = Math.ceil(Math.hypot(next[0] - point[0], next[1] - point[1]) / 250);
        for (let step = 1; step < steps; step++) {
            const fraction = step / steps;
            projectPoint([point[0] + (next[0] - point[0]) * fraction, point[1] + (next[1] - point[1]) * fraction]);
        }
    }
    // Projection curvature between source vertices is bounded by 250 m samples;
    // a 0.0001 degree pad keeps the resulting geographic envelope conservative.
    bboxWgs[0] -= 0.0001; bboxWgs[1] -= 0.0001; bboxWgs[2] += 0.0001; bboxWgs[3] += 0.0001;
    return { bboxNative, bboxWgs };
}

export function createMemoryHmlrFeatureStore() {
    const features = new Map(), indexes = new Map(), statuses = new Map();
    const authorityKey = (releaseId, index) => `${releaseId}:${index}`;
    const featureKey = (releaseId, index, nativeId) => `${releaseId}:${index}:${nativeId}`;
    return Object.freeze({
        async getAuthority(releaseId, index) { return statuses.get(authorityKey(releaseId, index)) || null; },
        async setAuthority(releaseId, index, metadata) { statuses.set(authorityKey(releaseId, index), metadata); },
        async clearAuthority(releaseId, index) {
            const prefix = `${releaseId}:${index}:`;
            for (const key of features.keys()) if (key.startsWith(prefix)) features.delete(key);
            indexes.delete(authorityKey(releaseId, index)); statuses.delete(authorityKey(releaseId, index));
        },
        async putBatch(releaseId, index, records) {
            for (const record of records) features.set(featureKey(releaseId, index, record.nativeId), record.feature);
            const key = authorityKey(releaseId, index), current = indexes.get(key) || [];
            current.push(...records.map(record => ({ nativeId: record.nativeId, bboxWgs: record.bboxWgs, bboxNative: record.bboxNative })));
            indexes.set(key, current);
        },
        async getIndex(releaseId, index) { return indexes.get(authorityKey(releaseId, index)) || []; },
        async getFeature(releaseId, index, nativeId) { return features.get(featureKey(releaseId, index, nativeId)) || null; }
    });
}

function createIndexedDbFeatureStore(indexedDB) {
    let dbPromise;
    function db() {
        if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('hmlr-browser-ground-v1', 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains('features')) {
                    const store = database.createObjectStore('features', { keyPath: 'key' });
                    store.createIndex('byAuthority', ['releaseId', 'authorityIndex'], { unique: false });
                }
                if (!database.objectStoreNames.contains('featureIndex')) {
                    const store = database.createObjectStore('featureIndex', { keyPath: 'key' });
                    store.createIndex('byAuthority', ['releaseId', 'authorityIndex'], { unique: false });
                }
                if (!database.objectStoreNames.contains('authorities')) database.createObjectStore('authorities', { keyPath: 'key' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Could not open local HMLR parcel storage.'));
        });
        return dbPromise;
    }
    const authorityKey = (releaseId, authorityIndex) => `${releaseId}:${authorityIndex}`;
    const featureKey = (releaseId, authorityIndex, nativeId) => `${releaseId}:${authorityIndex}:${nativeId}`;
    async function transaction(stores, mode, run) {
        const database = await db();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(stores, mode); let value;
            try { value = run(tx); } catch (error) { tx.abort(); reject(error); return; }
            tx.oncomplete = () => resolve(value);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local HMLR storage transaction failed.'));
        });
    }
    return Object.freeze({
        async getAuthority(releaseId, index) {
            const database = await db(); return new Promise((resolve, reject) => {
                const request = database.transaction('authorities').objectStore('authorities').get(authorityKey(releaseId, index));
                request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
            });
        },
        setAuthority(releaseId, index, metadata) {
            return transaction(['authorities'], 'readwrite', tx => tx.objectStore('authorities').put({ ...metadata, key: authorityKey(releaseId, index), releaseId, authorityIndex: index }));
        },
        clearAuthority(releaseId, index) {
            return transaction(['features', 'featureIndex', 'authorities'], 'readwrite', tx => {
                tx.objectStore('authorities').delete(authorityKey(releaseId, index));
                for (const storeName of ['features', 'featureIndex']) {
                    const store = tx.objectStore(storeName), request = store.index('byAuthority').openCursor(IDBKeyRange.only([releaseId, index]));
                    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
                }
            });
        },
        putBatch(releaseId, index, records) {
            return transaction(['features', 'featureIndex'], 'readwrite', tx => {
                for (const record of records) {
                    const key = featureKey(releaseId, index, record.nativeId);
                    tx.objectStore('features').put({ key, releaseId, authorityIndex: index, nativeId: record.nativeId, feature: record.feature });
                    tx.objectStore('featureIndex').put({ key, releaseId, authorityIndex: index, nativeId: record.nativeId,
                        bboxWgs: record.bboxWgs, bboxNative: record.bboxNative });
                }
            });
        },
        async getIndex(releaseId, index) {
            const database = await db(); return new Promise((resolve, reject) => {
                const request = database.transaction('featureIndex').objectStore('featureIndex').index('byAuthority').getAll([releaseId, index]);
                request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error);
            });
        },
        async getFeature(releaseId, index, nativeId) {
            const database = await db(); return new Promise((resolve, reject) => {
                const request = database.transaction('features').objectStore('features').get(featureKey(releaseId, index, nativeId));
                request.onsuccess = () => resolve(request.result?.feature || null); request.onerror = () => reject(request.error);
            });
        }
    });
}

function cachedArchiveStore(cacheStorage, manifestUrl) {
    const cacheName = 'hmlr-browser-ground-archives-v1';
    return Object.freeze({ async get(releaseId, sha, expectedBytes) {
        if (!cacheStorage) return null;
        const cache = await cacheStorage.open(cacheName), key = new URL(`${releaseId}/${sha}.zip`, new URL('./.archives/', manifestUrl));
        const response = await cache.match(key.href);
        if (!response) return null;
        try { return await responseBytes(response, expectedBytes, MAX_ARCHIVE_BYTES, 'Cached HMLR authority archive'); }
        catch { await cache.delete(key.href); return null; }
    }, async put(releaseId, sha, bytes) {
        if (!cacheStorage) return;
        const cache = await cacheStorage.open(cacheName), key = new URL(`${releaseId}/${sha}.zip`, new URL('./.archives/', manifestUrl));
        await cache.put(key.href, new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-length': String(bytes.byteLength) } }));
    }, async delete(releaseId, sha) {
        if (!cacheStorage) return;
        const cache = await cacheStorage.open(cacheName), key = new URL(`${releaseId}/${sha}.zip`, new URL('./.archives/', manifestUrl));
        await cache.delete(key.href);
    } });
}

async function responseBytes(response, expectedBytes, limit, label, onBytes) {
    if (!response.ok || response.status !== 200) throw providerHttpError(response);
    if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > limit)) {
        throw upstreamError(`${label} has an invalid manifest byte limit.`);
    }
    // Fetch returns decoded bytes. HTTP Content-Length can be absent or describe
    // compressed bytes, so enforce the release size against the stream itself.
    const byteLimit = expectedBytes ?? limit;
    const reader = response.body?.getReader?.();
    if (!reader) throw upstreamError(`${label} response has no readable body.`);
    let total = 0; const chunks = [];
    try {
        for (;;) {
            const part = await reader.read(); if (part.done) break;
            total += part.value.byteLength;
            if (total > byteLimit) throw upstreamError(`${label} exceeds its manifest byte limit.`);
            chunks.push(part.value);
            onBytes?.(total);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (total < 1 || (expectedBytes !== null && total !== expectedBytes)) throw upstreamError(`${label} response is incomplete.`);
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

// Lets one cancelled query stop waiting without cancelling the shared work it was waiting for.
function untilCancelled(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
}

async function* withBatchWriteBackpressure(chunks, drainWrites) {
    for await (const chunk of chunks) {
        yield chunk;
        await drainWrites();
    }
}

export function createHmlrBrowserParcelSource(descriptor, { fetchImpl = globalThis.fetch?.bind(globalThis), featureStore,
    cacheStorage = globalThis.caches, indexedDB = globalThis.indexedDB, allowSample = false, now = Date.now,
    engineFactory = createHmlrBrowserGroundEngine, maxContextFeatures = MAX_CONTEXT_FEATURES, onProgress,
    orphanedLoadGraceMs = ORPHANED_LOAD_GRACE_MS } = {}) {
    if (!descriptor || descriptor.id !== HMLR_BROWSER_GROUND_SOURCE || descriptor.adapter !== 'hmlr-browser'
        || descriptor.idPrefix !== ID_PREFIX || typeof descriptor.manifestUrl !== 'string' || typeof fetchImpl !== 'function'
        || typeof engineFactory !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(maxContextFeatures)
        || maxContextFeatures < 1 || maxContextFeatures > MAX_CONTEXT_FEATURES) throw new Error('Invalid HMLR browser source descriptor.');
    let manifestUrl;
    try { manifestUrl = new URL(descriptor.manifestUrl); } catch { throw new Error('Invalid HMLR manifest URL.'); }
    if (manifestUrl.protocol !== 'https:' || manifestUrl.username || manifestUrl.password || manifestUrl.port || manifestUrl.search || manifestUrl.hash
        || !manifestUrl.pathname.endsWith('.json')) throw new Error('HMLR manifest URL must be explicit HTTPS metadata.');
    if (descriptor.snapshotId !== undefined && !/^[a-f0-9]{64}$/.test(descriptor.snapshotId)) throw new Error('Invalid HMLR browser snapshot ID.');
    const store = featureStore || (indexedDB ? createIndexedDbFeatureStore(indexedDB) : createMemoryHmlrFeatureStore());
    const archiveCache = cachedArchiveStore(cacheStorage, manifestUrl.href);
    const authorityState = new Map(), authorityPending = new Map(), shardPending = new Map(), shardCache = new Map();
    const scopeCache = new Map(), scopePending = new Map();
    let manifestPromise, enginePromise;
    let authorityLoadQueue = Promise.resolve();
    let lastProgress, lastProgressTime = -Infinity;
    function reportProgress(detail) {
        if (typeof onProgress !== 'function') return;
        const time = now();
        const changed = detail.phase !== lastProgress?.phase || detail.authority !== lastProgress?.authority;
        const finished = (detail.totalBytes > 0 && detail.loadedBytes === detail.totalBytes)
            || (detail.totalFeatures > 0 && detail.processedFeatures === detail.totalFeatures);
        if (!changed && !finished && time - lastProgressTime < 200) return;
        lastProgress = detail; lastProgressTime = time;
        try { onProgress(detail); } catch { /* Progress observers must never interrupt parcel loading. */ }
    }

    async function getManifest() {
        if (!manifestPromise) manifestPromise = (async () => {
            const controller = AbortSignal.timeout(30000);
            let response;
            try { response = await fetchImpl(manifestUrl.href, { signal: controller, redirect: 'follow', headers: { Accept: 'application/json' } }); }
            catch (error) { if (error.status) throw error; throw upstreamError('HMLR release manifest is unavailable.', controller.aborted ? 504 : 502); }
            const bytes = await responseBytes(response, null, MAX_METADATA_BYTES, 'HMLR release manifest');
            let raw;
            try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { throw upstreamError('HMLR release manifest is malformed.'); }
            return validateManifest(raw, manifestUrl.href, { allowSample, snapshotId: descriptor.snapshotId });
        })().catch(error => { manifestPromise = null; throw error; });
        return manifestPromise;
    }
    async function getEngine() { if (!enginePromise) enginePromise = engineFactory(); return enginePromise; }
    async function getScope(manifest, index) {
        if (scopeCache.has(index)) return scopeCache.get(index);
        if (scopePending.has(index)) return scopePending.get(index);
        const task = (async () => {
            const authority = manifest.authorities[index], item = authority.scope, signal = AbortSignal.timeout(30000);
            let response;
            try { response = await fetchImpl(item.url, { signal, redirect: 'follow', headers: { Accept: 'application/json' } }); }
            catch (error) { if (error.status) throw error; throw upstreamError('HMLR land scope is unavailable.', signal.aborted ? 504 : 502); }
            const bytes = await responseBytes(response, item.bytes, MAX_METADATA_BYTES, 'HMLR land scope');
            if (sha256Hex(bytes) !== item.sha256) throw upstreamError('HMLR land scope SHA-256 does not match its release manifest.');
            let scope;
            try { scope = validateHmlrArchiveScope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), authority); }
            catch { throw upstreamError('HMLR land scope is malformed or does not describe the complete archive.'); }
            scopeCache.set(index, scope); return scope;
        })();
        scopePending.set(index, task);
        try { return await task; } finally { scopePending.delete(index); }
    }
    async function scopesNear(manifest, boxes) {
        const possible = [];
        manifest.authorities.forEach((authority, index) => {
            if (boxes.some(bounds => overlaps(authority.bounds, bounds))) possible.push(index);
        });
        if (possible.reduce((total, index) => total + manifest.authorities[index].scope.bytes, 0) > MAX_METADATA_BYTES) {
            throw upstreamError('HMLR land scope metadata exceeds its safe byte limit; use a smaller query.', 413);
        }
        const scopes = await Promise.all(possible.map(index => getScope(manifest, index)));
        return possible.map((index, position) => ({ index, scope: scopes[position] }));
    }
    async function authoritiesForBounds(manifest, boxes) {
        return (await scopesNear(manifest, boxes))
            .filter(({ scope }) => boxes.some(bounds => hmlrArchiveScopeIntersects(scope, bounds))).map(({ index }) => index);
    }
    // Overlap context comes from archives holding land in the cells the candidates' own polygons
    // occupy, built by the archive scope policy. A candidate's enclosing rectangle can reach a
    // neighbouring council's land without any of its polygon doing so; that must not download it.
    async function authoritiesForParcels(manifest, candidates) {
        const project = proj4('EPSG:27700', 'EPSG:4326'), cells = createHmlrArchiveScopeBuilder(point => project.forward(point));
        for (const candidate of candidates) cells.addGeometry(candidate.feature.geometry);
        const occupied = cells.finish(null);
        return (await scopesNear(manifest, candidates.map(item => item.bboxWgs)))
            .filter(({ scope }) => hmlrArchiveScopesShareCell(scope, occupied)).map(({ index }) => index);
    }
    async function getArchiveBytes(manifest, authority, signal, cancelSignal) {
        let bytes = await archiveCache.get(manifest.releaseId, authority.archiveSha256, authority.bytes);
        if (bytes && (bytes.byteLength !== authority.bytes || sha256Hex(bytes) !== authority.archiveSha256)) {
            await archiveCache.delete(manifest.releaseId, authority.archiveSha256);
            bytes = null;
        }
        if (!bytes) {
            const progress = { phase: 'source-download', authority: authority.name, totalBytes: authority.bytes };
            reportProgress({ ...progress, loadedBytes: 0 });
            let response;
            try { response = await fetchImpl(authority.endpoint, { signal, redirect: 'follow', headers: {
                Accept: 'application/zip', 'If-Match': authority.etag
            } }); }
            catch (error) {
                if (cancelSignal?.aborted) throw cancelSignal.reason;
                if (error.status || error.code === 'provider-probe-request-budget' || error.code === 'qualification-request-budget') throw error;
                const failure = upstreamError(signal.aborted ? 'HMLR authority archive download timed out.' : 'HMLR authority archive is unavailable.', signal.aborted ? 504 : 502);
                failure.cause = error;
                throw failure;
            }
            const finalUrl = response.url ? new URL(response.url) : null;
            if (finalUrl && (finalUrl.protocol !== 'https:' || ![ARCHIVE_HOST, ALLOWED_ARCHIVE_REDIRECT_HOST].includes(finalUrl.hostname)
                || finalUrl.username || finalUrl.password)) { await response.body?.cancel(); throw upstreamError('HMLR archive redirected outside the verified publisher.'); }
            if (response.headers?.get?.('etag') !== authority.etag) throw upstreamError('HMLR authority archive ETag changed.');
            try {
                bytes = await responseBytes(response, authority.bytes, MAX_ARCHIVE_BYTES, 'HMLR authority archive',
                    loadedBytes => reportProgress({ ...progress, loadedBytes }));
            } catch (error) { throw cancelSignal?.aborted ? cancelSignal.reason : error; }
            if (sha256Hex(bytes) !== authority.archiveSha256) throw upstreamError('HMLR authority archive SHA-256 does not match its release manifest.');
            await archiveCache.put(manifest.releaseId, authority.archiveSha256, bytes);
        }
        return bytes;
    }
    function makeAuthorityIndex(rawRows) {
        const ids = rawRows.map(row => row.nativeId), bboxWgs84 = new Float64Array(rawRows.length * 4), bboxNative = new Float64Array(rawRows.length * 4);
        rawRows.forEach((row, index) => { bboxWgs84.set(row.bboxWgs, index * 4); bboxNative.set(row.bboxNative, index * 4); });
        return packIndex(ids, bboxWgs84, bboxNative);
    }
    // One load per authority serves every query that needs it. A query that passes a signal can
    // be cancelled; the load stops only once no query wants it. A running load nobody claims
    // again within the grace period is aborted, and a queued one nobody wants is skipped.
    function abandonAuthorityLoad(index, entry, reason) {
        clearTimeout(entry.graceTimer);
        if (authorityPending.get(index) === entry) authorityPending.delete(index);
        entry.controller.abort(reason ?? undefined);
    }
    const unwanted = entry => entry.interest === 0 && !entry.pinned;
    async function loadAuthority(index, signal) {
        const manifest = await getManifest(), authority = manifest.authorities[index];
        if (!authority) throw upstreamError('HMLR ID directory references an unknown authority.');
        signal?.throwIfAborted();
        if (authorityState.has(index)) return authorityState.get(index);
        let entry = authorityPending.get(index);
        if (!entry) {
            const created = { controller: new AbortController(), interest: 0, pinned: false, graceTimer: null, reason: null };
            created.task = authorityLoadQueue.catch(() => {}).then(() => {
                if (unwanted(created)) abandonAuthorityLoad(index, created, created.reason);
                return runAuthorityLoad(manifest, authority, index, created.controller.signal);
            });
            authorityLoadQueue = created.task.then(() => undefined, () => undefined);
            authorityPending.set(index, created);
            const settled = () => { clearTimeout(created.graceTimer); if (authorityPending.get(index) === created) authorityPending.delete(index); };
            created.task.then(settled, settled);
            entry = created;
        }
        clearTimeout(entry.graceTimer);
        if (!signal) { entry.pinned = true; return entry.task; }
        entry.interest++;
        let counted = true;
        const leave = cancelled => {
            if (!counted) return;
            counted = false; entry.interest--;
            if (!cancelled || !unwanted(entry)) return;
            entry.reason = signal.reason;
            entry.graceTimer = setTimeout(() => { if (unwanted(entry)) abandonAuthorityLoad(index, entry, entry.reason); }, orphanedLoadGraceMs);
            entry.graceTimer.unref?.();
        };
        const cancel = () => leave(true);
        signal.addEventListener('abort', cancel, { once: true });
        try { return await untilCancelled(entry.task, signal); }
        finally { signal.removeEventListener('abort', cancel); leave(false); }
    }
    async function runAuthorityLoad(manifest, authority, index, cancelSignal) {
        cancelSignal.throwIfAborted();
        const load = async () => {
            let stored = await store.getAuthority(manifest.releaseId, index);
            if (stored?.ready && stored.archiveSha256 === authority.archiveSha256 && stored.featureCount === authority.featureCount
                && stored.sourceDate === manifest.sourceDate) {
                reportProgress({ phase: 'source-cache', authority: authority.name });
                const storedRows = await store.getIndex(manifest.releaseId, index);
                const storedIds = new Set();
                const validStoredRows = storedRows.length === authority.featureCount && storedRows.every(row => {
                    const nativeId = decimalId(row?.nativeId, true);
                    if (nativeId === null || storedIds.has(nativeId) || !withinBounds(row.bboxNative, authority.nativeBounds)
                        || !withinBounds(row.bboxWgs, authority.bounds)) return false;
                    storedIds.add(nativeId); return true;
                });
                if (validStoredRows) {
                    const built = makeAuthorityIndex(storedRows.map(row => ({ nativeId: row.nativeId, bboxWgs: row.bboxWgs, bboxNative: row.bboxNative })));
                    authorityState.set(index, built); return built;
                }
            }
            await store.clearAuthority(manifest.releaseId, index);
            await store.setAuthority(manifest.releaseId, index, { ready: false, archiveSha256: authority.archiveSha256, featureCount: authority.featureCount });
            // Download and local parsing have separate budgets. A completed download's
            // timer must not abort a large council while it is being indexed locally.
            const bytes = await getArchiveBytes(manifest, authority,
                AbortSignal.any([AbortSignal.timeout(ARCHIVE_TIMEOUT_MS), cancelSignal]), cancelSignal);
            reportProgress({ phase: 'source-decompress', authority: authority.name });
            const signal = AbortSignal.any([AbortSignal.timeout(PARSE_TIMEOUT_MS), cancelSignal]);
            const project = proj4('EPSG:27700', 'EPSG:4326');
            const seen = new Set(), rows = [], pendingWrites = []; let batch = [], writeFailure = null;
            const drainWrites = async () => {
                if (pendingWrites.length) await Promise.all(pendingWrites.splice(0));
                if (writeFailure) throw writeFailure;
            };
            const flush = () => {
                if (!batch.length) return;
                const current = batch; batch = [];
                const pending = store.putBatch(manifest.releaseId, index, current).catch(error => { writeFailure = error; });
                pendingWrites.push(pending);
            };
            try {
                const parsed = await parseGmlParcels(withBatchWriteBackpressure(
                    readGmlZipMember(bytes, MAX_GML_BYTES, signal), drainWrites), {
                    coordinateMode: 'native', maxBytes: MAX_GML_BYTES, maxFeatures: authority.featureCount, signal,
                    onFeature: feature => {
                        const nativeId = decimalId(feature.properties?.INSPIREID);
                        if (nativeId === null || seen.has(nativeId)) throw upstreamError('HMLR authority archive has invalid or repeated INSPIREIDs.');
                        seen.add(nativeId);
                        const bounds = collectBoxes(feature.geometry, project);
                        if (!withinBounds(bounds.bboxNative, authority.nativeBounds)) {
                            throw upstreamError('HMLR authority feature exceeds its manifest native extent.');
                        }
                        if (!withinBounds(bounds.bboxWgs, authority.bounds)) {
                            throw upstreamError('HMLR authority feature exceeds its manifest projected extent.');
                        }
                        const record = { nativeId, bboxWgs: bounds.bboxWgs, bboxNative: bounds.bboxNative, feature };
                        rows.push({ nativeId, bboxWgs: bounds.bboxWgs, bboxNative: bounds.bboxNative });
                        batch.push(record); if (batch.length >= 250) flush();
                        // Decompression and parsing stream together; report actual accepted
                        // features, without inventing a separate completed unpacking phase.
                        if (rows.length === 1 || rows.length % 250 === 0 || rows.length === authority.featureCount) {
                            reportProgress({ phase: 'source-process', authority: authority.name,
                                processedFeatures: rows.length, totalFeatures: authority.featureCount });
                        }
                    }
                });
                flush(); await drainWrites();
                if (parsed.sourceCrs !== 'EPSG:27700' || parsed.featureCount !== authority.featureCount
                    || parsed.numberMatched !== authority.featureCount || parsed.numberReturned !== authority.featureCount
                    || parsed.sourceTimestamp?.slice(0, 10) !== manifest.sourceDate || rows.length !== authority.featureCount) {
                    throw upstreamError('HMLR authority GML date, CRS, or complete feature count disagrees with its release manifest.');
                }
                const built = makeAuthorityIndex(rows);
                await store.setAuthority(manifest.releaseId, index, { ready: true, archiveSha256: authority.archiveSha256,
                    featureCount: authority.featureCount, sourceDate: manifest.sourceDate });
                authorityState.set(index, built); return built;
            } catch (error) {
                await Promise.allSettled(pendingWrites.splice(0));
                await store.clearAuthority(manifest.releaseId, index);
                await store.setAuthority(manifest.releaseId, index, { ready: false, archiveSha256: authority.archiveSha256, featureCount: authority.featureCount });
                if (cancelSignal.aborted) throw cancelSignal.reason;
                throw error.status ? error : upstreamError('HMLR authority archive is malformed or incomplete.');
            }
        };
        const built = typeof store.withAuthorityLoad === 'function'
            ? await store.withAuthorityLoad(manifest.releaseId, index, load) : await load();
        authorityState.set(index, built);
        return built;
    }
    async function getShard(manifest, bucket) {
        if (shardCache.has(bucket)) return shardCache.get(bucket);
        if (!manifest.directory.has(bucket)) return null;
        if (shardPending.has(bucket)) return shardPending.get(bucket);
        const task = (async () => {
            const item = manifest.directory.get(bucket), controller = AbortSignal.timeout(30000);
            let response;
            try { response = await fetchImpl(item.url, { signal: controller, redirect: 'follow', headers: { Accept: 'application/json' } }); }
            catch (error) { if (error.status) throw error; throw upstreamError('HMLR ID shard is unavailable.', controller.aborted ? 504 : 502); }
            const bytes = await responseBytes(response, item.bytes, MAX_METADATA_BYTES, 'HMLR ID shard');
            if (sha256Hex(bytes) !== item.sha256) throw upstreamError('HMLR ID shard SHA-256 does not match its release manifest.');
            let value;
            try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { throw upstreamError('HMLR ID shard is malformed.'); }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw upstreamError('Invalid HMLR ID shard contents.');
            const entries = new Map();
            for (const [nativeId, indices] of Object.entries(value)) {
                const id = decimalId(nativeId, true), expectedBucket = nativeId.length < 4 ? nativeId : nativeId.slice(0, 4);
                if (id === null || expectedBucket !== bucket || !Array.isArray(indices) || !indices.length
                    || indices.some((authorityIndex, i) => !Number.isSafeInteger(authorityIndex) || authorityIndex < 0
                        || authorityIndex >= manifest.authorities.length || (i && authorityIndex <= indices[i - 1]))) {
                    throw upstreamError('HMLR ID shard contains an invalid native identity or authority index.');
                }
                entries.set(nativeId, indices);
            }
            shardCache.set(bucket, entries); return entries;
        })();
        shardPending.set(bucket, task);
        try { return await task; } finally { shardPending.delete(bucket); }
    }
    async function featureFrom(releaseId, index, nativeId, expectedRow = null) {
        const feature = await store.getFeature(releaseId, index, nativeId);
        const authority = (await getManifest()).authorities[index];
        if (!authority) throw upstreamError('HMLR stored parcel references an unknown authority.');
        const invalidate = async message => {
            await store.clearAuthority(releaseId, index);
            authorityState.delete(index);
            await store.setAuthority(releaseId, index, { ready: false, archiveSha256: authority.archiveSha256, featureCount: authority.featureCount });
            throw upstreamError(message);
        };
        if (!feature) return invalidate(`HMLR ID directory references missing native parcel ${nativeId}.`);
        if (decimalId(feature.properties?.INSPIREID) !== nativeId) return invalidate(`HMLR stored parcel ${nativeId} has a mismatched native identity.`);
        let bounds;
        try { bounds = collectBoxes(feature.geometry, proj4('EPSG:27700', 'EPSG:4326')); }
        catch { return invalidate(`HMLR stored parcel ${nativeId} has invalid geometry.`); }
        if (!withinBounds(bounds.bboxNative, authority.nativeBounds) || !withinBounds(bounds.bboxWgs, authority.bounds)
            || (expectedRow && (!Array.isArray(expectedRow.bboxNative) || !Array.isArray(expectedRow.bboxWgs)
                || bounds.bboxNative.some((value, axis) => value !== expectedRow.bboxNative[axis])
                || bounds.bboxWgs.some((value, axis) => value !== expectedRow.bboxWgs[axis])))) {
            return invalidate(`HMLR stored parcel ${nativeId} exceeds or disagrees with its conservative manifest extent.`);
        }
        return feature;
    }
    function rowsMatching(indices, queryBoxes) {
        const selected = [], seen = new Set();
        for (const [authorityIndex, index] of indices) {
            for (const queryBox of queryBoxes) for (const row of findRows(index.tree, queryBox)) {
                const key = `${authorityIndex}:${index.ids[row]}`;
                if (seen.has(key)) continue;
                seen.add(key);
                selected.push({ authorityIndex, nativeId: index.ids[row], bboxWgs: Array.from(index.bboxWgs84.subarray(row * 4, row * 4 + 4)),
                    bboxNative: Array.from(index.bboxNative.subarray(row * 4, row * 4 + 4)) });
                if (selected.length > maxContextFeatures) throw upstreamError('HMLR overlap context exceeds its safe feature limit.', 413);
            }
        }
        return selected;
    }
    async function resolveCandidates(manifest, candidates, signal) {
        if (!candidates.length) return { features: [], suppressedIds: [] };
        if (candidates.length > MAX_QUERY_FEATURES) throw upstreamError('HMLR browser query exceeds the parcel limit; use a smaller viewport.', 413);
        const boxes = candidates.map(item => item.bboxWgs), needed = await authoritiesForParcels(manifest, candidates);
        if (needed.length > MAX_QUERY_AUTHORITIES) throw upstreamError('HMLR overlap context spans too many authority archives; use a smaller query.', 413);
        await Promise.all(needed.map(index => loadAuthority(index, signal)));
        reportProgress({ phase: 'source-prepare' });
        const fullIndexes = needed.map(index => [index, authorityState.get(index)]);
        const contextRows = rowsMatching(fullIndexes, boxes), context = [];
        for (let offset = 0; offset < contextRows.length; offset += 250) {
            signal?.throwIfAborted();
            const batch = await Promise.all(contextRows.slice(offset, offset + 250).map(row => featureFrom(manifest.releaseId, row.authorityIndex, row.nativeId, row)));
            context.push(...batch);
        }
        signal?.throwIfAborted();
        const targetIds = [...new Set(candidates.map(item => item.nativeId))];
        const resolved = await (await getEngine()).resolve(context, { selectedIds: targetIds.map(id => `${ID_PREFIX}${id}`) });
        return resolved;
    }
    function outputForQuery(result, queryGeometry, manifest) {
        const geometry = queryGeometry.type === 'Feature' ? queryGeometry.geometry : queryGeometry;
        const features = result.features.filter(item => booleanIntersects(item, geoFeature(geometry)));
        return { type: 'FeatureCollection', complete: true, sourceId: HMLR_BROWSER_GROUND_SOURCE,
            normalizationPolicy: HMLR_BROWSER_GROUND_POLICY, snapshotId: manifest.releaseId, sourceDate: manifest.sourceDate,
            returnsWGS84: true, features, suppressedIds: result.suppressedIds };
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        const manifest = await getManifest(), viewport = bboxPolygon(bounds), initial = await authoritiesForBounds(manifest, [bounds]);
        if (initial.length > MAX_QUERY_AUTHORITIES) throw upstreamError('HMLR viewport spans too many authority archives; use a smaller query.', 413);
        await Promise.all(initial.map(index => loadAuthority(index, signal)));
        reportProgress({ phase: 'source-prepare' });
        const loaded = initial.map(index => [index, authorityState.get(index)]);
        const candidateRows = rowsMatching(loaded, [bounds]);
        if (candidateRows.length > MAX_QUERY_FEATURES) throw upstreamError('HMLR browser query exceeds the parcel limit; use a smaller viewport.', 413);
        const features = [];
        for (let offset = 0; offset < candidateRows.length; offset += 250) {
            signal?.throwIfAborted();
            features.push(...await Promise.all(candidateRows.slice(offset, offset + 250)
                .map(row => featureFrom(manifest.releaseId, row.authorityIndex, row.nativeId, row))));
        }
        // An enclosing rectangle that overlaps the query does not make a parcel part of it. Only
        // polygons whose policy input meets the query become candidates, so an offscreen parcel
        // cannot pull its overlap context (and neighbouring ZIPs) into this view. A rectangle
        // wholly inside the query already proves it.
        const undecided = candidateRows.map((row, index) => index).filter(index => !withinBounds(candidateRows[index].bboxWgs, bounds));
        const meets = undecided.length ? await (await getEngine()).intersectsBounds(undecided.map(index => features[index]), bounds) : [];
        const outside = new Set(undecided.filter((index, position) => !meets[position]));
        const candidates = candidateRows.map((row, index) => ({ ...row, feature: features[index] })).filter((_, index) => !outside.has(index));
        signal?.throwIfAborted();
        const result = await resolveCandidates(manifest, candidates, signal);
        return outputForQuery(result, viewport, manifest);
    }
    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid polygon geometry.');
        validateBounds(geometryBbox(geometry), descriptor.maxBboxKm2 ?? 25, descriptor);
        const result = await queryBounds(geometryBbox(geometry), options);
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, geoFeature(geometry))) };
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(ID_PREFIX) || decimalId(id.slice(ID_PREFIX.length), true) === null)) {
            throw new HttpError(400, 'Provide between 1 and 80 canonical HMLR browser parcel IDs.');
        }
        const unique = [...new Set(ids)], manifest = await getManifest();
        const requested = unique.map(id => ({ id, nativeId: id.slice(ID_PREFIX.length) }));
        const buckets = [...new Set(requested.map(item => item.nativeId.length < 4 ? item.nativeId : item.nativeId.slice(0, 4)))];
        if (buckets.reduce((total, bucket) => total + (manifest.directory.get(bucket)?.bytes || 0), 0) > MAX_METADATA_BYTES) {
            throw upstreamError('HMLR ID lookup metadata exceeds its safe byte limit.', 413);
        }
        const shards = new Map(); await Promise.all(buckets.map(async bucket => shards.set(bucket, await getShard(manifest, bucket))));
        const authorities = new Set(), declared = new Map();
        for (const item of requested) {
            const bucket = item.nativeId.length < 4 ? item.nativeId : item.nativeId.slice(0, 4);
            const indices = shards.get(bucket)?.get(item.nativeId);
            if (indices) { declared.set(item.nativeId, indices); for (const index of indices) authorities.add(index); }
        }
        const declaredReferences = [...declared.values()].reduce((total, indices) => total + indices.length, 0);
        if (authorities.size > MAX_QUERY_AUTHORITIES || declaredReferences > MAX_QUERY_FEATURES) {
            throw upstreamError('HMLR ID lookup spans too many authority parcels; use fewer IDs.', 413);
        }
        await Promise.all([...authorities].map(index => loadAuthority(index, signal)));
        reportProgress({ phase: 'source-prepare' });
        const targetRows = [];
        for (const [nativeId, indices] of declared) {
            for (const index of indices) {
                const authorityIndex = authorityState.get(index), position = authorityIndex.positions.get(nativeId);
                if (position === undefined) throw upstreamError(`HMLR ID directory references missing native parcel ${nativeId}.`);
                targetRows.push({ authorityIndex: index, nativeId,
                    bboxWgs: Array.from(authorityIndex.bboxWgs84.subarray(position * 4, position * 4 + 4)),
                    bboxNative: Array.from(authorityIndex.bboxNative.subarray(position * 4, position * 4 + 4)) });
            }
        }
        const candidates = [];
        for (let offset = 0; offset < targetRows.length; offset += 250) {
            const batch = await Promise.all(targetRows.slice(offset, offset + 250).map(row => featureFrom(manifest.releaseId, row.authorityIndex, row.nativeId, row)));
            batch.forEach((feature, index) => candidates.push({ ...targetRows[offset + index], feature }));
        }
        const result = await resolveCandidates(manifest, candidates, signal);
        const found = new Set(result.features.map(feature => feature.id)), suppressed = new Set(result.suppressedIds);
        const absentIds = requested.filter(item => !declared.has(item.nativeId) || suppressed.has(item.id)).map(item => item.id);
        for (const item of requested) if (declared.has(item.nativeId)
            && !found.has(item.id) && !suppressed.has(item.id)) throw upstreamError(`HMLR native parcel ${item.nativeId} was neither resolved nor suppressed.`);
        return { ...result, complete: true, sourceId: HMLR_BROWSER_GROUND_SOURCE, normalizationPolicy: HMLR_BROWSER_GROUND_POLICY,
            snapshotId: manifest.releaseId, sourceDate: manifest.sourceDate, returnsWGS84: true, absentIds };
    }
    return Object.freeze({ queryBounds, queryGeometry, queryIds });
}
