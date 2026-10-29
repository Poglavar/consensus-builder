// Durable, capability-scoped turn taking over immutable plan revisions.
import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const TOKEN = /^[\w-]{32}$/;
const SESSION = /^[\w-]{24}$/;
const token = () => randomBytes(24).toString('base64url');
const failure = (code, message, status = 400, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

function acquireWriter(directory) {
    const name = `.writer-${process.pid}-${randomBytes(12).toString('hex')}.lock`, own = join(directory, name);
    closeSync(openSync(own, 'wx', 0o600));
    const release = () => { try { unlinkSync(own); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    try {
        for (const other of readdirSync(directory)) {
            if (other === name) continue;
            const match = /^\.writer-([1-9]\d*)-[a-f0-9]{24}\.lock$/.exec(other);
            if (!match) continue;
            let alive = true; try { process.kill(Number(match[1]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
            if (alive) throw failure('shared-plan-store-locked', 'Shared plan storage already has an active writer.', 503);
            try { unlinkSync(join(directory, other)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return release;
    } catch (error) { release(); throw error; }
}

// This is intentionally a tiny single-process store. A session is a pointer to an exact immutable
// plan artifact, plus the one mutable fact collaboration needs: whose completed edit may advance it.
export function createSharedPlanSessions({ directory, now = Date.now, maxEntries = 1024, maxBytes = 128 * 1024 * 1024, validateArtifact }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Shared plan sessions require an absolute directory');
    if (typeof validateArtifact !== 'function') throw new Error('Shared plan sessions require artifact validation');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Shared plan session bounds must be positive');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Shared plan sessions must use a directory');
    chmodSync(directory, 0o700);
    const releaseWriter = acquireWriter(directory);
    const entries = new Map();
    const listeners = new Map(), activities = new Map();
    function notify(id) { for (const listener of listeners.get(id) || []) { try { listener(); } catch { /* A broken subscriber cannot undo a committed write. */ } } }
    function activity(id) { return { agentEditing: !!activities.get(id) }; }
    function subscribe(id, capability, listener) {
        access(id, capability);
        const set = listeners.get(id) || new Set(); set.add(listener); listeners.set(id, set);
        return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
    }
    function eventState(id, capability) {
        const { value } = access(id, capability);
        return { id, version: value.version, cid: value.artifact.cid, controller: value.controller, activity: activity(id) };
    }
    function beginActivity(id, capability, expectedVersion) {
        const { value, role } = access(id, capability); requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403);
        if (role !== 'agent') return () => {};
        const marker = Symbol(), pending = activities.get(id) || new Set();
        pending.add(marker); activities.set(id, pending); notify(id);
        return () => { if (activities.get(id) === pending && pending.delete(marker)) { if (!pending.size) activities.delete(id); notify(id); } };
    }
    function membersBetween(before, after, hints = []) {
        const old = new Set(before.designs.map(row => row.cid)), next = new Set(after.designs.map(row => row.cid));
        const removed = new Set([...old].filter(cid => !next.has(cid))), added = new Set([...next].filter(cid => !old.has(cid)));
        const links = new Map();
        for (const hint of hints) if (hint?.beforeCid && hint?.afterCid) links.set(hint.beforeCid, hint);
        for (const row of after.designs) if (row.content?.origin?.cid && !links.has(row.content.origin.cid)) links.set(row.content.origin.cid, { beforeCid: row.content.origin.cid, afterCid: row.cid });
        const result = [];
        for (const start of [...removed]) {
            let cursor = start, hint, seen = new Set();
            while (links.has(cursor) && !seen.has(cursor)) { seen.add(cursor); hint = links.get(cursor); cursor = hint.afterCid; }
            if (added.has(cursor)) { result.push({ beforeCid: start, afterCid: cursor, ...(hint?.ref ? { ref: hint.ref } : {}), ...(hint?.type ? { type: hint.type } : {}) }); removed.delete(start); added.delete(cursor); }
        }
        return [...result, ...[...removed].map(beforeCid => ({ beforeCid })), ...[...added].map(afterCid => ({ afterCid }))];
    }
    const pathOf = id => join(directory, `${id}.json`);
    const valid = value => value?.schema === 'ugt-shared-plan-session/v1' && SESSION.test(value.id)
        && TOKEN.test(value.ownerToken) && TOKEN.test(value.inviteToken) && Number.isInteger(value.version) && value.version >= 0
        && ['owner', 'agent'].includes(value.controller) && value.artifact && Number.isFinite(value.updatedAt);
    for (const name of readdirSync(directory)) {
        if (!/^[\w-]{24}\.json$/.test(name)) continue;
        try {
            if (lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('Shared plan session files must not be symlinks');
            const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
            if (valid(value) && `${value.id}.json` === name) {
                validateArtifact(value.artifact);
                if (value.undo != null) {
                    if (value.undo.afterCid !== value.artifact.cid || !value.undo.artifact) throw new Error('Invalid undo history');
                    validateArtifact(value.undo.artifact);
                }
                if (value.lastChange != null && (value.lastChange.toCid !== value.artifact.cid || typeof value.lastChange.fromCid !== 'string'
                    || !['owner', 'agent'].includes(value.lastChange.actor) || !['edit', 'undo'].includes(value.lastChange.kind)
                    || !Array.isArray(value.lastChange.members) || value.lastChange.members.some(row => !row || typeof row !== 'object'
                        || ![row.beforeCid, row.afterCid].some(cid => typeof cid === 'string')
                        || ['beforeCid', 'afterCid', 'ref', 'type'].some(key => row[key] !== undefined && typeof row[key] !== 'string')))) throw new Error('Invalid change receipt');
                entries.set(value.id, value); chmodSync(pathOf(value.id), 0o600);
            }
        } catch (error) { if (/symlink/i.test(error.message)) { releaseWriter(); throw error; } /* A damaged object cannot hide other sessions. */ }
    }
    function write(value) {
        const temp = join(directory, `.${value.id}.${randomBytes(12).toString('hex')}.tmp`);
        let fd;
        try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, pathOf(value.id)); }
        finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    function syncDirectory() { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    function assertCapacity(next, replacing = null) {
        const all = [...entries.values()].filter(value => value.id !== replacing); all.push(next);
        if (all.length > maxEntries || all.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0) > maxBytes) {
            throw failure('shared-plan-capacity', 'Shared plan storage is full.', 503);
        }
    }
    function persist(next, replacing = null) { assertCapacity(next, replacing); write(next); syncDirectory(); entries.set(next.id, next); }
    function publicState(value, includeArtifact = true) {
        return { id: value.id, version: value.version, controller: value.controller, cid: value.artifact.cid, updatedAt: new Date(value.updatedAt).toISOString(), lastChange: structuredClone(value.lastChange || null), canUndo: !!value.undo && value.undo.afterCid === value.artifact.cid, ...(includeArtifact ? { artifact: structuredClone(value.artifact) } : {}) };
    }
    function access(id, capability) {
        const value = entries.get(id);
        if (!value) throw failure('shared-plan-not-found', 'This shared plan is unavailable.', 404);
        if (capability === value.ownerToken) return { value, role: 'owner' };
        if (capability === value.inviteToken) return { value, role: 'agent' };
        throw failure('shared-plan-forbidden', 'This shared plan capability is not valid.', 403);
    }
    function requireVersion(value, expectedVersion) {
        if (!Number.isInteger(expectedVersion) || expectedVersion !== value.version) throw failure('shared-plan-version-conflict', 'This shared plan changed. Read its latest revision before editing.', 409, { currentVersion: value.version, currentCid: value.artifact.cid });
    }
    function create(artifact) {
        validateArtifact(artifact);
        let id; do { id = randomBytes(18).toString('base64url'); } while (entries.has(id));
        const value = { schema: 'ugt-shared-plan-session/v1', id, ownerToken: token(), inviteToken: token(), version: 0, controller: 'owner', artifact: structuredClone(artifact), updatedAt: now() };
        persist(value);
        return { ...publicState(value), ownerToken: value.ownerToken, inviteToken: value.inviteToken };
    }
    function inspect(id, capability) { const { value } = access(id, capability); return publicState(value); }
    function control(id, capability, { expectedVersion, controller, revoke = false }) {
        const { value, role } = access(id, capability);
        if (role !== 'owner') throw failure('shared-plan-owner-required', 'Only the plan owner can change editing control.', 403);
        requireVersion(value, expectedVersion);
        if (!['owner', 'agent'].includes(controller)) throw failure('shared-plan-controller-invalid', 'Choose owner or agent as the editor.');
        const next = { ...value, controller, version: value.version + 1, updatedAt: now(), ...(revoke ? { inviteToken: token() } : {}) };
        persist(next, value.id); activities.delete(id); notify(id); return { ...publicState(next), ...(revoke ? { inviteToken: next.inviteToken } : {}) };
    }
    function replace(id, capability, { expectedVersion, artifact, changes = [], consequences = {} }) {
        validateArtifact(artifact);
        const { value, role } = access(id, capability);
        requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
        const changed = value.artifact.cid !== artifact.cid;
        const next = { ...value, artifact: structuredClone(artifact), version: value.version + 1, updatedAt: now(),
            ...(changed ? { lastChange: { fromCid: value.artifact.cid, toCid: artifact.cid, actor: role, kind: 'edit', members: membersBetween(value.artifact, artifact, [...changes, ...(consequences.junctions || [])]) },
                undo: role === 'agent' ? { artifact: structuredClone(value.artifact), afterCid: artifact.cid } : null } : role === 'owner' ? { undo: null } : {}) };
        persist(next, value.id); activities.delete(id); notify(id); return publicState(next);
    }
    function undo(id, capability, { expectedVersion }) {
        const { value, role } = access(id, capability); requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403);
        if (!value.undo || value.undo.afterCid !== value.artifact.cid) throw failure('shared-plan-undo-unavailable', 'There is no agent change to undo.', 409);
        const artifact = structuredClone(value.undo.artifact); validateArtifact(artifact);
        const next = { ...value, artifact, undo: null, version: value.version + 1, updatedAt: now(),
            lastChange: { fromCid: value.artifact.cid, toCid: artifact.cid, actor: role, kind: 'undo', members: membersBetween(value.artifact, artifact, (value.lastChange?.members || []).map(row => ({ ...row, beforeCid: row.afterCid, afterCid: row.beforeCid }))) } };
        persist(next, value.id); activities.delete(id); notify(id); return publicState(next);
    }
    function assertEditable(id, capability, expectedVersion) {
        const { value, role } = access(id, capability);
        requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
        return publicState(value);
    }
    return { create, inspect, control, replace, undo, assertEditable, subscribe, eventState, beginActivity, dispose() { listeners.clear(); activities.clear(); releaseWriter(); entries.clear(); } };
}
