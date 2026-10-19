// Verifies authoritative binding and parcel acts against complete live-source results.
import { describe, expect, it, vi } from 'vitest';
import { computeSourceBinding, computeSourceParcelActBinding } from '../parcels/source-binding.js';

const SOURCE = 'ca-on-toronto';
const SOURCE_PREFIX = 'CA-ON-TORONTO-';
const square = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const site = square(-79.384, 43.652, -79.374, 43.662);

function parcel(nativeId, geometry, sourceId = SOURCE) {
    const parcelId = `${SOURCE_PREFIX}${nativeId}`;
    return {
        type: 'Feature', id: parcelId, geometry,
        properties: { id: parcelId, parcelId, sourceId, sourceParcelId: String(nativeId) }
    };
}

function adapterWith(features, overrides = {}) {
    return {
        queryGeometry: vi.fn(async () => ({ type: 'FeatureCollection', complete: true, features })),
        queryIds: vi.fn(async ids => ({
            type: 'FeatureCollection', complete: true, features: features.filter(f => ids.includes(f.properties.parcelId)),
            absentIds: ids.filter(id => !features.some(f => f.properties.parcelId === id))
        })),
        ...overrides
    };
}

describe('computeSourceBinding', () => {
    it('normalizes site to MultiPolygon and returns canonical source binding with timestamp', async () => {
        const adapter = adapterWith([
            parcel('101', square(-79.384, 43.652, -79.379, 43.662)),
            parcel('102', square(-79.379, 43.652, -79.374, 43.662))
        ]);
        const now = () => new Date('2026-10-02T10:30:00.000Z');

        const result = await computeSourceBinding(adapter, { site, sourceId: SOURCE, now });

        expect(adapter.queryGeometry).toHaveBeenCalledWith({ type: 'MultiPolygon', coordinates: [site.coordinates] });
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.binding).toMatchObject({
            source: 'server:ca-on-toronto', coverage: 'complete', unknownM2: 0,
            computedAt: '2026-10-02T10:30:00.000Z', toleranceM: 0
        });
        expect(result.binding.parcels.map(item => item.parcelId)).toEqual([
            'CA-ON-TORONTO-101', 'CA-ON-TORONTO-102'
        ]);
    });

    it('applies a bounded tolerance so a narrow contact becomes touched rather than bound', async () => {
        const thin = parcel('201', square(-79.384, 43.652, -79.383999, 43.662));
        const adapter = adapterWith([thin]);
        const result = await computeSourceBinding(adapter, { site, toleranceM: 0.5, sourceId: SOURCE });

        expect(result.binding.toleranceM).toBe(0.5);
        expect(result.binding.parcels).toEqual([]);
        expect(result.binding.touched.map(item => item.parcelId)).toEqual(['CA-ON-TORONTO-201']);
    });

    it('reports partial coverage when the complete response leaves open ground', async () => {
        const adapter = adapterWith([parcel('301', square(-79.384, 43.652, -79.379, 43.662))]);

        const { binding } = await computeSourceBinding(adapter, { site, sourceId: SOURCE });

        expect(binding.coverage).toBe('partial');
        expect(binding.unsurveyedM2).toBeGreaterThan(0);
        expect(binding.unknownM2).toBe(0);
    });

    it('keeps a genuinely empty complete sample as partial open ground', async () => {
        const adapter = adapterWith([]);

        const { binding } = await computeSourceBinding(adapter, { site, sourceId: SOURCE });

        expect(binding).toMatchObject({ coverage: 'partial', parcels: [], touched: [], unknownM2: 0 });
        expect(binding.unsurveyedM2).toBeGreaterThan(0);
    });

    it('rejects incomplete, oversized, foreign, and failed source responses without producing binding', async () => {
        const incomplete = adapterWith([], {
            queryGeometry: vi.fn(async () => ({ type: 'FeatureCollection', complete: false, features: [] }))
        });
        await expect(computeSourceBinding(incomplete, { site, sourceId: SOURCE })).rejects.toThrow(/complete/i);

        const oversized = adapterWith(Array.from({ length: 5001 }, (_, i) => parcel(String(i + 1), square(-79.384, 43.652, -79.383, 43.653))));
        await expect(computeSourceBinding(oversized, { site, sourceId: SOURCE })).rejects.toThrow(/5000/);

        const foreign = adapterWith([parcel('401', square(-79.384, 43.652, -79.383, 43.653), 'other-source')]);
        await expect(computeSourceBinding(foreign, { site, sourceId: SOURCE })).rejects.toThrow(/foreign/i);

        const failed = adapterWith([], { queryGeometry: vi.fn(async () => { throw new Error('provider down'); }) });
        await expect(computeSourceBinding(failed, { site, sourceId: SOURCE })).rejects.toThrow('provider down');
    });

    it('validates site shape and tolerance before querying the provider', async () => {
        const adapter = adapterWith([]);
        await expect(computeSourceBinding(adapter, { site: { type: 'Point', coordinates: [0, 0] }, sourceId: SOURCE })).rejects.toThrow(/Polygon/);
        await expect(computeSourceBinding(adapter, { site, toleranceM: 1.1, sourceId: SOURCE })).rejects.toThrow(/toleranceM/);
        expect(adapter.queryGeometry).not.toHaveBeenCalled();
    });
});

describe('computeSourceParcelActBinding', () => {
    it('unions declared parcel geometries and returns geodesic areas plus explicit absent IDs', async () => {
        const first = parcel('501', square(-79.384, 43.652, -79.379, 43.657));
        const second = parcel('502', square(-79.379, 43.652, -79.374, 43.657));
        const absent = `${SOURCE_PREFIX}503`;
        const adapter = adapterWith([first, second]);
        const result = await computeSourceParcelActBinding(adapter, [first.properties.parcelId, second.properties.parcelId, absent], {
            sourceId: SOURCE,
            toleranceM: 0.25,
            now: () => new Date('2026-10-02T12:00:00.000Z')
        });

        expect(adapter.queryIds).toHaveBeenCalledWith([first.properties.parcelId, second.properties.parcelId, absent]);
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.extra).toEqual([absent]);
        expect(result.binding).toMatchObject({
            coverage: 'complete', subject: 'declared-parcels', source: `server:${SOURCE}`,
            toleranceM: 0.25, unsurveyedM2: 0, unknownM2: 0, computedAt: '2026-10-02T12:00:00.000Z'
        });
        expect(result.binding.parcels).toEqual([
            expect.objectContaining({ parcelId: first.properties.parcelId, overlapM2: expect.any(Number), intrusionM: null }),
            expect.objectContaining({ parcelId: second.properties.parcelId, overlapM2: expect.any(Number), intrusionM: null })
        ]);
        expect(result.binding.siteM2).toBeGreaterThan(0);
    });

    it('requires complete ID results and a consistent absent-ID set', async () => {
        const id = `${SOURCE_PREFIX}601`;
        const incomplete = adapterWith([], {
            queryIds: vi.fn(async () => ({ type: 'FeatureCollection', complete: false, features: [], absentIds: [id] }))
        });
        await expect(computeSourceParcelActBinding(incomplete, [id], { sourceId: SOURCE })).rejects.toThrow(/complete/i);

        const inconsistent = adapterWith([], {
            queryIds: vi.fn(async () => ({ type: 'FeatureCollection', complete: true, features: [], absentIds: [] }))
        });
        await expect(computeSourceParcelActBinding(inconsistent, [id], { sourceId: SOURCE })).rejects.toThrow(/inconsistent/i);
    });

    it('reports every declared ID as extra when a complete lookup finds no parcels', async () => {
        const ids = [`${SOURCE_PREFIX}701`, `${SOURCE_PREFIX}702`];
        const adapter = adapterWith([]);

        const result = await computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE });

        expect(result.site).toBeNull();
        expect(result.extra).toEqual(ids);
        expect(result.binding).toMatchObject({ coverage: 'complete', subject: 'declared-parcels', parcels: [], siteM2: 0 });
    });

    it('resolves selections larger than the provider request limit in complete batches', async () => {
        const ids = Array.from({ length: 81 }, (_, index) => `${SOURCE_PREFIX}${1000 + index}`);
        const adapter = adapterWith([]);

        const result = await computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE });

        expect(adapter.queryIds.mock.calls.map(([batch]) => batch.length)).toEqual([80, 1]);
        expect(result.extra).toEqual(ids);
        expect(result.binding).toMatchObject({ coverage: 'complete', parcels: [], siteM2: 0 });
    });

    it('rejects a selection if a later ID batch is incomplete', async () => {
        const ids = Array.from({ length: 81 }, (_, index) => `${SOURCE_PREFIX}${2000 + index}`);
        const adapter = adapterWith([], {
            queryIds: vi.fn()
                .mockResolvedValueOnce({ complete: true, features: [], absentIds: ids.slice(0, 80) })
                .mockResolvedValueOnce({ complete: false, features: [], absentIds: [] })
        });

        await expect(computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE })).rejects.toThrow(/complete/i);
    });
});
