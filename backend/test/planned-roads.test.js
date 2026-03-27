import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupPlannedRoadRoute } from '../routes/planned-roads.js';
import { createRouteApp } from './helpers/create-route-app.js';

function createPlannedRoadPool(resultRows = []) {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('FROM road') || sql.includes('FROM parcel')) {
                return { rows: [{ geom: null }], rowCount: 1 };
            }
            return { rows: resultRows, rowCount: resultRows.length };
        },
        release() { }
    };

    return {
        calls,
        async connect() {
            return client;
        }
    };
}

let pool;
let app;

beforeEach(() => {
    pool = createPlannedRoadPool([
        {
            props: { road_name: 'Planned Avenue' },
            geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] }
        }
    ]);
    app = createRouteApp(setupPlannedRoadRoute, pool);
});

describe('GET /planned-road', () => {
    it('rejects invalid bbox values', async () => {
        const res = await request(app).get('/planned-road?bbox=1,2,3');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
    });

    it('returns 500 when planned-road lookup fails', async () => {
        pool = {
            async connect() {
                return {
                    async query() {
                        throw new Error('planned road query failed');
                    },
                    release() { }
                };
            }
        };
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('supports requests without bbox filters', async () => {
        const res = await request(app).get('/planned-road');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(pool.calls.at(-1).params[4]).toBe(false);
    });

    it('filters out rows without geometry', async () => {
        pool = createPlannedRoadPool([
            { props: { road_name: 'Broken row' }, geometry: null },
            { props: { road_name: 'Good row' }, geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.78], [15.9, 45.79]]] } }
        ]);
        app = createRouteApp(setupPlannedRoadRoute, pool);

        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(res.body.features[0].properties.road_name).toBe('Good row');
    });

    it('returns planned road features with default styling props', async () => {
        const res = await request(app).get('/planned-road?bbox=1,2,3,4');

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features[0].properties.road_name).toBe('Planned Avenue');
        expect(res.body.features[0].properties.planStatus).toBe('planned');
        expect(res.body.features[0].properties.source).toBe('government_plan');
    });
});