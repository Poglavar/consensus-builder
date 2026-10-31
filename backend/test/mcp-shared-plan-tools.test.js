import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createSharedPlanMcpTools } from '../agents/mcp-shared-plan-tools.js';
import { createMemorySharedPlanRepository } from './helpers/shared-plan-repository.js';

const cleanup = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
const revision = cid => ({ cid, plan: { schema: 'plan/v1', title: cid }, designs: [] });
function setup() {
    const store = createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: value => {
        if (!value?.cid || !value.plan || !Array.isArray(value.designs)) throw new Error('Invalid test artifact');
    } });
    cleanup.push(() => store.dispose());
    const created = store.create(revision('initial'));
    const pending = [], failures = [];
    const actions = { editPlan: () => new Promise((resolve, reject) => { pending.push(resolve); failures.push(reject); }) };
    const tools = createSharedPlanMcpTools({ actions, sharedPlans: store });
    const edit = async () => {
        const session = await created;
        return tools.editSharedPlan({ sessionId: session.id, capability: session.inviteToken,
            expectedVersion: 1, expectedCid: 'initial', title: 'Edited' });
    };
    return { store, created, pending, failures, edit };
}

describe('shared plan asynchronous commit', () => {
    it('keeps failed publication retries on the approved shared-session path', async () => {
        const { store, created } = setup(), session = await created;
        await store.approvePublication(session.id, session.ownerToken, { expectedVersion: 0, expectedCid: 'initial', approve: true });
        const error = Object.assign(new Error('Readback failed'), { code: 'publication-failed', publishedCids: ['initial'], next: { arguments: { plan: 'copied-artifact' } } });
        const tools = createSharedPlanMcpTools({ actions: { publishPlan: async () => { throw error; } }, sharedPlans: store });
        await expect(tools.publishSharedPlan({ sharedSession: { sessionId: session.id, capability: session.inviteToken }, expectedVersion: 1, expectedCid: 'initial', confirm: true }))
            .rejects.toMatchObject({ code: 'publication-failed', publishedCids: ['initial'], next: { tool: 'ugt_publish_plan', action: expect.stringContaining('sharedSession') } });
        expect(error.next).not.toHaveProperty('arguments');
        await store.dispose();
    });

    it('publishes only the server-approved artifact and keeps approval usable for an idempotent retry', async () => {
        const { store, created } = setup(), session = await created;
        const publishPlan = vi.fn(async args => ({ cid: args.expectedCid, publication: 'published' }));
        const tools = createSharedPlanMcpTools({ actions: { publishPlan }, sharedPlans: store });
        const args = { sharedSession: { sessionId: session.id, capability: session.inviteToken }, expectedVersion: 0, expectedCid: 'initial', confirm: true };
        await expect(tools.publishSharedPlan(args)).rejects.toMatchObject({ code: 'shared-plan-publication-approval-required' });
        expect(publishPlan).not.toHaveBeenCalled();
        await store.approvePublication(session.id, session.ownerToken, { expectedVersion: 0, expectedCid: 'initial', approve: true });
        await expect(tools.publishSharedPlan({ ...args, expectedVersion: 1, confirm: false })).rejects.toMatchObject({ code: 'confirmation-required' });
        await expect(tools.publishSharedPlan({ ...args, expectedVersion: 1, expectedCid: 'forged' })).rejects.toMatchObject({ code: 'shared-plan-revision-mismatch' });
        for (let i = 0; i < 2; i++) await expect(tools.publishSharedPlan({ ...args, expectedVersion: 1 })).resolves.toMatchObject({ cid: 'initial', publication: 'published' });
        expect(publishPlan).toHaveBeenCalledTimes(2);
        expect(publishPlan.mock.calls[0][0]).toEqual({ plan: revision('initial'), expectedCid: 'initial', confirm: true });
        await store.approvePublication(session.id, session.ownerToken, { approve: false });
        await expect(tools.publishSharedPlan({ ...args, expectedVersion: 2 })).rejects.toMatchObject({ code: 'shared-plan-publication-approval-required' });
        expect(publishPlan).toHaveBeenCalledTimes(2);
    });
    it('publishes the approved snapshot even if a later edit changes the session after publication starts', async () => {
        const { store, created } = setup(), session = await created;
        await store.approvePublication(session.id, session.ownerToken, { expectedVersion: 0, expectedCid: 'initial', approve: true });
        let finish;
        const publishPlan = vi.fn(args => new Promise(resolve => { finish = () => resolve({ cid: args.expectedCid }); }));
        const tools = createSharedPlanMcpTools({ actions: { publishPlan }, sharedPlans: store });
        const running = tools.publishSharedPlan({ sharedSession: { sessionId: session.id, capability: session.inviteToken }, expectedVersion: 1, expectedCid: 'initial', confirm: true });
        await vi.waitFor(() => expect(publishPlan).toHaveBeenCalledOnce());
        await store.replace(session.id, session.ownerToken, { expectedVersion: 1, artifact: revision('later') });
        finish(); expect(await running).toEqual({ cid: 'initial' });
        expect(publishPlan.mock.calls[0][0].plan).toEqual(revision('initial'));
        expect((await store.inspect(session.id, session.ownerToken)).publicationApproval).toBeNull();
    });
    it('rejects an edit that was authorized when it started but finishes after human takeover', async () => {
        const { store, created, pending, edit } = setup();
        const session = await created;
        await store.control(session.id, session.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const task = edit();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        const owner = await store.control(session.id, session.ownerToken, { expectedVersion: 1, controller: 'owner' });
        pending[0](revision('late-agent'));
        await expect(task).rejects.toMatchObject({ code: 'shared-plan-version-conflict', status: 409 });
        expect(await store.inspect(session.id, session.ownerToken)).toEqual(owner);
    });

    it('announces actual activity and supports MCP undo of an accepted edit', async () => {
        const { store, created, pending, edit } = setup();
        const session = await created;
        await store.control(session.id, session.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const states = []; const off = await store.subscribe(session.id, session.ownerToken, async () => states.push(await store.eventState(session.id, session.ownerToken)));
        expect((await store.eventState(session.id, session.ownerToken)).activity.agentEditing).toBe(false);
        const task = edit(); await vi.waitFor(() => expect(states.at(-1)?.activity.agentEditing).toBe(true));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        pending[0](revision('edited')); await task;
        await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ cid: 'edited', activity: { agentEditing: false } }));
        const tools = createSharedPlanMcpTools({ actions: {}, sharedPlans: store });
        const undone = await tools.editSharedPlan({ sessionId: session.id, capability: session.inviteToken, expectedVersion: 2, expectedCid: 'edited', undoLastAgentChange: true });
        expect(undone).toMatchObject({ cid: 'initial', version: 3, canUndo: false, lastChange: { kind: 'undo' } }); off();
    });
    it('allows the owner capability to edit through MCP without announcing agent activity', async () => {
        const { store, created } = setup();
        const session = await created;
        await store.control(session.id, session.ownerToken, { expectedVersion: 0, controller: 'owner' });
        const seen = []; const off = await store.subscribe(session.id, session.ownerToken, async () => seen.push(await store.eventState(session.id, session.ownerToken)));
        const tools = createSharedPlanMcpTools({ actions: { editPlan: async () => revision('owner-edit') }, sharedPlans: store });
        await expect(tools.editSharedPlan({ sessionId: session.id, capability: session.ownerToken, expectedVersion: 1, expectedCid: 'initial', title: 'Owner edit' })).resolves.toMatchObject({ cid: 'owner-edit', lastChange: { actor: 'owner' } });
        expect(seen.every(state => !state.activity.agentEditing)).toBe(true); off();
    });
    it('keeps activity visible until every concurrent operation has finished or been superseded', async () => {
        const { store, created, pending, failures, edit } = setup();
        const session = await created;
        await store.control(session.id, session.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const first = edit(), second = edit();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        failures[1](new Error('failed')); await expect(second).rejects.toThrow('failed');
        expect(await store.eventState(session.id, session.ownerToken)).toMatchObject({ version: 1, cid: 'initial', activity: { agentEditing: true } });
        failures[0](new Error('failed too')); await expect(first).rejects.toThrow('failed too');
        expect(await store.eventState(session.id, session.ownerToken)).toMatchObject({ version: 1, cid: 'initial', activity: { agentEditing: false } });
        const late = edit(); await vi.waitFor(() => expect(pending).toHaveLength(3)); await store.control(session.id, session.ownerToken, { expectedVersion: 1, controller: 'owner' });
        expect((await store.eventState(session.id, session.ownerToken)).activity.agentEditing).toBe(false);
        pending[2](revision('late')); await expect(late).rejects.toMatchObject({ code: 'shared-plan-version-conflict' });
        expect((await store.eventState(session.id, session.ownerToken)).activity.agentEditing).toBe(false);
    });
    it('accepts only one of two edits computed from the same inspected version', async () => {
        const { store, created, pending, edit } = setup();
        const session = await created;
        await store.control(session.id, session.ownerToken, { expectedVersion: 0, controller: 'agent' });
        const first = edit(), second = edit();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        pending[0](revision('first-edit'));
        await expect(first).resolves.toMatchObject({ cid: 'first-edit', version: 2 });
        pending[1](revision('second-edit'));
        await expect(second).rejects.toMatchObject({ code: 'shared-plan-version-conflict' });
        expect(await store.inspect(session.id, session.inviteToken)).toMatchObject({ cid: 'first-edit', version: 2 });
    });
});
