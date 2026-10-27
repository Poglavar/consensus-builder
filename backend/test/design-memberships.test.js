// Reverse membership sessions and read-only parent inspection: exact revisions, bounded lookup,
// cancellation, and canonical member geometry.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { dictionary, testI18n } from './helpers/i18n.js';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const { localAgreements, localPlans, mergeRows, fetchPage, createSession, inspect, createAgreementScope, mountSection } = require('../../frontend/js/design-memberships.js');
const page = (kind, items = [], nextOffset = null) => Response.json({ [kind]: items, hasMore: nextOffset !== null, nextOffset });

function fixture({ published = true, agreements = [], fetch = vi.fn(async url => page(new URL(url).pathname.slice(1))) } = {}) {
    const win = {
        fetch, location: new URL('https://app.example/?backend=https%3A%2F%2Fapi.example'),
        console: { warn: vi.fn() }, resolveBackendBaseUrl: () => 'https://api.example',
        DesignSync: { publishedCid: proposal => proposal.cid || null },
        AgreementStore: { list: () => agreements },
        NamedPlans: { current: null, link: cid => `https://app.example/plans/${cid}` },
        AgreementSync: { agreementLink: cid => `https://app.example/agreements/${cid}` },
        AgreementPanel: { open: vi.fn() }, showStyledAlert: vi.fn(),
        i18n: testI18n()
    };
    const proposal = { proposalId: 'local-design', ...(published ? { cid: 'design-current' } : {}) };
    return { win, proposal, session: options => createSession(proposal, win, options) };
}

const draft = { id: 'draft-agreement', title: 'Local consultation', designs: [{ proposalId: 'local-design' }] };

describe('design membership sessions', () => {
    it('keeps the loaded browser entry asynchronous on every selection, including a view switch', async () => {
        const f = fixture({ agreements: [draft], published: false });
        const context = { window: f.win, AbortController, AbortSignal, URL, URLSearchParams };
        vm.runInNewContext(readFileSync(new URL('../../frontend/js/design-memberships.js', import.meta.url), 'utf8'), context);
        for (let selection = 0; selection < 2; selection++) {
            const session = await f.win.loadDesignMemberships(f.proposal).then(session => session);
            await session.ready;
            expect(Object.keys(session.groups)).toEqual(['plans']);
            expect(session.instances('plans')).toEqual([]);
            session.dispose();
        }
    });
    it('lists only agreements that reference this exact plan CID', () => {
        const agreements = [
            { id: 'matching', title: 'Same plan', plan: { cid: 'plan-current' }, published: { cid: 'agreement-a' } },
            { id: 'stale', title: 'Old plan', plan: { cid: 'plan-old' }, published: { cid: 'agreement-b' } },
            { id: 'unrelated', title: 'Same designs, different plan', designs: [{ proposalId: 'local-design', cid: 'design-current' }] }
        ];
        expect(localAgreements('plan-current', agreements, row => row.published?.cid || null).map(row => row.localId)).toEqual(['matching']);
        expect(localAgreements('plan-old', agreements, row => row.published?.cid || null).map(row => row.localId)).toEqual(['stale']);
    });

    it('projects local plans from matching plan memberships only', () => {
        const agreement = { id: 'a', designs: [{ proposalId: 'local-design' }], plan: { cid: 'plan-a', content: { title: 'Plan A', designCids: ['design-current'] } } };
        expect(localPlans('local-design', 'design-current', [agreement])).toMatchObject([{ cid: 'plan-a', title: 'Plan A', localDesigns: agreement.designs }]);
        expect(localPlans('different-design', 'design-other', [agreement])).toEqual([]);
    });

    it('keeps membership sessions plans-only and queries public plans by exact design CID', async () => {
        const f = fixture();
        const session = f.session();
        await session.ready;
        expect(Object.keys(session.groups)).toEqual(['plans']);
        const requestUrl = f.win.fetch.mock.calls.find(([url]) => url.includes('/plans?'))[0];
        expect(new URL(requestUrl).searchParams.get('design')).toBe('design-current');
        expect(f.win.fetch.mock.calls.some(([url]) => url.includes('/agreements?'))).toBe(false);
    });

    it('keeps the known plan when the public lookup fails and retries only that list', async () => {
        let plansFail = true;
        const fetch = vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return plansFail ? new Response('', { status: 503 }) : page(kind, [{ cid: `${kind}-one`, title: `${kind} result` }]);
        });
        const f = fixture({ fetch });
        f.win.NamedPlans.current = { cid: 'local-plan', content: { title: 'Known plan', designCids: ['design-current'] } };
        const session = f.session();
        await session.ready;
        expect(session.groups.plans.items.map(row => row.title)).toContain('Known plan');
        expect(session.groups.plans.error).toBe(true);
        plansFail = false;
        await session.load('plans');
        expect(session.groups.plans.items.map(row => row.title)).toContain('plans result');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('uses bounded pages and advances until the server reports the end', async () => {
        const fetch = vi.fn(async url => {
            const query = new URL(url), kind = query.pathname.slice(1), offset = Number(query.searchParams.get('offset'));
            return page(kind,
                Array.from({ length: offset === 0 ? 5 : 2 }, (_, i) => ({ cid: `plan-${offset + i}`, title: `Plan ${offset + i}` })), offset === 0 ? 5 : null);
        });
        const f = fixture({ fetch });
        const session = f.session();
        await session.ready;
        expect(session.groups.plans.items).toHaveLength(5);
        expect(new URL(fetch.mock.calls.find(([url]) => url.includes('/plans?'))[0]).searchParams.get('limit')).toBe('5');
        await session.load('plans');
        expect(session.groups.plans.items).toHaveLength(7);
        expect(session.groups.plans.nextOffset).toBeNull();
        expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('offset') === '5')).toBe(true);
    });

    it('keeps matching local agreement drafts available for an unpublished design', async () => {
        const f = fixture({ published: false, agreements: [draft] });
        const session = f.session();
        await session.ready;
        expect(session.groups.plans.items).toEqual([]);
        expect(f.win.fetch).not.toHaveBeenCalled();
    });

    it('finds independently saved private plans by exact unpublished revision', async () => {
        const f = fixture({ published: false });
        f.win.DesignRecord = { cidOf: () => 'local-revision' };
        f.win.NamedPlans.list = () => [
            { cid: 'matching-plan', content: { title: 'Private park plan', designCids: ['local-revision'] }, designs: [] },
            { cid: 'old-plan', content: { title: 'Older revision', designCids: ['old-revision'] }, designs: [] }
        ];
        const session = f.session();
        await session.ready;
        expect(session.groups.plans.items).toMatchObject([{ cid: 'matching-plan', title: 'Private park plan', draft: true }]);
        expect(f.win.fetch).not.toHaveBeenCalled();
    });

    it('disposes a session so late lookup results cannot write or notify', async () => {
        const pending = [];
        const fetch = vi.fn(url => new Promise(resolve => pending.push({ url, resolve })));
        const onChange = vi.fn();
        const f = fixture({ fetch });
        const session = f.session(onChange);
        await Promise.resolve();
        session.dispose();
        onChange.mockClear();
        for (const row of pending) row.resolve(page(new URL(row.url).pathname.slice(1), [{ cid: 'late', title: 'Late result' }]));
        await session.ready;
        expect(Object.values(session.groups).every(group => group.items.every(item => item.cid !== 'late'))).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps the known current plan visible if its remote lookup fails', async () => {
        const f = fixture({ fetch: vi.fn(async () => new Response('', { status: 503 })) });
        f.win.NamedPlans.current = { cid: 'open-plan', content: { title: 'Open plan', designCids: ['design-current'] } };
        const session = f.session();
        await session.ready;
        expect(session.groups.plans.items[0]).toMatchObject({ cid: 'open-plan', title: 'Open plan' });
        expect(session.groups.plans.error).toBe(true);
    });

    it.each(['en', 'hr', 'sr', 'es'])('uses membership meaning and action labels from %s.json', language => {
        const f = fixture();
        f.win.i18n = testI18n(language);
        const register = vi.spyOn(f.win.i18n, 'registerTranslations');
        f.session();
        for (const key of ['planMeaning', 'agreementMeaning', 'openPlan']) {
            expect(f.win.i18n.t(`designMemberships.${key}`)).toBe(dictionary(language).designMemberships[key]);
        }
        expect(register).not.toHaveBeenCalled();
    });

    it('rejects malformed and nonadvancing pages', async () => {
        for (const payload of [{ plans: [] }, { plans: [], hasMore: true, nextOffset: 0 }]) {
            await expect(fetchPage({ fetch: async () => Response.json(payload), backend: 'https://api.example', kind: 'plans', designCid: 'design-current' }))
                .rejects.toThrow(/Invalid membership/);
        }
    });

    it('queries agreements by exact plan revision and rejects unrelated results', async () => {
        const fetch = vi.fn(async () => page('agreements', [{ cid: 'agreement-one', planCid: 'plan-current' }]));
        const request = { fetch, backend: 'https://api.example', kind: 'agreements', planCid: 'plan-current' };
        expect((await fetchPage(request)).items).toHaveLength(1);
        expect(new URL(fetch.mock.calls[0][0]).searchParams.get('plan')).toBe('plan-current');
        for (const planCid of ['plan-old', undefined]) {
            fetch.mockImplementationOnce(async () => page('agreements', [{ cid: 'agreement-one', planCid }]));
            await expect(fetchPage(request)).rejects.toThrow('different plan revision');
        }
    });
});

describe('read-only parent inspection', () => {
    function inspectionWin({ localCopies = new Map(), downloaded = new Map(), missing = [], plan } = {}) {
        const members = [];
        const win = {
            i18n: testI18n(),
            resolveBackendBaseUrl: () => 'https://api.example',
            NamedPlans: { fetchPlan: vi.fn(async () => ({ content: plan })) },
            AgreementSync: { fetchAgreement: vi.fn(async () => ({ content: plan })) },
            DesignSync: {
                localCopyOf: vi.fn(cid => localCopies.get(cid) || null),
                fetchDesigns: vi.fn(async cids => ({ rows: downloaded, missing })),
                localDesignFromRow: vi.fn((row, meta) => ({ proposalId: `downloaded-${row.cid}`, title: row.title, meta })),
                importDesign: vi.fn(), applyDesign: vi.fn()
            },
            proposalStorage: { getProposal: vi.fn(() => null) },
            collectProposalFeatureSets: vi.fn(proposal => ({ primaryFeatures: proposal.features || [] })),
            __planOrder: { footprintOf: vi.fn() },
            ApplyProposal: { apply: vi.fn() },
            members
        };
        return win;
    }

    it('uses an exact stored revision and collects features for every member without importing or applying', async () => {
        const stored = { proposalId: 'stored-design', title: 'Stored exact revision', features: [{ id: 'stored-footprint' }] };
        const second = { proposalId: 'second-design', title: 'Second exact revision', features: [{ id: 'second-footprint' }] };
        const win = inspectionWin({ localCopies: new Map([['cid-stored', stored], ['cid-second', second]]) });
        const data = await inspect('plans', { id: 'plan-1', cid: 'plan-1', content: { designCids: ['cid-stored', 'cid-second'] } }, win);
        expect(win.DesignSync.localCopyOf).toHaveBeenCalledWith('cid-stored');
        expect(data.members.map(member => member.proposal)).toEqual([stored, second]);
        expect(data.features).toEqual([{ id: 'stored-footprint' }, { id: 'second-footprint' }]);
        expect(win.collectProposalFeatureSets).toHaveBeenCalledTimes(2);
        expect(win.DesignSync.fetchDesigns).not.toHaveBeenCalled();
        expect(win.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(win.DesignSync.applyDesign).not.toHaveBeenCalled();
        expect(win.ApplyProposal.apply).not.toHaveBeenCalled();
    });

    it('builds an uncached exact revision from the canonical downloaded row', async () => {
        const row = { cid: 'canonical-cid', title: 'Canonical server revision', feature: { id: 'geometry' } };
        const win = inspectionWin({ downloaded: new Map([['canonical-cid', row]]), plan: { designCids: ['canonical-cid'] } });
        const data = await inspect('plans', { id: 'plan-1', cid: 'plan-1', content: { designCids: ['canonical-cid'] } }, win);
        expect(win.DesignSync.fetchDesigns).toHaveBeenCalledWith(['canonical-cid']);
        expect(win.DesignSync.localDesignFromRow).toHaveBeenCalledWith(row, { apiBase: 'https://api.example' });
        expect(data.members[0]).toMatchObject({ cid: 'canonical-cid', serverId: 'canonical-cid', label: 'Canonical server revision' });
        expect(data.features).toEqual([]);
        expect(win.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(win.ApplyProposal.apply).not.toHaveBeenCalled();
    });

    it('fails inspection when any referenced member is missing', async () => {
        const win = inspectionWin({ missing: ['missing-cid'] });
        await expect(inspect('plans', { id: 'plan-1', cid: 'plan-1', content: { designCids: ['missing-cid'] } }, win))
            .rejects.toThrow(/Could not load all included designs/);
        expect(win.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(win.ApplyProposal.apply).not.toHaveBeenCalled();
    });

    it('retains an exact unpublished local member without downloading or importing it', async () => {
        const win = inspectionWin();
        const draft = { proposalId: 'local-draft', title: 'Exact draft' };
        win.proposalStorage.getProposal.mockReturnValue(draft);
        win.DesignRecord = { cidOf: vi.fn(() => 'cid-exact') };
        const data = await inspect('plans', { id: 'plan-1', content: { designCids: ['cid-exact'] },
            localDesigns: [{ proposalId: draft.proposalId, cid: 'cid-exact' }] }, win);
        expect(data.members[0].proposal).toBe(draft);
        expect(win.DesignSync.fetchDesigns).not.toHaveBeenCalled();
        expect(win.DesignSync.importDesign).not.toHaveBeenCalled();
    });

    it('does not substitute an edited local record for the plan revision it used to contain', async () => {
        const row = { cid: 'cid-exact', title: 'Original revision' };
        const win = inspectionWin({ downloaded: new Map([['cid-exact', row]]) });
        win.proposalStorage.getProposal.mockReturnValue({ proposalId: 'local-draft', title: 'Edited revision' });
        win.DesignRecord = { cidOf: vi.fn(() => 'cid-edited') };
        const data = await inspect('plans', { id: 'plan-1', content: { designCids: ['cid-exact'] },
            localDesigns: [{ proposalId: 'local-draft', cid: 'cid-exact' }] }, win);
        expect(data.members[0].proposal.title).toBe('Original revision');
        expect(win.DesignSync.fetchDesigns).toHaveBeenCalledWith(['cid-exact']);
        expect(win.DesignSync.importDesign).not.toHaveBeenCalled();
    });

    it('keeps plan actions in place without a navigation or reimport link', async () => {
        const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const f = fixture();
        f.win.i18n.t = key => key === 'designMemberships.planMeaning' ? 'Plan meaning' : key === 'designMemberships.openPlan' ? 'Open plan' : key;
        f.win.ClickStackRelations = { renderGroup: vi.fn(() => doc.createElement('div')) };
        const session = { groups: { plans: { loading: false, error: false, nextOffset: null } }, details: vi.fn(async () => ({ members: [], features: [] })) };
        mountSection(host, 'plans', { id: 'plan-cid', cid: 'plan-cid', label: 'Plan title' }, session, f.win);
        await vi.waitFor(() => expect(host.querySelector('.click-stack__membership-details')).toBeTruthy());
        expect(host.textContent).toContain('Plan meaning');
        expect(host.querySelector('.click-stack__actions').querySelector('a')).toBeNull();
        expect(host.querySelector('.click-stack__share-plan')).toBeTruthy();
    });

    it('scopes agreements to the selected exact plan and refreshes local saves', async () => {
        const agreements = [{ id: 'a1', title: 'First terms', plan: { cid: 'plan-one' } }, { id: 'a2', title: 'Other terms', plan: { cid: 'plan-two' } }];
        const f = fixture({ agreements });
        let changed; f.win.AgreementStore.subscribe = fn => { changed = fn; return vi.fn(); };
        let plan = { cid: 'plan-one', draft: true };
        const updates = vi.fn(), scope = createAgreementScope(f.win, { getPlan: () => plan, onChange: updates });
        scope.sync(); await vi.waitFor(() => expect(updates).toHaveBeenCalled());
        expect(updates.mock.lastCall[0].map(row => row.id)).toEqual(['a1']);
        plan = { cid: 'plan-two', draft: true }; scope.sync();
        await vi.waitFor(() => expect(updates.mock.lastCall[0].map(row => row.id)).toEqual(['a2']));
        agreements.push({ id: 'a3', title: 'New terms', plan: { cid: 'plan-two' } }); changed();
        await vi.waitFor(() => expect(updates.mock.lastCall[0].map(row => row.id)).toEqual(['a2', 'a3']));
        expect(f.win.fetch).not.toHaveBeenCalled(); scope.dispose();
    });

    it('discards a delayed agreement response after switching exact plans', async () => {
        let finish;
        const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const f = fixture({ fetch, agreements: [{ id: 'new', title: 'Current', plan: { cid: 'plan-new' } }] });
        let plan = { cid: 'plan-old', draft: false };
        const updates = vi.fn(), scope = createAgreementScope(f.win, { getPlan: () => plan, onChange: updates });
        const pending = scope.sync();
        plan = { cid: 'plan-new', draft: true }; scope.sync();
        finish(page('agreements', [{ cid: 'stale-agreement', planCid: 'plan-old' }]));
        await pending; await Promise.resolve();
        expect(updates.mock.lastCall[0].map(row => row.id)).toEqual(['new']); scope.dispose();
    });

    it('does not restore stale plan highlights after its host was detached', async () => {
        const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const f = fixture();
        let finishInspection;
        const data = { members: [{ id: 'design-1' }], features: [{ id: 'inspected-geometry' }] };
        const session = {
            groups: { plans: { loading: false, error: false, nextOffset: null } },
            details: vi.fn(() => new Promise(resolve => { finishInspection = resolve; }))
        };
        const onFocus = vi.fn();
        mountSection(host, 'plans', { id: 'plan-1', cid: 'plan-1', label: 'Plan' }, session, f.win, { onFocus });
        host.remove();
        finishInspection(data);
        await Promise.resolve();
        expect(onFocus).not.toHaveBeenCalled();
    });
});
