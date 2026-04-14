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