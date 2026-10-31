// Durable, capability-scoped turn taking over immutable plan revisions.
import { randomBytes, createHash } from 'node:crypto';
import { createSharedPlanRepository } from './shared-plan-repository.js';
import { withSharedPlanActivity } from './shared-plan-activity.js';

export const SHARED_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

const TOKEN = /^[\w-]{32}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(24).toString('base64url');
const failure = (code, message, status = 400, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

export function createSharedPlanSessions({ pool, now = Date.now, repository = createSharedPlanRepository({ pool, now }), ttlMs = SHARED_PLAN_TTL_MS, validateArtifact }) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Shared plan lifetime must be positive');
    if (typeof validateArtifact !== 'function') throw new Error('Shared plan sessions require artifact validation');
    async function subscribe(id, capability, listener, onError) {
        access(await repository.read(id), capability);
        return repository.subscribe(id, listener, onError);
    }
    async function eventState(id, capability) {
        const { value } = access(await repository.read(id), capability);
        return { id, version: value.version, cid: value.artifact.cid, controller: value.controller, expiresAt: new Date(value.expiresAt).toISOString() };
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
    function publicState(value, includeArtifact = true) {
        return { id: value.id, version: value.version, controller: value.controller, cid: value.artifact.cid, updatedAt: new Date(value.updatedAt).toISOString(), expiresAt: new Date(value.expiresAt).toISOString(), lastChange: structuredClone(value.lastChange || null), canUndo: !!value.undo && value.undo.afterCid === value.artifact.cid, ...(includeArtifact ? { artifact: structuredClone(value.artifact) } : {}) };
    }
    function access(value, capability) {
        if (!value) throw failure('shared-plan-not-found', 'This shared plan is unavailable.', 404);
        if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now()) throw failure('shared-plan-expired', 'This shared plan session expired. Start a new session from your local plan.', 410);
        if (!TOKEN.test(capability || '')) throw failure('shared-plan-forbidden', 'This shared plan capability is not valid.', 403);
        if (hash(capability) === value.ownerTokenHash) return { value, role: 'owner' };
        if (hash(capability) === value.inviteTokenHash) return { value, role: 'agent' };
        throw failure('shared-plan-forbidden', 'This shared plan capability is not valid.', 403);
    }
    function requireVersion(value, expectedVersion) {
        if (!Number.isInteger(expectedVersion) || expectedVersion !== value.version) throw failure('shared-plan-version-conflict', 'This shared plan changed. Read its latest revision before editing.', 409, { currentVersion: value.version, currentCid: value.artifact.cid });
    }
    async function create(artifact) {
        validateArtifact(artifact);
        const id = randomBytes(18).toString('base64url'), ownerToken = token(), inviteToken = token();
        const value = { schema: 'ugt-shared-plan-session/v1', id, ownerTokenHash: hash(ownerToken), inviteTokenHash: hash(inviteToken), version: 0, controller: 'owner', artifact: structuredClone(artifact), updatedAt: now(), expiresAt: now() + ttlMs };
        await repository.insert(value);
        return { ...publicState(value), ownerToken, inviteToken };
    }
    async function inspect(id, capability) { const { value } = access(await repository.read(id), capability); return publicState(value); }
    async function control(id, capability, { expectedVersion, controller, revoke = false }) {
        const inviteToken = revoke ? token() : null;
        const result = await repository.change(id, previous => {
            const { value, role } = access(previous, capability);
            if (role !== 'owner') throw failure('shared-plan-owner-required', 'Only the plan owner can change editing control.', 403);
            // Revocation takes effect on the locked current row, regardless of intervening edits.
            // It preserves the accepted artifact and always returns control to the owner.
            if (revoke !== true) requireVersion(value, expectedVersion);
            if (revoke && (revoke !== true || controller !== 'owner')) throw failure('shared-plan-controller-invalid', 'Revocation must return control to the owner.');
            if (!['owner', 'agent'].includes(controller)) throw failure('shared-plan-controller-invalid', 'Choose owner or agent as the editor.');
            const next = { ...value, controller, version: value.version + 1, updatedAt: now(), ...(revoke ? { inviteTokenHash: hash(inviteToken) } : {}) };
            return next;
        });
        return { ...publicState(result), ...(revoke ? { inviteToken } : {}) };
    }
    async function replace(id, capability, { expectedVersion, artifact, changes = [], consequences = {} }) {
        validateArtifact(artifact);
        const result = await repository.change(id, previous => {
            const { value, role } = access(previous, capability);
            requireVersion(value, expectedVersion);
            if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
            const changed = value.artifact.cid !== artifact.cid;
            const next = { ...value, artifact: structuredClone(artifact), version: value.version + 1, updatedAt: now(),
                ...(changed ? { lastChange: { fromCid: value.artifact.cid, toCid: artifact.cid, actor: role, kind: 'edit', members: membersBetween(value.artifact, artifact, [...changes, ...(consequences.junctions || [])]) },
                    undo: role === 'agent' ? { artifact: structuredClone(value.artifact), afterCid: artifact.cid } : null } : role === 'owner' ? { undo: null } : {}) };
            return next;
        });
        return publicState(result);
    }
    async function undo(id, capability, { expectedVersion }) {
        const result = await repository.change(id, previous => {
            const { value, role } = access(previous, capability); requireVersion(value, expectedVersion);
            if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403);
            if (!value.undo || value.undo.afterCid !== value.artifact.cid) throw failure('shared-plan-undo-unavailable', 'There is no agent change to undo.', 409);
            const artifact = structuredClone(value.undo.artifact); validateArtifact(artifact);
            const next = { ...value, artifact, undo: null, version: value.version + 1, updatedAt: now(),
                lastChange: { fromCid: value.artifact.cid, toCid: artifact.cid, actor: role, kind: 'undo', members: membersBetween(value.artifact, artifact, (value.lastChange?.members || []).map(row => ({ ...row, beforeCid: row.afterCid, afterCid: row.beforeCid }))) } };
            return next;
        });
        return publicState(result);
    }
    async function assertEditable(id, capability, expectedVersion) {
        const { value, role } = access(await repository.read(id), capability);
        requireVersion(value, expectedVersion);
        if (value.controller !== role) throw failure('shared-plan-control-required', `The ${value.controller} currently holds editing control.`, 403, { controller: value.controller });
        return publicState(value);
    }
    return withSharedPlanActivity({ create, inspect, control, replace, undo, assertEditable, subscribe, eventState, dispose: () => repository.dispose() });
}
