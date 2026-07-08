import { beforeEach, describe, expect, it } from 'vitest';
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
                id: 7,
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                footprint_area: 12,
                containment_ratio: 0.95,
                CESTICA_ID: 123,
                BROJ_CESTICE: '7396'
            }],
            rowCount: 1
        });

        const res = await request(app).get('/buildings?cestica_id=123');

        expect(res.status).toBe(200);
        expect(res.body.cestica_id).toBe('123');
        expect(res.body.count).toBe(1);
        expect(res.body.features[0].properties.cestica_id).toBe(123);
        expect(res.body.features[0].properties.containment_ratio).toBe(0.95);
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
                buffer_meters: 150
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
                properties: { building_id: 5 }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/buildings?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { building_id: 5 },
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
            }]
        });
    });
});
describe('POST /buildings/footprints', () => {
    const geometry = { type: 'Polygon', coordinates: [[[15.975, 45.812], [15.979, 45.812], [15.979, 45.814], [15.975, 45.814], [15.975, 45.812]]] };

    it('rejects a missing geometry', async () => {
        const res = await request(app).post('/buildings/footprints').send({ city: 'zagreb' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/geometry/);
    });

    it('returns footprints with heights for Zagreb (default city)', async () => {
        pool.setResult({
            rows: [
                { id: 101, height_m: 12.5, geometry: { type: 'MultiPolygon', coordinates: [[[[15.976, 45.813], [15.977, 45.813], [15.977, 45.8135], [15.976, 45.813]]]] } },
                { id: 102, height_m: null, geometry: { type: 'MultiPolygon', coordinates: [[[[15.978, 45.813], [15.9785, 45.813], [15.9785, 45.8135], [15.978, 45.813]]]] } }
            ],
            rowCount: 2
        });

        const res = await request(app).post('/buildings/footprints').send({ geometry });

        expect(res.status).toBe(200);
        expect(res.body.supported).toBe(true);
        expect(res.body.source).toBe('zagreb-cadastre');
        expect(res.body.count).toBe(2);
        expect(res.body.footprints[0]).toEqual(expect.objectContaining({ id: 101, height_m: 12.5, floors: null }));
        expect(res.body.footprints[1].height_m).toBe(null);

        // The provider query filters to mostly-inside current buildings and joins measured heights.
        const { sql, params } = pool.getCalls()[0];
        expect(sql).toContain('ST_Intersects(b.geom, q.g)');
        expect(sql).toContain('0.5 * ST_Area(b.geom)');
        expect(sql).toContain('b.current');
        expect(sql).toContain('LEFT JOIN building_3d_match');
        expect(params[0]).toBe(JSON.stringify(geometry));
    });

    it('reports unsupported for a city whose provider has no footprint source', async () => {
        const res = await request(app).post('/buildings/footprints').send({ geometry, city: 'new_york' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ supported: false, footprints: [], count: 0, source: null });
        expect(pool.getCalls().length).toBe(0);
    });

    it('reports unsupported for an unknown city instead of falling back to Zagreb', async () => {
        const res = await request(app).post('/buildings/footprints').send({ geometry, city: 'atlantis' });

        expect(res.status).toBe(200);
        expect(res.body.supported).toBe(false);
        expect(pool.getCalls().length).toBe(0);
    });

    it('returns 500 when the footprint query fails', async () => {
        pool.query = async () => {
            throw new Error('footprints unavailable');
        };

        const res = await request(app).post('/buildings/footprints').send({ geometry });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});
