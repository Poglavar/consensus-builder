// The number on the parcel menu's "Proposals (N)" (ParcelSetProposals.count in
// frontend/js/parcels/parcel-set-proposals.js): the proposals this browser holds on the parcel plus
// the published designs it holds no copy of, settled once the designs index answers (GET /designs by
// the box of the parcels, kept when the index's binding takes one of them), and the same entries the
// parcel panel's Proposals tab lists.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

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
const PARCEL = { type: 'Feature', properties: { parcelId: 'HR-1-7' },
    geometry: { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] } };

function browser({ local = [], published = [], held = new Set(), fail = false, features = [PARCEL] } = {}) {
    const fetchCalls = [];
    let resolveFetch;
    const answered = new Promise(resolve => { resolveFetch = resolve; });
    globalThis.fetch = vi.fn(url => {
        fetchCalls.push(url);
        return answered.then(() => (fail
            ? { ok: false, status: 503, text: async () => 'down' }
            : { ok: true, json: async () => ({ designs: published }) }));
    });
    const root = {
        proposalStorage: { getProposalsForParcel: () => local },
        LiveParcelFabric: { get: id => ({ id }), explicitCadastreIds: () => ['HR-1-7'] },
        CadastralParcelRepository: { peekMany: vi.fn(() => features) },
        turf,
        normalizeCityCodeForApi: city => city,
        resolveCurrentCityCode: () => 'zagreb',
        resolveBackendBaseUrl: () => 'https://api.test',
        DesignSync: { designSummary },
        findLocalCopyOfServerProposal: summary => (held.has(summary.cid) ? {} : null)
    };
    return { root, fetchCalls, answer: () => resolveFetch() };
}

afterEach(() => { delete globalThis.fetch; });

describe('Proposals (N) on the parcel menu', () => {
    it('counts what is held here at once, then adds the published designs not held, once the index answers', async () => {
        const env = browser({
            local: [{ proposalId: 'p-a' }, { proposalId: 'p-b' }],
            // Design 14 stands in the parcels' box but its binding takes another parcel.
            published: [designRow(11, ['HR-1-7']), designRow(12, ['HR-1-7']), designRow(13, ['HR-1-7', 'HR-1-8']), designRow(14, ['HR-1-9'])],
            held: new Set([cidOf(11)])
        });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        const first = SetProposals.count(['live-7'], update => updates.push(update));
        expect(first).toEqual({ count: 2, loading: true, error: null });
        expect(env.root.CadastralParcelRepository.peekMany).toHaveBeenCalledWith(['HR-1-7']);
        const box = turf.bbox({ type: 'FeatureCollection', features: [PARCEL] }).map(value => value.toFixed(7)).join(',');
        expect(env.fetchCalls).toEqual([`https://api.test/designs?bbox=${box}&city=zagreb&limit=200`]);
        env.answer();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        // 11 is a published design this browser already holds: counted once, as its own copy.
        expect(updates[0]).toEqual({ count: 4, loading: false, error: null });
        // Asked again within the minute, the answer is already known and nothing is fetched.
        expect(SetProposals.count(['live-7'], () => {})).toEqual({ count: 4, loading: false, error: null });
        expect(env.fetchCalls).toHaveLength(1);
    });

    it('keeps the held count and reports the error when the index cannot answer', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }], fail: true });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        SetProposals.count(['live-7'], update => updates.push(update));
        env.answer();
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]).toEqual({ count: 1, loading: false, error: 'down' });
    });

    it('asks nothing when this browser holds no outline of the parcels: there is no box to ask for', async () => {
        const env = browser({ local: [{ proposalId: 'p-a' }], features: [] });
        const SetProposals = loadWithRoot(env.root);
        const updates = [];
        SetProposals.count(['live-7'], update => updates.push(update));
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]).toEqual({ count: 1, loading: false, error: null });
        expect(env.fetchCalls).toEqual([]);
    });
});
