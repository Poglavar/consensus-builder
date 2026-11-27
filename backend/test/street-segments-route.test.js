// GET /streets/segments (backend/streets/street-segments.js): the street at a point read from the
// road network, cut into segments with the buildings and house numbers around it, and named by the
// official identity sources (OSM's ref:GB:usrn tags, the street register) where they have one.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreetSegments, createStreetIdentityRegistry, overpassAddresses, buildAddressQuery } from '../streets/street-segments.js';
import { setupStreetsRoute } from '../routes/streets.js';

const LNG0 = -0.1, LAT0 = 51.5, M_PER_DEG = Math.PI * 6378137 / 180;
const ll = ([x, y]) => [LNG0 + x / (M_PER_DEG * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / M_PER_DEG];
const road = (id, name, points, tags = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: points.map(ll) },
    properties: { osm_id: id, name, highway_type: 'residential', tags: { name, highway: 'residential', ...tags }, source: 'overpass' } });
const FEATURES = [
    road(11, 'Hughes Road', [[0, 0], [100, 0], [150, 0]], { 'ref:GB:usrn': '21000001' }),
    road(12, 'Hughes Road', [[150, 0], [220, 0], [300, 0]], { 'ref:GB:usrn': '21000002' }),
    road(13, 'Cross Road', [[150, 0], [150, 120]])
];

function service({ features = FEATURES, live = true, pool = null } = {}) {
    const calls = { network: [], live: [], buildings: 0, addresses: 0 };
    const roads = {
        async readNetwork(boxes) { calls.network.push(boxes[0]); return live ? [] : features; },
        async readLiveNetwork(bbox) { calls.live.push(bbox); return { type: 'FeatureCollection', features }; }
    };
    const fetchBuildings = async () => { calls.buildings++; return { type: 'FeatureCollection', features: [] }; };
    const fetchAddresses = async () => { calls.addresses++; return overpassAddresses([
        { type: 'node', id: 1, lat: ll([20, 15])[1], lon: ll([20, 15])[0], tags: { 'addr:housenumber': '2', 'addr:street': 'Hughes Road' } },
        { type: 'way', id: 2, center: { lat: ll([250, -15])[1], lon: ll([250, -15])[0] }, tags: { 'addr:housenumber': '41', 'addr:street': 'Hughes Road', building: 'house' } }
    ]); };
    const identity = createStreetIdentityRegistry(pool || { async query() { return { rows: [{ w: 13.4, s: 42.3, e: 19.5, n: 46.6 }] }; } });
    return { calls, segments: createStreetSegments(null, { roads, fetchBuildings, fetchAddresses, identity }) };
}

describe('street segments service', () => {
    it('reads the street at a point, cuts it at its branching and names each segment by its own USRN', async () => {
        const { segments, calls } = service();
        const result = await segments.read({ point: ll([60, 5]) });
        expect(result.street).toMatchObject({ name: 'Hughes Road', wayIds: ['11', '12'], lengthM: 300, complete: true });
        // Two USRNs along the street: no single official id for the whole of it, one per segment.
        expect(result.street.official).toBeNull();
        expect(result.street.officialIds.map(row => row.id)).toEqual(['21000001', '21000002']);
        expect(result.segments.map(s => s.official)).toEqual([{ scheme: 'GB-USRN', id: '21000001' }, { scheme: 'GB-USRN', id: '21000002' }]);
        expect(result.segments[0].to).toMatchObject({ kind: 'branch', names: ['Cross Road'] });
        expect(result.segments[0].numbers).toEqual([expect.objectContaining({ houseNumber: '2', side: 'left' })]);
        expect(result.coverage).toEqual({ ways: 'overpass', waysComplete: true, buildings: 'osm', numbers: 'osm' });
        expect(calls.live).toHaveLength(1);
        expect(calls.buildings).toBe(1);
    });

    it('reads again over the street when it runs to the edge of the first box, within 0.04°', async () => {
        const long = [road(21, 'Long Lane', [[0, 0], [400, 0], [900, 0], [1600, 0]])];
        const { segments, calls } = service({ features: long });
        const result = await segments.read({ point: ll([100, 3]) });
        expect(calls.live.length).toBeGreaterThan(1);
        const last = calls.live.at(-1);
        expect(last[2] - last[0]).toBeLessThanOrEqual(0.04 + 1e-9);
        expect(result.street.lengthM).toBe(1600);
    });

    it('finds a street by name in a box, and says when none is there', async () => {
        const { segments } = service();
        const box = [ll([-50, -50])[0], ll([-50, -50])[1], ll([350, 50])[0], ll([350, 50])[1]];
        expect((await segments.read({ name: 'cross road', bbox: box })).street.name).toBe('Cross Road');
        await expect(segments.read({ point: ll([60, 200]) })).rejects.toMatchObject({ status: 404, code: 'street-not-found' });
    });

    it('matches the street register by name inside its coverage only', async () => {
        const queries = [];
        const pool = { async query(sql, params) {
            queries.push(sql);
            if (/EstimatedExtent/.test(sql)) return { rows: [{ w: -1, s: 51, e: 1, n: 52 }] };
            return { rows: [{ street_id: '4711', street_name: 'HUGHES ROAD' }, { street_id: '99', street_name: 'Cross Road' }] };
        } };
        const { segments } = service({ features: FEATURES.map(f => ({ ...f, properties: { ...f.properties, tags: { name: f.properties.name } } })), pool });
        const result = await segments.read({ point: ll([60, 5]) });
        expect(result.street.official).toEqual({ scheme: 'HR-street-register', id: '4711' });
        // Every segment asks with the same name and box: one register query in all.
        expect(queries.filter(sql => /FROM street/.test(sql))).toHaveLength(1);
    });
});

describe('GET /streets/segments', () => {
    const app = express();
    const { segments } = service();
    setupStreetsRoute(app, { async query() { return { rows: [] }; } }, { streetSegments: segments });

    it('answers a point and refuses a missing or oversized target', async () => {
        const [lng, lat] = ll([60, 5]);
        const ok = await request(app).get(`/streets/segments?point=${lng},${lat}`);
        expect(ok.status).toBe(200);
        expect(ok.body.segments).toHaveLength(2);
        expect((await request(app).get('/streets/segments')).status).toBe(400);
        expect((await request(app).get('/streets/segments?name=Hughes%20Road&bbox=-0.2,51.4,0,51.6')).status).toBe(400);
        const none = await request(app).get(`/streets/segments?point=${lng},${lat + 0.01}`);
        expect(none.status).toBe(404);
        expect(none.body.code).toBe('street-not-found');
    });

    it('asks Overpass for every addressed node, way and relation in one cell', () => {
        expect(buildAddressQuery([1, 2, 3, 4])).toBe('[out:json][timeout:25];nwr["addr:housenumber"](2,1,4,3);out center;');
    });
});
