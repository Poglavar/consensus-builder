// Private bearer objects survive process shutdown; only expiry or explicit clear removes them.
import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonicalBytes, cidOfObject, isCid } from '../cid.js';

const TOKEN = /^[\w-]{32}$/;
const full = () => Object.assign(new Error('Private draft storage capacity is full'), { code: 'preview-cache-full' });

export function draftMembersMatch(record, members) {
    if (record?.schema === 'design/v1') return true;
    const expected = record?.schema === 'plan/v1' ? record.designCids : record?.designs?.map(member => member.cid);
    if (!Array.isArray(expected) || !Array.isArray(members) || expected.length !== members.length) return false;
    const actual = new Set(members.map(member => member?.cid));
    return actual.size === members.length && new Set(expected).size === expected.length
        && expected.every(cid => isCid(cid) && actual.has(cid));
}

// Each contender creates its own atomic claim before checking every other live claim. Two
// simultaneous contenders can both refuse, but can never both become writers. Unique filenames
// let dead-PID cleanup remove only that old claim, never a replacement writer's lock.
function acquireWriter(directory) {
    const name = `.writer-${process.pid}-${randomBytes(12).toString('hex')}.lock`;
    const own = join(directory, name);
    closeSync(openSync(own, 'wx', 0o600));
    const release = () => { try { unlinkSync(own); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    try {
        for (const other of readdirSync(directory)) {
            if (other === name) continue;
            const match = /^\.writer-([1-9]\d*)-[a-f0-9]{24}\.lock$/.exec(other);
            if (!match) continue;
            let alive = true;
            try { process.kill(Number(match[1]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
            if (alive) throw Object.assign(new Error('Private draft storage already has an active writer. Use one server process per directory.'), { code: 'draft-store-locked' });
            try { unlinkSync(join(directory, other)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return release;
    } catch (error) { release(); throw error; }
}

export function createDraftStore({ directory, now = Date.now, maxEntries = 4096, maxBytes = 128 * 1024 * 1024 }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Private draft storage requires an absolute directory');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Private draft storage bounds must be positive');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Private draft storage must be a directory');
    chmodSync(directory, 0o700);
    const releaseWriter = acquireWriter(directory);
    try {
        const entries = new Map(), byKey = new Map();
        let disposed = false;
        const assertOpen = () => { if (disposed) throw new Error('Private draft storage is disposed'); };
        const fileOf = token => join(directory, `${token}.json`);
        const valid = entry => entry?.version === 1 && TOKEN.test(entry.token) && typeof entry.key === 'string'
            && Number.isFinite(entry.expiresAt) && entry.row && ['design/v1', 'plan/v1', 'agreement/v1'].includes(entry.row.record?.schema)
            && entry.row.cid === cidOfObject(entry.row.record)
            && draftMembersMatch(entry.row.record, entry.row.designs);
        for (const name of readdirSync(directory)) {
            if (!/^[\w-]{32}\.json$/.test(name)) continue;
            try {
                const path = join(directory, name);
                if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
                const entry = JSON.parse(readFileSync(path, 'utf8'));
                if (!valid(entry) || `${entry.token}.json` !== name) continue;
                chmodSync(path, 0o600);
                entries.set(entry.token, entry); byKey.set(entry.key, entry.token);
            } catch { /* A damaged object cannot prevent recovery of unrelated drafts. */ }
        }
        function write(entry) {
            const temporary = join(directory, `.${entry.token}.${randomBytes(12).toString('hex')}.tmp`);
            let descriptor;
            try {
                descriptor = openSync(temporary, 'wx', 0o600);
                writeFileSync(descriptor, canonicalBytes(entry)); fsyncSync(descriptor);
                closeSync(descriptor); descriptor = undefined;
                renameSync(temporary, fileOf(entry.token));
            } finally {
                if (descriptor !== undefined) closeSync(descriptor);
                try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        }
        function syncDirectory() {
            const descriptor = openSync(directory, 'r');
            try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
        }
        function remove(token) {
            const entry = entries.get(token);
            if (!entry) return;
            try { unlinkSync(fileOf(token)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            entries.delete(token);
            if (byKey.get(entry.key) === token) byKey.delete(entry.key);
        }
        function prune() {
            for (const [token, entry] of entries) if (entry.expiresAt <= now()) remove(token);
        }
        function get(token) {
            assertOpen(); prune();
            if (typeof token !== 'string' || !TOKEN.test(token)) return null;
            const entry = entries.get(token);
            return entry && entry.expiresAt > now() ? structuredClone(entry) : null;
        }
        // Stage the whole collection before admission: capacity never evicts an unexpired reference.
        function putBatch(build, expiresAt) {
            assertOpen(); prune();
            const pending = new Map();
            function add(key, row) {
                const token = byKey.get(key) || [...pending.values()].find(entry => entry.key === key)?.token || randomBytes(24).toString('base64url');
                const previous = pending.get(token) || entries.get(token);
                const entry = { version: 1, token, key, expiresAt: Math.max(previous?.expiresAt || 0, expiresAt), row: structuredClone(row) };
                pending.set(token, entry); return structuredClone(entry);
            }
            const result = build(add);
            const merged = new Map([...entries, ...pending]);
            const size = [...merged.values()].reduce((sum, entry) => sum + canonicalBytes(entry).length, 0);
            if (merged.size > maxEntries || size > maxBytes) throw full();
            // Children are written before their manifest. No reference is returned until all writes sync.
            try {
                for (const entry of pending.values()) write(entry);
                syncDirectory();
            } catch (error) {
                // An interrupted admission must not leave unseen new objects consuming capacity.
                for (const token of pending.keys()) if (!entries.has(token)) {
                    try { unlinkSync(fileOf(token)); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
                }
                throw error;
            }
            for (const [token, entry] of pending) { entries.set(token, entry); byKey.set(entry.key, token); }
            return result;
        }
        prune();
        return { get, putBatch,
            dispose() { if (disposed) return; releaseWriter(); disposed = true; entries.clear(); byKey.clear(); },
            clear() {
                assertOpen();
                // Explicit erasure also covers damaged object files and interrupted atomic writes.
                for (const name of readdirSync(directory)) if (/^[\w-]{32}\.json$/.test(name) || /^\.[\w-]{32}\.[a-f0-9]{24}\.tmp$/.test(name)) {
                    try { unlinkSync(join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                entries.clear(); byKey.clear(); syncDirectory();
            }
        };
    } catch (error) { releaseWriter(); throw error; }
}
