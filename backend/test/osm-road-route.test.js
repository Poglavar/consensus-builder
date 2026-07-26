// GET /osm-road — the endpoint every existing-street feature reads.
//
// Two things here are easy to get wrong in ways nothing complains about. Zagreb's 463 tramways carry
// no highway class, so the default query cannot see them and the lane paint has to ask; but the same
// endpoint feeds the reference layer and the road snapping, and a tram reservation is not something a
// new road should snap onto — so asking must be OPT-IN and the default must stay exactly as it was.
// And the answer is capped, so it has to say when it hit the cap: a way that fell off the end is
// otherwise indistinguishable from a way OSM does not have.
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

describe('which ways come back', () => {
    it('returns only the roads by default, exactly as it always did', async () => {
        await request(app).get(`/osm-road?bbox=${BBOX}`).expect(200);
        const { sql, params } = pool.calls[0];
        expect(sql).toContain('r.highway_type IS NOT NULL');
        // `railway_type` is always SELECTED; what must be absent is the filter that lets one through.
        expect(sql).not.toContain('r.railway_type = ANY');
        expect(params).toEqual([457900, 5074700, 458700, 5075000]);
    });

    it('adds the street-running railways when asked for them', async () => {
        await request(app).get(`/osm-road?bbox=${BBOX}&rail=1`).expect(200);
        const { sql, params } = pool.calls[0];
        expect(sql).toContain('r.railway_type = ANY($1)');
        expect(params[0]).toEqual(['tram', 'light_rail']);
        // The bbox still lands in the right placeholders behind it.
        expect(params.slice(1)).toEqual([457900, 5074700, 458700, 5075000]);
    });

    // Heavy rail is a railway line, not a street. It must never arrive with the trams.
    it('never includes heavy rail', async () => {
        await request(app).get(`/osm-road?bbox=${BBOX}&rail=1`).expect(200);
        expect(pool.calls[0].params[0]).not.toContain('rail');
    });

    it('treats anything that is not a yes as a no', async () => {
        await request(app).get(`/osm-road?bbox=${BBOX}&rail=bogus`).expect(200);
        expect(pool.calls[0].sql).not.toContain('r.railway_type = ANY');
        expect(pool.calls[0].params).toEqual([457900, 5074700, 458700, 5075000]);
    });

    it('still refuses a bbox that is not one', async () => {
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
