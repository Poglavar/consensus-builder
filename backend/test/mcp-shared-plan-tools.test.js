import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createSharedPlanMcpTools } from '../agents/mcp-shared-plan-tools.js';

const cleanup = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const revision = cid => ({ cid, plan: { schema: 'plan/v1', title: cid }, designs: [] });
function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'shared-plan-race-'));
    const store = createSharedPlanSessions({ directory, validateArtifact: value => {
        if (!value?.cid || !value.plan || !Array.isArray(value.designs)) throw new Error('Invalid test artifact');
    } });
    cleanup.push(() => { store.dispose(); rmSync(directory, { recursive: true, force: true }); });
    const created = store.create(revision('initial'));
    store.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
    const pending = [];
    const actions = { editPlan: () => new Promise(resolve => pending.push(resolve)) };
    const tools = createSharedPlanMcpTools({ actions, sharedPlans: store });
    const edit = () => tools.editSharedPlan({ sessionId: created.id, capability: created.inviteToken,
        expectedVersion: 1, expectedCid: 'initial', title: 'Edited' });
    return { store, created, pending, edit };
}

describe('shared plan asynchronous commit', () => {
    it('rejects an edit that was authorized when it started but finishes after human takeover', async () => {
        const { store, created, pending, edit } = setup();
        const task = edit();
        expect(pending).toHaveLength(1);
        const owner = store.control(created.id, created.ownerToken, { expectedVersion: 1, controller: 'owner' });
        pending[0](revision('late-agent'));
        await expect(task).rejects.toMatchObject({ code: 'shared-plan-version-conflict', status: 409 });
        expect(store.inspect(created.id, created.ownerToken)).toEqual(owner);
    });

    it('accepts only one of two edits computed from the same inspected version', async () => {
        const { store, created, pending, edit } = setup();
        const first = edit(), second = edit();
        expect(pending).toHaveLength(2);
        pending[0](revision('first-edit'));
        await expect(first).resolves.toMatchObject({ cid: 'first-edit', version: 2 });
        pending[1](revision('second-edit'));
        await expect(second).rejects.toMatchObject({ code: 'shared-plan-version-conflict' });
        expect(store.inspect(created.id, created.inviteToken)).toMatchObject({ cid: 'first-edit', version: 2 });
    });
});
