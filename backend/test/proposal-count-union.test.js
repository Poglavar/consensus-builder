// The sidebar's "Proposals List" button carried TWO numbers that disagreed: a bracketed total and a
// circled count of unsaved work. Read side by side they looked like one of them was wrong.
//
// Now it carries one — the UNION of the list's three tabs. They overlap: Blockchain is the minted
// subset of Local, and an uploaded local proposal is also a server row, so adding the tabs counts a
// proposal up to three times. And because half the number comes from the server, it is re-asked
// whenever the sidebar section becomes visible, not only at boot.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const counts = require('../../frontend/js/proposals/counts.js');

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const listUi = read('../../frontend/js/proposals/list-ui.js');
const serverSync = read('../../frontend/js/proposals/server-sync.js');

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
    const body = sliceBetween(serverSync, "// How long the sidebar's server count",
        '// The sort keys the SERVER can order by');

    function harness({ ok = true, count = 42, cache } = {}) {
        const serverProposalCache = cache || {
            proposals: [{ id: 1 }], count: null, loading: false, error: null,
            lastCity: 'sibenik', lastFetchedAt: 0, lastQuery: null,
            countRefreshedAt: 0, countLoading: false
        };
        const fetchSpy = vi.fn(async () => ({
            ok,
            status: ok ? 200 : 503,
            json: async () => ({ count })
        }));
        const updateShowProposalsButton = vi.fn();
        const run = new Function('normalizeCityCodeForApi', 'resolveCurrentCityCode', 'resolveBackendBaseUrl',
            'serverProposalCache', 'resetServerProposalCache', 'window', 'fetch', 'console',
            'updateShowProposalsButton', `${body} return refreshServerProposalCount;`)(
            city => city, () => 'sibenik', () => 'http://backend',
            serverProposalCache, vi.fn(), { __proposalCounts: counts }, fetchSpy,
            { warn: vi.fn(), error: vi.fn() }, updateShowProposalsButton);
        return { run, serverProposalCache, fetchSpy, updateShowProposalsButton };
    }

    it('pita jeftini /proposals/count za taj grad, ne 250 sažetaka', async () => {
        const { run, fetchSpy, serverProposalCache } = harness();
        await run('sibenik');
        expect(fetchSpy).toHaveBeenCalledWith('http://backend/proposals/count?city=sibenik');
        expect(serverProposalCache.count).toBe(42);
    });

    it('records the count under the list\'s own key, so the next list render does not refetch', async () => {
        // ensureServerProposals compares lastCity with the area key; the bare city here made every
        // count refresh look like a move to another area, wiping and refetching the list
        const context = { explore: false, city: 'sibenik', key: 'city:sibenik' };
        const { serverProposalCache, fetchSpy } = harness();
        const body = sliceBetween(serverSync, "// How long the sidebar's server count", '// The sort keys the SERVER can order by');
        await new Function('normalizeCityCodeForApi', 'resolveCurrentCityCode', 'resolveBackendBaseUrl',
            'serverProposalCache', 'resetServerProposalCache', 'window', 'fetch', 'console',
            'updateShowProposalsButton', `${body} return refreshServerProposalCount;`)(
            city => city, () => 'sibenik', () => 'http://backend', serverProposalCache, vi.fn(),
            { __proposalCounts: counts, getProposalCountAreaContext: () => context }, fetchSpy,
            { warn: vi.fn(), error: vi.fn() }, vi.fn())();
        expect(serverProposalCache.count).toBe(42);
        expect(serverProposalCache.lastCity).toBe('city:sibenik');
    });

    it('requests the active Explore viewport bounds instead of a city total', async () => {
        const context = { explore: true, city: null, bbox: [15.9, 45.7, 16.1, 45.9], key: 'explore:15.9,45.7,16.1,45.9' };
        const { run, fetchSpy, serverProposalCache } = harness();
        // Rebuild the isolated function with the browser's current area context exposed.
        const body = sliceBetween(serverSync, "// How long the sidebar's server count", '// The sort keys the SERVER can order by');
        const contextualRun = new Function('normalizeCityCodeForApi', 'resolveCurrentCityCode', 'resolveBackendBaseUrl',
            'serverProposalCache', 'resetServerProposalCache', 'window', 'fetch', 'console',
            'updateShowProposalsButton', `${body} return refreshServerProposalCount;`)(
            city => city, () => 'explore', () => 'http://backend', serverProposalCache, vi.fn(),
            { __proposalCounts: counts, getProposalCountAreaContext: () => context }, fetchSpy,
            { warn: vi.fn(), error: vi.fn() }, vi.fn());
        await contextualRun();
        expect(fetchSpy).toHaveBeenCalledWith('http://backend/proposals/count?bbox=15.9%2C45.7%2C16.1%2C45.9');
    });

    it('does not apply a count response after the user has moved to another Explore viewport', async () => {
        let context = { explore: true, city: null, bbox: [15.9, 45.7, 16.1, 45.9], key: 'explore:old' };
        let resolveResponse;
        const response = new Promise(resolve => { resolveResponse = resolve; });
        const cache = {
            proposals: [], count: null, loading: false, error: null,
            lastCity: 'explore', lastFetchedAt: 0, lastQuery: null,
            countRefreshedAt: 0, countLoading: false
        };
        const fetchSpy = vi.fn(() => response);
        const refresh = new Function('normalizeCityCodeForApi', 'resolveCurrentCityCode', 'resolveBackendBaseUrl',
            'serverProposalCache', 'resetServerProposalCache', 'window', 'fetch', 'console',
            'updateShowProposalsButton', `${sliceBetween(serverSync, "// How long the sidebar's server count", '// The sort keys the SERVER can order by')} return refreshServerProposalCount;`)(
            city => city, () => 'explore', () => 'http://backend', cache, vi.fn(),
            { __proposalCounts: counts, getProposalCountAreaContext: () => context }, fetchSpy,
            { warn: vi.fn(), error: vi.fn() }, vi.fn());
        const pending = refresh();
        context = { ...context, bbox: [16.3, 45.7, 16.5, 45.9], key: 'explore:new' };
        resolveResponse({ ok: true, json: async () => ({ count: 99 }) });
        await pending;
        expect(cache.count).toBeNull();
    });

    it('NE dira lastFetchedAt ni keširane retke', async () => {
        // lastFetchedAt znači "jesmo li tražili SAŽETKE"; kad bi ga ovo postavilo, lista bi mislila
        // da već ima retke koje nikad nije dohvatila i server kartica bi ostala prazna.
        const { run, serverProposalCache } = harness();
        await run('sibenik');
        expect(serverProposalCache.lastFetchedAt).toBe(0);
        expect(serverProposalCache.proposals).toHaveLength(1);
        expect(serverProposalCache.countRefreshedAt).toBeGreaterThan(0);
    });

    it('drugi put unutar prozora ne ide na mrežu', async () => {
        const { run, fetchSpy } = harness();
        await run('sibenik');
        await run('sibenik');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('neuspjeh zadrži prethodni broj i ne ostavi zaključan countLoading', async () => {
        const cache = {
            proposals: [], count: 7, loading: false, error: null, lastCity: 'sibenik',
            lastFetchedAt: 0, lastQuery: null, countRefreshedAt: 0, countLoading: false
        };
        const { run, updateShowProposalsButton } = harness({ ok: false, cache });
        await run('sibenik');
        expect(cache.count).toBe(7);              // prazan gumb je gori od starog broja
        expect(cache.countLoading).toBe(false);
        expect(updateShowProposalsButton).toHaveBeenCalled();
    });

    it('osvježi gumb kad broj stigne', async () => {
        const { run, updateShowProposalsButton } = harness();
        await run('sibenik');
        expect(updateShowProposalsButton).toHaveBeenCalled();
    });

    it('ne pita dok je dohvat sažetaka u tijeku — donijet će isti broj', async () => {
        const cache = {
            proposals: [], count: null, loading: true, error: null, lastCity: 'sibenik',
            lastFetchedAt: 0, lastQuery: null, countRefreshedAt: 0, countLoading: false
        };
        const { run, fetchSpy } = harness({ cache });
        await run('sibenik');
        expect(fetchSpy).not.toHaveBeenCalled();
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
        // p.serverProposalId je uže: PREUZET prijedlog nosi serijski broj kao proposalId/id, pa bi
        // ga uži test proglasio samo-lokalnim i zbrojio dvaput.
        const fn = sliceBetween(listUi, 'function proposalUnionCountNow() {', 'function markProposalCountAreaOpened');
        expect(fn).toContain('getSerialProposalId(proposal)');
        expect(fn).toContain('counts.unionProposalCount(local, serverCount)');
        expect(fn).toContain('proposalIntersectsBounds');
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
        const reset = sliceBetween(serverSync, 'function resetServerProposalCache(cityCode) {',
            "// How long the sidebar's server count");
        expect(reset).toContain('serverProposalCache.countRefreshedAt = 0;');
    });
});
