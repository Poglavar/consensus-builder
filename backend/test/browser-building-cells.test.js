// The adapter worker's building cells: a URL building source read straight from its public service
// (never our server), split while the service is over its limit, answering what POST /buildings/cell
// answers for the same kind; and the mapping module the server's reader shares with it.
import { describe, expect, it, vi } from 'vitest';
import { createBrowserBuildingCells } from '../buildings/browser-building-cells.js';
import { customBuildingFeature, decodeBuildingSourceId, BUILDING_SOURCE_LIMITS } from '../buildings/building-cell-read.js';
import { encodeCustomSource, decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

const arcgisUrl = 'https://data.example/arcgis/rest/services/Buildings/FeatureServer/0';
const sourceId = encodeCustomSource({ adapter: 'arcgis', endpoint: arcgisUrl, cityIds: ['bogota'], metricSrid: 32618,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer', outFields: ['OBJECTID', 'H_FT', 'PISOS'],
    kind: 'building', heightField: 'H_FT', heightUnit: 'ft', levelsField: 'PISOS' });
// A 200 m cell in Bogotá: under the adapter's 1 km² limit, read in one query.
const cell = [-74.072, 4.61, -74.0702, 4.6118];
// Building ids carry the source's own prefix, as the server's reader gives them.
const idOf = native => decodeCustomBuildingSource(sourceId).idPrefix + native;
const square = (lon, lat, d = 0.0001) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
const answer = body => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/geo+json' }),
    json: async () => body, text: async () => JSON.stringify(body) });
// The service's GeoJSON answer for a box: the fixture's features, whatever the query.
const arcgisAnswer = features => answer({ type: 'FeatureCollection', features: features.map(([id, lon, lat, props]) => ({
    type: 'Feature', id, properties: { OBJECTID: id, ...props }, geometry: square(lon, lat) })) });

describe('browser building cells', () => {
    it('reads a cell from the service directly, with no credentials and no request to our server', async () => {
        const fetchImpl = vi.fn(async () => arcgisAnswer([[1, -74.0715, 4.6105, { H_FT: 100 }], [2, -74.071, 4.611, { PISOS: 4 }], [3, -74.0705, 4.6112, {}]]));
        const cells = createBrowserBuildingCells({ fetchImpl });
        const near = await cells.read(sourceId, { kind: 'near', bbox: cell });
        expect(near).toMatchObject({ supported: true, kind: 'near', bbox: cell, count: 3, complete: true, source: 'custom-3d' });
        const byId = Object.fromEntries(near.items.map(record => [record.object_id, record]));
        expect(byId[idOf(1)]).toMatchObject({ height_source: 'measured' });
        expect(byId[idOf(1)].z_max - byId[idOf(1)].z_min).toBeCloseTo(30.48, 2);
        expect(byId[idOf(2)]).toMatchObject({ height_source: 'levels' });
        expect(byId[idOf(3)]).toMatchObject({ height_source: 'estimated' });
        for (const [url, init] of fetchImpl.mock.calls) {
            expect(new URL(url).origin).toBe('https://data.example');
            expect(init.credentials).toBe('omit');
        }
        const footprints = await cells.read(sourceId, { kind: 'footprints', bbox: cell });
        expect(footprints).toMatchObject({ supported: true, kind: 'footprints', count: 3, complete: true, source: 'custom-footprints' });
        expect(footprints.items.find(item => item.id === idOf(1))).toEqual({ id: idOf(1), geometry: square(-74.0715, 4.6105), height_m: expect.closeTo(30.48, 2), floors: null });
        expect(footprints.items.find(item => item.id === idOf(2))).toMatchObject({ height_m: null, floors: 4 });
    });

    it('reads a box over the area limit in quarters and merges a building seen twice', async () => {
        const fetchImpl = vi.fn(async () => arcgisAnswer([[7, -74.065, 4.605, {}]]));
        // 1.6 km across: over the 950 m side, so four quarters.
        const read = await createBrowserBuildingCells({ fetchImpl }).read(sourceId, { kind: 'footprints', bbox: [-74.07, 4.60, -74.0556, 4.61] });
        expect(read).toMatchObject({ count: 1, complete: true });
        expect(new Set(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('geometry'))).size).toBe(4);
    });

    it('answers the whole cell unavailable when the service fails, with no partial buildings', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '40' }), text: async () => 'down', json: async () => ({}) }));
        const read = await createBrowserBuildingCells({ fetchImpl }).read(sourceId, { kind: 'near', bbox: cell });
        expect(read).toMatchObject({ supported: true, items: [], complete: false, unavailable: true });
    });

    it('reads an OpenStreetMap mirror with one Overpass query per box', async () => {
        const mirror = encodeCustomSource({ adapter: 'overpass', endpoint: 'https://mirror.example/api/interpreter', cityIds: ['lima'], kind: 'building' });
        const way = { type: 'way', id: 9, tags: { building: 'yes', height: '12' },
            geometry: [{ lon: -77.03, lat: -12.05 }, { lon: -77.0299, lat: -12.05 }, { lon: -77.0299, lat: -12.0499 }, { lon: -77.03, lat: -12.0499 }] };
        const fetchImpl = vi.fn(async () => answer({ elements: [way] }));
        const read = await createBrowserBuildingCells({ fetchImpl }).read(mirror, { kind: 'near', bbox: [-77.031, -12.051, -77.029, -12.049] });
        expect(read).toMatchObject({ count: 1, complete: true });
        expect(read.items[0]).toMatchObject({ object_id: 'w9', z_max: expect.any(Number), height_source: 'measured' });
        expect(fetchImpl).toHaveBeenCalledWith('https://mirror.example/api/interpreter', expect.objectContaining({ method: 'POST', credentials: 'omit' }));
    });

    it('refuses an id that is not a building source', async () => {
        const cells = createBrowserBuildingCells({ fetchImpl: vi.fn() });
        await expect(cells.read('gdi-3d', { kind: 'near', bbox: cell })).rejects.toMatchObject({ code: 'invalid-building-source' });
        await expect(cells.read(sourceId, { kind: 'all', bbox: cell })).rejects.toMatchObject({ code: 'invalid-building-cell' });
    });
});

describe('building source mapping shared by the server and the worker', () => {
    it('decodes a building id in the browser as the server does', () => {
        const server = decodeCustomBuildingSource(sourceId);
        const browser = decodeBuildingSourceId(sourceId);
        for (const key of [...Object.keys(BUILDING_SOURCE_LIMITS), 'id', 'idPrefix', 'adapter', 'endpoint', 'heightField', 'heightUnit', 'levelsField', 'outFields', 'name']) {
            expect(browser[key], key).toEqual(server[key]);
        }
    });

    it('converts a feet height to metres and falls back to storeys', () => {
        const descriptor = { heightField: 'H_FT', heightUnit: 'ft', levelsField: 'PISOS' };
        const read = props => customBuildingFeature(descriptor, { id: 5, geometry: square(0, 0), properties: { sourceProperties: props } }).properties;
        expect(read({ H_FT: 100 }).measured_height_m).toBeCloseTo(30.48, 2);
        expect(read({ H_FT: 0, PISOS: '3' })).toMatchObject({ measured_height_m: null, levels: 3 });
        expect(read({})).toMatchObject({ measured_height_m: null, levels: null });
    });
});
