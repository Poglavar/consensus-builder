import { describe, expect, it } from 'vitest';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createMemorySharedPlanRepository } from './helpers/shared-plan-repository.js';

const artifact = cid => ({ cid, plan: { schema: 'plan/v1' }, designs: [] });
function sessions(repository = createMemorySharedPlanRepository()) {
    return createSharedPlanSessions({ repository, validateArtifact: value => {
        if (!value?.cid?.startsWith('baf')) throw Object.assign(new Error('invalid artifact'), { code: 'shared-plan-artifact-invalid' });
    } });
}

describe('shared plan sessions', () => {
    it('keeps an exact revision across restart without exposing capabilities in reads', async () => {
        const repository = createMemorySharedPlanRepository();
        const first = sessions(repository), created = await first.create(artifact('baf-first'));
        expect(created).toMatchObject({ version: 0, controller: 'owner', cid: 'baf-first' });
        const ownerRead = await first.inspect(created.id, created.ownerToken);
        expect(ownerRead).not.toHaveProperty('ownerToken'); expect(ownerRead).not.toHaveProperty('inviteToken');
        await first.dispose();
        const restarted = sessions(repository);
        expect(await restarted.inspect(created.id, created.inviteToken)).toMatchObject({ version: 0, artifact: artifact('baf-first') });
        await restarted.dispose();
    });
    it('makes handover and stale edits conflict at the commit point', async () => {
        const store = sessions(), created = await store.create(artifact('baf-first'));
        const handed = await store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        expect(handed.version).toBe(1);
        await expect(store.replace(created.id, created.ownerToken, { expectedVersion: 0, artifact: artifact('baf-owner-late') }))
            .rejects.toMatchObject({ code: 'shared-plan-version-conflict', status: 409 });
        const agent = await store.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('baf-agent') });
        expect(agent).toMatchObject({ version: 2, cid: 'baf-agent' });
        const taken = await store.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' });
        await expect(store.replace(created.id, created.inviteToken, { expectedVersion: taken.version, artifact: artifact('baf-late') }))
            .rejects.toMatchObject({ code: 'shared-plan-control-required', status: 403 });
    });
    it('limits control to the owner and revokes the old invitation', async () => {
        const store = sessions(), created = await store.create(artifact('baf-first'));
        await expect(store.control(created.id, created.inviteToken, { expectedVersion: 0, controller: 'agent' }))
            .rejects.toMatchObject({ code: 'shared-plan-owner-required', status: 403 });
        const revoked = await store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'owner', revoke: true });
        expect(revoked.inviteToken).toMatch(/^[\w-]{32}$/);
        await expect(store.inspect(created.id, created.inviteToken)).rejects.toMatchObject({ code: 'shared-plan-forbidden', status: 403 });
    });
    it('persists a single agent undo across takeover and restart, and rejects stale or missing history', async () => {
        const repository = createMemorySharedPlanRepository();
        const first = sessions(repository), created = await first.create(artifact('baf-first'));
        await first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const edit = await first.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('baf-agent') });
        expect(edit).toMatchObject({ canUndo: true, lastChange: { fromCid: 'baf-first', toCid: 'baf-agent', actor: 'agent', kind: 'edit' } });
        await first.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' });
        await first.dispose();
        const second = sessions(repository);
        await expect(second.undo(created.id, created.ownerToken, { expectedVersion: 2 })).rejects.toMatchObject({ code: 'shared-plan-version-conflict' });
        expect(await second.undo(created.id, created.ownerToken, { expectedVersion: 3 })).toMatchObject({ version: 4, cid: 'baf-first', canUndo: false, lastChange: { kind: 'undo' } });
        await expect(second.undo(created.id, created.ownerToken, { expectedVersion: 4 })).rejects.toMatchObject({ code: 'shared-plan-undo-unavailable' });
        await second.control(created.id, created.ownerToken, { expectedVersion: 4, controller: 'agent' });
        await second.replace(created.id, created.inviteToken, { expectedVersion: 5, artifact: artifact('baf-agent-2') });
        await second.control(created.id, created.ownerToken, { expectedVersion: 6, controller: 'owner' });
        expect((await second.replace(created.id, created.ownerToken, { expectedVersion: 7, artifact: artifact('baf-owner') })).canUndo).toBe(false);
        await second.dispose();
    });
    it('collapses member revision chains into a durable receipt and reverses them on undo', async () => {
        const old = { ...artifact('baf-old-plan'), designs: [{ cid: 'old', content: {} }, { cid: 'removed', content: {} }] };
        const revised = { ...artifact('baf-new-plan'), designs: [{ cid: 'new', content: {} }, { cid: 'added', content: {} }] };
        const repository = createMemorySharedPlanRepository();
        const first = sessions(repository), created = await first.create(old);
        await first.subscribe(created.id, created.ownerToken, () => { throw new Error('broken subscriber'); });
        await first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const edit = await first.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: revised, changes: [
            { beforeCid: 'old', afterCid: 'middle', type: 'edit' }, { beforeCid: 'middle', afterCid: 'new', type: 'edit', ref: 'design:old' }
        ] });
        expect(edit.lastChange.members).toEqual([{ beforeCid: 'old', afterCid: 'new', ref: 'design:old', type: 'edit' }, { beforeCid: 'removed' }, { afterCid: 'added' }]);
        await expect(first.undo(created.id, created.ownerToken, { expectedVersion: 2 })).rejects.toMatchObject({ code: 'shared-plan-control-required' });
        await first.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' }); await first.dispose();
        const second = sessions(repository);
        expect((await second.inspect(created.id, created.ownerToken)).lastChange).toEqual(edit.lastChange);
        const undone = await second.undo(created.id, created.ownerToken, { expectedVersion: 3 });
        expect(undone.artifact).toEqual(old);
        expect(undone.lastChange.members).toEqual([{ beforeCid: 'new', afterCid: 'old', ref: 'design:old', type: 'edit' }, { beforeCid: 'added' }, { afterCid: 'removed' }]);
        await second.dispose();
    });
    it('refuses capacity growth and atomically accepts only one simultaneous write for a version', async () => {
        const repository = createMemorySharedPlanRepository({ maxEntries: 1 });
        const store = createSharedPlanSessions({ repository, validateArtifact: value => {
            if (!value?.cid) throw new Error('invalid artifact');
        } });
        const created = await store.create(artifact('baf-first'));
        await expect(store.create(artifact('baf-second'))).rejects.toMatchObject({ code: 'shared-plan-capacity', status: 503 });
        const writes = await Promise.allSettled([
            store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' }),
            store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'owner' })
        ]);
        expect(writes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
        expect(writes.filter(row => row.status === 'rejected')[0].reason).toMatchObject({ code: 'shared-plan-version-conflict', status: 409 });
        expect(await store.inspect(created.id, created.ownerToken)).toMatchObject({ version: 1 });
        await store.dispose();
    });
});
