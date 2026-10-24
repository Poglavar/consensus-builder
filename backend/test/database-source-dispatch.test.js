// Imported defaults retain native read operations, coordinates and response meanings.
import { describe, expect, it, vi } from 'vitest';
import { databaseParcelSourceRegistry, openDatabaseParcelSource } from '../parcels/database-sources.js';
import { buildingMapSourceRegistry, buildingMapLookup, osmReferenceSourceRegistry } from '../buildings/map-source.js';
import { BINDING_COUNT_SQL, BINDING_SQL, PARCEL_ACT_SITE_SQL } from '../parcels/oss-binding-source.js';
import catalog from '../../frontend/data/source-catalog.json' with { type: 'json' };
const polygon = { type: 'Polygon', coordinates: [[[10,40],[10.001,40],[10.001,40.001],[10,40]]] };

describe('database source dispatch', () => {
    it('keeps staged OSM reference data and falls back only when it is absent', async () => {
        const bbox = [10, 40, 10.01, 40.01];
        const completeEmpty = { type: 'FeatureCollection', features: [], partial: false, truncated: false };
        const live = vi.fn(async () => completeEmpty);
        const staged = vi.fn(async () => completeEmpty);
        expect(await osmReferenceSourceRegistry.open('osm-reference', { pool: {}, staged, live }).fetchBbox(bbox)).toBe(completeEmpty);
        expect(live).not.toHaveBeenCalled();
        staged.mockResolvedValueOnce(null);
        await osmReferenceSourceRegistry.open('osm-reference', { pool: {}, staged, live }).fetchBbox(bbox);
        expect(live).toHaveBeenCalledWith(bbox);
        const error = Object.assign(new Error('provider unavailable'), { status: 503, retryAfter: 60 });
        live.mockRejectedValueOnce(error);
        staged.mockResolvedValueOnce(null);
        await expect(osmReferenceSourceRegistry.open('osm-reference', { pool: {}, staged, live }).fetchBbox(bbox)).rejects.toBe(error);
    });
    it('registers every imported dataset with public config and configured-only adapters', () => {
        expect(databaseParcelSourceRegistry.sources()).toHaveLength(catalog.databaseSources.length);
        for (const descriptor of catalog.databaseSources) {
            expect(databaseParcelSourceRegistry.source(descriptor.id).config).toBe(descriptor);
            expect(databaseParcelSourceRegistry.adapters().find(adapter => adapter.id === descriptor.id).custom).toBe(false);
        }
    });
    it.each([
        ['oss-wfs', { coordinates: '10,40' }, 'FROM parcel p', false],
        ['parcel-ba', { smp: '001-001-001' }, 'FROM parcel_ba', true],
        ['parcel-bg', { cadmun: '1' }, 'FROM parcel_bg', true],
        ['parcel-lj', { eid: '1' }, 'FROM parcel_lj', true],
        ['parcel-nyc', { parcel_id: 'US-NY-100001' }, 'FROM parcel_nyc_geom', false]
    ])('dispatches %s native lookup and preserves no-result meaning', async (id, query, table, absent) => {
        const pool = { query: vi.fn(async () => ({ rows: [] })) };
        const read = openDatabaseParcelSource(id, pool).lookup({ query });
        if (absent) await expect(read).rejects.toMatchObject({ status: 404, payload: { error: 'No parcels found for the provided filters.' } });
        else expect(await read).toMatchObject({ type: 'FeatureCollection', features: [] });
        expect(pool.query.mock.calls[0][0]).toContain(table);
    });
    it('dispatches optimized binding reads through the configured OSS adapter', async () => {
        const measurement = { site_m2: 4, in_region: true, parcels: [] };
        const declared = { site_m2: 4, parcels: [{ parcelId: 'HR-1-a' }] };
        const pool = { query: vi.fn(async sql => ({ rows: [sql === BINDING_COUNT_SQL
            ? { parcels: 2 } : sql === BINDING_SQL ? measurement : declared] })) };
        const reader = openDatabaseParcelSource('oss-wfs', pool);
        const scope = { polygons: '[]', lines: '[]', projection: 'fixture-projection' };
        expect(await reader.countBindingCandidates(scope)).toBe(2);
        expect(await reader.bindingMeasurements({ ...scope, floorM: .1, uncertaintyM: .00001 })).toBe(measurement);
        const parcels = [{ id: 'HR-1-a', ko: 1, number: 'a' }];
        expect(await reader.declaredParcelSite({ parcels })).toBe(declared);
        expect(pool.query.mock.calls).toEqual([
            [BINDING_COUNT_SQL, ['[]', '[]', scope.projection]],
            [BINDING_SQL, ['[]', '[]', .1, scope.projection, .00001]],
            [PARCEL_ACT_SITE_SQL, [JSON.stringify(parcels)]]
        ]);
    });
    it('routes native NYC binding reads through the same registered dataset', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [{ geom_id: 1, geom: polygon, swis_sbl_ids: ['100001'] }] })) };
        const reader = openDatabaseParcelSource('parcel-nyc', pool);
        expect((await reader.queryIds(['US-NY-100001'])).features[0].properties).toEqual({ parcelId: 'US-NY-100001', sourceId: 'parcel-nyc' });
        expect((await reader.queryGeometry(polygon)).complete).toBe(true);
        expect(pool.query).toHaveBeenCalledTimes(2);
    });
    it('retains native validation before querying imported data', async () => {
        const pool = { query: vi.fn() };
        await expect(openDatabaseParcelSource('oss-wfs', pool).under({ body: { geometry: { type: 'Point', coordinates: [10,40] } } })).rejects.toMatchObject({ status: 400 });
        expect(pool.query).not.toHaveBeenCalled();
    });
    it.each([['gdi', 'gdi_building_footprint'], ['dgu', 'dgu_building']])('dispatches the %s map building survey', async (source, table) => {
        const pool = { query: vi.fn(async () => ({ rows: [{ geometry: polygon, properties: { nativeId: 1 } }] })) };
        expect(await buildingMapSourceRegistry.open(source, { pool }).lookup({ bbox: '400000,4500000,400100,4500100' })).toMatchObject({
            type: 'FeatureCollection', source, features: [{ geometry: polygon, properties: { nativeId: 1 } }]
        });
        expect(pool.query.mock.calls[0][0]).toContain(table);
        expect(pool.query.mock.calls[0][1]).toEqual([400000,4500000,400100,4500100]);
        expect(buildingMapSourceRegistry.source(source).config.storage).toBe(table);
    });
});
