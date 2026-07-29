// Separately mapped street-side parking comes from the versioned local snapshot maintained by
// zagreb-parkiralista. The map endpoint is an indexed database read — never a live Overpass call.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupOsmParkingRoute } from '../routes/osm-parking.js';
import { createRouteApp } from './helpers/create-route-app.js';

const BBOX = '15.9808,45.8046,15.9835,45.8084';

function fakePool(rowCount = 2) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return {
                rows: Array.from({ length: rowCount }, (_, index) => ({
                    id: `way/${972607499 + index}`,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[15.982, 45.806], [15.983, 45.806],
                            [15.983, 45.807], [15.982, 45.806]]]
                    },
                    properties: {
                        osm_id: `way/${972607499 + index}`,
                        parking: 'street_side',
                        orientation: 'parallel',
                        source: 'parking.osm_parking'
                    }
                }))
            };
        }
    };
}

let pool;
let app;

beforeEach(() => {
    pool = fakePool();
    app = createRouteApp(setupOsmParkingRoute, pool);
});

describe('GET /osm-parking', () => {
    it('serves street-side polygons from the local versioned parking table', async () => {
        const response = await request(app).get(`/osm-parking?bbox=${BBOX}`).expect(200);
        expect(response.body.features).toHaveLength(2);
        expect(response.body.features[0].properties.source).toBe('parking.osm_parking');

        const { sql, params } = pool.calls[0];
        expect(sql).toContain('FROM parking.osm_parking');
        expect(sql).toContain("p.parking = 'street_side'");
        expect(sql).toContain('p.current');
        expect(sql).toContain('p.date_missing IS NULL');
        expect(sql).toContain('p.geom && ST_MakeEnvelope');
        expect(params).toEqual([15.9808, 45.8046, 15.9835, 45.8084]);
    });

    it('rejects malformed or city-scale bounds without touching the database', async () => {
        await request(app).get('/osm-parking?bbox=nope').expect(400);
        await request(app).get('/osm-parking?bbox=15,45,16,46').expect(400);
        expect(pool.calls).toEqual([]);
    });

    it('reports when the bounded response reaches its feature cap', async () => {
        app = createRouteApp(setupOsmParkingRoute, fakePool(2000));
        const response = await request(app).get(`/osm-parking?bbox=${BBOX}`).expect(200);
        expect(response.body.truncated).toBe(true);
        expect(response.body.limit).toBe(2000);
    });
});
