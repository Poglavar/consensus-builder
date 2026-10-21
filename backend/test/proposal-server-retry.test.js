// Exercise the proposal list's Server tab retry against the real cache/fetch orchestration of
// proposals/design-sync.js (GET /designs), including render re-entry.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const source = readFileSync(new URL('../../frontend/js/proposals/design-sync.js', import.meta.url), 'utf8');

// The list's globals of design-sync.js run as the classic script the page loads; the cache and the
// list size are the page globals of proposals/data.js. Every render asks the list again, as the
// list's own render does.
function harness(fetch) {
    const cache = { proposals: [], count: null, loading: false, error: null, lastCity: 'zagreb', lastFetchedAt: 0 };
    const context = vm.createContext({
        document: {}, console: { log() {}, info() {}, warn() {}, error() {} }, URLSearchParams, Cid,
        serverProposalCache: cache, SERVER_PROPOSAL_SUMMARY_LIMIT: 250,
        normalizeCityCodeForApi: city => city, resolveBackendBaseUrl: () => 'http://backend', fetch
    });
    context.window = context;
    vm.runInContext(source, context);
    context.renderProposalListModal = vi.fn(() => context.ensureServerProposals('zagreb'));
    return { ensure: context.ensureServerProposals, fetch: context.fetchServerProposalSummaries, cache, render: context.renderProposalListModal };
}

const success = () => ({ ok: true, status: 200, json: async () => ({ designs: [] }) });

describe('explicit server proposal retry', () => {
    it('retries a failed request while ordinary rendering reuses the failed attempt', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Temporary outage' }) })
            .mockResolvedValueOnce(success());
        const { ensure, fetch: fetchSummaries, cache, render } = harness(fetch);
        await fetchSummaries('zagreb');
        expect(cache.error).toBe('Temporary outage');
        expect(cache.lastFetchedAt).toBeGreaterThan(0);
        expect(render).toHaveBeenCalled();
        ensure('zagreb');
        expect(fetch).toHaveBeenCalledTimes(1);

        await ensure('zagreb', { force: true });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe('http://backend/designs?limit=250&city=zagreb');
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

    it('takes an answer that is not a list of designs for a failure, not for an empty list', async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ proposals: [] }) });
        const { fetch: fetchSummaries, cache } = harness(fetch);
        await fetchSummaries('zagreb');
        expect(cache.error).toBe('HTTP 200');
        expect(cache.count).toBeNull();
    });
});
