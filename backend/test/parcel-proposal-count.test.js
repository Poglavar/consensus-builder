// The number on the parcel menu's "Proposals (N)" (ParcelSetProposals.count in
// frontend/js/parcels/parcel-set-proposals.js): the proposals this browser holds on the parcel plus
// every published design on it, settled once the designs index answers (GET /designs?parcel=, the
// designs whose binding takes the parcel, a page at a time with the total), and the same entries the
// parcel panel's Proposals tab lists, which an owner can search, filter by type and page through.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { makeDocument, makeEvent } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const MODULE = require.resolve('../../frontend/js/parcels/parcel-set-proposals.js');
const { designSummary } = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');

// The module binds to `window` when one exists; give it a browser of stubs.
function loadWithRoot(root) {
    delete require.cache[MODULE];
    globalThis.window = root;
    try { return require(MODULE); } finally { delete globalThis.window; }
}

const cidOf = n => Cid.cidOfObject({ schema: 'design/v1', n });
// A row of GET /designs whose site the index bound to these cadastral parcels.
const designRow = (n, parcelIds) => ({ cid: cidOf(n), city: 'zagreb', goal: 'park', title: `Design ${n}`,
    createdAt: '2026-10-21T10:00:00.000Z', binding: { parcels: parcelIds.map(parcelId => ({ parcelId })) } });

// answer(url) → the index's JSON for that request (its query decides the page).
function browser({ local = [], answer = () => ({ designs: [], total: 0 }), fail = false } = {}) {
    const fetchCalls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = vi.fn(url => {
        fetchCalls.push(url);
        return gate.then(() => (fail
            ? { ok: false, status: 503, text: async () => 'down' }
            : { ok: true, json: async () => answer(new URL(url)) }));
    });
    const root = {
        proposalStorage: { getProposalsForParcel: () => local, getProposal: id => local.find(p => p.proposalId === id) || null },
        LiveParcelFabric: { get: id => ({ id }), explicitCadastreIds: () => ['HR-1-7'] },
        normalizeCityCodeForApi: city => city,
        resolveCurrentCityCode: () => 'zagreb',
        resolveBackendBaseUrl: () => 'https://api.test',
        DesignSync: { designSummary, publishedCid: proposal => proposal?.published?.cid || null },
        findLocalCopyOfServerProposal: summary => local.find(p => p.published?.cid === summary.cid) || null,
        getProposalDisplayType: proposal => ({ park: 'park', 'road-track': 'road', single: 'building', row: 'building' }[proposal.goal] || 'other')
    };
    return { root, fetchCalls, open: () => release() };
}

// The index over `count` designs on the parcel, numbered newest first, every third a road: it pages,
// filters by goal and title as GET /designs does, and counts the goals of what the other filters keep.
function indexOf(count) {
    const all = Array.from({ length: count }, (_, i) => ({ ...designRow(i, ['HR-1-7']), goal: i % 3 === 0 ? 'road-track' : 'park',
        createdAt: new Date(Date.UTC(2026, 9, 1) - i * 60000).toISOString() }));
    return url => {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const goals = url.searchParams.get('goal')?.split(',') || null;
        const kept = all.filter(row => !q || row.title.toLowerCase().includes(q));
        const rows = kept.filter(row => !goals || goals.includes(row.goal));
        if (url.searchParams.get('order') === 'oldest') rows.reverse();
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'));
        const page = rows.slice(offset, offset + limit);
        const hasMore = offset + page.length < rows.length;
        const counts = {};
        kept.forEach(row => { counts[row.goal] = (counts[row.goal] || 0) + 1; });
        return { designs: page, count: page.length, total: rows.length, hasMore, nextOffset: hasMore ? offset + page.length : null,
            ...(url.searchParams.get('facets') === 'goal' ? { goals: counts } : {}) };
    };
}

afterEach(() => { delete globalThis.fetch; });

describe('Proposals (N) on the parcel menu', () => {
    it('counts what is held here at once, then every design on the parcel once the index answers', async () => {
        // p-11 is this browser's copy of published design 11: counted once, as its own copy.
        const env = browser({
            local: [{ proposalId: 'p-a' }, { proposalId: 'p-b' }, { proposalId: 'p-11', published: { cid: cidOf(11) } }],
            answer: () => ({ designs: [designRow(11, ['HR-1-7']), designRow(12, ['HR-1-7']), designRow(13, ['HR-1-7', 'HR-1-8'])],
                total: 3, hasMore: false, nextOffset: null })
        });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        expect(SetProposals.count(['live-7'], update => updates.push(update))).toEqual({ count: 3, loading: true, error: null });
        // Asked by the parcel itself: a large parcel's box would also hold its neighbours' designs.
        expect(env.fetchCalls).toEqual(['https://api.test/designs?parcel=HR-1-7&city=zagreb&limit=50&facets=goal']);
        env.open();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]).toEqual({ count: 5, loading: false, error: null });
        // Asked again within the minute, the answer is already known and nothing is fetched.
        expect(SetProposals.count(['live-7'], () => {})).toEqual({ count: 5, loading: false, error: null });
        expect(env.fetchCalls).toHaveLength(1);
    });

    it('counts designs not loaded yet: the total is the index\'s, not the page\'s', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }], answer: indexOf(312) });
        const SetProposals = loadWithRoot(env.root);
        env.open();
        const updates = [];
        SetProposals.count(['live-7'], update => updates.push(update));
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0].count).toBe(313);
        const { entries, published } = SetProposals.lookup(['live-7']);
        expect(entries).toHaveLength(51);
        expect(published).toMatchObject({ total: 313, more: 262 });
        expect(published.choices).toEqual([{ type: 'park', goals: ['park'], count: 208 }, { type: 'road', goals: ['road-track'], count: 104 }]);
    });

    it('keeps the held count and reports the error when the index cannot answer', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }], fail: true });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        SetProposals.count(['live-7'], update => updates.push(update));
        env.open();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]).toEqual({ count: 1, loading: false, error: 'down' });
    });

    it('asks nothing for open ground: it has no cadastral parcel to ask by', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }] });
        env.root.LiveParcelFabric.explicitCadastreIds = () => [];
        const SetProposals = loadWithRoot(env.root);
        expect(SetProposals.count(['ground-1'], () => {})).toEqual({ count: 1, loading: false, error: null });
        expect(env.fetchCalls).toEqual([]);
    });
});

// A government parcel can carry hundreds of designs: the list shows the newest page with the true
// total, pages on with "Show more", and narrows by search and type through the index.
describe('a parcel set\'s design list at scale', () => {
    async function mounted(count = 120, local = []) {
        const env = browser({ local, answer: indexOf(count) });
        env.root.BusyControl = { track: (_control, work) => Promise.resolve(work()) };
        env.root.ObjectList = require('../../frontend/js/ui/object-list.js');
        const SetProposals = loadWithRoot(env.root);
        env.open();
        const doc = makeDocument();
        const container = doc.createElement('div');
        doc.body.appendChild(container);
        const counts = [];
        env.root.getProposalLadder = () => ({ label: 'Published', rung: 'published' });
        env.root.getProposalDisplayTypeLabel = () => '';
        env.root.ProposalDisplayText = { text: name => name };
        env.root.RecordLabel = require('../../frontend/js/ui/record-label.js');
        SetProposals.render(container, ['live-7'], { onCount: total => counts.push(total) });
        const titles = () => container.querySelectorAll('.proposal-item-title [data-proposal-pick]').map(button => button.textContent);
        // Settled: the index has answered and no "Checking published designs…" line is left.
        await vi.waitFor(() => expect(titles().length > local.length && !container.querySelector('.parcel-set-proposals-status')).toBe(true));
        return { env, container, counts, titles };
    }

    it('shows the newest page with the full total, and the next page on "Show more"', async () => {
        const { env, container, counts, titles } = await mounted(120);
        expect(titles()).toHaveLength(50);
        expect(titles()[0]).toBe('Design 0');
        expect(container.querySelector('.parcel-set-proposals-summary').textContent).toBe('120 designs on these parcels');
        expect(counts.at(-1)).toBe(120);
        container.querySelector('[data-parcel-set-more]').click();
        await vi.waitFor(() => expect(titles()).toHaveLength(100));
        expect(env.fetchCalls.at(-1)).toBe('https://api.test/designs?parcel=HR-1-7&city=zagreb&limit=50&offset=50');
        expect(container.querySelector('[data-parcel-set-more]').textContent).toBe('Show more (20 left)');
    });

    it('filters by type through the index, with each type\'s count, and searches titles', async () => {
        const { env, container, counts, titles } = await mounted(120);
        const toolbar = container.querySelector('.parcel-set-proposals-toolbar');
        expect(toolbar.hidden).toBe(false);
        const type = toolbar.querySelector('[data-parcel-set-type]');
        expect(type.querySelectorAll('option').map(option => option.textContent)).toEqual(['All types', 'park (80)', 'road (40)']);
        type.value = 'road';
        type.dispatchEvent(makeEvent('change', { target: type }));
        await vi.waitFor(() => expect(titles()).toHaveLength(40));
        expect(env.fetchCalls.at(-1)).toContain('goal=road-track');
        expect(titles().slice(0, 2)).toEqual(['Design 0', 'Design 3']);
        // A filtered list does not change the tab's count, which counts every design on the parcel
        // (before the index answered, it counted what this browser holds: none).
        expect(counts[0]).toBe(0);
        expect(counts.slice(1).every(total => total === 120)).toBe(true);
        expect(container.querySelector('[data-parcel-set-more]')).toBe(null);
    });

    it('lists this browser\'s drafts among the published ones by date, and narrows them by the same search', async () => {
        const draft = { proposalId: 'p-draft', title: 'Draft plaza', goal: 'park', createdAt: '2026-11-01T00:00:00.000Z' };
        const { container, titles } = await mounted(10, [draft]);
        expect(titles()[0]).toBe('Draft plaza');
        expect(titles()).toHaveLength(11);
        const search = container.querySelector('[data-parcel-set-search]');
        search.value = 'design 1';
        vi.useFakeTimers();
        search.dispatchEvent(makeEvent('input', { target: search }));
        vi.advanceTimersByTime(400);
        vi.useRealTimers();
        await vi.waitFor(() => expect(titles()).toEqual(['Design 1']));
    });
});
