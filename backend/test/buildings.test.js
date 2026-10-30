import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupBuildingsRoute } from '../routes/buildings.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupBuildingsRoute, pool);
});

describe('GET /buildings', () => {
    it('rejects invalid bbox when cestica_id is not provided', async () => {
        const res = await request(app).get('/buildings?bbox=1,2,3');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('rejects invalid bbox even when cestica_id is provided', async () => {
        const res = await request(app).get('/buildings?cestica_id=123&bbox=1,2,3');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('returns buildings for a parcel id query', async () => {
        pool.setResult({
            rows: [{
                object_id: 7,
                metadata: null,
                source: 'gdi',
                geom: '0106000020B50E0000',
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                footprint_area: 12,
                intersection_area: 11.4,
                containment_ratio: 0.95,
                // node-postgres returns unquoted identifiers lowercased
                cestica_id: 123,
                broj_cestice: '7396'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/buildings?cestica_id=123');

        expect(res.status).toBe(200);
        expect(res.body.cestica_id).toBe('123');
        expect(res.body.count).toBe(1);
        expect(res.body.features[0].properties.cestica_id).toBe(123);
        expect(res.body.features[0].properties.containment_ratio).toBe(0.95);
        expect(res.body.features[0].properties.broj_cestice).toBe('7396');
        expect(res.body.features[0].properties.object_id).toBe(7);
        expect(res.body.features[0].properties).not.toHaveProperty('geom');
    });

    it('parcel query survives invalid footprints: MakeValid inside area math, raw geoms in the join', async () => {
        pool.setResult({ rows: [], rowCount: 0 });
        await request(app).get('/buildings?cestica_id=21486692');
        const sql = pool.getCalls()[0].sql;
        expect(sql).not.toMatch(/bf\.\*/);
        // every ST_Intersection argument is a made-valid geometry, never a raw column
        const intersections = [...sql.matchAll(/ST_Intersection\(([^)]*)\)/g)].map(m => m[1]);
        expect(intersections.length).toBeGreaterThan(0);
        for (const args of intersections) expect(args).not.toMatch(/\b(p|bf)\.geom\b/);
        expect(sql).toMatch(/ST_MakeValid\(bf\.geom\)/);
        expect(sql).toMatch(/ST_MakeValid\(p\.geom\)/);
        expect(sql).toMatch(/bf\.geom && p\.geom/);
        expect(sql).toMatch(/NULLIF\(a\.footprint_area, 0\)/);
        expect(pool.getCalls()[0].params).toEqual(['21486692']);
    });

    it('rejects a non-numeric cestica_id instead of a pg cast error', async () => {
        const res = await request(app).get('/buildings?cestica_id=abc');
        expect(res.status).toBe(400);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('returns 500 when the building query fails', async () => {
        pool.query = async () => {
            throw new Error('buildings unavailable');
        };

        const res = await request(app).get('/buildings?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('returns an empty parcel-scoped collection when no buildings match', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/buildings?cestica_id=123');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            features: [],
            cestica_id: '123',
            count: 0
        });
    });

    it('POST /buildings/near rejects missing geometry', async () => {
        const res = await request(app).post('/buildings/near').send({ buffer_meters: 100 });
        expect(res.status).toBe(400);
    });

    it('POST /buildings/near returns buildings with 3D faces', async () => {
        pool.setResult({
            rows: [{
                object_id: 42,
                z_min: 120,
                z_max: 135,
                faces: [
                    { type: 'Polygon', coordinates: [[[15.9, 45.79, 120], [15.91, 45.79, 120], [15.91, 45.78, 135], [15.9, 45.79, 120]]] }
                ]
            }],
            rowCount: 1
        });

        const res = await request(app)
            .post('/buildings/near')
            .send({
                geometry: { type: 'Point', coordinates: [15.9, 45.79] },
                buffer_meters: 150,
                source: 'gdi-3d'
            });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.buildings[0].object_id).toBe(42);
        expect(res.body.buildings[0].z_min).toBe(120);
        expect(res.body.buildings[0].z_max).toBe(135);
        expect(Array.isArray(res.body.buildings[0].faces)).toBe(true);
        expect(res.body.buildings[0].faces.length).toBe(1);
    });

    it('returns building features for bbox queries', async () => {
        pool.setResult({
            rows: [{
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                properties: { object_id: 5 }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/buildings?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            source: 'gdi',
            truncated: false,
            features: [{
                type: 'Feature',
                properties: { object_id: 5 },
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
            }]
        });
    });

    // The bbox layer is the WORKING SET — the buildings detection scans and the 3D view renders.
    // It must be the GDI objects (object_id), because those are the ones gdi_building_3d meshes.
    // Serving the DGU cadastre here is the original bug: we cut one dataset and rendered another.
    it('serves the GDI footprints by default, keyed by object_id', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/buildings?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.source).toBe('gdi');
        const { sql } = pool.getCalls()[0];
        expect(sql).toContain('gdi_building_footprint');
        expect(sql).toContain('f.object_id');
        expect(sql).not.toContain('dgu_building');
    });

    it('serves the DGU cadastre as an explicit, separate reference layer', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/buildings?bbox=1,2,3,4&source=dgu');

        expect(res.status).toBe(200);
        expect(res.body.source).toBe('dgu');
        const { sql } = pool.getCalls()[0];
        expect(sql).toContain('dgu_building');
        expect(sql).toContain('b.current');
        expect(sql).not.toContain('gdi_building_footprint');
    });

    it('rejects an unknown source rather than quietly serving the wrong survey', async () => {
        const res = await request(app).get('/buildings?bbox=1,2,3,4&source=overture');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/source/);
        expect(pool.getCalls().length).toBe(0);
    });

    it('flags a truncated response — an uncovered bbox means buildings that can never be detected', async () => {
        pool.setResult({
            rows: Array.from({ length: 4000 }, (_, i) => ({
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                properties: { object_id: i }
            })),
            rowCount: 4000
        });

        const res = await request(app).get('/buildings?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.truncated).toBe(true);
    });
});
describe('POST /buildings/cell', () => {
    const cell = [15.975, 45.812, 15.979, 45.814];
    const row = { object_id: 42, z_min: 120, z_max: 135, faces: [
        { type: 'Polygon', coordinates: [[[15.976, 45.813, 120], [15.977, 45.813, 120], [15.977, 45.8135, 135], [15.976, 45.813, 120]]] }] };

    it('rejects an unknown kind and a bbox that is not a cell', async () => {
        expect((await request(app).post('/buildings/cell').send({ kind: 'all', bbox: cell, source: 'gdi-3d' })).status).toBe(400);
        expect((await request(app).post('/buildings/cell').send({ kind: 'near', bbox: [15.98, 45.8, 15.97, 45.81], source: 'gdi-3d' })).status).toBe(400);
        expect((await request(app).post('/buildings/cell').send({ kind: 'near', bbox: [15.9, 45.8, 16.0, 45.9], source: 'gdi-3d' })).status).toBe(400);
    });

    it('answers one cell of 3D records from the selected source and serves a repeat from its cache', async () => {
        pool.setResult({ rows: [row], rowCount: 1 });
        const first = await request(app).post('/buildings/cell').send({ kind: 'near', bbox: cell, source: 'gdi-3d' });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ supported: true, kind: 'near', bbox: cell, count: 1, complete: true });
        expect(first.body.items[0]).toMatchObject({ object_id: 42, z_max: 135 });
        const queries = pool.getCalls().length;
        const again = await request(app).post('/buildings/cell').send({ kind: 'near', bbox: cell, source: 'gdi-3d' });
        expect(again.body).toEqual(first.body);
        expect(pool.getCalls().length).toBe(queries);
    });

    const outline = { type: 'MultiPolygon', coordinates: [[[[15.976, 45.813], [15.977, 45.813], [15.977, 45.8135], [15.976, 45.813]]]] };

    it("answers GDI footprints for the 2D map with the properties GET /buildings gives, never the cadastre's", async () => {
        pool.setResult({ rows: [{ geometry: outline, properties: { object_id: 42, area_m2: 118.5, height_m: 14.2, eave_height_m: 11, survey_year: 2022 } },
            { geometry: outline, properties: { object_id: 43, area_m2: null, height_m: null, eave_height_m: null, survey_year: null } }], rowCount: 2 });
        const res = await request(app).post('/buildings/cell').send({ kind: 'footprints', bbox: cell, source: 'gdi-3d' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ supported: true, kind: 'footprints', count: 2, complete: true, source: 'gdi-footprints' });
        expect(res.body.items[0]).toEqual({ id: 42, geometry: outline, height_m: 14.2, floors: null, area_m2: 118.5, eave_height_m: 11, survey_year: 2022 });
        expect(res.body.items[1]).toEqual({ id: 43, geometry: outline, height_m: null, floors: null, area_m2: null, eave_height_m: null, survey_year: null });
        const { sql, params } = pool.getCalls()[0];
        expect(sql).toContain('FROM gdi_building_footprint f');
        expect(sql).toContain('LEFT JOIN gdi_building g');
        expect(sql).not.toContain('dgu_building');
        // In WGS84 out, the cell polygon in.
        expect(sql).toContain('ST_Transform(f.geom, 4326)');
        expect(JSON.parse(params[0]).type).toBe('Polygon');
    });

    it('splits a GDI footprint cell over the 4,000-row cap into quarters', async () => {
        const capped = { rows: Array.from({ length: 4001 }, (_, i) => ({ geometry: outline, properties: { object_id: i } })), rowCount: 4001 };
        const quarter = n => ({ rows: [{ geometry: outline, properties: { object_id: 10000 + n } }], rowCount: 1 });
        pool.setResults([capped, quarter(1), quarter(2), quarter(3), quarter(4)]);
        const res = await request(app).post('/buildings/cell').send({ kind: 'footprints', bbox: cell, source: 'gdi-3d' });
        expect(res.body).toMatchObject({ count: 4, complete: true });
        expect(pool.getCalls()).toHaveLength(5);
    });

    it('answers the DGU cadastre as a building source: estimated 3D blocks and flat footprints keyed by zgrada_id', async () => {
        const square = { type: 'Polygon', coordinates: [[[15.976, 45.813], [15.9762, 45.813], [15.9762, 45.8132], [15.976, 45.8132], [15.976, 45.813]]] };
        pool.setResult({ rows: [{ zgrada_id: 9001, broj_zgrade: '12', naziv_vrste_zgrade: 'Stambena zgrada', geometry: square }], rowCount: 1 });
        const near = await request(app).post('/buildings/cell').send({ kind: 'near', bbox: cell, source: 'dgu' });
        expect(near.status).toBe(200);
        expect(near.body).toMatchObject({ supported: true, count: 1, complete: true, source: 'dgu-3d' });
        expect(near.body.items[0]).toMatchObject({ object_id: '9001', height_source: 'estimated' });
        expect(near.body.items[0].z_max).toBeGreaterThan(near.body.items[0].z_min);
        pool.setResult({ rows: [{ zgrada_id: 9001, broj_zgrade: '12', naziv_vrste_zgrade: 'Stambena zgrada', geometry: square }], rowCount: 1 });
        const flat = await request(app).post('/buildings/cell').send({ kind: 'footprints', bbox: cell, source: 'dgu' });
        expect(flat.body).toMatchObject({ supported: true, count: 1, source: 'dgu-footprints' });
        expect(flat.body.items[0]).toEqual({ id: 9001, geometry: square, height_m: null, floors: null, broj_zgrade: '12', naziv_vrste_zgrade: 'Stambena zgrada' });
        for (const { sql } of pool.getCalls()) {
            expect(sql).toContain('FROM dgu_building b');
            expect(sql).toContain('b.current');
            expect(sql).not.toContain('gdi_building');
        }
    });
});

describe('POST /buildings/footprints', () => {
    const geometry = { type: 'Polygon', coordinates: [[[15.975, 45.812], [15.979, 45.812], [15.979, 45.814], [15.975, 45.814], [15.975, 45.812]]] };

    it('rejects a missing geometry', async () => {
        const res = await request(app).post('/buildings/footprints').send({ city: 'zagreb' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/geometry/);
    });

    it('returns footprints with heights from the selected survey', async () => {
        pool.setResult({
            rows: [
                { id: 101, height_m: 12.5, geometry: { type: 'MultiPolygon', coordinates: [[[[15.976, 45.813], [15.977, 45.813], [15.977, 45.8135], [15.976, 45.813]]]] } },
                { id: 102, height_m: null, geometry: { type: 'MultiPolygon', coordinates: [[[[15.978, 45.813], [15.9785, 45.813], [15.9785, 45.8135], [15.978, 45.813]]]] } }
            ],
            rowCount: 2
        });

        const res = await request(app).post('/buildings/footprints').send({ geometry, source: 'gdi-3d' });

        expect(res.status).toBe(200);
        expect(res.body.supported).toBe(true);
        expect(res.body.source).toBe('zagreb-cadastre');
        expect(res.body.count).toBe(2);
        expect(res.body.footprints[0]).toEqual(expect.objectContaining({ id: 101, height_m: 12.5, floors: null }));
        expect(res.body.footprints[1].height_m).toBe(null);

        // The provider query filters to mostly-inside current buildings and joins measured heights.
        // The urban-rule "existing buildings" mode reasons about the LEGAL stock, so it stays on the
        // cadastre — but height is a property of the GDI OBJECT, so it is read off gdi_building via
        // the match table, not off the match table itself (the rename migration moved the column).
        const { sql, params } = pool.getCalls()[0];
        expect(sql).toContain('ST_Intersects(b.geom, q.g)');
        expect(sql).toContain('0.5 * ST_Area(b.geom)');
        expect(sql).toContain('b.current');
        expect(sql).toContain('FROM dgu_building b');
        expect(sql).toContain('LEFT JOIN dgu_gdi_building_match m');
        expect(sql).toContain('LEFT JOIN gdi_building g');
        expect(sql).toContain('g.height_m');
        expect(params[0]).toBe(JSON.stringify(geometry));
    });

    // A geometry in another location still uses the explicitly selected provider.
    const manhattan = { type: 'Polygon', coordinates: [[[-73.987, 40.748], [-73.984, 40.748], [-73.984, 40.75], [-73.987, 40.75], [-73.987, 40.748]]] };

    it('uses the explicitly selected footprint source across geometry locations', async () => {
        const res = await request(app).post('/buildings/footprints').send({ geometry: manhattan, source: 'gdi-3d' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ supported: true, footprints: [], count: 0, source: 'zagreb-cadastre' });
        expect(pool.getCalls().length).toBe(1);
    });

    it('reads the explicitly selected OpenStreetMap source', async () => {
        // Live Overpass is stubbed: a unit test never touches the network.
        const overpass = vi.fn(async () => ({ ok: true, json: async () => ({ elements: [] }) }));
        vi.stubGlobal('fetch', overpass);
        try {
            // Dhaka: no configured city covers it
            const dhaka = { type: 'Polygon', coordinates: [[[90.407, 23.71], [90.409, 23.71], [90.409, 23.712], [90.407, 23.712], [90.407, 23.71]]] };
            const res = await request(app).post('/buildings/footprints').send({ geometry: dhaka, source: 'osm' });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ supported: true, source: 'osm-footprints' });
            expect(overpass).toHaveBeenCalled();
            // Only the staged-OSM city lookup reaches the database; Zagreb's survey tables never do.
            expect(pool.getCalls().every(call => !/dgu_building|gdi_building/.test(call.sql))).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('returns 500 when the footprint query fails', async () => {
        pool.query = async () => {
            throw new Error('footprints unavailable');
        };

        const res = await request(app).post('/buildings/footprints').send({ geometry, source: 'gdi-3d' });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});
