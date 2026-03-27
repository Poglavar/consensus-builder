import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupObjectRoute } from '../routes/objects.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupObjectRoute, pool);
});

describe('GET /objects', () => {
    it('rejects missing geometry', async () => {
        const res = await request(app).get('/objects');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing required parameter: geometry' });
    });

    it('rejects invalid geometry json', async () => {
        const res = await request(app).get('/objects?geometry=not-json');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid geometry parameter. Must be valid JSON.' });
    });

    it('rejects unsupported geometry types', async () => {
        const geometry = encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: [15.9, 45.79] }));

        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid geometry format. Expected Polygon or MultiPolygon.' });
    });

    it('rejects polygons with malformed coordinates', async () => {
        const geometry = encodeURIComponent(JSON.stringify({
            type: 'Polygon',
            coordinates: [[[15.9, 45.79], [15.91, 'bad'], [15.91, 45.78], [15.9, 45.79]]]
        }));

        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid geometry coordinates. Expected GeoJSON Polygon or MultiPolygon rings with numeric coordinates.'
        });
    });

    it('rejects multipolygons with malformed rings', async () => {
        const geometry = encodeURIComponent(JSON.stringify({
            type: 'MultiPolygon',
            coordinates: [
                [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78]]]
            ]
        }));

        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid geometry coordinates. Expected GeoJSON Polygon or MultiPolygon rings with numeric coordinates.'
        });
    });

    it('returns 404 when no 3d objects intersect the geometry', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const geometry = encodeURIComponent(JSON.stringify({
            type: 'Polygon',
            coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]]
        }));
        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'No 3D objects found for the given geometry.' });
    });

    it('returns 500 when the objects query fails', async () => {
        pool.query = async () => {
            throw new Error('object lookup failed');
        };

        const geometry = encodeURIComponent(JSON.stringify({
            type: 'Polygon',
            coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]]
        }));
        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('detects EPSG:3765 geometry via CRS metadata', async () => {
        pool.setResult({
            rows: [{
                object_id: 102,
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                properties: { height: 10 }
            }],
            rowCount: 1
        });

        const geometry = encodeURIComponent(JSON.stringify({
            type: 'Polygon',
            crs: { properties: { name: 'EPSG:3765' } },
            coordinates: [[[500000, 5030000], [500010, 5030000], [500010, 5029990], [500000, 5030000]]]
        }));
        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(200);
        expect(pool.getCalls().at(-1).params[1]).toBe(3765);
    });

    it('returns object features for a matching polygon', async () => {
        pool.setResult({
            rows: [{
                object_id: 101,
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] },
                properties: { height: 42 }
            }],
            rowCount: 1
        });

        const geometry = encodeURIComponent(JSON.stringify({
            type: 'Polygon',
            coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]]
        }));
        const res = await request(app).get(`/objects?geometry=${geometry}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { object_id: 101, height: 42 },
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
            }]
        });
        expect(pool.getCalls()[0].params[1]).toBe(4326);
    });
});