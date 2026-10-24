// Shared dispatch preserves each domain's native reader and backend context.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { parcelSourceCatalog, parcelSourceRegistry, createParcelSource } from '../parcels/sources.js';
import { buildingSourceRegistry, createBuildingProviders } from '../buildings/index.js';
import { planningSourceRegistry, createPlanningSources } from '../planning/sources.js';
import { createOwnershipRegistry } from '../ownership/registry.js';
import { buildingDetailSourceRegistry, fetchFloorModels, attachNearbyFloorModels } from '../buildings/floor-models.js';
import { encodeCustomSource, decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');
const polygon = { type: 'Polygon', coordinates: [[[10, 40], [10.001, 40], [10.001, 40.001], [10, 40]]] };
const response = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const arcgis = { id: 'fixture-parcels', adapter: 'arcgis', endpoint: 'https://example.com/FeatureServer/0',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idPrefix: 'FIXTURE-', outFields: ['OBJECTID'] };

describe('domain source registries', () => {
    it('registers all parcel descriptors and dispatches native ID reads through the adapter', async () => {
        expect(parcelSourceRegistry.sources()).toHaveLength(parcelSourceCatalog.sources.length);
        for (const descriptor of parcelSourceCatalog.sources) {
            expect(parcelSourceRegistry.source(descriptor.id).config).toBe(descriptor);
        }
        const fetchImpl = vi.fn(async () => response({ type: 'FeatureCollection', features: [{
            type: 'Feature', properties: { OBJECTID: 17 }, geometry: polygon
        }] }));
        const found = await createParcelSource(arcgis, { fetchImpl }).queryIds(['FIXTURE-17']);
        expect(found.features.map(feature => feature.id)).toEqual(['FIXTURE-17']);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(String(fetchImpl.mock.calls[0][0])).toContain(arcgis.endpoint);
    });

    it('dispatches built-in buildings with the caller pool and retains service caching', async () => {
        const id = buildingSourceRegistry.sources().find(source => source.adapter === 'gdi-3d').id;
        const pool = { query: vi.fn(async () => ({ rows: [{ object_id: 17, z_min: 1, z_max: 9, faces: [] }] })) };
        const service = createBuildingProviders(pool, {});
        const reader = service.resolveSource(id);
        expect(service.forRequest({ source: id })).toBe(reader);
        expect(await reader.near(polygon, 20)).toMatchObject({ count: 1, buildings: [{ object_id: 17 }] });
        expect(pool.query.mock.calls[0][1]).toEqual([JSON.stringify(polygon), 20]);
        expect(buildingSourceRegistry.source(id).config).not.toHaveProperty('pool');
    });

    it('dispatches custom building transports with the native descriptor and reader', async () => {
        const id = encodeCustomSource({ adapter: 'arcgis', endpoint: arcgis.endpoint, cityIds: ['fixture'],
            metricSrid: 32632, idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
            outFields: ['OBJECTID'], kind: 'building' });
        const descriptor = decodeCustomBuildingSource(id);
        const fetchImpl = vi.fn(async () => response({ type: 'FeatureCollection', features: [] }));
        const reader = buildingSourceRegistry.open(SourceRuntime.source('buildings', descriptor.adapter, descriptor,
            { kind: 'custom' }), { fetchImpl });
        expect(await reader.footprints(polygon)).toMatchObject({ footprints: [], count: 0 });
        expect(fetchImpl).toHaveBeenCalledOnce();
        const service = createBuildingProviders({ query: vi.fn() }, {});
        expect(service.resolveSource(id)).toBe(service.resolveSource(id));
    });

    it('dispatches planning providers with their descriptors and keeps Atlas loading lazy', async () => {
        const source = planningSourceRegistry.sources().find(entry => entry.adapter === 'gup');
        const pool = { query: vi.fn(async () => ({ rows: [] })) };
        const reader = planningSourceRegistry.open(source.id);
        expect(reader.descriptor).toBe(source.config);
        expect(await reader.parcel(pool, { parcel: 'HR-1-fixture' })).toEqual([]);
        expect(pool.query).toHaveBeenCalled();
        const metadata = { id: 'fixture-atlas', city: 'fixture', label: 'Fixture', edition: '1',
            url: 'https://example.com/slices.geojson' };
        const fetchImpl = vi.fn(async () => response({ type: 'FeatureCollection', features: [{
            type: 'Feature', properties: { slice_id: 17 }, geometry: polygon
        }] }));
        const before = planningSourceRegistry.sources().length;
        const atlas = createPlanningSources(JSON.stringify([metadata]), { fetchImpl }).at(-1);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await atlas.record({}, { city: metadata.city, recordId: 'missing' })).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(planningSourceRegistry.sources()).toHaveLength(before);
    });

    it('dispatches ownership with backend context and validates the answer', async () => {
        const declaration = { adapter: 'fixture', attribution: 'Fixture register' };
        const pool = { query: vi.fn() };
        const lookup = vi.fn(async ({ parcelId }) => ({ parcelId, owners: [], observedAt: null, retrievedAt: null }));
        const registry = createOwnershipRegistry({ catalog: { sources: [{ id: 'fixture', ownership: declaration }] },
            adapters: { fixture: { lookup } } });
        expect(await registry.lookup('fixture', 'FIXTURE-17', { pool })).toMatchObject({
            contract: 'parcel-ownership/1', sourceId: 'fixture', parcelId: 'FIXTURE-17', attribution: declaration.attribution
        });
        expect(lookup).toHaveBeenCalledExactlyOnceWith({ parcelId: 'FIXTURE-17', pool, fetchImpl: undefined, declaration });
    });

    it('dispatches detail reads and attachment to current versioned storage', async () => {
        const identity = { city: 'fixture', source: 'survey', ownerId: '', buildingId: '17' };
        const row = { city: identity.city, source: identity.source, owner_id: '', building_id: identity.buildingId,
            version: 3, floor_plans: { layouts: [] }, footprint: polygon };
        const pool = { query: vi.fn(async () => ({ rows: [row] })) };
        expect((await fetchFloorModels(pool, [identity])).size).toBe(1);
        const [building] = await attachNearbyFloorModels(pool, identity.city, identity.source, [{ object_id: 17 }]);
        expect(building.floorModel).toMatchObject({ buildingId: '17', version: 3 });
        expect(pool.query).toHaveBeenCalledTimes(2);
        expect(pool.query.mock.calls[0][0]).toContain('WHERE m.current');
        expect(buildingDetailSourceRegistry.sources()[0].config).toEqual({
            id: 'building-floor-models', storage: 'consensus.building_floor_model'
        });
    });
});
