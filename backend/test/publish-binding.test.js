// Publishing as the server's prepared artifact (frontend/js/proposals/publish-binding.js): a proposal
// publishes exactly the declaration, binding and — for a corridor — land of the artifact
// POST /proposals/prepare returns (mocked here), an empty declaration included; the request carries
// the authored record, never a derived site or a stale binding/preparation; small intrusions are
// surfaced for confirmation; the corridor's shift from the browser preview is measured; the server's
// binding and preparation refusals read as sentences. PARCEL-OPTIONAL.md rules 1 and 3, projections.md §3.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const publishBinding = require('../../frontend/js/proposals/publish-binding.js');

const square = (lng, lat, d) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]]
});
const SITE = square(15.97, 45.8, 0.0004);

beforeAll(() => { globalThis.turf = turf; });

function serverBinding(parcels, extra = {}) {
    return {
        parcels: parcels.map(([parcelId, intrusionM]) => ({ parcelId, overlapM2: 10, intrusionM })),
        touched: [],
        toleranceM: 0,
        coverage: 'complete',
        unsurveyedM2: 0,
        siteM2: 1000,
        source: 'server:hr-cadastre',
        ...extra
    };
}

// A prepare answer the way the server shapes it (backend/proposals/prepare.js).
function prepared(binding, { cadastreParcelIds = binding.parcels.map(hit => hit.parcelId), corridor = null, site = SITE } = {}) {
    return { preparationId: 'prep_0123', digest: 'd'.repeat(64), artifact: { binding, cadastreParcelIds, corridor, site } };
}

describe('prepareForPublish', () => {
    it('publishes the artifact\'s declaration and binding, preparing the authored record', async () => {
        const fetchPrepare = vi.fn(async () => prepared(serverBinding([['HR-1-2', 4.1], ['HR-1-3', 12]])));
        const proposal = { goal: 'park', site: SITE, cadastreParcelIds: ['HR-1-9'], structureProposal: { kind: 'park', geometry: SITE },
            binding: { source: 'client-preview' }, preparation: { id: 'prep_old', digest: 'x' } };
        const out = await publishBinding.prepareForPublish(proposal, { fetchPrepare, city: 'zagreb' });
        const request = fetchPrepare.mock.calls[0][0];
        expect(request.city).toBe('zagreb');
        expect(request.toleranceM).toBe(0);
        // the authored record, without the outputs of an earlier preparation or preview
        expect(request.proposal.binding).toBeUndefined();
        expect(request.proposal.preparation).toBeUndefined();
        expect(request.proposal.site).toEqual(SITE);
        expect(out.proposal.cadastreParcelIds).toEqual(['HR-1-2', 'HR-1-3']);
        expect(out.proposal.preparation).toEqual({ id: 'prep_0123', digest: 'd'.repeat(64) });
        expect(publishBinding.isServerBinding(out.proposal.binding)).toBe(true);
        expect(out.smallIntrusions).toEqual([]);
        expect(out.landShiftM).toBeNull();
        // The stored record is not mutated.
        expect(proposal.cadastreParcelIds).toEqual(['HR-1-9']);
        expect(proposal.preparation.id).toBe('prep_old');
    });

    it('never adds a derived site: the artifact holds it, and the record publishes as prepared', async () => {
        const fetchPrepare = vi.fn(async () => prepared(serverBinding([['HR-1-2', 3]])));
        const out = await publishBinding.prepareForPublish(
            { goal: 'park', toleranceM: 0.05, structureProposal: { kind: 'park', geometry: SITE }, cadastreParcelIds: [] },
            { fetchPrepare });
        expect(fetchPrepare.mock.calls[0][0].toleranceM).toBe(0.05);
        expect(fetchPrepare.mock.calls[0][0].proposal.site).toBeUndefined();
        expect(out.proposal.site).toBeUndefined();
        expect(out.proposal.toleranceM).toBe(0.05);
        expect(out.artifact.site).toEqual(SITE);
    });

    it('an empty binding on bare ground publishes an empty declaration', async () => {
        const fetchPrepare = async () => prepared(serverBinding([], { coverage: 'partial', unsurveyedM2: 1000 }));
        const out = await publishBinding.prepareForPublish({ goal: 'park', site: SITE, cadastreParcelIds: [] }, { fetchPrepare });
        expect(out.proposal.cadastreParcelIds).toEqual([]);
    });

    it('surfaces bound parcels reached into by under half a metre', async () => {
        const fetchPrepare = async () => prepared(serverBinding([['HR-1-2', 0.04], ['HR-1-3', 12]]));
        const out = await publishBinding.prepareForPublish({ goal: 'park', site: SITE }, { fetchPrepare });
        expect(out.smallIntrusions.map(hit => [hit.parcelId, hit.width])).toEqual([['HR-1-2', '4 cm']]);
        const accepted = await publishBinding.prepareForPublish({ goal: 'park', site: SITE }, { fetchPrepare, acceptedParcelIds: ['HR-1-2'] });
        expect(accepted.smallIntrusions).toEqual([]);
    });

    it('keeps the declaration the server keeps where it cannot check (coverage unknown)', async () => {
        const fetchPrepare = async () => prepared(serverBinding([], { coverage: 'unknown', reason: 'outside-held-cadastre' }), { cadastreParcelIds: ['NYC-1'] });
        const out = await publishBinding.prepareForPublish({ goal: 'park', site: SITE, cadastreParcelIds: ['NYC-1'] }, { fetchPrepare });
        expect(out.proposal.cadastreParcelIds).toEqual(['NYC-1']);
        expect(out.smallIntrusions).toEqual([]);
    });

    it('prepares a parcel act too: its declaration is what it acts on, verified by the server', async () => {
        const fetchPrepare = vi.fn(async () => prepared(serverBinding([['HR-1-1', null]], { subject: 'declared-parcels' }), { cadastreParcelIds: ['HR-1-1'] }));
        const out = await publishBinding.prepareForPublish({ goal: 'ownership-transfer', cadastreParcelIds: ['HR-1-1'] }, { fetchPrepare });
        expect(fetchPrepare).toHaveBeenCalledTimes(1);
        expect(out.parcelAct).toBe(true);
        expect(out.proposal.cadastreParcelIds).toEqual(['HR-1-1']);
        expect(out.smallIntrusions).toEqual([]);
    });

    it('writes the server-built corridor land into the record and measures its shift from the preview', async () => {
        const metricFrame = require('../../frontend/js/metric-frame.js');
        const frame = metricFrame.frameFor([[15.97, 45.8], [15.971, 45.8]]);
        const rectangle = (dy) => ({ type: 'Polygon', coordinates: [[[0, -6 + dy], [80, -6 + dy], [80, 6 + dy], [0, 6 + dy], [0, -6 + dy]].map(p => frame.toLngLat(p))] });
        const built = rectangle(0);
        const preview = rectangle(0.25); // the browser's own builder, 25 cm off
        const corridor = { polygon: built, constructionFrame: { ...frame.provenance(), algorithm: 'corridor-footprint/2' } };
        const fetchPrepare = async () => prepared(serverBinding([['HR-1-2', 6]]), { corridor, site: built });
        const record = { goal: 'road-track', roadProposal: { mode: 'draw', definition: { width: 12, points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.971 }], polygon: preview, latLngPairs: [[1, 2]] } } };
        const out = await publishBinding.prepareForPublish(record, { fetchPrepare });
        expect(out.proposal.roadProposal.definition.polygon).toEqual(built);
        expect(out.proposal.roadProposal.definition.constructionFrame).toEqual(corridor.constructionFrame);
        expect(out.proposal.roadProposal.definition.latLngPairs).toBeUndefined();
        expect(out.proposal.roadProposal.mode).toBe('draw');
        expect(out.landShiftM).toBeCloseTo(0.25, 6);
        expect(record.roadProposal.definition.polygon).toBe(preview);
    });

    it('refuses a broken answer', async () => {
        await expect(publishBinding.prepareForPublish({ goal: 'park', site: SITE }, { fetchPrepare: async () => ({ artifact: null }) }))
            .rejects.toMatchObject({ code: 'binding-invalid' });
        await expect(publishBinding.prepareForPublish({ goal: 'park', site: SITE }, {}))
            .rejects.toMatchObject({ code: 'binding-unavailable' });
    });
});

describe('createFetchPrepare', () => {
    it('posts the record with the city\'s parcel source and returns the artifact', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => prepared(serverBinding([['HR-1-2', 3]])) }));
        const answer = await publishBinding.createFetchPrepare(fetchImpl, 'http://localhost:4000')({ proposal: { goal: 'park', site: SITE }, city: 'zagreb', toleranceM: 0 });
        expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:4000/proposals/prepare');
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.proposal.site).toEqual(SITE);
        expect(body).toHaveProperty('parcelSourceId', null);
        expect(answer.preparationId).toBe('prep_0123');
    });

    it('turns an undecidable binding into a sentence naming the parcels', async () => {
        const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ code: 'binding-unresolved', error: 'x', unresolved: [{ id: 'HR-1-5', intrusionM: 0.3 }] }) });
        await expect(publishBinding.createFetchPrepare(fetchImpl, '')({ proposal: { goal: 'park', site: SITE } }))
            .rejects.toMatchObject({ code: 'binding-unresolved', status: 409, message: expect.stringContaining('HR-1-5 (30 cm)') });
    });
});

describe('createFetchBinding', () => {
    it('posts the site and returns the binding', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ binding: serverBinding([['HR-1-2', 3]]) }) }));
        const binding = await publishBinding.createFetchBinding(fetchImpl, 'http://localhost:4000')({ site: SITE, toleranceM: 0 });
        expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:4000/proposals/binding');
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).site).toEqual(SITE);
        expect(binding.parcels).toHaveLength(1);
    });

    it('throws the server refusal with its code', async () => {
        const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Site is invalid', code: 'invalid-site' }) });
        await expect(publishBinding.createFetchBinding(fetchImpl, '')({ site: SITE }))
            .rejects.toMatchObject({ code: 'invalid-site', message: 'Site is invalid', status: 400 });
    });
});

describe('refusalMessage', () => {
    it('lists the missing parcels with how far the site reaches into each', () => {
        const message = publishBinding.refusalMessage({
            code: 'undeclared-parcels',
            missing: [{ id: 'HR-1-5', overlapM2: 0.4, intrusionM: 0.04 }, { id: 'HR-1-6', intrusionM: 2.5 }],
            extra: [{ id: 'HR-1-7', intrusionM: 0 }]
        });
        expect(message).toContain('HR-1-5 (4 cm)');
        expect(message).toContain('HR-1-6 (2.5 m)');
        expect(message).toContain('does not reach (1): HR-1-7');
    });

    it('translates through the given t and ignores other errors', () => {
        const t = vi.fn((key, fallback, params) => `${key}|${params ? params.list : ''}`);
        expect(publishBinding.refusalMessage({ code: 'unbound-parcels', extra: [{ id: 'HR-1-7' }] }, t))
            .toBe('modal.createProposal.errors.bindingExtra|HR-1-7 modal.createProposal.errors.bindingFix|');
        expect(publishBinding.refusalMessage({ code: 'rate-limited' }, t)).toBeNull();
    });

    it('asks to publish again when the record no longer matches its preparation', () => {
        const message = publishBinding.refusalMessage({ code: 'preparation-mismatch', error: 'The proposal\'s geometry differs from what was prepared' });
        expect(message).toMatch(/changed after it was prepared/);
        expect(message).toMatch(/geometry differs/);
        for (const code of publishBinding.PREPARATION_CODES) expect(publishBinding.refusalMessage({ code })).toBeTruthy();
    });
});

describe('claims after re-binding', () => {
    it('drops acceptances on parcels the prepared binding no longer holds', async () => {
        const fetchPrepare = async () => prepared(serverBinding([['HR-1-2', 3]]));
        const out = await publishBinding.prepareForPublish({
            goal: 'park', site: SITE, cadastreParcelIds: ['HR-1-2', 'HR-1-9'],
            acceptedParcelIds: ['HR-1-9', 'HR-1-2'], ownerAcceptances: { 'HR-1-9': { accepted: true }, 'HR-1-2': { accepted: true } }
        }, { fetchPrepare });
        expect(out.proposal.acceptedParcelIds).toEqual(['HR-1-2']);
        expect(Object.keys(out.proposal.ownerAcceptances)).toEqual(['HR-1-2']);
    });
});
