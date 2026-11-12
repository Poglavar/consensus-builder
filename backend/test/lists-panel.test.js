import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeDocument } from './helpers/fake-dom.js';
import { testI18n } from './helpers/i18n.js';
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
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg' }))).toEqual({ limit: '1000', city: 'zg' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'city', area: explore }))).toEqual({ limit: '1000', bbox: '90.39,23.7,90.42,23.72' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg', area: { explore: false, bbox: null } }))).toEqual({ limit: '1000', city: 'zg' });
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
    it('orders loaded records by their authored date', () => {
        expect(filterRows(rows, { sort: 'newest' }).map(row => row.title)).toEqual(['Alpha', 'Zebra']);
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

function listsSheet({ designs = [], serverDesigns = [], plans = [] } = {}) {
    const doc = makeDocument();
    for (const id of ['lists-controls', 'lists-actions', 'lists-status', 'proposal-list-host', 'plan-list-host', 'agreement-list-host']) {
        const el = doc.createElement('div'); el.id = id; doc.body.append(el);
    }
    const i18n = testI18n('en');
    const calls = { confirm: [], deleted: [], plansRemoved: [], unapplied: [] };
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
        MapShell: { isOpen: () => true },
        normalizeCityCodeForApi: code => code,
        resolveCurrentCityCode: () => 'london',
        getProposalCountAreaContext: () => null,
        fetch: async url => ({ ok: true, json: async () => (String(url).includes('/designs?') ? { designs: serverDesigns } : { plans: [], agreements: [] }) }),
        DesignSync: { apiBase: () => 'https://api.test', publishedCid: record => record.cid || null,
            localCopyOf: cid => designs.find(design => design.cid === cid) || null },
        proposalStorage: { getAllProposals: () => designs },
        NamedPlans: { list: () => plans, remove: cid => calls.plansRemoved.push(cid) },
        AgreementStore: { list: () => [], subscribe() {} },
        AgreementSync: { localCopyOf: () => null },
        RecordLabel: { label: title => title, badge: d => d.createElement('span') },
        proposalLadderBadgesHtml: ladderBadges,
        __proposalDisplayState: displayState
    };
    const item = id => doc.querySelector(`[data-list-id="${id}"]`);
    const shown = host => doc.getElementById(host).querySelectorAll('.lists-item').map(el => el.dataset.listId);
    return { doc, calls, item, shown, panel: browser(win) };
}

describe('the Lists sheet', () => {
    // A draft applied to the map, this browser's copy of a published design, and one only on the server.
    const fixture = () => listsSheet({
        designs: [
            { proposalId: 'd-draft', title: 'Corner park', applied: true },
            { proposalId: 'd-copy', title: 'Shared square', cid: 'cid-shared', lifecycleStatus: 'Expired' }
        ],
        serverDesigns: [{ cid: 'cid-shared', title: 'Shared square' }, { cid: 'cid-server', title: 'Server street' }]
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
});
