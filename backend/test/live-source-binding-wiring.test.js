import { consumerParcelSourceId } from './helpers/frontend-source-selection.js';
// Checks that proposal binding selects live sources and their metric CRS without another cadastre.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProposalBinding, computeBinding, parcelActBinding } from '../proposals/binding.js';
import { clearParcelSourceRuntimeCache } from '../parcels/sources.js';

const SOURCE_ID = 'ca-on-toronto-property-boundary';
const PREFIX = 'CA-ON-TORONTO-';
const SITE = {
    type: 'Polygon',
    coordinates: [[[-79.384, 43.652], [-79.383, 43.652], [-79.383, 43.653], [-79.384, 43.653], [-79.384, 43.652]]]
};
const SITE_MULTI = { type: 'MultiPolygon', coordinates: [SITE.coordinates] };

function arcgisFeature(objectId, parcelId, geometry = SITE) {
    return { type: 'Feature', id: objectId, properties: { OBJECTID: objectId, PARCELID: parcelId }, geometry };
}

function fetchGeojson(features = [arcgisFeature(1, 41001)]) {
    return vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false })
    }));
}

afterEach(() => { vi.unstubAllGlobals(); clearParcelSourceRuntimeCache(); });

describe('live source proposal binding wiring', () => {
    it('binds an authored Toronto site from the configured ArcGIS source without querying HR SQL', async () => {
        const fetch = fetchGeojson();
        vi.stubGlobal('fetch', fetch);
        const db = { query: vi.fn(async () => { throw new Error('authored source binding must not query HR SQL'); }) };

        const { site, binding } = await computeBinding(db, { parcelSourceId: consumerParcelSourceId('toronto'),
            site: SITE, toleranceM: 0.2, city: 'toronto',
            now: () => new Date('2026-10-02T14:00:00.000Z')
        });

        expect(db.query).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(site).toEqual(SITE_MULTI);
        expect(binding).toMatchObject({
            source: `server:${SOURCE_ID}`, toleranceM: 0.2, coverage: 'complete', unknownM2: 0,
            computedAt: '2026-10-02T14:00:00.000Z'
        });
        expect(binding.parcels.map(hit => hit.parcelId)).toEqual([`${PREFIX}41001`]);
    });

    it('does not fall back to unknown coverage when the Toronto source fails', async () => {
        const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetch);
        const db = { query: vi.fn(async () => { throw new Error('unexpected HR SQL fallback'); }) };

        await expect(computeBinding(db, { parcelSourceId: consumerParcelSourceId('toronto'), site: SITE, city: 'toronto' }))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('resolves Toronto parcel acts by declared IDs and reports true absences without HR SQL', async () => {
        const declared = `${PREFIX}41002`;
        const absent = `${PREFIX}49999`;
        const fetch = fetchGeojson([arcgisFeature(2, 41002)]);
        vi.stubGlobal('fetch', fetch);
        const db = { query: vi.fn(async () => { throw new Error('parcel act source binding must not query HR SQL'); }) };

        const result = await parcelActBinding(db, [declared, absent], { parcelSourceId: SOURCE_ID });

        expect(db.query).not.toHaveBeenCalled();
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.extra).toEqual([absent]);
        expect(result.binding).toMatchObject({
            source: `server:${SOURCE_ID}`, coverage: 'complete', subject: 'declared-parcels',
            unknownM2: 0, unsurveyedM2: 0
        });
        expect(result.binding.parcels).toEqual([
            expect.objectContaining({ parcelId: declared, overlapM2: expect.any(Number), intrusionM: null })
        ]);
        const query = new URL(fetch.mock.calls[0][0]).searchParams.get('where');
        expect(query).toContain('PARCELID IN (41002,49999)');
    });

    it('derives a footprint site as the browser does (site-binding.js siteOf), with no database statement', async () => {
        const fetch = fetchGeojson();
        vi.stubGlobal('fetch', fetch);
        const db = { query: vi.fn(() => { throw new Error('Unexpected database read'); }) };
        const park = { goal: 'park', structureProposal: { kind: 'park', geometry: SITE } };

        const result = await checkProposalBinding(db, park, [], { parcelSourceId: consumerParcelSourceId('toronto'), toleranceM: 0.1, city: 'toronto', derive: true });

        expect(db.query).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(result.site).toEqual(SITE_MULTI);
        expect(result.binding).toMatchObject({ source: `server:${SOURCE_ID}`, toleranceM: 0.1, coverage: 'complete' });
    });
});
