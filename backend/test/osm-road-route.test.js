// GET /osm-road — the endpoint every existing-street feature reads.
//
// The answer is capped at 8000 ways, so it has to say when it hit the cap: a way that fell off the
// end is otherwise indistinguishable from a way OSM does not have, and a caller reconstructing a
// cross-section from what came back would report a well-mapped street as having no OSM way at all.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupOsmRoadRoute } from '../routes/osm-road.js';
import { createRouteApp } from './helpers/create-route-app.js';

const BBOX = '457900,5074700,458700,5075000';

function fakePool(rowCount = 3) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return {
                rows: Array.from({ length: rowCount }, (_, i) => ({
                    geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
                    properties: { osm_id: String(i), highway_type: 'residential' }
                }))
            };
        }
    };
}

let pool;
let app;

beforeEach(() => {
    pool = fakePool();
    app = createRouteApp(setupOsmRoadRoute, pool);
});

describe('the bbox it is asked for', () => {
    it('passes it through to the query', async () => {
        await request(app).get(`/osm-road?bbox=${BBOX}`).expect(200);
        expect(pool.calls[0].params).toEqual([457900, 5074700, 458700, 5075000]);
    });

    it('refuses one that is not a bbox', async () => {
        const response = await request(app).get('/osm-road?bbox=nonsense').expect(400);
        expect(response.body.error).toContain('EPSG:3765');
        expect(pool.calls.length).toBe(0);
    });
});

describe('saying when the answer is incomplete', () => {
    it('reports the limit it would truncate at', async () => {
        const response = await request(app).get(`/osm-road?bbox=${BBOX}`).expect(200);
        expect(response.body.truncated).toBe(false);
        expect(response.body.limit).toBe(8000);
    });

    // The one that matters: a full answer must SAY it is full, or the caller reports every street it
    // could not describe as a street OSM knows nothing about.
    it('says so when it filled the answer to the brim', async () => {
        app = createRouteApp(setupOsmRoadRoute, fakePool(8000));
        const response = await request(app).get(`/osm-road?bbox=${BBOX}`).expect(200);
        expect(response.body.truncated).toBe(true);
        expect(response.body.features.length).toBe(response.body.limit);
    });
});
