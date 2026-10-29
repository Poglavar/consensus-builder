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
    const pathOf = id => join(directory, `${id}.json`);
    const valid = value => value?.schema === 'ugt-shared-plan-session/v1' && SESSION.test(value.id)
        && TOKEN.test(value.ownerToken) && TOKEN.test(value.inviteToken) && Number.isInteger(value.version) && value.version >= 0
        && ['owner', 'agent'].includes(value.controller) && value.artifact && Number.isFinite(value.updatedAt);
    for (const name of readdirSync(directory)) {
        if (!/^[\w-]{24}\.json$/.test(name)) continue;
        try {
            if (lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('Shared plan session files must not be symlinks');
            const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
            if (valid(value) && `${value.id}.json` === name) { validateArtifact(value.artifact); entries.set(value.id, value); chmodSync(pathOf(value.id), 0o600); }
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
        return { id: value.id, version: value.version, controller: value.controller, cid: value.artifact.cid, updatedAt: new Date(value.updatedAt).toISOString(), ...(includeArtifact ? { artifact: structuredClone(value.artifact) } : {}) };
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
        persist(next, value.id); return { ...publicState(next), ...(revoke ? { inviteToken: next.inviteToken } : {}) };
    }
    function replace(id, capability, { expectedVersion, artifact }) {
        validateArtifact(artifact);
        const { value, role } = access(id, capability);
        requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
        const next = { ...value, artifact: structuredClone(artifact), version: value.version + 1, updatedAt: now() };
        persist(next, value.id); return publicState(next);
    }
    function assertEditable(id, capability, expectedVersion) {
        const { value, role } = access(id, capability);
        requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
        return publicState(value);
    }
    return { create, inspect, control, replace, assertEditable, dispose() { releaseWriter(); entries.clear(); } };
}
