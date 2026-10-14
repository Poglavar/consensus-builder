// Overlapping village-map outlines resolve to disjoint ground that does not depend on the view that read it.
import { describe, expect, it, vi } from 'vitest';
import { area, bbox as geometryBbox, intersect } from '@turf/turf';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { OVERLAP_GROUND_POLICY, resolveOverlapGround, subtractBox, tileBounds } from '../parcels/overlap-ground.js';

const rect = (west, south, east, north) => ({ type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
const parcel = (id, geometry) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry });
const overlapM2 = (a, b) => { const shared = intersect(a, b); return shared ? area(shared) : 0; };

describe('overlap ground policy', () => {
    it('gives an overlap to the larger outline and leaves edge-touching neighbours as published', () => {
        const big = parcel('B', rect(85.000, 25.000, 85.002, 25.002));
        const small = parcel('A', rect(85.0015, 25.000, 85.0025, 25.001));
        const beside = parcel('C', rect(85.002, 25.001, 85.003, 25.002));
        const { features, suppressedIds } = resolveOverlapGround([big, small, beside], [big, small, beside]);
        expect(suppressedIds).toEqual([]);
        const [bigOut, smallOut, besideOut] = features;
        expect(bigOut).toBe(big);
        expect(besideOut).toBe(beside);
        expect(smallOut.properties.geometryKind).toBe('derived-ground');
        expect(smallOut.properties.derivation).toMatchObject({ policy: OVERLAP_GROUND_POLICY, cutByIds: ['B'] });
        expect(area(smallOut)).toBeCloseTo(area(small) / 2, -1);
        expect(overlapM2(smallOut, bigOut)).toBeLessThan(0.01);
    });

    it('breaks equal-area ties by ID and suppresses an outline wholly inside a larger one', () => {
        const first = parcel('1', rect(85.000, 25.000, 85.001, 25.001));
        const second = parcel('2', rect(85.0005, 25.000, 85.0015, 25.001));
        const inner = parcel('3', rect(85.0001, 25.0001, 85.0002, 25.0002));
        const { features, suppressedIds } = resolveOverlapGround([second, first, inner], [first, second, inner]);
        expect(suppressedIds).toEqual(['3']);
        expect(features.find(f => f.id === '1')).toBe(first);
        expect(features.find(f => f.id === '2').properties.derivation.cutByIds).toEqual(['1']);
    });

    it('tiles a large context rectangle within the provider limit', () => {
        const tiles = tileBounds([85, 25, 85.05, 25.05], 4);
        expect(tiles.length).toBeGreaterThan(1);
        for (const tile of tiles) {
            const km2 = (tile[2] - tile[0]) * 111.32 * Math.cos(25.025 * Math.PI / 180) * (tile[3] - tile[1]) * 111.32;
            expect(km2).toBeLessThanOrEqual(4);
        }
        expect(Math.min(...tiles.map(t => t[0]))).toBe(85);
        expect(Math.max(...tiles.map(t => t[3]))).toBe(25.05);
    });
});

describe('ArcGIS overlapResolution', () => {
    const descriptor = { adapter: 'arcgis', id: 'in-br-test', endpoint: 'https://example.test/arcgis/rest/services/Bihar/MapServer/0', idField: 'KHASRA', objectIdField: 'OBJECTID', idType: 'string',
        idPrefix: 'IN-BR-TEST-', parcelNumberField: 'KHASRA', outFields: ['OBJECTID', 'KHASRA'], pageSize: 1000, maxFeatures: 2000,
        maxBboxKm2: 4, overlapResolution: OVERLAP_GROUND_POLICY };
    // Village A's plot (larger) reaches over the seam into village B's plot.
    const rows = [
        { KHASRA: 'A-348', geometry: rect(85.000, 25.000, 85.004, 25.002) },
        { KHASRA: 'B-2025', geometry: rect(85.0035, 25.000, 85.006, 25.001) },
        { KHASRA: 'B-2026', geometry: rect(85.006, 25.000, 85.008, 25.001) }
    ];
    function provider() {
        const calls = [];
        const fetchImpl = vi.fn(async url => {
            const u = new URL(url); calls.push(u);
            const where = u.searchParams.get('where') || '1=1';
            const envelope = u.searchParams.get('geometry')?.split(',').map(Number);
            const selected = rows.filter((row, index) => (!envelope || (() => { const box = geometryBbox(row.geometry);
                return box[0] <= envelope[2] && box[2] >= envelope[0] && box[1] <= envelope[3] && box[3] >= envelope[1]; })())
                && (where === '1=1' || where.includes(`'${row.KHASRA}'`)));
            return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', exceededTransferLimit: false,
                features: selected.map(row => ({ type: 'Feature', id: rows.indexOf(row) + 1,
                    properties: { OBJECTID: rows.indexOf(row) + 1, KHASRA: row.KHASRA }, geometry: row.geometry })) }) };
        });
        return { fetchImpl, calls };
    }

    it('cuts a seam overlap the same way from a view that misses the larger plot and from an ID read', async () => {
        const { fetchImpl } = provider();
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        // This view only touches B's plots; A's plot is found through the outlines' extent.
        const view = await source.queryBounds([85.005, 25.0002, 85.0055, 25.0008]);
        const b = view.features.find(f => f.id === 'IN-BR-TEST-B-2025');
        expect(b.properties.derivation.cutByIds).toEqual(['IN-BR-TEST-A-348']);
        const wide = await source.queryBounds([85.000, 25.000, 85.008, 25.002]);
        const byIds = await source.queryIds(['IN-BR-TEST-B-2025']);
        expect(wide.features.find(f => f.id === b.id).geometry).toEqual(b.geometry);
        expect(byIds.features[0].geometry).toEqual(b.geometry);
        const a = wide.features.find(f => f.id === 'IN-BR-TEST-A-348');
        expect(a.properties.geometryKind).toBeUndefined();
        expect(overlapM2(a, b)).toBeLessThan(0.01);
        expect(wide.features.find(f => f.id === 'IN-BR-TEST-B-2026').properties.geometryKind).toBeUndefined();
    });

    it('reads a view once when its padding holds every neighbour, and reads only the strips past it otherwise', async () => {
        const { fetchImpl, calls } = provider();
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        await source.queryBounds([85.005, 25.0002, 85.0055, 25.0008]);
        expect(calls).toHaveLength(1);
        // B-2025 reaches west past this view's padding; A's plot is found in the strip beyond it.
        calls.length = 0;
        const view = await source.queryBounds([85.0058, 25.0002, 85.0062, 25.0008]);
        // One strip west of the padding (to B-2025's edge) and one east (to B-2026's edge).
        const strips = calls.slice(1).map(call => call.searchParams.get('geometry').split(',').map(Number)).sort((a, b) => a[0] - b[0]);
        expect(strips).toHaveLength(2);
        expect(strips[0][0]).toBeCloseTo(85.0035, 9);
        expect(strips[0][2]).toBeCloseTo(85.0043, 9);
        expect(strips[1][0]).toBeCloseTo(85.0077, 9);
        expect(strips[1][2]).toBeCloseTo(85.008, 9);
        expect(view.features.find(f => f.id === 'IN-BR-TEST-B-2025').properties.derivation.cutByIds).toEqual(['IN-BR-TEST-A-348']);
        expect(view.features.map(f => f.id).sort()).toEqual(['IN-BR-TEST-B-2025', 'IN-BR-TEST-B-2026']);
    });

    it('subtracts one rectangle from another into at most four strips', () => {
        expect(subtractBox([0, 0, 4, 4], [1, 1, 3, 3])).toEqual([[0, 0, 1, 4], [3, 0, 4, 4], [1, 0, 3, 1], [1, 3, 3, 4]]);
        expect(subtractBox([0, 0, 1, 1], [-1, -1, 2, 2])).toEqual([]);
        expect(subtractBox([0, 0, 1, 1], [2, 2, 3, 3])).toEqual([[0, 0, 1, 1]]);
    });

    it('rejects an unknown overlap policy', () => {
        expect(() => createArcgisParcelSource({ ...descriptor, overlapResolution: 'first-wins' }, { fetchImpl: async () => ({}) }))
            .toThrow(/Invalid ArcGIS/);
    });
});
