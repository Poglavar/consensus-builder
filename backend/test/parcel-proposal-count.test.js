// The number on the parcel menu's "Proposals (N)" (ParcelSetProposals.count in
// frontend/js/parcels/parcel-set-proposals.js): the proposals this browser holds on the parcel plus
// the published ones it holds no copy of, settled once the server answers, and the same entries the
// parcel panel's Proposals tab lists.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODULE = require.resolve('../../frontend/js/parcels/parcel-set-proposals.js');

// The module binds to `window` when one exists; give it a browser of stubs.
function loadWithRoot(root) {
    delete require.cache[MODULE];
    globalThis.window = root;
    try { return require(MODULE); } finally { delete globalThis.window; }
}

function browser({ local = [], published = [], held = new Set(), fail = false } = {}) {
    const fetchCalls = [];
    let resolveFetch;
    const answered = new Promise(resolve => { resolveFetch = resolve; });
    globalThis.fetch = vi.fn(url => {
        fetchCalls.push(url);
        return answered.then(() => (fail
            ? { ok: false, status: 503, text: async () => 'down' }
            : { ok: true, json: async () => ({ proposals: published }) }));
    });
    const root = {
        proposalStorage: { getProposalsForParcel: () => local },
        LiveParcelFabric: { get: id => ({ id }), explicitCadastreIds: () => ['HR-1-7'] },
        normalizeCityCodeForApi: city => city,
        resolveCurrentCityCode: () => 'zagreb',
        resolveBackendBaseUrl: () => 'https://api.test',
        normalizeServerProposalSummary: raw => ({ ...raw, proposalId: `c2-${raw.id}`, serverProposalId: String(raw.id), cadastreParcelIds: raw.cadastreParcelIds }),
        findLocalCopyOfServerProposal: summary => (held.has(String(summary.id)) ? {} : null)
    };
    return { root, fetchCalls, answer: () => resolveFetch() };
}

afterEach(() => { delete globalThis.fetch; });

describe('Proposals (N) on the parcel menu', () => {
    it('counts what is held here at once, then adds the published ones not held, once the server answers', async () => {
        const env = browser({
            local: [{ proposalId: 'p-a' }, { proposalId: 'p-b' }],
            published: [{ id: 11, cadastreParcelIds: ['HR-1-7'] }, { id: 12, cadastreParcelIds: ['HR-1-7'] }, { id: 13, cadastreParcelIds: ['HR-1-7'] }],
            held: new Set(['11'])
        });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        const first = SetProposals.count(['live-7'], update => updates.push(update));
        expect(first).toEqual({ count: 2, loading: true, error: null });
        expect(env.fetchCalls[0]).toContain('/proposals/summary?parcel_ids=HR-1-7&city=zagreb');
        env.answer();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        // 11 is a published proposal this browser already holds: counted once, as its own copy.
        expect(updates[0]).toEqual({ count: 4, loading: false, error: null });
        // Asked again within the minute, the answer is already known and nothing is fetched.
        expect(SetProposals.count(['live-7'], () => {})).toEqual({ count: 4, loading: false, error: null });
        expect(env.fetchCalls).toHaveLength(1);
    });

    it('keeps the held count and reports the error when the server cannot answer', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }], fail: true });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        SetProposals.count(['live-7'], update => updates.push(update));
        env.answer();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]).toEqual({ count: 1, loading: false, error: 'down' });
    });
});
