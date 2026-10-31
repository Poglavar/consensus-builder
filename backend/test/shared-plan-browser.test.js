import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const SharedPlanSession = require('../../frontend/js/shared-plan-session.js');

function browser({ search = '', replies = [], stored = {}, plans = [] } = {}) {
    const values = new Map(), calls = [];
    const win = {
        location: { search, origin: 'https://urbangametheory.xyz' },
        resolveFrontendBaseUrl: () => 'https://urbangametheory.xyz',
        BrowserWorkspace: { id: 'workspace-test' },
        PersistentStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), ensureReady: callback => callback() },
        SharedPlanEvents: { connect: vi.fn(() => ({ close: vi.fn() })) },
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
    it.each(['https://receiver.invalid', 'http://127.0.0.1:3097', 'not a URL'])('ignores a hosted-page MCP override %s for private content and owner reads', async target => {
        const created = { id: 'session-a', ownerToken: 'owner-secret', version: 0 };
        const fixture = browser({ search: `?mcp=${encodeURIComponent(target)}`, replies: [created, created] });
        const client = fixture.api.client();
        await client.create(row); await client.read(created.id);
        expect(fixture.calls.map(call => new URL(call.url).origin)).toEqual(['https://urbangametheory.xyz', 'https://urbangametheory.xyz']);
        expect(fixture.calls[0].options.body).toContain('Park');
        expect(fixture.calls[1].options.headers.Authorization).toBe('Bearer owner-secret');
        expect(fixture.calls.every(call => call.options.redirect === 'error')).toBe(true);
    });
    it.each(['https://receiver.invalid', 'https://localhost.receiver.invalid', 'http://user:pass@localhost', 'file:///tmp/socket', 'http://localhost/path'])('refuses unsafe local overrides %s before sending content', target => {
        const fixture = browser({ search: `?mcp=${encodeURIComponent(target)}` });
        fixture.win.location.origin = 'http://localhost:5937';
        expect(() => fixture.api.client()).toThrow(/loopback HTTP origin/);
        expect(fixture.win.fetch).not.toHaveBeenCalled();
    });
    it.each([false, true])('shows the result of an actual dialog save, including failures (%s)', async failure => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const original = structuredClone(row);
        const changed = { ...original, cid: 'changed-plan', content: { ...original.content, title: 'Changed' } };
        const server = { id: 'session-a', version: 2, controller: 'owner', artifact: { plan: original.content, designs: original.designs } };
        let finish;
        const saving = new Promise(resolve => { finish = resolve; });
        const fixture = browser({ plans: [original], replies: [server, { ok: !failure, status: failure ? 503 : 200, data: saving }], stored: {
            [`${prefix}active`]: { id: server.id, cid: original.cid, memberIds: original.memberIds },
            [`${prefix}plan:${original.cid}`]: server.id,
            [`${prefix}${server.id}`]: { ownerToken: 'owner-secret', controller: 'owner', version: 2 }
        } });
        fixture.win.BusyControl = require('../../frontend/js/ui/busy-control.js');
        fixture.win.proposalStorage = { getAllProposals: () => [{ proposalId: 'bench-local', cid: 'design-cid', applied: true }] };
        fixture.win.PlanComposition.create = () => changed;
        fixture.win.DesignSync = { copyLink: vi.fn(async () => true) };
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = fixture.api.mount({ row: original, host }); await mounted.ready;
        const button = name => [...host.querySelectorAll('button')].find(el => el.textContent === name);
        expect(host.textContent).toContain('Your local changes have not been saved');
        button('Save to shared plan').click();
        await vi.waitFor(() => expect(fixture.calls.some(call => call.options.method === 'PUT')).toBe(true));
        expect(button('Save to shared plan').getAttribute('aria-busy')).toBe('true');
        expect([...host.querySelectorAll('button')].every(el => el.disabled)).toBe(true);
        const accepted = { ...server, version: 3, artifact: { plan: changed.content, designs: changed.designs } };
        finish(failure ? { message: 'Storage is unavailable' } : accepted);
        await vi.waitFor(() => expect(host.querySelector('[aria-busy]')).toBe(null));
        expect(fixture.calls.find(call => call.options.method === 'PUT').options.body).toContain('Changed');
        if (failure) {
            expect(host.querySelector('[role="alert"]').textContent).toBe('Storage is unavailable');
            expect(button('Save to shared plan').disabled).toBe(false);
            expect(JSON.parse(fixture.values.get(`${prefix}active`)).localCid).toBe(changed.cid);
            fixture.win.fetch.mockResolvedValueOnce({ ok: true, json: async () => server });
            await fixture.api.resumeActive();
            expect(host.querySelector('[role="alert"]').textContent).toBe('Storage is unavailable');
        } else {
            expect(host.textContent).toContain('All changes are saved');
            expect(button('Save to shared plan').disabled).toBe(true);
            expect(JSON.parse(fixture.values.get(`${prefix}active`))).toMatchObject({ cid: changed.cid });
            expect(JSON.parse(fixture.values.get(`${prefix}active`)).localCid).toBeUndefined();
            button('Copy invitation').click();
            await vi.waitFor(() => expect(host.textContent).toContain('Invitation copied.'));
        }
        mounted.dispose();
    });

    it.each([['shared-plan-expired', false], ['shared-plan-not-found', false], ['shared-plan-expired', true], ['shared-plan-not-found', true]])('releases the local editing lock after %s (live=%s)', async (code, live) => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const accepted = { id: 'expired', version: 1, controller: 'agent', artifact: { plan: row.content, designs: row.designs } };
        const fixture = browser({ plans: [row], replies: [...(live ? [accepted] : []), { ok: false, status: code === 'shared-plan-expired' ? 410 : 404, data: { code, message: 'Session expired' } }], stored: {
            [`${prefix}active`]: { id: 'expired', cid: row.cid, memberIds: row.memberIds },
            [`${prefix}plan:${row.cid}`]: 'expired',
            [`${prefix}expired`]: { ownerToken: 'owner-secret', controller: 'agent', designCids: row.content.designCids, memberIds: row.memberIds }
        } });
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = fixture.api.mount({ row, host }); await mounted.ready;
        if (live) {
            expect(fixture.api.editBlocked({ cid: 'design-cid' })).toBe(true);
            const callbacks = fixture.win.SharedPlanEvents.connect.mock.calls[0][0];
            callbacks.onStatus('unavailable', { status: code === 'shared-plan-expired' ? 410 : 404 });
        }
        await vi.waitFor(() => expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Collaborate']));
        expect(host.querySelector('[role="alert"]').textContent).toBe('Session expired');
        expect(fixture.api.editBlocked({ cid: 'design-cid' })).toBe(false);
        expect(fixture.values.has(`${prefix}active`)).toBe(false);
        expect(fixture.values.has(`${prefix}expired`)).toBe(false);
        expect(fixture.win.NamedPlans.list()).toEqual([row]);
        mounted.dispose();
    });
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

    it('shows real activity without polling and reconnects after page lifecycle changes', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const server = { id: 'session-a', version: 2, controller: 'agent', artifact: { plan: row.content, designs: row.designs } };
        const f = browser({ plans: [row], replies: [server], stored: {
            [`${prefix}active`]: { id: server.id, cid: row.cid, memberIds: row.memberIds },
            [`${prefix}plan:${row.cid}`]: server.id,
            [`${prefix}${server.id}`]: { ownerToken: 'owner-secret', controller: 'agent', version: 2 }
        } });
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = f.api.mount({ row, host }); await mounted.ready;
        const connection = f.win.SharedPlanEvents.connect.mock.calls[0][0];
        const state = { id: server.id, version: 2, cid: row.cid, controller: 'agent', activity: { agentEditing: true } };
        f.win.document = doc;
        connection.onStatus('reconnecting');
        expect(doc.querySelector('.shared-plan-live').textContent).toContain('Reconnecting');
        connection.onStatus('connected');
        expect(doc.querySelector('.shared-plan-live').textContent).toBe('');
        connection.onState(state); expect(host.textContent).toContain('The agent is working on a change');
        connection.onState({ ...state, activity: { agentEditing: false } });
        expect(host.textContent).toContain('Waiting for its next change');
        expect(f.win.fetch).toHaveBeenCalledTimes(1); expect(f.win.setInterval).not.toHaveBeenCalled();
        const lifecycle = Object.fromEntries(f.win.addEventListener.mock.calls);
        lifecycle.pagehide(); expect(f.win.SharedPlanEvents.connect.mock.results[0].value.close).toHaveBeenCalledOnce();
        lifecycle.pageshow(); expect(f.win.SharedPlanEvents.connect).toHaveBeenCalledTimes(2);
        mounted.dispose();
    });
    it('coalesces notifications during a map swap and ignores a duplicate accepted revision', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const server = (version, title) => ({ id: 'session-a', version, controller: 'agent', artifact: { plan: { ...row.content, title }, designs: row.designs } });
        const f = browser({ plans: [row], replies: [server(1, 'Park'), server(2, 'Second'), server(4, 'Fourth')], stored: {
            [`${prefix}active`]: { id: 'session-a', cid: row.cid, memberIds: row.memberIds },
            [`${prefix}session-a`]: { ownerToken: 'owner-secret', controller: 'agent', version: 1 }
        } });
        f.win.Cid.cidOfObject = value => value.title === 'Park' ? row.cid : value.title;
        let release; f.win.PlanDialog.syncSharedPlanOnMap.mockImplementationOnce(next => new Promise(resolve => { release = () => { f.win.PlanWorkspace.save(next); resolve(); }; }))
            .mockImplementation(async next => { f.win.PlanWorkspace.save(next); });
        await f.api.start(); const connection = f.win.SharedPlanEvents.connect.mock.calls[0][0];
        const state = (version, cid) => ({ id: 'session-a', version, cid, controller: 'agent', activity: { agentEditing: false } });
        connection.onState(state(2, 'Second')); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        connection.onState(state(3, 'Third')); connection.onState(state(4, 'Fourth')); release();
        await vi.waitFor(() => expect(JSON.parse(f.values.get(`${prefix}active`)).cid).toBe('Fourth'));
        expect(f.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledTimes(2);
        expect(f.win.fetch).toHaveBeenCalledTimes(3);
        connection.onState(state(4, 'Fourth')); await Promise.resolve();
        expect(f.win.fetch).toHaveBeenCalledTimes(3); expect(f.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledTimes(2);
    });
    it('applies the unseen agent revision after the owner takes control', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const initial = { id: 'session-a', version: 1, controller: 'agent', artifact: { plan: row.content, designs: row.designs } };
        const taken = { ...initial, version: 3, controller: 'owner', artifact: { plan: { ...row.content, title: 'Changed' }, designs: row.designs } };
        const f = browser({ plans: [row], replies: [initial, taken, taken], stored: {
            [`${prefix}active`]: { id: initial.id, cid: row.cid, memberIds: row.memberIds }, [`${prefix}plan:${row.cid}`]: initial.id,
            [`${prefix}${initial.id}`]: { ownerToken: 'owner-secret', controller: 'agent', version: 1 }
        } });
        f.win.BusyControl = require('../../frontend/js/ui/busy-control.js');
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = f.api.mount({ row, host }); await mounted.ready;
        [...host.querySelectorAll('button')].find(el => el.textContent === 'Take control').click();
        await vi.waitFor(() => expect(f.calls.some(call => call.url.endsWith('/control'))).toBe(true));
        await vi.waitFor(() => expect(mounted.session.controller).toBe('owner'));
        const event = f.win.SharedPlanEvents.connect.mock.calls[0][0];
        event.onState({ id: initial.id, version: 3, cid: 'changed-plan', controller: 'owner', activity: { agentEditing: false } });
        await vi.waitFor(() => expect(JSON.parse(f.values.get(`${prefix}active`)).cid).toBe('changed-plan'));
        expect(f.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledOnce();
        expect(JSON.parse(f.calls.find(call => call.url.endsWith('/control')).options.body)).toMatchObject({ expectedVersion: 1, controller: 'owner' });
        mounted.dispose();
    });
    it.each([false, true])('applies an unseen owner-controlled revision unless local changes conflict (%s)', async conflict => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const local = { ...row, cid: 'local-plan', content: { ...row.content, title: 'Local' } };
        const latest = { id: 'session-a', version: 3, controller: 'owner', artifact: { plan: { ...row.content, title: 'Changed' }, designs: row.designs } };
        const f = browser({ plans: conflict ? [row, local] : [row], replies: [latest], stored: {
            [`${prefix}active`]: { id: 'session-a', cid: row.cid, memberIds: row.memberIds, ...(conflict ? { localCid: local.cid } : {}) },
            [`${prefix}session-a`]: { ownerToken: 'owner-secret', controller: 'agent', version: 1 }
        } });
        await f.api.resumeActive();
        expect(f.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledTimes(conflict ? 0 : 1);
        expect(JSON.parse(f.values.get(`${prefix}active`)).cid).toBe(conflict ? row.cid : 'changed-plan');
        if (conflict) expect(f.win.dispatchEvent.mock.calls.some(([event]) => event.type === 'sharedplansessionconflict')).toBe(true);
    });
    it('uses a busy undo action with the current version and applies the accepted pointer', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const original = { ...row, cid: 'changed-plan', content: { ...row.content, title: 'Changed' } };
        const server = { id: 'session-a', version: 4, controller: 'owner', canUndo: true, artifact: { plan: original.content, designs: original.designs } };
        const undone = { ...server, version: 5, canUndo: false, artifact: { plan: row.content, designs: row.designs } };
        let finish; const wait = new Promise(resolve => { finish = resolve; });
        const f = browser({ plans: [original], replies: [server, { data: wait }, undone], stored: {
            [`${prefix}active`]: { id: server.id, cid: original.cid, memberIds: original.memberIds }, [`${prefix}plan:${original.cid}`]: server.id,
            [`${prefix}${server.id}`]: { ownerToken: 'owner-secret', controller: 'owner', version: 4 }
        } });
        f.win.BusyControl = require('../../frontend/js/ui/busy-control.js');
        f.win.proposalStorage = { getAllProposals: () => [{ proposalId: 'bench-local', cid: 'design-cid', applied: true }] };
        f.win.PlanComposition.create = () => original;
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = f.api.mount({ row: original, host }); await mounted.ready;
        const button = [...host.querySelectorAll('button')].find(el => el.textContent === 'Undo last agent change');
        expect(button.disabled).toBe(false); button.click();
        await vi.waitFor(() => expect(f.calls.some(call => call.url.endsWith('/undo'))).toBe(true));
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(JSON.parse(f.calls.find(call => call.url.endsWith('/undo')).options.body)).toEqual({ expectedVersion: 4 });
        expect(JSON.parse(f.values.get(`${prefix}active`)).cid).toBe('changed-plan');
        finish(undone);
        await vi.waitFor(() => expect(JSON.parse(f.values.get(`${prefix}active`)).cid).toBe(row.cid));
        expect(f.win.PlanDialog.syncSharedPlanOnMap).toHaveBeenCalledOnce(); mounted.dispose();
    });
    it('disables undo while local edits are pending', async () => {
        const prefix = 'ugt.shared-plan-session/v1:https://urbangametheory.xyz:workspace-test:';
        const changed = { ...row, cid: 'changed-plan', content: { ...row.content, title: 'Changed' } };
        const server = { id: 'session-a', version: 4, controller: 'owner', canUndo: true, artifact: { plan: row.content, designs: row.designs } };
        const f = browser({ plans: [row], replies: [server], stored: {
            [`${prefix}active`]: { id: server.id, cid: row.cid, memberIds: row.memberIds }, [`${prefix}plan:${row.cid}`]: server.id,
            [`${prefix}${server.id}`]: { ownerToken: 'owner-secret', controller: 'owner', version: 4 }
        } });
        f.win.proposalStorage = { getAllProposals: () => [{ proposalId: 'bench-local', cid: 'design-cid', applied: true }] };
        f.win.PlanComposition.create = () => changed;
        const doc = makeDocument(), host = doc.createElement('div'); doc.body.append(host);
        const mounted = f.api.mount({ row, host }); await mounted.ready;
        expect([...host.querySelectorAll('button')].find(el => el.textContent === 'Undo last agent change').disabled).toBe(true);
        expect(f.calls.filter(call => call.url.endsWith('/undo'))).toHaveLength(0); mounted.dispose();
    });
    it('allows a loopback MCP origin only on a loopback page without putting capabilities in its URL', () => {
        const fixture = browser({ search: '?mcp=http%3A%2F%2F127.0.0.1%3A3097' });
        fixture.win.location.origin = 'http://localhost:5937';
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
            .toThrow(/agent has editing control/i);
        expect(() => fixture.api.assertMutationAllowed(store, { getProposal: () => null }, { sharedPlanSessionRemote: true })).not.toThrow();
    });
});
