import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';

const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
const artifact = cid => ({ cid, plan: { schema: 'plan/v1' }, designs: [] });
function sessions(directory = mkdtempSync(join(tmpdir(), 'shared-plans-'))) {
    directories.push(directory);
    return createSharedPlanSessions({ directory, validateArtifact: value => {
        if (!value?.cid?.startsWith('baf')) throw Object.assign(new Error('invalid artifact'), { code: 'shared-plan-artifact-invalid' });
    } });
}

describe('shared plan sessions', () => {
    it('keeps an exact revision across restart without exposing capabilities in reads', () => {
        const directory = mkdtempSync(join(tmpdir(), 'shared-plans-')); directories.push(directory);
        const first = sessions(directory), created = first.create(artifact('baf-first'));
        expect(created).toMatchObject({ version: 0, controller: 'owner', cid: 'baf-first' });
        const ownerRead = first.inspect(created.id, created.ownerToken);
        expect(ownerRead).not.toHaveProperty('ownerToken'); expect(ownerRead).not.toHaveProperty('inviteToken');
        first.dispose();
        const restarted = sessions(directory);
        expect(restarted.inspect(created.id, created.inviteToken)).toMatchObject({ version: 0, artifact: artifact('baf-first') });
    });
    it('makes handover and stale edits conflict at the commit point', () => {
        const store = sessions(), created = store.create(artifact('baf-first'));
        const handed = store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        expect(handed.version).toBe(1);
        expect(() => store.replace(created.id, created.ownerToken, { expectedVersion: 0, artifact: artifact('baf-owner-late') }))
            .toThrow(expect.objectContaining({ code: 'shared-plan-version-conflict', status: 409 }));
        const agent = store.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('baf-agent') });
        expect(agent).toMatchObject({ version: 2, cid: 'baf-agent' });
        const taken = store.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' });
        expect(() => store.replace(created.id, created.inviteToken, { expectedVersion: taken.version, artifact: artifact('baf-late') }))
            .toThrow(expect.objectContaining({ code: 'shared-plan-control-required', status: 403 }));
    });
    it('limits control to the owner and revokes the old invitation', () => {
        const store = sessions(), created = store.create(artifact('baf-first'));
        expect(() => store.control(created.id, created.inviteToken, { expectedVersion: 0, controller: 'agent' }))
            .toThrow(expect.objectContaining({ code: 'shared-plan-owner-required', status: 403 }));
        const revoked = store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'owner', revoke: true });
        expect(revoked.inviteToken).toMatch(/^[\w-]{32}$/);
        expect(() => store.inspect(created.id, created.inviteToken)).toThrow(expect.objectContaining({ code: 'shared-plan-forbidden', status: 403 }));
    });
    it('persists a single agent undo across takeover and restart, and rejects stale or missing history', () => {
        const directory = mkdtempSync(join(tmpdir(), 'shared-plans-')); directories.push(directory);
        const first = sessions(directory), created = first.create(artifact('baf-first'));
        first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const edit = first.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('baf-agent') });
        expect(edit).toMatchObject({ canUndo: true, lastChange: { fromCid: 'baf-first', toCid: 'baf-agent', actor: 'agent', kind: 'edit' } });
        first.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' });
        first.dispose();
        const second = sessions(directory);
        expect(() => second.undo(created.id, created.ownerToken, { expectedVersion: 2 })).toThrow(expect.objectContaining({ code: 'shared-plan-version-conflict' }));
        expect(second.undo(created.id, created.ownerToken, { expectedVersion: 3 })).toMatchObject({ version: 4, cid: 'baf-first', canUndo: false, lastChange: { kind: 'undo' } });
        expect(() => second.undo(created.id, created.ownerToken, { expectedVersion: 4 })).toThrow(expect.objectContaining({ code: 'shared-plan-undo-unavailable' }));
        second.control(created.id, created.ownerToken, { expectedVersion: 4, controller: 'agent' });
        second.replace(created.id, created.inviteToken, { expectedVersion: 5, artifact: artifact('baf-agent-2') });
        second.control(created.id, created.ownerToken, { expectedVersion: 6, controller: 'owner' });
        expect(second.replace(created.id, created.ownerToken, { expectedVersion: 7, artifact: artifact('baf-owner') }).canUndo).toBe(false);
        second.dispose();
    });
    it('collapses member revision chains into a durable receipt and reverses them on undo', () => {
        const directory = mkdtempSync(join(tmpdir(), 'shared-plans-')); directories.push(directory);
        const old = { ...artifact('baf-old-plan'), designs: [{ cid: 'old', content: {} }, { cid: 'removed', content: {} }] };
        const revised = { ...artifact('baf-new-plan'), designs: [{ cid: 'new', content: {} }, { cid: 'added', content: {} }] };
        const first = sessions(directory), created = first.create(old);
        first.subscribe(created.id, created.ownerToken, () => { throw new Error('broken subscriber'); });
        first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const edit = first.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: revised, changes: [
            { beforeCid: 'old', afterCid: 'middle', type: 'edit' }, { beforeCid: 'middle', afterCid: 'new', type: 'edit', ref: 'design:old' }
        ] });
        expect(edit.lastChange.members).toEqual([{ beforeCid: 'old', afterCid: 'new', ref: 'design:old', type: 'edit' }, { beforeCid: 'removed' }, { afterCid: 'added' }]);
        expect(() => first.undo(created.id, created.ownerToken, { expectedVersion: 2 })).toThrow(expect.objectContaining({ code: 'shared-plan-control-required' }));
        first.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' }); first.dispose();
        const second = sessions(directory);
        expect(second.inspect(created.id, created.ownerToken).lastChange).toEqual(edit.lastChange);
        const undone = second.undo(created.id, created.ownerToken, { expectedVersion: 3 });
        expect(undone.artifact).toEqual(old);
        expect(undone.lastChange.members).toEqual([{ beforeCid: 'new', afterCid: 'old', ref: 'design:old', type: 'edit' }, { beforeCid: 'added' }, { afterCid: 'removed' }]);
        second.dispose();
    });
    it('refuses capacity growth without changing the committed session and holds one writer lock', () => {
        const directory = mkdtempSync(join(tmpdir(), 'shared-plans-')); directories.push(directory);
        const store = createSharedPlanSessions({ directory, maxEntries: 1, validateArtifact: value => {
            if (!value?.cid) throw new Error('invalid artifact');
        } });
        const created = store.create(artifact('baf-first'));
        expect(() => createSharedPlanSessions({ directory, validateArtifact: () => {} })).toThrow(/active writer/i);
        expect(() => store.create(artifact('baf-second'))).toThrow(expect.objectContaining({ code: 'shared-plan-capacity', status: 503 }));
        expect(store.inspect(created.id, created.ownerToken)).toMatchObject({ version: 0, cid: 'baf-first' });
        store.dispose();
    });
});
