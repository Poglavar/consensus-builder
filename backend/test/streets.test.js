import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupStreetsRoute } from '../routes/streets.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupStreetsRoute, pool);
});

describe('GET /streets', () => {
    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/streets?bbox=1,2,3');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('supports requests without bbox filters', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/streets');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].params).toEqual([]);
    });

    it('returns street features', async () => {
        pool.setResult({
            rows: [{
                geometry: { type: 'LineString', coordinates: [[15.9, 45.79], [15.91, 45.8]] },
                properties: { name: 'Ilica' }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/streets?bbox=1,2,3,4');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { name: 'Ilica' },
                geometry: { type: 'LineString', coordinates: [[15.9, 45.79], [15.91, 45.8]] }
            }]
        });
    });

    it('returns 500 when the streets query fails', async () => {
        pool.query = async () => {
            throw new Error('streets unavailable');
        };

        const res = await request(app).get('/streets?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});