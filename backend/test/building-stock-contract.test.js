import { afterEach, describe, expect, it, vi } from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import { createBuildingProviders } from '../buildings/index.js';
import { createNycArcgisProvider } from '../buildings/nyc-arcgis.js';
import { createNycProvider } from '../buildings/nyc-footprints.js';
import { createZagrebProvider } from '../buildings/zagreb-3d.js';
import request from 'supertest';
import { setupBuildingsRoute } from '../routes/buildings.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const box = (x = -74.006, y = 40.7128, d = .0001) => ({ type: 'Polygon', coordinates: [
    [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]
] });
const region = { key: 'take', geometry: box(-74.00601, 40.71279, .00003) };
const feature = (properties = {}, geometry = box()) => ({ type: 'Feature', properties: {
    BIN: 123, bin: 123, HEIGHT_ROOF: 100, height_roof: 100, ...properties
}, geometry });
const response = value => ({ ok: true, json: async () => value });
const fc = features => ({ type: 'FeatureCollection', features });
afterEach(() => vi.unstubAllGlobals());

it('every configured city has the complete building provider contract', () => {
    const context = { URLSearchParams, console }; context.window = context;
    runInNewContext(cityConfigSource(), context);
    const registry = createBuildingProviders({ query: async () => ({ rows: [] }) }, {});
    const cities = context.CityConfigManager.getAvailableCities();
    expect(cities.length).toBeGreaterThan(500);
    for (const city of cities) for (const { id } of city.buildings?.sources || []) for (const method of ['near', 'footprints', 'footprintsUnder']) {
        const provider = registry.resolveSource(id);
        expect(typeof provider[method], `${city.id}.${id}.${method}`).toBe('function');
    }
});

for (const [name, create, fields] of [
    ['ArcGIS', createNycArcgisProvider, { BIN: 123, HEIGHT_ROOF: 100 }],
    ['Socrata', () => createNycProvider({}), { bin: 123, height_roof: 100 }]
]) describe(`NYC ${name} stock`, () => {
    function feed(features, { count = features.length, fail = false } = {}) {
        const requests = [];
        vi.stubGlobal('fetch', vi.fn(async value => {
            const url = new URL(value); requests.push(url);
            if (fail) throw new Error('source offline');
            return response(url.searchParams.has('returnCountOnly') ? { count } : fc(features));
        }));
        return requests;
    }
    it('finds sliver intersections, preserves source geometry and matches 3D identity/height', async () => {
        const requests = feed([feature(fields)]);
        const provider = create();
        const under = await provider.footprintsUnder([region, { key: 'empty', geometry: box(-74.005, 40.713) }]);
        expect(under.truncated).toBe(false);
        expect(under.regions.get('take')).toEqual([{ id: '123', geometry: box(), height_m: 30.48, floors: null }]);
        expect(under.regions.get('empty')).toEqual([]);
        const near = await provider.near({ type: 'Point', coordinates: [-74.00603, 40.71283] }, 37);
        expect(String(near.buildings[0].object_id)).toBe('123');
        expect(near.buildings[0].z_max).toBeCloseTo(under.regions.get('take')[0].height_m);
        const stockQuery = requests[0].searchParams.get('where') || requests[0].searchParams.get('$where');
        expect(stockQuery).not.toMatch(/height_roof/i);
    });
    it('returns polygon footprints and keeps absent height unknown', async () => {
        feed([feature({ ...fields, HEIGHT_ROOF: null, height_roof: null })]);
        const result = await create().footprints(box(-74.0061, 40.7127, .0005));
        expect(result).toMatchObject({ count: 1, truncated: false });
        expect(result.footprints[0].height_m).toBeNull();
    });
    it('does not demolish a building whose courtyard contains the take', async () => {
        const geometry = box(-74.0061, 40.7127, .001);
        geometry.coordinates.push(box(-74.00605, 40.71275, .0004).coordinates[0].slice().reverse());
        feed([feature(fields, geometry)]);
        expect((await create().footprintsUnder([region])).regions.get('take')).toEqual([]);
    });
    it('source failure remains unavailable and incomplete, never confirmed empty', async () => {
        feed([], { fail: true });
        const result = await create().footprintsUnder([region]);
        expect(result).toMatchObject({ truncated: true, unavailable: true });
    });
    it('an authoritative empty response covers every requested key', async () => {
        feed([]);
        const result = await create().footprintsUnder([region]);
        expect(result.truncated).toBe(false);
        expect(result.regions.get('take')).toEqual([]);
    });
    it('malformed source features invalidate coverage', async () => {
        feed([feature(fields, null)]);
        expect((await create().footprintsUnder([region])).truncated).toBe(true);
    });
});

it('ArcGIS detects its own service cap even below our requested limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async value => response(new URL(value).searchParams.has('returnCountOnly')
        ? { count: 2500 } : fc([feature()]))));
    expect((await createNycArcgisProvider().footprintsUnder([region])).truncated).toBe(true);
});
it('ArcGIS cannot confirm coverage without an independent count', async () => {
    vi.stubGlobal('fetch', vi.fn(async value => response(new URL(value).searchParams.has('returnCountOnly')
        ? {} : fc([]))));
    expect(await createNycArcgisProvider().footprintsUnder([region])).toMatchObject({ truncated: true, unavailable: true });
});
it('Socrata cap invalidates coverage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(fc(Array.from({ length: 4000 }, (_, i) => feature({ bin: i + 1 }))))));
    expect((await createNycProvider({}).footprintsUnder([region])).truncated).toBe(true);
});
it('Zagreb demolition stock uses observed GDI identities and intersections, not the legal cadastre', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ key: 'take', id: 71, geometry: box(), height_m: null }] })) };
    const result = await createZagrebProvider(pool).footprintsUnder([region, { key: 'empty', geometry: box() }]);
    expect(result).toMatchObject({ source: 'gdi', truncated: false });
    expect(result.regions.get('take')[0]).toEqual({ id: 71, geometry: box(), height_m: null, floors: null });
    expect(result.regions.get('empty')).toEqual([]);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('gdi_building_footprint');
    expect(sql).toContain('ST_MakeValid(f.geom)');
    expect(sql).toContain('ST_Intersects(v.geom, r.geom)');
    expect(sql).not.toContain('dgu_building');
});
it('Zagreb cap voids every region, never an apparently empty complete scan', async () => {
    const pool = { query: async () => ({ rows: Array.from({ length: 4001 }, () => ({ key: 'take' })) }) };
    expect((await createZagrebProvider(pool).footprintsUnder([region])).truncated).toBe(true);
});

it('NYC HTTP endpoints support footprint and demolition reads with the source IDs intact', async () => {
    vi.stubGlobal('fetch', vi.fn(async value => response(new URL(value).searchParams.has('returnCountOnly')
        ? { count: 1 } : fc([feature()]))));
    const app = createRouteApp(setupBuildingsRoute, { query: async () => ({ rows: [] }) });
    const under = await request(app).post('/buildings/under').send({ source: 'nyc-arcgis', regions: [region] });
    expect(under.status).toBe(200);
    expect(under.body).toMatchObject({ supported: true, truncated: false, source: 'nyc-arcgis' });
    expect(under.body.regions.take[0].id).toBe('123');
    const footprints = await request(app).post('/buildings/footprints').send({ source: 'nyc-arcgis', geometry: box(-74.0061, 40.7127, .0005) });
    expect(footprints.body).toMatchObject({ supported: true, truncated: false, count: 1 });
});
