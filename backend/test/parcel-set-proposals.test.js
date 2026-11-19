// The Proposals tab for a set of parcels (frontend/js/parcels/parcel-set-proposals.js): a multi-parcel
// selection or a drawn site lists each proposal once with the parcels of the set it covers.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { makeDocument, makeEvent } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const SetProposals = require('../../frontend/js/parcels/parcel-set-proposals.js');

const proposals = {
    road: { proposalId: 'p-road', title: 'Road <b>', createdAt: '2026-10-03T10:00:00.000Z' },
    park: { proposalId: 'p-park', title: 'Park', createdAt: '2026-10-01T10:00:00.000Z' },
    block: { proposalId: 'p-block', title: 'Block', createdAt: '2026-10-02T10:00:00.000Z' }
};
const byParcel = { a: [proposals.park, proposals.road], b: [proposals.road], c: [proposals.road, proposals.block] };
const forParcel = id => byParcel[id] || [];
const PARK_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const NEW_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const describe_ = proposal => ({ title: proposal.title, typeLabel: 'Type', statusText: 'Draft', statusClass: 'draft', thumbHtml: '' });

describe('proposals on a set of parcels', () => {
    // An owner reading the designs sent against their land reads the latest first.
    it('lists each proposal once with every parcel it covers, newest first or oldest first, ties in the order met', () => {
        const entries = SetProposals.collect(['a', 'b', 'c', 'a'], forParcel, proposal => proposal.proposalId);
        expect(entries.map(entry => [entry.key, entry.parcelIds])).toEqual([
            ['p-road', ['a', 'b', 'c']],
            ['p-block', ['c']],
            ['p-park', ['a']]
        ]);
        expect(SetProposals.collect(['a', 'b', 'c'], forParcel, p => p.proposalId, { order: 'oldest' }).map(entry => entry.key))
            .toEqual(['p-park', 'p-block', 'p-road']);
        // A published design is ordered by its publication, a draft by its making; undated ones keep their order.
        const published = { proposalId: 'p-pub', createdAt: '2026-01-01T00:00:00.000Z', published: { publishedAt: '2026-10-05T00:00:00.000Z' } };
        const undated = [{ proposalId: 'u1' }, { proposalId: 'u2' }];
        expect(SetProposals.collect(['a'], () => [proposals.road, published], p => p.proposalId).map(entry => entry.key)).toEqual(['p-pub', 'p-road']);
        expect(SetProposals.collect(['a'], () => undated, p => p.proposalId).map(entry => entry.key)).toEqual(['u1', 'u2']);
    });

    it('matches a search on the title or author in any case, and a type through the given typeOf', () => {
        const typeOf = proposal => (proposal.goal === 'road-track' ? 'road' : 'park');
        const road = { title: 'Ring Road', author: 'City Studio', goal: 'road-track' };
        expect(SetProposals.matchesQuery(road, { q: 'ring' }, typeOf)).toBe(true);
        expect(SetProposals.matchesQuery(road, { q: 'STUDIO' }, typeOf)).toBe(true);
        expect(SetProposals.matchesQuery(road, { q: 'park' }, typeOf)).toBe(false);
        expect(SetProposals.matchesQuery(road, { type: 'road' }, typeOf)).toBe(true);
        expect(SetProposals.matchesQuery(road, { type: 'park' }, typeOf)).toBe(false);
        expect(SetProposals.matchesQuery(road, {}, typeOf)).toBe(true);
    });

    it('offers one type choice per display type with the goals it stands for, most designs first', () => {
        const typeOf = ({ goal }) => ({ single: 'building', row: 'building', 'road-track': 'road', park: 'park' }[goal] || 'other');
        expect(SetProposals.typeChoices({ park: 2, single: 3, row: 4, 'road-track': 9 }, typeOf)).toEqual([
            { type: 'road', goals: ['road-track'], count: 9 },
            { type: 'building', goals: ['single', 'row'], count: 7 },
            { type: 'park', goals: ['park'], count: 2 }
        ]);
        expect(SetProposals.typeChoices(null, typeOf)).toEqual([]);
    });

    it('asks the index for a parcel set by its parcels, a page at a time', () => {
        expect(SetProposals.publishedPath({ parcelIds: ['HR-1/2', 'HR-3'], city: 'zagreb', facets: true }))
            .toBe('/designs?parcel=HR-1%2F2%2CHR-3&city=zagreb&limit=50&facets=goal');
        expect(SetProposals.publishedPath({ parcelIds: ['P'], query: { q: ' ring ', order: 'oldest' }, goals: ['single', 'row'], offset: 50 }))
            .toBe('/designs?parcel=P&q=ring&goal=single%2Crow&order=oldest&limit=50&offset=50');
        const many = Array.from({ length: 600 }, (_, i) => `p${i}`);
        expect(new URLSearchParams(SetProposals.publishedPath({ parcelIds: many }).split('?')[1]).get('parcel').split(',')).toHaveLength(500);
    });

    it('skips proposals without an identity', () => {
        expect(SetProposals.collect(['a'], () => [{ title: 'x' }], proposal => proposal.proposalId)).toEqual([]);
    });

    it('renders a total, rows that open their proposal, coverage only for several parcels, escaped text', () => {
        const entries = SetProposals.collect(['a', 'b', 'c'], forParcel, proposal => proposal.proposalId);
        const html = SetProposals.listHtml(entries, { parcelCount: 3, describe: describe_ });
        expect(html).toContain('3 designs on these parcels');
        expect(html).toContain('data-parcel-set-proposal="p-road" data-parcel-id="a"');
        expect(html).toContain('On 3 of 3 parcels');
        expect(html).toContain('Road &lt;b&gt;');
        const single = SetProposals.listHtml(SetProposals.collect(['a'], forParcel, p => p.proposalId), { parcelCount: 1, describe: describe_ });
        expect(single).not.toContain(' of 1 parcels');
    });

    it('adds published designs this browser does not hold, by the cadastral parcels the index bound them to', () => {
        const local = { a: [proposals.park] };
        // Index summaries (DesignSync.designSummary) are named by their CID.
        const held = { proposalId: PARK_CID, cid: PARK_CID, cadastreParcelIds: ['HR-a'] };
        const fresh = { proposalId: NEW_CID, cid: NEW_CID, cadastreParcelIds: ['HR-b', 'HR-c'] };
        const cadastral = { a: ['HR-a'], b: ['HR-b'], c: ['HR-c'], ground: [] };
        const merged = SetProposals.withPublished(id => local[id] || [], [held, fresh], id => cadastral[id], s => s.cid === PARK_CID);
        expect([...merged.publishedOnly]).toEqual([fresh]);
        expect(merged.proposalsForParcel('a')).toEqual([proposals.park]);
        expect(merged.proposalsForParcel('b')).toEqual([fresh]);
        expect(merged.proposalsForParcel('ground')).toEqual([]);
        const entries = SetProposals.collect(['a', 'b', 'c'], merged.proposalsForParcel, p => p.proposalId);
        expect(entries.map(entry => [entry.key, entry.parcelIds])).toEqual([['p-park', ['a']], [NEW_CID, ['b', 'c']]]);
    });

    it('marks published-only rows with the CID to import them from, and shows the lookup state', () => {
        const entry = { key: NEW_CID, proposal: { title: 'New' }, parcelIds: ['b'], serverId: NEW_CID };
        const html = SetProposals.listHtml([entry], { parcelCount: 2, describe: describe_, published: { loading: true } });
        expect(html).toContain(`data-server-id="${NEW_CID}"`);
        expect(html).toContain('Checking published proposals…');
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_, emptyText: false, published: { error: 'HTTP 500' } }))
            .toBe('<p class="parcel-set-proposals-status">Published proposals could not be loaded: HTTP 500</p>');
    });

    it('counts every design on the parcels, offers the rest a page at a time, and says when a search matches none', () => {
        const entry = { key: 'p-park', proposal: proposals.park, parcelIds: ['a'] };
        const paged = SetProposals.listHtml([entry], { parcelCount: 1, describe: describe_, published: { total: 312, more: 261 }, pageable: true });
        expect(paged).toContain('312 designs on these parcels');
        expect(paged).toContain('data-parcel-set-more');
        expect(paged).toContain('Show more (261 left)');
        // A list that cannot page (the site tool's) says how much of the total it shows instead.
        const partial = SetProposals.listHtml([entry], { parcelCount: 1, describe: describe_, published: { total: 312, more: 261 } });
        expect(partial).not.toContain('data-parcel-set-more');
        expect(partial).toContain('Showing the newest 1 of 262');
        expect(SetProposals.listHtml([], { parcelCount: 1, describe: describe_, filtered: true })).toContain('No designs match this search.');
    });

    it('says so when nothing stands on the parcels', () => {
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_ })).toContain('No designs on these parcels yet.');
        expect(SetProposals.listHtml([], { parcelCount: 2, describe: describe_, emptyText: 'Nothing here' })).toContain('Nothing here');
    });

    it('has its strings in en, es, hr and sr, with the plural forms each language needs', () => {
        for (const lang of ['en', 'es', 'hr', 'sr', 'ru', 'fr', 'pt', 'ar']) {
            const i18n = require(`../../frontend/i18n/${lang}.json`);
            const set = i18n.panel.parcel.setProposals;
            expect(typeof set.empty).toBe('string');
            expect(Object.keys(set.summary)).toContain('other');
            expect(Object.keys(set.covers)).toContain('other');
            if (lang === 'hr' || lang === 'sr') expect(Object.keys(set.summary)).toEqual(['one', 'few', 'other']);
            expect(typeof set.publishedHeading).toBe('string');
            expect(typeof set.loading).toBe('string');
            expect(typeof set.unavailable).toBe('string');
            for (const key of ['search', 'type', 'typeAll', 'order', 'newest', 'oldest', 'more', 'partial', 'noMatch']) expect(typeof set[key], `${lang} ${key}`).toBe('string');
            expect(typeof i18n.panel.parcel.historySection).toBe('string');
            expect(Object.keys(i18n.siteTool.proposals).sort()).toEqual(['existing', 'none', 'show']);
        }
    });
});

// The rows are an object list (docs/design-language.md, "Object lists"): hovering or focusing a row
// outlines its design, a click keeps it outlined (its name pressed) until clicked again, a click
// never opens it, and the row's arrow opens it (importing a published-only one first).
describe('proposal rows as an object list', () => {
    const shape = id => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [0, 0] } });
    function setup({ inView = true } = {}) {
        const doc = makeDocument();
        const host = doc.createElement('div');
        host.className = 'right-dock-panel';
        const container = doc.createElement('div');
        host.appendChild(container);
        doc.body.appendChild(host);
        const local = { proposalId: 'p-park', title: 'Park' };
        const published = { proposalId: NEW_CID, cid: NEW_CID, title: 'Published' };
        const entries = [{ key: 'p-park', proposal: local, parcelIds: ['a'] },
            { key: NEW_CID, proposal: published, parcelIds: ['b'], serverId: NEW_CID }];
        container.innerHTML = SetProposals.listHtml(entries, { parcelCount: 2, describe: describe_ });
        const calls = [];
        const log = name => vi.fn((...args) => calls.push([name, ...args]));
        const fitBounds = vi.fn();
        const win = {
            ObjectList: require('../../frontend/js/ui/object-list.js'),
            proposalStorage: { getProposal: id => (id === 'p-park' ? local : null) },
            ClickStackHits: { featuresFor: (kind, instance) => (instance.proposal ? [shape(`${kind}:${instance.proposal.title}`)] : []) },
            highlightFeaturesForHover: log('hover'),
            highlightFeaturesForInspection: log('inspect'),
            clearProposalHoverLayers: log('clear'),
            ClickStack: { holdsHighlight: () => true, restoreFocus: log('restoreFocus') },
            BusyControl: { track: (_control, work) => Promise.resolve(work()) },
            showProposalDetails: log('open'),
            getProposalKey: proposal => proposal.proposalId,
            DesignSync: { fetchDesign: vi.fn(async cid => ({ cid })), importDesign: vi.fn(async () => ({ proposalId: 'imported-1' })) },
            updateStatus: vi.fn(),
            // A 1000 × 800 map; the shape lies inside the free area or far outside it.
            L: { geoJSON: () => ({ getBounds: () => ({ isValid: () => true, getNorthWest: () => 'nw', getSouthEast: () => 'se' }) }) },
            map: { getSize: () => ({ x: 1000, y: 800 }), fitBounds,
                latLngToContainerPoint: corner => (inView ? { x: corner === 'nw' ? 100 : 200, y: corner === 'nw' ? 100 : 200 } : { x: corner === 'nw' ? 5000 : 5100, y: 100 }) },
            innerWidth: 1000, innerHeight: 800,
            proposalPanelFitPadding: () => ({ paddingTopLeft: [0, 0], paddingBottomRight: [0, 0] }),
            __clickStackModel: require('../../frontend/js/click-stack/click-stack-model.js')
        };
        const bound = SetProposals.bindRows(container, win);
        const [park, remote] = container.querySelectorAll('.proposal-item');
        return { doc, container, win, calls, fitBounds, bound, park, remote };
    }
    const move = (type, target, relatedTarget = null) => target.dispatchEvent(makeEvent(type, { target, relatedTarget }));
    const pick = row => row.querySelector('[data-proposal-pick]');

    it('outlines a hovered row, keeps a clicked one until it is clicked again, and never opens on a click', () => {
        const { calls, park, remote, win } = setup();
        move('mouseover', park);
        expect(calls.pop()).toEqual(['hover', [expect.objectContaining({ properties: { id: 'designs:Park' } })]]);
        move('mouseout', park, null);
        expect(calls.pop()).toEqual(['clear']);

        pick(park).click();
        expect(pick(park).getAttribute('aria-pressed')).toBe('true');
        expect(calls.slice(-2)).toEqual([['clear'], ['inspect', [expect.objectContaining({ properties: { id: 'designs:Park' } })], expect.any(Object)]]);
        // Another row's hover draws over the kept one (this published-only row was not listed through
        // lookup here, so no index record outlines it); leaving it keeps the kept row's outline.
        calls.length = 0;
        move('mouseover', remote);
        expect(calls).toEqual([['hover', []]]);
        move('mouseout', remote, null);
        expect(calls.pop()).toEqual(['clear']);

        pick(park).click();
        expect(pick(park).getAttribute('aria-pressed')).toBe('false');
        expect(calls.slice(-2)).toEqual([['clear'], ['restoreFocus']]);
        expect(win.showProposalDetails).not.toHaveBeenCalled();
    });

    it('moves the map only for a kept design that is out of view', () => {
        const near = setup({ inView: true });
        pick(near.park).click();
        expect(near.fitBounds).not.toHaveBeenCalled();
        const far = setup({ inView: false });
        pick(far.park).click();
        expect(far.fitBounds).toHaveBeenCalledTimes(1);
    });

    it('opens a row only by its arrow, importing a published-only design first', async () => {
        const { win, park, remote } = setup();
        park.querySelector('[data-proposal-open]').click();
        await vi.waitFor(() => expect(win.showProposalDetails).toHaveBeenCalledWith('p-park', 'a'));
        expect(pick(park).getAttribute('aria-pressed')).toBe('false');
        expect(park.querySelector('[data-proposal-open]').getAttribute('aria-label')).toBe('Open Park · p-park');
        remote.querySelector('[data-proposal-open]').click();
        await vi.waitFor(() => expect(win.showProposalDetails).toHaveBeenCalledWith('imported-1', 'b'));
        expect(win.DesignSync.fetchDesign).toHaveBeenCalledWith(NEW_CID);
    });

    it('binds a container once; binding it again lets go of the pressed row', () => {
        const { container, win, park, bound } = setup();
        pick(park).click();
        expect(bound.pinnedKey()).toBe('p-park');
        expect(SetProposals.bindRows(container, win)).toBe(bound);
        expect(bound.pinnedKey()).toBe(null);
        expect(pick(park).getAttribute('aria-pressed')).toBe('false');
    });
});
