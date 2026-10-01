// Publishing with the server binding (frontend/js/proposals/publish-binding.js): a material proposal
// publishes exactly the parcels POST /proposals/binding binds for its site (mocked here), an empty
// binding included; parcel acts keep their declaration; coverage 'unknown' keeps the authored one;
// small intrusions are surfaced for confirmation; the server's undeclared/unbound refusals read as a
// list of parcels with intrusion widths. PARCEL-OPTIONAL.md rules 1 and 3.
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

describe('bindForPublish', () => {
    it('publishes the server binding of the authored site as the declaration', async () => {
        const fetchBinding = vi.fn(async () => serverBinding([['HR-1-2', 4.1], ['HR-1-3', 12]]));
        const proposal = { goal: 'park', site: SITE, cadastreParcelIds: ['HR-1-9'], structureProposal: { kind: 'park', geometry: SITE } };
        const out = await publishBinding.bindForPublish(proposal, { fetchBinding, city: 'zagreb' });
        expect(fetchBinding).toHaveBeenCalledWith({ site: { type: 'MultiPolygon', coordinates: [SITE.coordinates] }, toleranceM: 0, city: 'zagreb' });
        expect(out.proposal.cadastreParcelIds).toEqual(['HR-1-2', 'HR-1-3']);
        expect(out.proposal.binding.source).toBe('server:hr-cadastre');
        expect(publishBinding.isServerBinding(out.proposal.binding)).toBe(true);
        expect(out.smallIntrusions).toEqual([]);
        // The stored record is not mutated.
        expect(proposal.cadastreParcelIds).toEqual(['HR-1-9']);
    });

    it('an empty binding on bare ground publishes an empty declaration', async () => {
        const fetchBinding = async () => serverBinding([], { coverage: 'partial', unsurveyedM2: 1000 });
        const out = await publishBinding.bindForPublish({ goal: 'park', site: SITE, cadastreParcelIds: [] }, { fetchBinding });
        expect(out.proposal.cadastreParcelIds).toEqual([]);
        expect(out.proposal.site.type).toBe('MultiPolygon');
    });

    it('derives the site from the footprint when none was authored, and sends the tolerance', async () => {
        const fetchBinding = vi.fn(async () => serverBinding([['HR-1-2', 3]]));
        const out = await publishBinding.bindForPublish(
            { goal: 'park', toleranceM: 0.05, structureProposal: { kind: 'park', geometry: SITE }, cadastreParcelIds: [] },
            { fetchBinding });
        expect(fetchBinding.mock.calls[0][0].toleranceM).toBe(0.05);
        expect(fetchBinding.mock.calls[0][0].site.type).toBe('MultiPolygon');
        expect(out.proposal.toleranceM).toBe(0.05);
    });

    it('surfaces bound parcels reached into by under half a metre', async () => {
        const fetchBinding = async () => serverBinding([['HR-1-2', 0.04], ['HR-1-3', 12]]);
        const out = await publishBinding.bindForPublish({ goal: 'park', site: SITE }, { fetchBinding });
        expect(out.smallIntrusions.map(hit => [hit.parcelId, hit.width])).toEqual([['HR-1-2', '4 cm']]);
        const accepted = await publishBinding.bindForPublish({ goal: 'park', site: SITE }, { fetchBinding, acceptedParcelIds: ['HR-1-2'] });
        expect(accepted.smallIntrusions).toEqual([]);
    });

    it('keeps the authored declaration where the server cannot check (coverage unknown)', async () => {
        const fetchBinding = async () => serverBinding([], { coverage: 'unknown', reason: 'outside-held-cadastre' });
        const out = await publishBinding.bindForPublish({ goal: 'park', site: SITE, cadastreParcelIds: ['NYC-1'] }, { fetchBinding });
        expect(out.proposal.cadastreParcelIds).toEqual(['NYC-1']);
        expect(out.smallIntrusions).toEqual([]);
    });

    it('leaves a parcel act alone: its declaration is what it acts on', async () => {
        const fetchBinding = vi.fn();
        const out = await publishBinding.bindForPublish({ goal: 'ownership-transfer', cadastreParcelIds: ['HR-1-1'] }, { fetchBinding });
        expect(fetchBinding).not.toHaveBeenCalled();
        expect(out.parcelAct).toBe(true);
        expect(out.proposal.cadastreParcelIds).toEqual(['HR-1-1']);
    });

    it('refuses a material record with nothing to bind', async () => {
        await expect(publishBinding.bindForPublish({ goal: 'park' }, { fetchBinding: vi.fn() }))
            .rejects.toMatchObject({ code: 'proposal-site-missing' });
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
});

describe('claims after re-binding', () => {
    it('drops acceptances on parcels the server binding no longer holds', async () => {
        const fetchBinding = async () => serverBinding([['HR-1-2', 3]]);
        const out = await publishBinding.bindForPublish({
            goal: 'park', site: SITE, cadastreParcelIds: ['HR-1-2', 'HR-1-9'],
            acceptedParcelIds: ['HR-1-9', 'HR-1-2'], ownerAcceptances: { 'HR-1-9': { accepted: true }, 'HR-1-2': { accepted: true } }
        }, { fetchBinding });
        expect(out.proposal.acceptedParcelIds).toEqual(['HR-1-2']);
        expect(Object.keys(out.proposal.ownerAcceptances)).toEqual(['HR-1-2']);
    });
});
