// A plan lot over the study limit is reported unsupported before its zones are overlaid: that overlay
// cost Alatau's largest plan zone (7 km², 430 holes, 12,849 vertices) 6 s in every display cell it crossed.
import { describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';

vi.mock('../planning/parcel-study.js', async original => {
    const actual = await original();
    return { ...actual, parcelZones: vi.fn(actual.parcelZones) };
});
const { parcelZones } = await import('../planning/parcel-study.js');
const { loadParcelEnvelopes } = await import('../planning/parcel-envelopes.js');
const { createAtlasProvider } = await import('../planning/providers/atlas.js');

const metadata = { id: 'atlas-envelope-test', city: 'colorado', label: 'Synthetic Atlas source', edition: 'test',
    url: 'https://example.test/source', parcelSourceId: 'us-co-oit-statewide-parcels' };
const properties = { slice_id: 'district', jurisdiction: 'Synthetic', family1_treatment: 'allowed',
    family1_maxheightft: 35, family1_maxheightft_method: 'direct_number' };

describe('a plan lot over the study limit', () => {
    it('is listed unsupported without overlaying the zones around it', async () => {
        const district = turf.bboxPolygon([-105.012, 39.995, -104.999, 40.005]);
        const base = createAtlasProvider({ type: 'FeatureCollection', features: [{ ...district, properties }] }, metadata);
        // Like Alatau's plan provider: no per-lot rule reader, and the zone forms its own land.
        const plan = { ...base, parcelRecords: undefined,
            record: async (...args) => (await base.record(...args)).map(item => ({ ...item, landBasis: 'zone' })) };
        const result = await loadParcelEnvelopes({ city: 'colorado', source: metadata.id, bbox: [-105.0002, 40.0002, -104.9997, 40.0006] },
            { sources: [plan], parcelProvider: () => ({ queryBounds: async () => ({ features: [], complete: true }) }) });
        expect(result.unavailable).toEqual([{ parcelId: 'zone:district', reason: 'unsupported-parcel-shape' }]);
        expect(parcelZones.mock.calls.filter(([lot]) => lot.id === 'zone:district')).toEqual([]);
    });
});
