import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeDocument } from './helpers/fake-dom.js';
import { testI18n } from './helpers/i18n.js';
import { readSource } from './helpers/read-source.js';
const require = createRequire(import.meta.url);
const { stageOf, mergeRows, filterRows, indexQuery, browser } = require('../../frontend/js/lists-panel.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const Cid = require('../../frontend/js/cid.js');
describe('shared lists', () => {
    it('registers the agreement tab and leaves no deletion command outside Lists', () => {
        const commands = require('../../frontend/js/ui/commands.js').listCommands();
        expect(commands.find(row => row.control === 'designs-agreements-tab')?.labelKey).toBe('sidebar.proposals.agreementsButton');
        expect(commands.find(row => row.id === 'proposals.list')?.labelKey).toBe('lists.title');
        expect(commands.some(row => row.id === 'proposals.clearLocal')).toBe(false);
    });
    const rows = [
        { title: 'Zebra', author: 'Team', published: false, createdAt: '2026-10-01' },
        { title: 'Alpha', author: 'Council', published: true, createdAt: '2026-10-02' }
    ];
    it('combines search and publication filters without mutating records', () => {
        expect(filterRows(rows, { search: ' council ', publication: 'published' })).toEqual([rows[1]]);
        expect(filterRows(rows, { search: 'alpha', publication: 'draft' })).toEqual([]);
        expect(filterRows(rows, {})).toEqual([rows[1], rows[0]]);
        expect(rows[0].title).toBe('Zebra');
    });
    it('asks the index for a city, or in explore for the designs in the visible area', () => {
        const explore = { explore: true, bbox: [90.39, 23.7, 90.42, 23.72] };
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg' }))).toEqual({ limit: '50', city: 'zg' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'city', area: explore }))).toEqual({ limit: '50', bbox: '90.39,23.7,90.42,23.72' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg', area: { explore: false, bbox: null } }))).toEqual({ limit: '50', city: 'zg' });
        // Plans and agreements page by offset and stay city-scoped.
        expect(Object.fromEntries(indexQuery('plans', { city: 'zg', area: explore, offset: 50 }))).toEqual({ limit: '50', city: 'zg', offset: '50' });
    });
    it('lists each object once: a browser copy of a published object joins its server row, drafts stay', () => {
        const draft = { key: 'local-1', title: 'Draft', published: false, cid: null, local: { id: 'local-1' } };
        const copy = { key: 'local-2', title: 'Mine, published', published: true, cid: 'cid-b', local: { id: 'local-2' } };
        const offPage = { key: 'local-3', title: 'Published elsewhere', published: true, cid: 'cid-z', local: { id: 'local-3' } };
        const server = [{ key: 'cid-a', title: 'Theirs', published: true, local: null }, { key: 'cid-b', title: 'Mine, published', published: true, local: null }];
        const merged = mergeRows([draft, copy, offPage], server);
        expect(merged.map(row => row.key)).toEqual(['cid-a', 'local-2', 'local-1', 'local-3']);
        expect(merged[1]).toMatchObject({ title: 'Mine, published', published: true, local: { id: 'local-2' } });
        expect(mergeRows([draft], [])).toEqual([draft]);
    });
    it('filters by stage of saving: draft, published, and on chain for an agreement', () => {
        const staged = [{ title: 'A', published: false }, { title: 'B', published: true }, { title: 'C', published: true, onChain: true }];
        expect(staged.map(stageOf)).toEqual(['draft', 'published', 'onchain']);
        expect(filterRows(staged, { publication: 'published' }).map(row => row.title)).toEqual(['B']);
        expect(filterRows(staged, { publication: 'onchain' }).map(row => row.title)).toEqual(['C']);
        expect(filterRows(staged, { publication: 'all' })).toHaveLength(3);
    });
    it('sorts by the displayed instant, with undated records last and title order available', () => {
        const dated = [{ title: 'Zebra', createdAt: '2026-11-17T09:00:00Z' },
            { title: 'Alpha', publishedAt: '2026-11-17T10:00:00+02:00', createdAt: '2026-11-17T11:00:00Z' },
            { title: 'Beta', createdAt: 'invalid' }];
        expect(filterRows(dated).map(row => row.title)).toEqual(['Zebra', 'Alpha', 'Beta']);
        expect(filterRows(dated, { sort: 'title' }).map(row => row.title)).toEqual(['Alpha', 'Beta', 'Zebra']);
    });
    it('removes only the stored plan, retaining its agreement and member records', () => {
        const content = PlanRecord.create('Plan', [Cid.cidOfObject({ test: 'design' })], { city: 'london', at: '51.5,-0.1,17', mode: '2d', language: 'en' });
        const plan = { cid: Cid.cidOfObject(content), content };
        const storage = new Map([[`plan:${plan.cid}`, JSON.stringify(plan)], ['proposal:member', 'member'], ['agreement:one', 'agreement']]);
        const events = [];
        const api = NamedPlans.browser({ location: new URL('https://app.test/'), Cid, PlanRecord,
            CustomEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: event => events.push(event.type),
            PersistentStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key), forEach: fn => storage.forEach(fn) },
            AgreementStore: { list: () => [{ plan, designs: [{ proposalId: 'member' }] }] } });
        expect(api.list({ storedOnly: true })).toHaveLength(1);
        api.remove(plan.cid);
        expect(api.list({ storedOnly: true })).toHaveLength(0);
        expect(api.list()).toHaveLength(1); // inspection can still follow the agreement's exact subject
        expect([...storage.keys()]).toEqual(['proposal:member', 'agreement:one']);
        expect(events).toEqual(['planschange']);
    });
});

// The Lists sheet itself, over a small DOM and the real English strings: the trash on each row,
// the "On the map" toggle and the ladder badges (the real proposals/list-ui.js helper).
const listUiSource = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
const displayState = require('../../frontend/js/proposals/display-state.js');
const lifecycleLabels = { unknown: 'Status unknown', expired: 'Expired', cancelled: 'Withdrawn' };
const ladderBadges = new Function('window', 'getProposalI18nHelper', 'getProposalLifecycleLabel', 'escapeHtml',
    `${listUiSource.slice(listUiSource.indexOf('function getProposalLadder('), listUiSource.indexOf('function buildProposalListItemsHtml('))}; return proposalLadderBadgesHtml;`)(
    { __proposalDisplayState: displayState }, () => (_key, fallback) => fallback, key => lifecycleLabels[key] || key,
    require('../../frontend/js/shared-utils.js').escapeHtml);

function listsSheet({ designs = [], serverDesigns = [], plans = [], serverPlans = [], agreements = [], serverAgreements = [], offers = [], serverOffers = [], resolvePlan = null,
    source = 'server', chainAgreements = [] } = {}) {
    const doc = makeDocument();
    for (const id of ['lists-controls', 'lists-actions', 'lists-status', 'proposal-list-host', 'plan-list-host', 'agreement-list-host']) {
        const el = doc.createElement('div'); el.id = id; doc.body.append(el);
    }
    const i18n = testI18n('en');
    const calls = { confirm: [], deleted: [], plansRemoved: [], unapplied: [], offersOpened: [] };
    const win = {
        document: doc,
        i18n: { t: i18n.t, translationsReady: Promise.resolve() },
        addEventListener() {},
        BusyControl: { isBusy: () => false, track: (_el, action) => Promise.resolve().then(action) },
        CbDialog: { confirm: async (message, options) => { calls.confirm.push({ message, options }); return true; } },
        deleteProposal: async id => { calls.deleted.push(id); },
        // proposals/layer-render.js: takes the designs off the map and announces it.
        unapplyDesignsFromMap: async ids => {
            calls.unapplied.push(ids);
            designs.forEach(design => { if (ids.includes(String(design.proposalId))) design.applied = false; });
            return ids.map(id => ({ proposalId: id }));
        },
        showStyledAlert: message => { throw new Error(message); },
        MapShell: { isOpen: () => true, closeSheets() {} },
        clearProposalPreview() {},
        normalizeCityCodeForApi: code => code,
        resolveCurrentCityCode: () => 'london',
        getProposalCountAreaContext: () => null,
        fetch: vi.fn(async url => ({ ok: true, json: async () => (String(url).includes('/property-offers?') ? { propertyOffers: serverOffers } : { plans: serverPlans, agreements: serverAgreements }) })),
        // Where the rows are read from (chain/read-source.js), and the agreement program's accounts.
        ReadSource: readSource(source),
        ChainReader: { cluster: () => 'devnet', listAgreements: vi.fn(async () => chainAgreements) },
        DesignSync: { apiBase: () => 'https://api.test', publishedCid: record => record.cid || null,
            listPage: vi.fn(async () => ({ designs: serverDesigns, hasMore: false, nextOffset: null })),
            localDesignIndex: () => { const byCid = new Map(designs.filter(row => row.cid).map(row => [row.cid, row])); return { records: designs, byCid, published: new Map(designs.filter(row => row.cid).map(row => [row, row.cid])) }; },
            localCopyOf: cid => designs.find(design => design.cid === cid) || null },
        proposalStorage: { getAllProposals: () => designs },
        NamedPlans: { list: () => plans, remove: cid => calls.plansRemoved.push(cid) },
        PlanWorkspace: { resolve: resolvePlan || (async row => row) },
        PlanComposition: { localRecords: plan => plan.designs || [] },
        previewRecordsOnMap: vi.fn(() => true), clearProposalPreview() {},
        AgreementStore: { list: () => agreements, subscribe() {} },
        AgreementSync: { localCopyOf: () => null },
        AgreementPanel: { ruleShort: () => '' },
        PropertyOfferStore: { list: () => offers, subscribe() {} },
        PropertyOfferSync: { localCopyOf: cid => offers.find(offer => offer.published?.cid === cid) || null, openDetails: async cid => calls.offersOpened.push(cid) },
        PropertyOfferPanel: { open: id => calls.offersOpened.push(id) },
        RecordLabel: { label: title => title, badge: d => d.createElement('span') },
        proposalLadderBadgesHtml: ladderBadges,
        __proposalDisplayState: displayState
    };
    const item = id => doc.querySelector(`[data-list-id="${id}"]`);
    const shown = host => doc.getElementById(host).querySelectorAll('.lists-item').map(el => el.dataset.listId);
    return { doc, win, calls, item, shown, panel: browser(win) };
}

describe('the Lists sheet', () => {
    it('offers only unpublished saved records for update review', () => {
        const { panel } = listsSheet({
            designs: [{ proposalId: 'draft-design', title: 'Park' }, { proposalId: 'published-design', cid: 'shared' }],
            plans: [{ cid: 'draft-plan', content: { title: 'Blocks', view: {} }, designs: [] },
                { cid: 'published-plan', content: { title: 'Shared blocks', view: {} }, published: true }],
            agreements: [{ id: 'draft-agreement', title: 'Terms' }, { id: 'published-agreement', published: { cid: 'shared' } }]
        });
        expect(panel.drafts().map(group => [group.kind, group.rows.map(row => row.key)]))
            .toEqual([['designs', ['draft-design']], ['plans', ['draft-plan']], ['agreements', ['draft-agreement']]]);
    });
    // A draft applied to the map, this browser's copy of a published design, and one only on the server.
    const fixture = () => listsSheet({
        designs: [
            { proposalId: 'd-draft', title: 'Corner park', applied: true },
            { proposalId: 'd-copy', title: 'Shared square', cid: 'cid-shared', lifecycleStatus: 'Expired' }
        ],
        serverDesigns: [{ cid: 'cid-shared', title: 'Shared square' }, { cid: 'cid-server', title: 'Server street' }]
    });

    it('starts newest first across tabs, keeps an explicit title sort, and resets to newest', async () => {
        const { doc, shown, panel } = listsSheet({
            designs: [{ proposalId: 'park', title: 'Zebra park', createdAt: '2026-11-18T12:00:00Z' }],
            serverDesigns: [{ cid: 'older', title: 'Alpha square', publishedAt: '2026-11-01T12:00:00Z' }],
            plans: [{ cid: 'plan-z', content: { title: 'Zebra', view: {}, designCids: [] }, publishedAt: '2026-11-18T12:00:00Z' },
                { cid: 'plan-a', content: { title: 'Alpha', view: {}, designCids: [] }, publishedAt: '2026-11-01T12:00:00Z' }],
            agreements: [{ id: 'draft-a', title: 'Alpha', createdAt: '2026-11-01T12:00:00Z' }],
            serverAgreements: [{ cid: 'agreement-z', title: 'Zebra', createdAt: '2026-11-18T12:00:00Z' }]
        });
        await panel.open();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toEqual(['park', 'older']));
        const sort = () => doc.querySelector('[data-list-filter="sort"]');
        expect(sort().value).toBe('newest');
        sort().value = 'title'; sort().dispatchEvent({ type: 'change', target: sort() });
        expect(shown('proposal-list-host')).toEqual(['older', 'park']);
        await panel.select('plans');
        expect(sort().value).toBe('title');
        expect(shown('plan-list-host')).toEqual(['plan-a', 'plan-z']);
        sort().value = 'newest'; sort().dispatchEvent({ type: 'change', target: sort() });
        await panel.select('designs');
        expect(sort().value).toBe('newest');
        sort().value = 'title'; sort().dispatchEvent({ type: 'change', target: sort() });
        doc.querySelector('#lists-filter-panel .btn-quiet').click();
        await vi.waitFor(() => expect(sort().value).toBe('newest'));
        expect(shown('proposal-list-host')).toEqual(['park', 'older']);
        await panel.select('plans');
        expect(sort().value).toBe('newest');
        expect(shown('plan-list-host')).toEqual(['plan-z', 'plan-a']);
        await panel.select('agreements');
        await vi.waitFor(() => expect(shown('agreement-list-host')).toEqual(['agreement-z', 'draft-a']));
        expect(sort().value).toBe('newest');
    });

    it('deletes a draft, removes the copy of a published design from this device, and offers nothing for a server-only row', async () => {
        const { calls, item, shown, panel } = fixture();
        await panel.open();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toHaveLength(3));
        const trash = id => item(id).querySelector('.lists-item__remove');
        expect(trash('d-draft').getAttribute('aria-label')).toBe('Delete draft');
        expect(trash('d-copy').getAttribute('aria-label')).toBe('Remove from this device');
        expect(trash('cid-server')).toBeNull();

        trash('d-copy').click();
        await vi.waitFor(() => expect(calls.deleted).toEqual(['d-copy']));
        expect(calls.confirm[0].message).toBe('Remove this browser’s copy of “Shared square”? The published design stays available through its link. If it is on the map here, it comes off the map.');
        expect(calls.confirm[0].options).toMatchObject({ destructive: true, okText: 'Remove from this device' });

        trash('d-draft').click();
        await vi.waitFor(() => expect(calls.deleted).toEqual(['d-copy', 'd-draft']));
        expect(calls.confirm[1].message).toBe('Delete the draft “Corner park”? It is saved only in this browser, so it cannot be recovered. If it is on the map, it comes off the map.');
        expect(calls.confirm[1].options).toMatchObject({ destructive: true, okText: 'Delete draft' });
    });

    it('shows only the designs on the map when On the map is pressed, with their count, until Reset', async () => {
        const { doc, shown, panel } = fixture();
        await panel.open();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toHaveLength(3));
        const toggle = () => doc.querySelector('[data-lists-on-map]');
        expect(toggle().textContent).toBe('On the map (1)');
        expect(toggle().getAttribute('aria-pressed')).toBe('false');

        toggle().click();
        expect(toggle().getAttribute('aria-pressed')).toBe('true');
        expect(shown('proposal-list-host')).toEqual(['d-draft']);

        doc.querySelector('#lists-filter-panel .btn-quiet').click();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toHaveLength(3));
        expect(toggle().getAttribute('aria-pressed')).toBe('false');
    });

    it('takes every design on the map off it after one question, and offers nothing once none is left', async () => {
        const { doc, calls, shown, panel } = fixture();
        await panel.open();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toHaveLength(3));
        const unapplyAll = () => doc.querySelector('[data-lists-unapply-all]');
        expect(unapplyAll().textContent).toBe('Unapply all (1)');
        expect(unapplyAll().hidden).toBe(false);

        unapplyAll().click();
        await vi.waitFor(() => expect(calls.unapplied).toEqual([['d-draft']]));
        expect(calls.confirm[0].message).toBe('Unapply every design on the map (1)? They stay in Lists and can be applied again.');
        expect(calls.confirm[0].options.okText).toBe('Unapply');
        // Nothing is on the map any more: the button goes and the toggle counts none.
        await vi.waitFor(() => expect(unapplyAll().hidden).toBe(true));
        expect(doc.querySelector('[data-lists-on-map]').textContent).toBe('On the map (0)');
        // The designs themselves are kept.
        expect(shown('proposal-list-host')).toHaveLength(3);
    });

    it('leaves out the Status unknown badge on a row and keeps a known lifecycle badge', async () => {
        const { item, shown, panel } = fixture();
        await panel.open();
        await vi.waitFor(() => expect(shown('proposal-list-host')).toHaveLength(3));
        const badges = id => item(id).querySelector('.lists-item__badges').textContent;
        expect(badges('d-draft')).toContain('Applied');
        expect(badges('d-draft')).not.toContain('Status unknown');
        expect(badges('d-copy')).toContain('Expired');
        // Elsewhere the same helper still shows it.
        expect(ladderBadges({ proposalId: 'x' })).toContain('Status unknown');
    });

    it('removes this browser’s copy of a published plan, saying its designs stay', async () => {
        const plan = { cid: 'plan-cid', published: true, content: { title: 'Residents plan', view: {}, designCids: ['a'] } };
        const { calls, item, shown, panel } = listsSheet({ plans: [plan] });
        await panel.select('plans');
        await vi.waitFor(() => expect(shown('plan-list-host')).toEqual(['plan-cid']));
        const trash = item('plan-cid').querySelector('.lists-item__remove');
        expect(trash.getAttribute('aria-label')).toBe('Remove from this device');
        trash.click();
        await vi.waitFor(() => expect(calls.plansRemoved).toEqual(['plan-cid']));
        expect(calls.confirm[0].message).toBe('Remove this browser’s copy of the plan “Residents plan”? The published plan stays available through its link, and its designs stay in this browser.');
        expect(calls.confirm[0].options.destructive).toBe(true);
    });

    it('retains remote plan publication dates alongside local and remote property offers', async () => {
        const publishedAt = '2026-11-17T09:10:11.000Z';
        const content = { schema: 'property-offer/v1', direction: 'buy', title: 'Purchase', proposer: 'buyer', createdAt: publishedAt };
        const f = listsSheet({
            serverPlans: [{ cid: 'remote-plan', publishedAt, content: { title: 'Published plan', view: {}, designCids: ['a'] } }],
            offers: [{ id: 'draft-offer', content }],
            serverOffers: [{ cid: 'remote-offer', content }]
        });
        await f.panel.select('plans');
        await vi.waitFor(() => expect(f.item('remote-plan')?.querySelector('time.lists-item__timestamp')?.dateTime).toBe(publishedAt));
        await f.panel.select('agreements');
        await vi.waitFor(() => expect(f.shown('agreement-list-host').sort()).toEqual(['draft-offer', 'remote-offer']));
        expect(f.item('draft-offer').textContent).toContain('Offer to buy');
        expect(f.item('remote-offer').textContent).toContain('Offer to buy');
        expect(f.item('draft-offer').querySelector('time')?.dateTime).toBe(publishedAt);
        expect(f.item('remote-offer').querySelector('time')?.dateTime).toBe(publishedAt);
        f.item('draft-offer').querySelector('.lists-item__open').click();
        f.item('remote-offer').querySelector('.lists-item__open').click();
        await vi.waitFor(() => expect(f.calls.offersOpened).toEqual(['draft-offer', 'remote-offer']));
        expect(f.panel.drafts().find(group => group.kind === 'agreements').rows.map(row => row.key)).toEqual(['draft-offer']);
    });

    it('shows first publication times and draft creation times on design and agreement rows', async () => {
        const createdAt = '2026-11-16T09:10:11.000Z', publishedAt = '2026-11-17T09:10:11.000Z';
        const f = listsSheet({
            designs: [{ proposalId: 'draft-design', createdAt }, { proposalId: 'design-copy', cid: 'copy-cid', createdAt, published: { publishedAt } }],
            serverDesigns: [{ cid: 'copy-cid', title: 'Cached design' }, { cid: 'remote-design', title: 'Design', createdAt: publishedAt }],
            agreements: [{ id: 'draft-agreement', title: 'Draft agreement', createdAt }],
            serverAgreements: [{ cid: 'remote-agreement', title: 'Agreement', createdAt: publishedAt }]
        });
        const stamp = id => f.item(id)?.querySelector('time.lists-item__timestamp')?.dateTime;
        await f.panel.open();
        await vi.waitFor(() => expect(stamp('remote-design')).toBe(publishedAt));
        expect(stamp('draft-design')).toBe(createdAt);
        expect(stamp('design-copy')).toBe(publishedAt);
        await f.panel.select('agreements');
        await vi.waitFor(() => expect(stamp('remote-agreement')).toBe(publishedAt));
        expect(stamp('draft-agreement')).toBe(createdAt);
    });

    it('shows a published plan timestamp only when the server supplied one', async () => {
        const publishedAt = '2026-11-17T09:10:11.000Z';
        const dated = { cid: 'dated', published: true, publishedAt, content: { title: 'Same name', view: {}, designCids: ['a'] } };
        const undated = { cid: 'undated', published: true, content: { title: 'Same name', view: {}, designCids: ['b'] } };
        const { item, panel } = listsSheet({ plans: [dated, undated] });
        await panel.select('plans');
        await vi.waitFor(() => expect(item('dated')).not.toBeNull());
        const timestamp = item('dated').querySelector('time.lists-item__timestamp');
        expect(timestamp.dateTime).toBe(publishedAt);
        expect(timestamp.textContent).not.toContain('1970');
        expect(item('undated').querySelector('time.lists-item__timestamp')).toBeNull();
    });

    it('does not repaint an older plan preview after a newer card resolves first', async () => {
        let resolveA, resolveB;
        const planA = { cid: 'plan-a', content: { title: 'Alatau', view: {}, designCids: [] }, designs: [] };
        const planB = { cid: 'plan-b', content: { title: 'Garden streets', view: {}, designCids: [] }, designs: [] };
        const f = listsSheet({ plans: [planA, planB], resolvePlan: plan => new Promise(resolve => {
            if (plan.content.title === 'Alatau') resolveA = resolve; else resolveB = resolve;
        }) });
        await f.panel.select('plans');
        await vi.waitFor(() => expect(f.item('plan-a')).not.toBeNull());
        f.item('plan-a').dispatchEvent({ type: 'click', target: f.item('plan-a') });
        f.item('plan-b').dispatchEvent({ type: 'click', target: f.item('plan-b') });
        await vi.waitFor(() => expect(resolveB).toEqual(expect.any(Function)));
        resolveB({ ...planB, designs: [{ proposalId: 'b' }] });
        await vi.waitFor(() => expect(f.win.previewRecordsOnMap).toHaveBeenCalledTimes(1));
        // The old request must be harmless when it finally resolves: only B may repaint.
        resolveA({ ...planA, designs: [{ proposalId: 'a' }] });
        await Promise.resolve(); await Promise.resolve();
        expect(f.win.previewRecordsOnMap.mock.calls.map(call => call[1])).toEqual(['list:plans:plan-b']);
    });

    // Where the rows are read from is the app-wide choice (chain/read-source.js), shown above the list.
    const minted = 'bafkreibzljimrgcqmzvmsmn337hetk56oarx5ypanyd6gwtnuakjqxigf4';
    const chainRow = { cid: minted, createdAt: '2026-11-26T18:50:09.000Z', readFrom: 'chain',
        onchain: { chain: 'solana', cluster: 'devnet', account: 'Acc1', status: 'executed' } };
    const chainSheet = options => {
        const f = listsSheet({ chainAgreements: [chainRow], ...options });
        f.win.AgreementSync.shortCid = value => `${value.slice(0, 12)}…${value.slice(-6)}`;
        f.win.AgreementPanel.chainStatusText = status => `Status: ${status}`;
        f.readFrom = () => f.doc.querySelector('[data-lists-read-from]');
        f.indexAsked = () => f.win.fetch.mock.calls.length + f.win.DesignSync.listPage.mock.calls.length;
        return f;
    };

    it('reads our server alone by default: the chain is never asked, and Read from shows the app-wide choice', async () => {
        const f = chainSheet({ serverAgreements: [{ cid: 'indexed-agreement', title: 'From the index', createdAt: '2026-11-17T09:10:11.000Z' }] });
        await f.panel.select('agreements');
        await vi.waitFor(() => expect(f.shown('agreement-list-host')).toEqual(['indexed-agreement']));
        expect(f.win.ChainReader.listAgreements).not.toHaveBeenCalled();
        expect(f.readFrom().value).toBe('server');
        expect(f.readFrom().parentNode.textContent).toContain('Read from');
        expect(f.readFrom().querySelectorAll('option').map(option => option.textContent)).toEqual(['Our server', 'Chain', 'Both']);
        // No source badges when one source is read: Read from says it.
        expect(f.item('indexed-agreement').querySelector('[data-held-by]')).toBeNull();
    });

    it('reads the chain alone once Chain is chosen: agreements from the program accounts, nothing from our server', async () => {
        const f = chainSheet({ serverAgreements: [{ cid: 'indexed-agreement', title: 'From the index' }],
            designs: [{ proposalId: 'own-draft', title: 'Own draft' }], serverDesigns: [{ cid: 'cid-server', title: 'Server street' }] });
        await f.panel.select('agreements');
        await vi.waitFor(() => expect(f.shown('agreement-list-host')).toEqual(['indexed-agreement']));
        f.readFrom().value = 'chain'; f.readFrom().dispatchEvent({ type: 'change', target: f.readFrom() });
        expect(f.win.ReadSource.get()).toBe('chain');
        const asked = f.indexAsked();
        await vi.waitFor(() => expect(f.shown('agreement-list-host')).toEqual([minted]));
        expect(f.win.ChainReader.listAgreements).toHaveBeenCalledTimes(1);
        expect(f.item(minted).querySelector('.lists-item__title').textContent).toBe('Agreement bafkreibzlji…qxigf4');
        expect(f.item(minted).textContent).toContain('Status: executed');
        expect(f.item(minted).querySelector('time.lists-item__timestamp').dateTime).toBe('2026-11-26T18:50:09.000Z');
        // Designs have no chain accounts: the tab lists this browser's own and says why.
        await f.panel.select('designs');
        await vi.waitFor(() => expect(f.shown('proposal-list-host')).toEqual(['own-draft']));
        expect(f.doc.getElementById('lists-status').textContent).toContain('The chain lists agreements only, not designs or plans.');
        expect(f.indexAsked()).toBe(asked);
        // Reset filters leaves where the rows are read from alone: it is not a filter.
        f.doc.querySelector('#lists-filter-panel .btn-quiet').click();
        expect(f.win.ReadSource.get()).toBe('chain');
    });

    it('reads both: one row per agreement marked by the sources that hold it, a failed source named', async () => {
        const f = chainSheet({ source: 'both', serverAgreements: [{ cid: minted, title: 'Minted lane', createdAt: '2026-11-17T09:10:11.000Z' },
            { cid: 'indexed-agreement', title: 'Not minted' }] });
        await f.panel.select('agreements');
        await vi.waitFor(() => expect(f.shown('agreement-list-host').sort()).toEqual(['indexed-agreement', minted].sort()));
        const heldBy = id => f.item(id).querySelectorAll('[data-held-by]').map(badge => badge.textContent);
        expect(heldBy(minted)).toEqual(['Our server', 'Chain']);
        expect(heldBy('indexed-agreement')).toEqual(['Our server']);
        expect(f.item(minted).querySelector('.lists-item__title').textContent).toBe('Minted lane');
        expect(f.item(minted).textContent).toContain('Status: executed');
        // Our server down: the chain's rows are still listed and the failure is our server's.
        const down = chainSheet({ source: 'both' });
        down.win.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({ error: 'HTTP 503' }) }));
        await down.panel.select('agreements');
        await vi.waitFor(() => expect(down.shown('agreement-list-host')).toEqual([minted]));
        expect(down.item(minted).querySelectorAll('[data-held-by]').map(badge => badge.textContent)).toEqual(['Chain']);
        expect(down.doc.getElementById('lists-status').textContent).toContain('Our server could not be read: HTTP 503');
    });
});
