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
        expect(fn.match(/button\.textContent =/g)).toHaveLength(2);   // i18n grana + zamjenska
        expect(fn).toContain('const totalProposals = proposalUnionCountNow();');
    });

    it('broji "na serveru" istim testom kojim kartica crta svoju značku', () => {
        // p.serverProposalId je uže: PREUZET prijedlog nosi serijski broj kao proposalId/id, pa bi
        // ga uži test proglasio samo-lokalnim i zbrojio dvaput.
        const fn = sliceBetween(listUi, 'function proposalUnionCountNow() {', 'function updateShowProposalsButton');
        expect(fn).toContain('getSerialProposalId(proposal)');
        expect(fn).toContain('counts.unionProposalCount(local, serverProposalCache.count)');
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
