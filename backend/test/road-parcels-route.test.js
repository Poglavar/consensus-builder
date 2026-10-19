// GET /road-parcels answers the ids of the classified road parcels in a bbox, nothing else: its one
// consumer (fetchRoadIds in frontend/js/parcels/fetch.js) marks parcels by id, so geometry, scores
// and the per-row clipping work they needed are never sent.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MAX_ROAD_PARCEL_IDS, setupRoadParcelsRoute } from '../routes/road-parcels.js';
import { createRouteApp } from './helpers/create-route-app.js';

function roadPool(rows) {
    const calls = [];
    return {
        calls,
        connect: async () => ({
            query: async (sql, params) => {
                calls.push({ sql, params });
                return { rows: typeof rows === 'function' ? rows(params) : rows };
            },
            release: () => { }
        })
    };
}

const BBOX = '15.965,45.805,15.990,45.820';

describe('GET /road-parcels', () => {
    it('answers only the road parcel ids and the truncation flag', async () => {
        const pool = roadPool([{ parcel_id: 'HR-335754-1' }, { parcel_id: 'HR-335754-2' }]);
        const res = await request(createRouteApp(setupRoadParcelsRoute, pool)).get(`/road-parcels?bbox=${BBOX}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ids: ['HR-335754-1', 'HR-335754-2'], truncated: false });
        expect(res.text).not.toMatch(/geometry|coordinates|Feature|score/);
        const { sql, params } = pool.calls[0];
        expect(sql).not.toMatch(/ST_AsGeoJSON|ST_Intersection|total_score/);
        expect(sql).toMatch(/classification = 'road'/);
        expect(params).toEqual([15.965, 45.805, 15.99, 45.82, MAX_ROAD_PARCEL_IDS + 1]);
    });

    it('caps the list and says so', async () => {
        const pool = roadPool(params => Array.from({ length: params[4] }, (_, i) => ({ parcel_id: `HR-1-${i}` })));
        const res = await request(createRouteApp(setupRoadParcelsRoute, pool)).get(`/road-parcels?bbox=${BBOX}`);

        expect(res.body.ids).toHaveLength(MAX_ROAD_PARCEL_IDS);
        expect(res.body.truncated).toBe(true);
    });

    it('refuses a missing or region-sized bbox before any SQL', async () => {
        const pool = roadPool([]);
        const app = createRouteApp(setupRoadParcelsRoute, pool);
        expect((await request(app).get('/road-parcels')).status).toBe(400);
        expect((await request(app).get('/road-parcels?bbox=13,42,19,46.5')).status).toBe(400);
        expect(pool.calls).toHaveLength(0);
    });
});
