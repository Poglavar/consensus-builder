// Reverse membership sessions and read-only parent inspection: exact revisions, bounded lookup,
// cancellation, and canonical member geometry.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const { localAgreements, mergeRows, fetchPage, createSession, inspect, mountSection, strings } = require('../../frontend/js/design-memberships.js');
const page = (kind, items = [], nextOffset = null) => Response.json({ [kind]: items, hasMore: nextOffset !== null, nextOffset });

function fixture({ published = true, agreements = [], fetch = vi.fn(async url => page(new URL(url).pathname.slice(1))) } = {}) {
    const dictionaries = {};
    const win = {
        fetch, location: new URL('https://app.example/?backend=https%3A%2F%2Fapi.example'),
        console: { warn: vi.fn() }, resolveBackendBaseUrl: () => 'https://api.example',
        DesignSync: { publishedCid: proposal => proposal.cid || null },
        AgreementStore: { list: () => agreements },
        NamedPlans: { current: null, link: cid => `https://app.example/plans/${cid}` },
        AgreementSync: { agreementLink: cid => `https://app.example/agreements/${cid}` },
        AgreementPanel: { open: vi.fn() }, showStyledAlert: vi.fn(),
        i18n: {
            registerTranslations(lang, values) { dictionaries[lang] = { ...dictionaries[lang], ...values }; },
            t: key => dictionaries.en?.[key] || key
        }
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
            expect(session.instances('agreements').map(item => item.id)).toEqual(['draft-agreement']);
            session.dispose();
        }
    });
    it('matches exact published revisions and local drafts without matching stale revisions', () => {
        const agreements = [draft,
            { id: 'published', published: { cid: 'agreement-current' }, designs: [{ proposalId: 'different-copy', cid: 'design-current' }] },
            { id: 'old', published: { cid: 'agreement-old' }, designs: [{ proposalId: 'local-design', cid: 'design-old' }] }];
        expect(localAgreements('local-design', 'design-current', agreements, row => row.published?.cid || null).map(row => row.localId))
            .toEqual(['draft-agreement', 'published']);
        expect(localAgreements('local-design', null, agreements, row => row.published?.cid || null).map(row => row.localId))
            .toEqual(['draft-agreement']);
    });

    it('preserves a foreign published agreement identity and never treats its stale local id as a draft match', async () => {
        const foreign = { id: 'foreign-agreement', title: 'Published elsewhere',
            published: { cid: 'agreement-foreign', apiBase: 'https://other-api.example' },
            designs: [{ proposalId: 'local-design', cid: 'design-old' }] };
        const f = fixture({ agreements: [foreign] });
        const session = f.session();
        await session.ready;
        expect(session.groups.agreements.items).toEqual([]);
        // With its published identity retained, the same local row can only match its exact CID,
        // never the reused local proposal id for a different published revision.
        expect(localAgreements('local-design', 'design-current', [foreign], row => row.published?.cid || null)).toEqual([]);
        expect(localAgreements('local-design', 'design-old', [foreign], row => row.published?.cid || null)[0])
            .toMatchObject({ cid: 'agreement-foreign', localId: 'foreign-agreement', draft: false, agreement: foreign });
    });

    it('deduplicates imported published agreements while retaining local navigation identity', async () => {
        const imported = { id: 'imported', title: 'Published consultation', published: { cid: 'agreement-pub', apiBase: 'https://api.example' },
            designs: [{ proposalId: 'local-design', cid: 'design-current' }], outputs: [{ pieceId: 'rebuilt-land' }] };
        const f = fixture({ agreements: [imported], fetch: vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return page(kind, kind === 'agreements' ? [{ cid: 'agreement-pub', title: 'Published consultation' }] : []);
        }) });
        const session = f.session();
        await session.ready;
        const records = session.groups.agreements.items;
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ cid: 'agreement-pub', localId: 'imported', title: 'Published consultation' });
        expect(session.instances('agreements')).toHaveLength(1);
    });

    it('keeps the successful list when the other lookup fails and retries only that list', async () => {
        let plansFail = true;
        const fetch = vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return kind === 'plans' && plansFail ? new Response('', { status: 503 }) : page(kind, [{ cid: `${kind}-one`, title: `${kind} result` }]);
        });
        const f = fixture({ fetch });
        const session = f.session();
        await session.ready;
        expect(session.groups.agreements.items.map(row => row.title)).toContain('agreements result');
        expect(session.groups.agreements.items.map(row => row.title)).toContain('agreements result');
        expect(session.groups.plans.error).toBe(true);
        plansFail = false;
        await session.load('plans');
        expect(session.groups.plans.items.map(row => row.title)).toContain('plans result');
        expect(fetch.mock.calls.filter(([url]) => url.includes('/agreements?'))).toHaveLength(1);
    });

    it('uses bounded pages and advances until the server reports the end', async () => {
        const fetch = vi.fn(async url => {
            const query = new URL(url), kind = query.pathname.slice(1), offset = Number(query.searchParams.get('offset'));
            return kind === 'agreements' ? page(kind) : page(kind,
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
        expect(f.win.fetch).not.toHaveBeenCalled();
        expect(session.instances('agreements')).toMatchObject([{ id: 'draft-agreement', draft: true, title: 'Local consultation' }]);
        expect(session.groups.plans.items).toEqual([]);
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

    it.each(['en', 'hr', 'sr', 'es'])('registers membership meaning and action labels in %s', language => {
        const f = fixture();
        const registered = {};
        f.win.i18n.registerTranslations = (lang, entries) => { registered[lang] = entries; };
        // Session setup registers every supported locale; verify the requested dictionary is complete.
        f.session();
        expect(registered[language]['designMemberships.planMeaning']).toBe(strings[language].planMeaning);
        expect(registered[language]['designMemberships.agreementMeaning']).toBe(strings[language].agreementMeaning);
        expect(registered[language]['designMemberships.openPlan']).toBe(strings[language].openPlan);
    });

    it('rejects malformed and nonadvancing pages', async () => {
        for (const payload of [{ plans: [] }, { plans: [], hasMore: true, nextOffset: 0 }]) {
            await expect(fetchPage({ fetch: async () => Response.json(payload), backend: 'https://api.example', kind: 'plans', designCid: 'design-current' }))
                .rejects.toThrow(/Invalid membership/);
        }
    });
});

describe('read-only parent inspection', () => {
    function inspectionWin({ localCopies = new Map(), downloaded = new Map(), missing = [], plan } = {}) {
        const members = [];
        const win = {
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

    it('renders the plan meaning and an explicit backend-preserving navigation link', async () => {
        const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const f = fixture();
        f.win.i18n.t = key => key === 'designMemberships.planMeaning' ? 'Plan meaning' : key === 'designMemberships.openPlan' ? 'Open plan' : key;
        f.win.ClickStackRelations = { renderGroup: vi.fn(() => doc.createElement('div')) };
        const session = { groups: { plans: { loading: false, error: false, nextOffset: null } }, details: vi.fn(async () => ({ members: [], features: [] })) };
        mountSection(host, 'plans', { id: 'plan-cid', cid: 'plan-cid', label: 'Plan title' }, session, f.win);
        await vi.waitFor(() => expect(host.querySelector('.click-stack__membership-details')).toBeTruthy());
        const link = host.querySelector('a');
        expect(host.textContent).toContain('Plan meaning');
        expect(link.textContent).toBe('Open plan');
        expect(link.href).toContain('/plans/plan-cid?backend=https%3A%2F%2Fapi.example');
    });

    it('renders the agreement meaning for agreement instances', async () => {
        const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const f = fixture();
        f.win.i18n.t = key => key === 'designMemberships.agreementMeaning' ? 'Agreement meaning' : key;
        const session = { groups: { agreements: { loading: false, error: false, nextOffset: null } }, details: vi.fn(async () => ({ members: [], features: [] })) };
        mountSection(host, 'agreements', { id: 'agreement-cid', cid: 'agreement-cid', label: 'Agreement title' }, session, f.win);
        await vi.waitFor(() => expect(host.textContent).toContain('Agreement meaning'));
        expect(host.textContent).toContain('Agreement title');
    });

    it.each(['active', 'expired', 'cancelled'])('inspects a published %s agreement row instead of treating lifecycle status as a placeholder', async status => {
        const inspectedFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
        const f = fixture({ fetch: vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return page(kind, kind === 'agreements' ? [{ cid: 'agreement-cid', title: 'Published agreement', status }] : []);
        }) });
        f.win.AgreementSync.fetchAgreement = vi.fn(async () => ({ content: { designs: [{ cid: 'design-cid', title: 'Exact revision' }] } }));
        f.win.DesignSync.localCopyOf = vi.fn(() => ({ proposalId: 'local-design', title: 'Exact revision' }));
        f.win.collectProposalFeatureSets = vi.fn(() => ({ primaryFeatures: [inspectedFeature] }));
        f.win.ClickStackRelations = { renderGroup: vi.fn(() => makeDocument().createElement('div')) };
        const session = f.session();
        await session.ready;
        const instance = session.instances('agreements')[0];
        expect(instance).toMatchObject({ cid: 'agreement-cid', status });

        const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const onFocus = vi.fn();
        mountSection(host, 'agreements', instance, session, f.win, { onFocus });
        await vi.waitFor(() => expect(onFocus).toHaveBeenCalledOnce());

        expect(host.textContent).toContain(strings.en.agreementMeaning);
        expect(host.textContent).toContain('Published agreement');
        expect(host.textContent).not.toContain('None');
        expect(host.querySelector('a').href).toContain('/agreements/agreement-cid?backend=https%3A%2F%2Fapi.example');
        expect(f.win.AgreementSync.fetchAgreement).toHaveBeenCalledWith('agreement-cid');
        expect(onFocus.mock.calls[0][0].features).toEqual([inspectedFeature]);
    });

    it('omits only a redundant relationship to a single deduplicated visible design', async () => {
        const renderGroup = vi.fn((_group, doc) => doc.createElement('div'));
        const render = async hits => {
            const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
            const f = fixture();
            f.win.ClickStackRelations = { renderGroup };
            const member = { id: 'design-one', label: 'Design one' };
            const session = {
                groups: { agreements: { loading: false, error: false, nextOffset: null } },
                details: vi.fn(async () => ({ members: [member], features: [] }))
            };
            const instance = { id: 'agreement-1', cid: 'agreement-1', label: 'Agreement' };
            mountSection(host, 'agreements', instance, session, f.win, { hits });
            await vi.waitFor(() => expect(session.details).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(instance.features).toEqual([]));
            return { host, doc, instance };
        };

        renderGroup.mockClear();
        const duplicateOnly = await render({ designs: [{ id: 'design-one' }, { id: 'design-one', onParcel: true }] });
        expect(renderGroup).not.toHaveBeenCalled();
        expect(duplicateOnly.host.querySelector('.click-stack__membership-details').textContent).not.toContain('Design one');

        renderGroup.mockClear();
        const twoVisible = await render({ designs: [{ id: 'design-one' }, { id: 'design-two', onParcel: true }] });
        expect(renderGroup).toHaveBeenCalledOnce();
        expect(twoVisible.host.querySelector('.click-stack__membership-details').children).toHaveLength(1);
    });

    it('calls onFocus with inspected geometry after completion even if its host was detached', async () => {
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
        await vi.waitFor(() => expect(onFocus).toHaveBeenCalledWith(expect.objectContaining(data)));
        expect(onFocus.mock.calls[0][0].features).toEqual(data.features);
    });
});
