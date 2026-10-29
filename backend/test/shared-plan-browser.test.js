import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const SharedPlanSession = require('../../frontend/js/shared-plan-session.js');

function browser({ search = '', replies = [], stored = {}, plans = [] } = {}) {
    const values = new Map(), calls = [];
    const win = {
        location: { search, origin: 'https://urbangametheory.xyz' },
        resolveFrontendBaseUrl: () => 'https://urbangametheory.xyz',
        BrowserWorkspace: { id: 'workspace-test' },
        PersistentStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), ensureReady: callback => callback() },
        setTimeout: vi.fn(), setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(), dispatchEvent: vi.fn(),
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        Cid: { cidOfObject: value => value.title === 'Park' ? 'plan-cid' : 'changed-plan' },
        PlanComposition: { validate: vi.fn() },
        NamedPlans: { list: () => plans },
        PlanWorkspace: { save: vi.fn(row => { plans.push(row); return row; }) },
        PlanDialog: { syncSharedPlanOnMap: vi.fn(async () => {}) },
        showStyledAlert: vi.fn(),
        DesignRecord: { cidOf: proposal => proposal.cid },
        fetch: vi.fn(async (url, options) => {
            calls.push({ url, options });
            const body = replies.shift() || {};
            return { ok: body.ok !== false, status: body.status || 200, json: async () => body.data || body };
        })
    };
    Object.entries(stored).forEach(([key, value]) => values.set(key, typeof value === 'string' ? value : JSON.stringify(value)));
    return { api: SharedPlanSession.browser(win), calls, values, win };
}

const row = { cid: 'plan-cid', content: { schema: 'plan/v1', title: 'Park', designCids: ['design-cid'] },
    designs: [{ cid: 'design-cid', content: { schema: 'design/v1', title: 'Bench' } }], memberIds: ['bench-local'], designSources: {} };

describe('shared plan browser client', () => {
    it('keeps capabilities in workspace storage and addresses control as a path segment', async () => {
        const created = { id: 'session-a', ownerToken: 'owner-secret', inviteToken: 'invite-secret', version: 1, controller: 'owner', artifact: { plan: row.content, designs: row.designs } };
        const fixture = browser({ replies: [created, { id: 'session-a', version: 2, controller: 'agent', artifact: created.artifact }] });
        const client = fixture.api.client();
        await client.create(row);
        await client.control('session-a', 1, 'agent');
        expect(fixture.calls.map(call => call.url)).toEqual([
            'https://urbangametheory.xyz/mcp/plan-sessions',
            'https://urbangametheory.xyz/mcp/plan-sessions/session-a/control'
        ]);
        expect(fixture.calls[1].options.headers.Authorization).toBe('Bearer owner-secret');
        expect([...fixture.values.values()].join(' ')).toContain('owner-secret');
        expect([...fixture.values.keys()].join(' ')).toContain('workspace-test');
    });

    it('addresses reads and revision saves at their session path', async () => {
        const created = { id: 'session-a', ownerToken: 'owner-secret', version: 1, controller: 'owner', artifact: { plan: row.content, designs: row.designs } };
        const fixture = browser({ replies: [created, created, { ...created, version: 2 }] });
        const client = fixture.api.client();

        await client.create(row);
        await client.read('session-a');
        await client.save('session-a', 1, row);

        expect(fixture.calls.map(call => call.url)).toEqual([
            'https://urbangametheory.xyz/mcp/plan-sessions',
            'https://urbangametheory.xyz/mcp/plan-sessions/session-a',
            'https://urbangametheory.xyz/mcp/plan-sessions/session-a'
        ]);
        expect(fixture.calls[2].options.method).toBe('PUT');
    });

    it('follows the applied ordinary revision chain without absorbing a separate copy', () => {
        const source = { proposalId: 'bench-local', cid: 'design-cid', published: { cid: 'design-cid' }, applied: false };
        const fork = { proposalId: 'fork', cid: 'fork-cid', applied: true,
            proposalOrigin: { relation: 'revision', source: { kind: 'design', cid: 'design-cid' } } };
        const separateCopy = { ...fork, proposalId: 'copy', proposalOrigin: { ...fork.proposalOrigin, relation: 'copy' } };
        expect(SharedPlanSession.currentMembers(row, [source, fork, separateCopy], { DesignRecord: { cidOf: record => record.cid } }))
            .toEqual([fork]);
        expect(() => SharedPlanSession.currentMembers(row, [source, fork, { ...fork, proposalId: 'fork-2' }], {}))
            .toThrow(/More than one local revision/);
    });

    it('resolves composed temporary member IDs to the exact applied design and rejects ambiguity', () => {
        const composed = { ...row, memberIds: ['plan-member-design-cid'] };
        const actual = { proposalId: 'bench-local', cid: 'design-cid', applied: true };
        const runtime = { DesignRecord: { cidOf: record => record.cid } };
        expect(SharedPlanSession.currentMembers(composed, [actual], runtime)).toEqual([actual]);
        expect(() => SharedPlanSession.currentMembers(composed, [actual, { ...actual, proposalId: 'copy' }], runtime))
            .toThrow(/More than one local instance/);
        expect(() => SharedPlanSession.currentMembers(composed, [], runtime)).toThrow(/missing locally/);
    });

    it('keeps ordinary local plan revisions connected through a refresh until explicit shared save', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const server = { id: 'session-a', version: 2, controller: 'owner', artifact: { plan: row.content, designs: row.designs } };
        const fixture = browser({ plans: [row], replies: [server], stored: {
            [`${prefix}active`]: { id: 'session-a', cid: row.cid, memberIds: row.memberIds },
            [`${prefix}session-a`]: { ownerToken: 'owner-secret', controller: 'owner', designCids: row.content.designCids, memberIds: row.memberIds }
        } });
        const revision = { ...row, cid: 'changed-plan', content: { ...row.content, title: 'Changed' } };
        expect(fixture.api.saveLocalRevision(row, revision)).toBe(true);
        expect(fixture.win.fetch).not.toHaveBeenCalled();
        await fixture.api.resumeActive();
        expect(JSON.parse(fixture.values.get(`${prefix}active`))).toMatchObject({ cid: row.cid, localCid: revision.cid });
        expect(fixture.values.get(`${prefix}plan:${revision.cid}`)).toBe('session-a');
        expect(fixture.win.PlanDialog.syncSharedPlanOnMap).not.toHaveBeenCalled();
        const capability = JSON.parse(fixture.values.get(`${prefix}session-a`));
        fixture.values.set(`${prefix}session-a`, JSON.stringify({ ...capability, controller: 'agent' }));
        expect(() => fixture.api.saveLocalRevision(revision, row)).toThrow(/Take control/);
    });

    it.each(['in-place', 'fork'])('keeps the local plan attached to a committed %s member edit without saving to the server', mode => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const window = { start: '2027-01', end: '2027-03' };
        const original = { ...row, content: { ...row.content, schedule: { 'design-cid': window } } };
        const source = { proposalId: 'bench-local', cid: 'design-cid', applied: mode !== 'fork' };
        const changed = mode === 'fork'
            ? { proposalId: 'bench-fork', cid: 'edited-design', applied: true,
                proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: 'bench-local' } } }
            : { ...source, cid: 'edited-design' };
        const records = mode === 'fork' ? [source, changed] : [changed];
        records.push({ proposalId: 'unrelated', cid: 'unrelated-design', applied: true });
        const fixture = browser({ plans: [original], stored: {
            [`${prefix}active`]: { id: 'session-a', cid: original.cid, memberIds: original.memberIds },
            [`${prefix}session-a`]: { ownerToken: 'owner-secret', controller: 'owner', version: 4 }
        } });
        fixture.win.proposalStorage = { getAllProposals: () => records };
        fixture.win.PlanComposition.create = (title, members, view, schedule) => ({
            cid: 'edited-plan', content: { ...original.content, title, view, designCids: members.map(member => member.cid), schedule },
            designs: members.map(member => ({ cid: member.cid, content: { title: 'Edited bench' } })),
            memberIds: members.map(member => member.proposalId), designSources: {}
        });
        const next = fixture.api.captureLocalRevision();
        expect(next.content.designCids).toEqual(['edited-design']);
        expect(next.memberIds).toEqual([changed.proposalId]);
        expect(next.content.schedule).toEqual({ 'edited-design': window });
        expect(original.content.designCids).toEqual(['design-cid']);
        expect(JSON.parse(fixture.values.get(`${prefix}active`))).toMatchObject({ cid: original.cid, localCid: next.cid });
        expect(fixture.values.get(`${prefix}plan:${next.cid}`)).toBe('session-a');
        expect(fixture.win.fetch).not.toHaveBeenCalled();
        fixture.api.captureLocalRevision();
        expect(fixture.win.PlanWorkspace.save).toHaveBeenCalledTimes(1);
        fixture.values.set(`${prefix}session-a`, JSON.stringify({ ownerToken: 'owner-secret', controller: 'agent', version: 5 }));
        fixture.api.captureLocalRevision();
        expect(fixture.win.PlanWorkspace.save).toHaveBeenCalledTimes(1);
    });

    it('does not request or poll when this workspace has no active shared session', async () => {
        const fixture = browser();
        await fixture.api.start();
        expect(fixture.win.fetch).not.toHaveBeenCalled();
        expect(fixture.win.setInterval).not.toHaveBeenCalled();
    });

    it('advances the accepted pointer only after the map swap succeeds, and permits retry after failure', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const next = { id: 'session-a', version: 3, controller: 'agent',
            artifact: { plan: { ...row.content, title: 'Changed' }, designs: row.designs } };
        const fixture = browser({ plans: [row], replies: [next, next], stored: {
            [`${prefix}active`]: { id: 'session-a', cid: row.cid, memberIds: row.memberIds },
            [`${prefix}session-a`]: { ownerToken: 'owner-secret', controller: 'agent', designCids: row.content.designCids, memberIds: row.memberIds }
        } });
        let rejectSwap;
        fixture.win.PlanDialog.syncSharedPlanOnMap.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSwap = reject; }));
        const first = fixture.api.resumeActive();
        await vi.waitFor(() => expect(rejectSwap).toBeTypeOf('function'));
        expect(JSON.parse(fixture.values.get(`${prefix}active`)).cid).toBe(row.cid);
        rejectSwap(new Error('Ground unavailable'));
        await first;
        expect(JSON.parse(fixture.values.get(`${prefix}active`)).cid).toBe(row.cid);
        expect(fixture.win.showStyledAlert).toHaveBeenCalledTimes(1);
        await fixture.api.resumeActive();
        expect(fixture.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fixture.values.get(`${prefix}active`)).cid).toBe('changed-plan');
    });

    it('uses an explicit MCP origin without putting a capability in the URL', () => {
        const fixture = browser({ search: '?mcp=http%3A%2F%2F127.0.0.1%3A3097' });
        expect(fixture.api.endpoint()).toBe('http://127.0.0.1:3097/mcp/plan-sessions');
        expect(fixture.api.invitation({ id: 's', inviteToken: 'private-invite' }, fixture.api.endpoint())).toContain('"inviteToken"');
        expect(fixture.api.endpoint()).not.toContain('private-invite');
    });

    it('transports a parcel source as a string while restoring browser source objects', () => {
        const fixture = browser();
        const artifact = fixture.api.artifactOf({ ...row, designSources: { 'design-cid': { sourceId: 'fixture-source', snapshotId: 'ignored' } } });
        expect(artifact.designs[0].parcelSourceId).toBe('fixture-source');
        expect(fixture.api.rowOf(artifact).designSources).toEqual({ 'design-cid': { sourceId: 'fixture-source', snapshotId: null } });
    });

    it('sets the persisted agent gate before a reload refresh finishes and rejects only changed connected members', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const current = { id: 'session-a', ownerToken: 'owner-secret', controller: 'agent', designCids: ['design-cid'], memberIds: ['bench-local'] };
        const fixture = browser({
            stored: { [`${prefix}active`]: { id: 'session-a', cid: 'plan-cid', memberIds: ['bench-local'] }, [`${prefix}session-a`]: current },
            plans: [row],
            replies: [{ data: pending }]
        });
        const reloading = fixture.api.resumeActive();
        expect(fixture.api.editBlocked({ cid: 'design-cid' })).toBe(true);
        release({ id: 'session-a', version: 2, controller: 'agent', artifact: { plan: row.content, designs: row.designs } });
        await reloading;

        const original = { proposalId: 'bench-local', cid: 'design-cid', applied: true };
        const store = { getProposal: vi.fn(id => id === 'bench-local' ? original : null) };
        expect(() => fixture.api.assertMutationAllowed(store, { getProposal: store.getProposal }, {})).not.toThrow();
        expect(() => fixture.api.assertMutationAllowed(store, { getProposal: () => ({ ...original, applied: false }) }, {}))
            .toThrow(/agent is editing/i);
        expect(() => fixture.api.assertMutationAllowed(store, { getProposal: () => null }, { sharedPlanSessionRemote: true })).not.toThrow();
    });
});
