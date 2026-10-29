// The sidebar's "Proposals List" button carried TWO numbers that disagreed: a bracketed total and a
// circled count of unsaved work. Read side by side they looked like one of them was wrong.
//
// Now it carries one — the UNION of the list's three tabs. They overlap: Blockchain is the minted
// subset of Local, and a published local design is also a row of the designs index, so adding the
// tabs counts a proposal up to three times. And because half the number comes from the server, it is
// re-asked whenever the sidebar section becomes visible, not only at boot. The server half is the
// index's listing for the area (proposals/design-sync.js, GET /designs): the rows that came back.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const counts = require('../../frontend/js/proposals/counts.js');
const PlanningScene = require('../../frontend/js/planning/scene.js');
const Cid = require('../../frontend/js/cid.js');

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const listUi = read('../../frontend/js/proposals/list-ui.js');
const designSyncSource = read('../../frontend/js/proposals/design-sync.js');

const freshCache = (extra = {}) => ({
    proposals: [], count: null, loading: false, error: null, lastCity: null, lastFetchedAt: 0,
    lastQuery: null, countRefreshedAt: 0, countLoading: false, ...extra
});
// A row of GET /designs, as the index answers it.
const designRow = n => ({ cid: Cid.cidOfObject({ schema: 'design/v1', n }), title: `Design ${n}`, goal: 'park', city: 'sibenik',
    createdAt: '2026-10-21T10:00:00.000Z', binding: { parcels: [] } });

// The list's globals of proposals/design-sync.js, run as the classic script the page loads: the
// cache and the list size are the page globals of proposals/data.js, here the context's own.
function serverList({ fetch, cache = freshCache(), area = () => null } = {}) {
    const context = vm.createContext({
        document: {}, console: { log() {}, info() {}, warn: vi.fn(), error() {} }, URLSearchParams, Cid,
        serverProposalCache: cache, SERVER_PROPOSAL_SUMMARY_LIMIT: 250,
        normalizeCityCodeForApi: city => city, resolveBackendBaseUrl: () => 'http://backend',
        getProposalCountAreaContext: () => area(), renderProposalListModal: vi.fn(), updateShowProposalsButton: vi.fn(), fetch,
        PlanningScene, __proposalCounts: counts, AbortController
    });
    context.window = context;
    vm.runInContext(designSyncSource, context);
    return context;
}
const answer = (designs, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => (ok ? { designs } : { error: 'Index unavailable' }) });

/** Izvor između dvije oznake; kraj se traži OD početka, ne od nule. */
function sliceBetween(src, from, to) {
    const start = src.indexOf(from);
    expect(start, `nema "${from}"`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start);
    expect(end, `nema "${to}" iza toga`).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('unionProposalCount — jedan broj za tri kartice', () => {
    const local = n => Array.from({ length: n }, () => ({ onServer: false }));

    it('bez odgovora servera broji samo ono što je lokalno', () => {
        expect(counts.unionProposalCount(local(3), null)).toBe(3);
        expect(counts.unionProposalCount(local(3), undefined)).toBe(3);
        expect(counts.unionProposalCount(local(3), NaN)).toBe(3);
        expect(counts.unionProposalCount(local(3), -1)).toBe(3);
    });

    it('serverski ukupno + lokalni koji nikad nisu poslani', () => {
        const mix = [{ onServer: true }, { onServer: true }, { onServer: false }];
        expect(counts.unionProposalCount(mix, 10)).toBe(11);
    });

    it('poslani prijedlog se ne broji dvaput', () => {
        // Isti prijedlog je i lokalno i na serveru: zbrajanje kartica bi ga brojalo dvaput.
        expect(counts.unionProposalCount([{ onServer: true }], 1)).toBe(1);
        expect(counts.unionProposalCount([{ onServer: true }, { onServer: true }], 2)).toBe(2);
    });

    it('iskovan prijedlog nije treći primjerak — Blockchain je podskup Local', () => {
        // Blockchain kartica čita lokalnu pohranu, pa iskovan prijedlog već JEST u `local`.
        const minted = [{ onServer: true, minted: true }, { onServer: false, minted: true }];
        expect(counts.unionProposalCount(minted, 5)).toBe(6);
    });

    it('prazna lista i prazan server', () => {
        expect(counts.unionProposalCount([], 0)).toBe(0);
        expect(counts.unionProposalCount([], 7)).toBe(7);
        expect(counts.unionProposalCount(null, 4)).toBe(4);
        expect(counts.unionProposalCount(null, null)).toBe(0);
    });
});

describe('proposalIntersectsBounds — proposal area totals', () => {
    const bounds = { west: 15.9, south: 45.7, east: 16.1, north: 45.9 };
    it('uses stored bounds and nested building geometry without converting missing coordinates to zero', () => {
        expect(counts.proposalIntersectsBounds({ bounds: [15.95, 45.75, 16, 45.8] }, bounds)).toBe(true);
        expect(counts.proposalIntersectsBounds({ geometry: { buildings: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [16, 45.8] } }] } }, bounds)).toBe(true);
        expect(counts.proposalIntersectsBounds({ geometry: { type: 'Point', coordinates: [null, null] } }, { west: -1, south: -1, east: 1, north: 1 })).toBe(false);
        expect(counts.proposalIntersectsBounds({ geometry: { type: 'Point', coordinates: [0, 0] } }, { west: null, south: null, east: 1, north: 1 })).toBe(false);
    });
    it('includes a GeoJSON proposal whose geometry overlaps the viewport', () => {
        expect(counts.proposalIntersectsBounds({ geometry: {
            type: 'Polygon', coordinates: [[[15.95, 45.75], [16.2, 45.75], [16.2, 46], [15.95, 46], [15.95, 45.75]]]
        } }, bounds)).toBe(true);
    });
    it('includes known proposal geometry formats and excludes offscreen or geometry-less records', () => {
        expect(counts.proposalIntersectsBounds({ siteProposal: { geometry: {
            type: 'Point', coordinates: [16, 45.8]
        } } }, bounds)).toBe(true);
        expect(counts.proposalIntersectsBounds({ geometry: {
            type: 'Point', coordinates: [17, 46]
        } }, bounds)).toBe(false);
        expect(counts.proposalIntersectsBounds({ proposalId: 'no-shape' }, bounds)).toBe(false);
    });
    it('treats an unavailable viewport as unknown rather than inventing an area match', () => {
        expect(counts.proposalIntersectsBounds({ geometry: { type: 'Point', coordinates: [16, 45.8] } }, null)).toBe(false);
    });
});

describe('serverCountIsStale — kad ponovno pitati', () => {
    it('nikad pitano je uvijek zastarjelo', () => {
        expect(counts.serverCountIsStale(0, 1000, 15000)).toBe(true);
        expect(counts.serverCountIsStale(null, 1000, 15000)).toBe(true);
    });

    it('unutar prozora se ne pita ponovno', () => {
        expect(counts.serverCountIsStale(1000, 5000, 15000)).toBe(false);
    });

    it('iza prozora se pita', () => {
        expect(counts.serverCountIsStale(1000, 16000, 15000)).toBe(true);
        expect(counts.serverCountIsStale(1000, 16001, 15000)).toBe(true);
    });
});

describe('area proposal count and filtered summaries', () => {
    it('only lets an unfiltered summary replace the full-area count', () => {
        expect(counts.summaryUpdatesAreaCount('')).toBe(true);
        expect(counts.summaryUpdatesAreaCount('   ')).toBe(true);
        expect(counts.summaryUpdatesAreaCount('park')).toBe(false);
    });
});

describe('osvježavanje serverskog broja', () => {
    const sibenik = { explore: false, city: 'sibenik', key: 'city:sibenik' };

    it('pita indeks /designs za taj grad i broji retke koji su stigli', async () => {
        const fetch = vi.fn(async () => answer([designRow(1), designRow(2), designRow(3)]));
        const list = serverList({ fetch, area: () => sibenik });
        await expect(list.refreshServerProposalCount('sibenik')).resolves.toBe(3);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('http://backend/designs?limit=250&city=sibenik');
        expect(list.serverProposalCache.count).toBe(3);
        expect(list.serverProposalCache.proposals.map(row => row.cid)).toEqual([1, 2, 3].map(n => designRow(n).cid));
    });

    it('records the count under the list\'s own key, so the next list render does not refetch', async () => {
        // ensureServerProposals compares lastCity with the area key; the bare city here made every
        // count refresh look like a move to another area, wiping and refetching the list
        const fetch = vi.fn(async () => answer([designRow(1)]));
        const list = serverList({ fetch, area: () => sibenik });
        await list.refreshServerProposalCount();
        expect(list.serverProposalCache).toMatchObject({ count: 1, lastCity: 'city:sibenik', countAreaKey: 'city:sibenik' });
        list.ensureServerProposals('sibenik');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('requests the active Explore viewport, snapped to the viewport grid, instead of a city total', async () => {
        const fetch = vi.fn(async () => answer([]));
        const list = serverList({ fetch, area: () => ({ explore: true, city: null, bbox: [15.9, 45.7, 16.1, 45.9], key: 'explore:15.9,45.7,16.1,45.9' }) });
        await list.refreshServerProposalCount();
        expect(fetch.mock.calls[0][0]).toBe('http://backend/designs?limit=250&bbox=15.872%2C45.696%2C16.128%2C45.92');
    });

    it('drops an answer for the previous Explore viewport once the next refresh has moved the area', async () => {
        let area = { explore: true, city: null, bbox: [15.9, 45.7, 16.1, 45.9], key: 'explore:old' };
        const replies = [];
        const fetch = vi.fn(() => new Promise(resolve => replies.push(resolve)));
        const list = serverList({ fetch, area: () => area });
        const stale = list.refreshServerProposalCount();
        area = { ...area, bbox: [16.3, 45.7, 16.5, 45.9], key: 'explore:new' };
        const current = list.refreshServerProposalCount();
        expect(fetch).toHaveBeenCalledTimes(2);
        replies[0](answer([designRow(1), designRow(2)]));
        await stale;
        expect(list.serverProposalCache.count).toBeNull();
        replies[1](answer([designRow(3)]));
        await current;
        expect(list.serverProposalCache).toMatchObject({ count: 1, countAreaKey: 'explore:new', loading: false });
    });

    it('drugi put unutar prozora ne ide na mrežu', async () => {
        const fetch = vi.fn(async () => answer([designRow(1)]));
        const list = serverList({ fetch, area: () => sibenik });
        await list.refreshServerProposalCount('sibenik');
        await list.refreshServerProposalCount('sibenik');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('neuspjeh zadrži prethodni broj, zapiše grešku i ne ostavi listu u učitavanju', async () => {
        const cache = freshCache({ count: 7, lastCity: 'city:sibenik', countAreaKey: 'city:sibenik' });
        const list = serverList({ fetch: vi.fn(async () => answer(null, false)), cache, area: () => sibenik });
        await list.refreshServerProposalCount('sibenik');
        expect(cache.count).toBe(7);              // prazan gumb je gori od starog broja
        expect(cache.error).toBe('Unable to load published designs. Check the connection and retry.'); // the user sentence, not the server's raw error (3d29268e4)
        expect(cache.loading).toBe(false);
        expect(list.updateShowProposalsButton).toHaveBeenCalled();
    });

    it('osvježi gumb kad broj stigne', async () => {
        const list = serverList({ fetch: vi.fn(async () => answer([designRow(1)])), area: () => sibenik });
        await list.refreshServerProposalCount('sibenik');
        expect(list.updateShowProposalsButton).toHaveBeenCalled();
    });

    it('ne pita dok je dohvat sažetaka u tijeku — donijet će isti broj', async () => {
        const cache = freshCache({ loading: true, lastCity: 'city:sibenik', countAreaKey: 'city:sibenik' });
        const fetch = vi.fn(async () => answer([]));
        const list = serverList({ fetch, cache, area: () => sibenik });
        await list.refreshServerProposalCount('sibenik');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('gumb u bočnoj traci', () => {
    it('piše točno jedan broj — druga, zaokružena brojka je maknuta', () => {
        const fn = sliceBetween(listUi, 'function updateShowProposalsButton() {', 'function watchProposalsSectionVisibility');
        expect(fn).not.toContain('proposal-unsaved-count');
        expect(fn).not.toContain('appendChild');
        expect(fn.match(/button\.textContent =/g)).toHaveLength(3);   // loading + i18n + fallback
        expect(fn).toContain('const state = proposalUnionCountNow();');
        expect(fn).toContain("'data-proposal-count-ready'");
    });

    it('broji "na serveru" istim testom kojim kartica crta svoju značku', () => {
        // A local design is on the server while it still hashes to its published CID
        // (DesignSync.publishedCid), the predicate the card's save state reads too.
        const fn = sliceBetween(listUi, 'function getProposalCountAreaContext() {', 'function markProposalCountAreaOpened');
        const records = [{ proposalId: 'published-a' }, { proposalId: 'published-b' }, { proposalId: 'draft' }];
        const publishedCid = vi.fn(record => (record.proposalId.startsWith('published') ? designRow(record.proposalId).cid : null));
        const unionNow = new Function('window', 'proposalStorage', 'serverProposalCache', 'getCurrentCityId',
            `let _proposalCountArrivalCenter = null; ${fn} return proposalUnionCountNow;`)(
            { __proposalCounts: counts, DesignSync: { publishedCid },
                CityConfigManager: { getCurrentCityConfig: () => ({ id: 'sibenik' }), getCityCodeForCityId: id => id } },
            { getAllProposals: () => records }, { count: 5, countAreaKey: 'city:sibenik' }, () => 'sibenik');
        // Five on the server, two of them held here, plus the one draft never published.
        expect(unionNow()).toMatchObject({ count: 6, ready: true });
        expect(publishedCid).toHaveBeenCalledTimes(3);
    });

    it('starts a fresh city or Explore-area count after app arrival', () => {
        expect(listUi).toContain("window.addEventListener('cityChanged', onCityChanged)");
        expect(listUi).toContain("window.addEventListener('worldview:landed'");
        expect(listUi).toContain("map.on('moveend zoomend'");
        expect(listUi).toContain('refreshServerProposalCount()');
        expect(listUi).toContain('window.whenAppBooted()');
    });

    it('waits for delayed app boot before attaching the viewport listener and fetching Explore count', async () => {
        const body = sliceBetween(listUi, 'function watchProposalCountArrival() {', '// Half the count is local');
        let resolveBoot;
        const bootPromise = new Promise(resolve => { resolveBoot = resolve; });
        const fakeMap = { on: vi.fn() };
        const fakeWindow = {
            whenAppBooted: vi.fn(() => bootPromise),
            addEventListener: vi.fn(),
            map: null
        };
        const refresh = vi.fn();
        const update = vi.fn();
        const watch = new Function('window', 'getProposalCountAreaContext', 'updateShowProposalsButton',
            'refreshServerProposalCount', 'captureProposalCountArrivalCenter', 'setTimeout', 'clearTimeout',
            `let _proposalCountArrivalWatching = false; let _proposalCountViewportTimer = null; ${body} return watchProposalCountArrival;`)(
            fakeWindow, () => ({ explore: true }), update, refresh, vi.fn(), setTimeout, clearTimeout);
        watch();
        expect(fakeWindow.whenAppBooted).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
        fakeWindow.map = fakeMap;
        resolveBoot();
        await bootPromise;
        await Promise.resolve();
        expect(fakeMap.on).toHaveBeenCalledWith('moveend zoomend', expect.any(Function));
        expect(update).toHaveBeenCalled();
        expect(refresh).toHaveBeenCalled();
    });

    it('uses the entered Explore center for the pulse key, not the current pan center', () => {
        const contextHelper = sliceBetween(listUi, 'function getProposalCountAreaContext() {', 'function proposalUnionCountNow');
        const getContext = new Function('window', 'getCurrentCityId', 'normalizeCityCodeForApi',
            `let _proposalCountArrivalCenter = [44.8, 16.1]; ${contextHelper} return getProposalCountAreaContext;`)(
            { CityConfigManager: { isExplore: () => true, getCurrentCityConfig: () => ({ id: 'explore', explore: true, map: { defaultCenter: [44.8, 16.1] } }) },
                map: { getBounds: () => ({ getWest: () => 15.9, getSouth: () => 44.7, getEast: () => 16.2, getNorth: () => 44.9 }),
                    getCenter: () => ({ lat: 45.1, lng: 17.2 }) } }, () => 'explore', city => city);
        const area = getContext();
        expect(area.arrivalKey).toBe('explore:44.8,16.1');
        expect(area.key).toBe('explore:15.9,44.7,16.2,44.9');
    });

    it('osvježava se kad sekcija postane vidljiva, i lokalno i sa servera', () => {
        const fn = sliceBetween(listUi, 'function watchProposalsSectionVisibility() {', 'function handleMultiSelectChange');
        expect(fn).toContain('new IntersectionObserver');
        expect(fn).toContain('observer.observe(button)');
        expect(fn).toContain('entries.some(entry => entry.isIntersecting)');
        expect(fn).toContain('updateShowProposalsButton();');
        expect(fn).toContain('refreshServerProposalCount()');
        // Zove se iz updateShowProposalsButton, koji ide na svaku promjenu prijedloga.
        expect(fn).toContain('button.__proposalCountObserved');
    });

    it('modul se učitava u stranici', () => {
        expect(read('../../frontend/index.html')).toContain("'js/proposals/counts.js'");
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s više ne prevodi maknutu značku', locale => {
        const dict = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dict.sidebar.proposals.unsavedCount).toBeUndefined();
        expect(dict.sidebar.proposals.listButton).toContain('{{count}}');
    });

    it('keš zna za svoje novo polje, i briše ga pri promjeni grada', () => {
        expect(read('../../frontend/js/proposals/data.js')).toContain('countRefreshedAt: 0');
        const cache = freshCache({ proposals: [designRow(1)], count: 1, countRefreshedAt: 1234, lastFetchedAt: 1234,
            lastCity: 'city:zadar', countAreaKey: 'city:zadar' });
        serverList({ fetch: vi.fn(), cache }).resetServerProposalCache('city:sibenik');
        expect(cache).toMatchObject({ proposals: [], count: null, countRefreshedAt: 0, lastFetchedAt: 0, lastCity: 'city:sibenik', countAreaKey: null });
    });
});
