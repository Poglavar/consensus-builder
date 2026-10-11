// Exercise proposal-list retry against the real cache/fetch orchestration, including render re-entry.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('function resetServerProposalCache('), source.indexOf('async function fetchServerProposalById('));

function harness(fetch) {
    const cache = { proposals: [], count: null, loading: false, lastCity: 'zagreb', lastFetchedAt: 0 };
    let api;
    const render = vi.fn(() => api.ensure('zagreb'));
    api = new Function('serverProposalCache', 'proposalListState', 'normalizeCityCodeForApi',
        'resolveCurrentCityCode', 'resolveBackendBaseUrl', 'normalizeServerProposalSummary',
        'SERVER_PROPOSAL_SUMMARY_LIMIT', 'window', 'fetch', 'renderProposalListModal',
        `${body} return { ensure: ensureServerProposals, fetch: fetchServerProposalSummaries };`)(
        cache, { source: 'server', searchText: '', sortKey: '' }, city => city,
        () => 'zagreb', () => 'http://backend', row => row, 250, {}, fetch, render);
    return { ...api, cache, render };
}

const success = () => ({ ok: true, json: async () => ({ proposals: [], count: 0 }) });

describe('explicit server proposal retry', () => {
    it('retries a failed request while ordinary rendering reuses the failed attempt', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false, text: async () => 'Temporary outage' })
            .mockResolvedValueOnce(success());
        const { ensure, fetch: fetchSummaries, cache } = harness(fetch);
        await fetchSummaries('zagreb');
        expect(cache.error).toBe('Temporary outage');
        expect(cache.lastFetchedAt).toBeGreaterThan(0);
        ensure('zagreb');
        expect(fetch).toHaveBeenCalledTimes(1);

        await ensure('zagreb', { force: true });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(cache.error).toBeNull();
        expect(cache.loading).toBe(false);
        expect(cache.count).toBe(0);
        ensure('zagreb');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not start duplicate retries while the request is in flight', async () => {
        let finish;
        const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const { ensure, cache } = harness(fetch);
        const pending = ensure('zagreb', { force: true });
        expect(cache.loading).toBe(true);
        ensure('zagreb', { force: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        finish(success());
        await pending;
        expect(cache.loading).toBe(false);
    });

    it('keeps an empty successful list cached through subsequent renders', async () => {
        const fetch = vi.fn().mockResolvedValue(success());
        const { ensure, fetch: fetchSummaries, cache } = harness(fetch);
        await fetchSummaries('zagreb');
        ensure('zagreb');
        ensure('zagreb');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(cache.proposals).toEqual([]);
        expect(cache.error).toBeNull();
    });
});
