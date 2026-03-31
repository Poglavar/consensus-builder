import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupLandUsesRoute } from '../routes/land-uses.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupLandUsesRoute, pool);
});

describe('GET /land-uses', () => {
    it('rejects missing coordinates', async () => {
        const res = await request(app).get('/land-uses');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing required parameter: coordinates. Expected x,y format.' });
    });

    it('rejects invalid coordinate ranges', async () => {
        const res = await request(app).get('/land-uses?coordinates=9999,9999');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
        });
    });

    it('rejects malformed coordinate pairs', async () => {
        const res = await request(app).get('/land-uses?coordinates=15.9,abc');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid coordinates. Expected x,y format.' });
    });

    it('returns 500 when land-use lookup fails', async () => {
        pool.query = async () => {
            throw new Error('planned land use unavailable');
        };

        const res = await request(app).get('/land-uses?coordinates=15.9,45.79');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('queries HTRS96 coordinates without transforming from WGS84', async () => {
        pool.setResult({ rows: [], rowCount: 0 });

        const res = await request(app).get('/land-uses?coordinates=500000,5030000');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [] });
        expect(pool.getCalls()[0].sql).toContain('ST_SetSRID(ST_MakePoint($1, $2), 3765)');
        expect(pool.getCalls()[0].sql).toContain('oznaka is null');
    });

    it('returns land use features for WGS84 coordinates', async () => {
        pool.setResult({
            rows: [{
                oznaka: 'M1',
                namjena: 'Mixed use',
                skupna_namjena: 'Urban',
                naziv_plana: 'Generalni urbanisticki plan Zagreba',
                godina_zadnje_izmjene: 2024,
                geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
            }],
            rowCount: 1
        });

        const res = await request(app).get('/land-uses?coordinates=15.9,45.79');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features[0].properties.oznaka).toBe('M1');
        expect(pool.getCalls()[0].sql).toContain('ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765)');
    });
});