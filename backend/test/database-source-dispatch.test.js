// Imported defaults retain native read operations, coordinates and response meanings.
import { describe, expect, it, vi } from 'vitest';
import { databaseParcelSourceRegistry, openDatabaseParcelSource } from '../parcels/database-sources.js';
import { buildingMapSourceRegistry, buildingMapLookup, osmReferenceSourceRegistry } from '../buildings/map-source.js';
import { HR_PARCEL_IDS_SQL, HR_SITE_CANDIDATES_SQL } from '../parcels/oss-binding-source.js';
import { MAX_SOURCE_BINDING_PARCELS } from '../parcels/source-binding.js';
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
    it('dispatches the binding candidate reads through the configured OSS adapter', async () => {
        const region = { id: '1', geometry: polygon };
        const pool = { query: vi.fn(async sql => ({ rows: sql === HR_SITE_CANDIDATES_SQL
            ? [{ parcels: [{ id: 'HR-1-a', geometry: polygon }], regions: [region] }]
            : [{ id: 'HR-1-a', geometry: polygon }] })) };
        const reader = openDatabaseParcelSource('oss-wfs', pool);
        const feature = { type: 'Feature', properties: { parcelId: 'HR-1-a', sourceId: 'hr-cadastre' }, geometry: polygon };
        expect(await reader.queryGeometry(polygon)).toEqual({ complete: true, features: [feature], regions: [region] });
        // An id that is not an HR cadastral id is absent without a statement for it.
        expect(await reader.queryIds(['HR-1-a', 'HR-2-b', 'BG-1'])).toEqual({ complete: true, features: [feature], absentIds: ['HR-2-b', 'BG-1'] });
        expect(pool.query.mock.calls).toEqual([
            [HR_SITE_CANDIDATES_SQL, [JSON.stringify(polygon), MAX_SOURCE_BINDING_PARCELS + 1]],
            [HR_PARCEL_IDS_SQL, [JSON.stringify([{ id: 'HR-1-a', ko: 1, number: 'a' }, { id: 'HR-2-b', ko: 2, number: 'b' }])]]
        ]);
        // One more parcel than the cap: truncated, nothing served.
        pool.query.mockResolvedValueOnce({ rows: [{ parcels: Array.from({ length: MAX_SOURCE_BINDING_PARCELS + 1 }, (_, i) => ({ id: `HR-1-${i}` })), regions: [] }] });
        expect(await reader.queryGeometry(polygon)).toEqual({ complete: false, truncated: true, features: [], regions: [] });
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
