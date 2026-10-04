// User-chosen building sources: discovery with the building profile (building layer, any stable id,
// height and storey fields, no exact-id round trip), the `building.` portable id kept apart from
// parcel ids, and the provider extruding a source's own heights (feet converted) by the shared rule.

import { describe, expect, it, vi } from 'vitest';
import { discoverCustomBuildingSource, discoverCustomParcelSource } from '../parcels/custom-source-discovery.js';
import { encodeCustomSource, decodeCustomBuildingSource, decodeCustomSource } from '../parcels/custom-source-config.js';
import { customBuildingFeature, createCustomBuildingProvider } from '../buildings/custom-source-3d.js';

const bbox = [15.97, 45.80, 15.9705, 45.8005];
const polygon = { type: 'Polygon', coordinates: [[[15.97, 45.80], [15.9702, 45.80], [15.9702, 45.8002], [15.97, 45.8002], [15.97, 45.80]]] };
const response = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => body });
const arcgisUrl = 'https://data.example/arcgis/rest/services/Buildings/FeatureServer/0';
const buildingLayer = async () => response({ objectIdField: 'OBJECTID', fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'HEIGHT_FT', type: 'esriFieldTypeDouble' },
    { name: 'NUM_FLOORS', type: 'esriFieldTypeInteger' }
] });

describe('building source discovery', () => {
    it('accepts a building layer keyed by its object id and finds its height and storey fields', async () => {
        const queryIds = vi.fn();
        const createSource = vi.fn(() => ({ queryBounds: async () => ({ complete: true, features: [{ id: 'B-1', geometry: polygon, properties: {} }] }), queryIds }));
        const result = await discoverCustomBuildingSource({ url: arcgisUrl, city: 'zagreb', metricSrid: 32633, bbox }, { fetchImpl: buildingLayer, createSource });
        expect(result.descriptor).toMatchObject({ adapter: 'arcgis', kind: 'building', idField: 'OBJECTID', heightField: 'HEIGHT_FT', heightUnit: 'ft', levelsField: 'NUM_FLOORS' });
        expect(result.descriptor.outFields).toEqual(expect.arrayContaining(['OBJECTID', 'HEIGHT_FT', 'NUM_FLOORS']));
        expect(queryIds).not.toHaveBeenCalled();
    });

    it('still refuses the same layer as a parcel source', async () => {
        const createSource = vi.fn(() => ({ queryBounds: async () => ({ complete: true, features: [] }) }));
        await expect(discoverCustomParcelSource({ url: arcgisUrl, city: 'zagreb', metricSrid: 32633, bbox }, { fetchImpl: buildingLayer, createSource }))
            .rejects.toMatchObject({ code: 'no-available-adapter' });
    });
});

describe('building source ids', () => {
    const config = { adapter: 'arcgis', endpoint: arcgisUrl, cityIds: ['zagreb'], metricSrid: 32633, idField: 'OBJECTID', objectIdField: 'OBJECTID',
        idType: 'integer', outFields: ['OBJECTID', 'HEIGHT_FT'], kind: 'building', heightField: 'HEIGHT_FT', heightUnit: 'ft' };

    it('round-trips under its own prefix and never decodes as a parcel source', () => {
        const id = encodeCustomSource(config);
        expect(id.startsWith('building.')).toBe(true);
        expect(decodeCustomBuildingSource(id)).toMatchObject({ id, heightField: 'HEIGHT_FT', idPrefix: expect.stringMatching(/^CUSTOM-B-[0-9a-f]{20}-$/) });
        expect(() => decodeCustomSource(id)).toThrow();
        const parcelId = encodeCustomSource({ ...config, kind: undefined, heightField: undefined, heightUnit: undefined, parcelNumberField: 'OBJECTID' });
        expect(() => decodeCustomBuildingSource(parcelId)).toThrow();
    });

    it('rejects a height field that is not read', () => {
        expect(() => encodeCustomSource({ ...config, heightField: 'ELSEWHERE' })).toThrow();
    });
});

describe('custom building provider', () => {
    it('converts a feet height to metres and falls back to storeys, then the estimate', () => {
        const descriptor = { heightField: 'HEIGHT_FT', heightUnit: 'ft', levelsField: 'NUM_FLOORS' };
        const read = props => customBuildingFeature(descriptor, { id: 'B-1', geometry: polygon, properties: { sourceProperties: props } }).properties;
        expect(read({ HEIGHT_FT: 100 }).measured_height_m).toBeCloseTo(30.48, 2);
        expect(read({ HEIGHT_FT: null, NUM_FLOORS: 4 })).toMatchObject({ measured_height_m: null, levels: 4 });
    });

    it('extrudes what the source returns, with the height source of each block', async () => {
        const id = encodeCustomSource({ adapter: 'arcgis', endpoint: arcgisUrl, cityIds: ['zagreb'], metricSrid: 32633, idField: 'OBJECTID',
            objectIdField: 'OBJECTID', idType: 'integer', outFields: ['OBJECTID', 'H'], kind: 'building', heightField: 'H', heightUnit: 'm' });
        const descriptor = decodeCustomBuildingSource(id);
        // The ArcGIS adapter asks for f=geojson pages.
        const small = { type: 'Polygon', coordinates: [[[15.9703, 45.80], [15.9704, 45.80], [15.9704, 45.8001], [15.9703, 45.8001], [15.9703, 45.80]]] };
        const fetchImpl = vi.fn(async () => response({ type: 'FeatureCollection', features: [
            { type: 'Feature', id: 1, properties: { OBJECTID: 1, H: 12 }, geometry: polygon },
            { type: 'Feature', id: 2, properties: { OBJECTID: 2, H: null }, geometry: small }
        ] }));
        const provider = createCustomBuildingProvider(descriptor, { fetchImpl });
        const result = await provider.near(polygon, 50);
        expect(result.source).toBe('custom-3d');
        expect(result.heights).toEqual({ measured: 1, levels: 0, estimated: 1 });
        expect(result.buildings.find(b => b.height_source === 'measured').z_max).toBe(12);
    });
});

describe('OpenStreetMap mirror as a building source', () => {
    const way = (id, lon, lat) => ({ type: 'way', id, tags: { building: 'yes', 'building:levels': '2' }, geometry: [
        { lon, lat }, { lon: lon + 0.0001, lat }, { lon: lon + 0.0001, lat: lat + 0.0001 }, { lon, lat: lat + 0.0001 }
    ] });
    const overpass = elements => vi.fn(async () => response({ elements }));

    it('recognises an Overpass endpoint by its /interpreter path', async () => {
        const { looksLikeOverpass } = await import('../buildings/overpass-source.js');
        expect(looksLikeOverpass('https://overpass.kumi.systems/api/interpreter')).toBe(true);
        expect(looksLikeOverpass(arcgisUrl)).toBe(false);
    });

    it('is a building-only id holding just the endpoint and city', () => {
        const config = { adapter: 'overpass', endpoint: 'https://mirror-a.example/api/interpreter', cityIds: ['lima'], kind: 'building' };
        const id = encodeCustomSource(config);
        expect(decodeCustomBuildingSource(id)).toMatchObject({ adapter: 'overpass', endpoint: config.endpoint, cityIds: ['lima'] });
        expect(() => decodeCustomSource(id)).toThrow();
        expect(() => encodeCustomSource({ ...config, kind: undefined })).toThrow();
        expect(() => encodeCustomSource({ ...config, outFields: ['x'] })).toThrow();
    });

    it('is accepted when it answers an Overpass query, and refused or reported busy otherwise', async () => {
        const { discoverOverpassSource } = await import('../buildings/overpass-source.js');
        const box = [-77.03, -12.05, -77.0295, -12.0495];
        const found = await discoverOverpassSource({ url: 'https://mirror-b.example/api/interpreter', city: 'lima', bbox: box },
            { fetchImpl: overpass([way(1, -77.0298, -12.0499)]) });
        expect(found.buildingCount).toBe(1);
        expect(found.source.id.startsWith('building.')).toBe(true);
        const notAMirror = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'not found' }));
        await expect(discoverOverpassSource({ url: 'https://mirror-c.example/api/interpreter', city: 'lima', bbox: box }, { fetchImpl: notAMirror }))
            .rejects.toMatchObject({ status: 422, code: 'no-available-adapter' });
        const busy = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'slow down' }));
        await expect(discoverOverpassSource({ url: 'https://mirror-d.example/api/interpreter', city: 'lima', bbox: box }, { fetchImpl: busy }))
            .rejects.toMatchObject({ status: 503, code: 'building-source-rate-limited', retryAfterSeconds: expect.any(Number) });
    });

    it('extrudes the mirror\'s buildings through the guarded fetch', async () => {
        const { createOverpassBuildingProvider } = await import('../buildings/overpass-source.js');
        const descriptor = decodeCustomBuildingSource(encodeCustomSource({ adapter: 'overpass', endpoint: 'https://mirror-e.example/api/interpreter', cityIds: ['lima'], kind: 'building' }));
        const fetchImpl = overpass([way(5, -71.5401, -16.4001)]);
        const provider = createOverpassBuildingProvider(descriptor, { fetchImpl });
        const point = { type: 'Point', coordinates: [-71.54, -16.40] };
        const result = await provider.near(point, 100);
        expect(fetchImpl).toHaveBeenCalledWith('https://mirror-e.example/api/interpreter', expect.objectContaining({ method: 'POST' }));
        expect(result).toMatchObject({ source: 'osm-3d', count: 1, heights: { measured: 0, levels: 1, estimated: 0 } });
    });

    it('is discovered by POST /building-sources/discover without trying the feature-service adapters', async () => {
        const { setupBuildingSourcesRoute } = await import('../routes/building-sources.js');
        const routes = {};
        const app = { post: (path, ...handlers) => { routes[path] = handlers[handlers.length - 1]; } };
        const discover = vi.fn();
        const discoverOverpass = vi.fn(async () => ({ source: { id: 'building.x', adapter: 'overpass' }, buildingCount: 7 }));
        setupBuildingSourcesRoute(app, { discover, discoverOverpass, publicFetch: vi.fn() });
        let sent;
        const res = { writableEnded: false, destroyed: false, once() {}, off() {}, set() { return this; },
            status() { return this; }, json(body) { sent = body; return this; } };
        await routes['/building-sources/discover']({ body: { url: 'https://overpass.example/api/interpreter', city: 'lima', bbox: [-77.03, -12.05, -77.0295, -12.0495] } }, res);
        expect(discover).not.toHaveBeenCalled();
        expect(sent).toMatchObject({ source: { adapter: 'overpass' }, buildingCount: 7 });
    });
});
