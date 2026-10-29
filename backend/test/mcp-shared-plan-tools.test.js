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
    const pending = [], failures = [];
    const actions = { editPlan: () => new Promise((resolve, reject) => { pending.push(resolve); failures.push(reject); }) };
    const tools = createSharedPlanMcpTools({ actions, sharedPlans: store });
    const edit = () => tools.editSharedPlan({ sessionId: created.id, capability: created.inviteToken,
        expectedVersion: 1, expectedCid: 'initial', title: 'Edited' });
    return { store, created, pending, failures, edit };
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

    it('announces actual activity and supports MCP undo of an accepted edit', async () => {
        const { store, created, pending, edit } = setup();
        const states = []; const off = store.subscribe(created.id, created.ownerToken, () => states.push(store.eventState(created.id, created.ownerToken)));
        expect(store.eventState(created.id, created.ownerToken).activity.agentEditing).toBe(false);
        const task = edit(); expect(states.at(-1).activity.agentEditing).toBe(true);
        pending[0](revision('edited')); await task;
        expect(states.at(-1)).toMatchObject({ cid: 'edited', activity: { agentEditing: false } });
        const tools = createSharedPlanMcpTools({ actions: {}, sharedPlans: store });
        const undone = await tools.editSharedPlan({ sessionId: created.id, capability: created.inviteToken, expectedVersion: 2, expectedCid: 'edited', undoLastAgentChange: true });
        expect(undone).toMatchObject({ cid: 'initial', version: 3, canUndo: false, lastChange: { kind: 'undo' } }); off();
    });
    it('allows the owner capability to edit through MCP without announcing agent activity', async () => {
        const { store, created } = setup();
        store.control(created.id, created.ownerToken, { expectedVersion: 1, controller: 'owner' });
        const seen = []; const off = store.subscribe(created.id, created.ownerToken, () => seen.push(store.eventState(created.id, created.ownerToken)));
        const tools = createSharedPlanMcpTools({ actions: { editPlan: async () => revision('owner-edit') }, sharedPlans: store });
        await expect(tools.editSharedPlan({ sessionId: created.id, capability: created.ownerToken, expectedVersion: 2, expectedCid: 'initial', title: 'Owner edit' })).resolves.toMatchObject({ cid: 'owner-edit', lastChange: { actor: 'owner' } });
        expect(seen.every(state => !state.activity.agentEditing)).toBe(true); off();
    });
    it('keeps activity visible until every concurrent operation has finished or been superseded', async () => {
        const { store, created, pending, failures, edit } = setup();
        const first = edit(), second = edit();
        failures[1](new Error('failed')); await expect(second).rejects.toThrow('failed');
        expect(store.eventState(created.id, created.ownerToken)).toMatchObject({ version: 1, cid: 'initial', activity: { agentEditing: true } });
        failures[0](new Error('failed too')); await expect(first).rejects.toThrow('failed too');
        expect(store.eventState(created.id, created.ownerToken)).toMatchObject({ version: 1, cid: 'initial', activity: { agentEditing: false } });
        const late = edit(); store.control(created.id, created.ownerToken, { expectedVersion: 1, controller: 'owner' });
        expect(store.eventState(created.id, created.ownerToken).activity.agentEditing).toBe(false);
        pending[2](revision('late')); await expect(late).rejects.toMatchObject({ code: 'shared-plan-version-conflict' });
        expect(store.eventState(created.id, created.ownerToken).activity.agentEditing).toBe(false);
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
