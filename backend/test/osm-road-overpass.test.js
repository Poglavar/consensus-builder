// /osm-road outside the ingested table (backend/roads/osm-road-overpass.js): Overpass ways convert
// to the route's own feature shape, and the route falls back to them only when the table has no
// rows for a small bbox, never for a city-wide one.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildRoadQuery, overpassRoadsToFeatures, roadsBboxTooLarge, clipRoadsBbox, ROAD_MAX_SPAN_DEG } from '../roads/osm-road-overpass.js';
import { setupOsmRoadRoute } from '../routes/osm-road.js';

const BBOX = 'bbox=20.43,44.80,20.45,44.82&crs=EPSG:4326';

function fakePool(rows) {
    return { async query() { return { rows }; } };
}

function appWith(pool, fetchOverpassRoads, fetchOverpassRoadsAndRailways) {
    const app = express();
    setupOsmRoadRoute(app, pool, { fetchOverpassRoads, fetchOverpassRoadsAndRailways });
    return app;
}

describe('overpassRoadsToFeatures', () => {
    it('keeps every highway way with its tags, width and ordered coordinates', () => {
        const { features, truncated } = overpassRoadsToFeatures([
            { type: 'way', id: 7, tags: { highway: 'residential', name: 'Ulica', lanes: '2', width: '7.5 m', oneway: 'yes' }, geometry: [{ lon: 20.43, lat: 44.81 }, { lon: 20.44, lat: 44.81 }] },
            { type: 'way', id: 8, tags: { highway: 'footway' }, geometry: [{ lon: 20.43, lat: 44.812 }, { lon: 20.431, lat: 44.812 }] },
            { type: 'way', id: 9, tags: { building: 'yes' }, geometry: [{ lon: 20.43, lat: 44.81 }, { lon: 20.44, lat: 44.81 }] },
            { type: 'node', id: 10, tags: { highway: 'crossing' } },
            { type: 'way', id: 11, tags: { highway: 'path' }, geometry: [{ lon: 20.43, lat: 44.81 }] }
        ]);
        expect(truncated).toBe(false);
        expect(features.map(f => f.properties.osm_id)).toEqual([7, 8]);
        expect(features.map(f => f.id)).toEqual(['w7', 'w8']);
        expect(features[0].geometry).toEqual({ type: 'LineString', coordinates: [[20.43, 44.81], [20.44, 44.81]] });
        expect(features[0].properties).toMatchObject({ highway_type: 'residential', name: 'Ulica', width_meters: 7.5, source: 'overpass' });
        expect(features[0].properties.tags.oneway).toBe('yes');
        expect(features[1].properties.width_meters).toBeNull();
    });

    it('marks truncation at the cap', () => {
        const elements = Array.from({ length: 5 }, (_, i) => ({ type: 'way', id: i, tags: { highway: 'service' }, geometry: [{ lon: 1, lat: 1 }, { lon: 1.001, lat: 1 }] }));
        const { features, truncated } = overpassRoadsToFeatures(elements, 3);
        expect(features).toHaveLength(3);
        expect(truncated).toBe(true);
    });

    it('keeps railway ways and every way\'s node ids when railways are asked for', () => {
        const elements = [
            { type: 'way', id: 1, nodes: [10, 11], tags: { railway: 'rail' }, geometry: [{ lon: 1, lat: 1 }, { lon: 1.001, lat: 1 }] },
            { type: 'way', id: 2, nodes: [11, 12], tags: { highway: 'primary' }, geometry: [{ lon: 1.001, lat: 1 }, { lon: 1.002, lat: 1 }] }
        ];
        expect(overpassRoadsToFeatures(elements).features.map(f => f.properties.osm_id)).toEqual([2]);
        const { features } = overpassRoadsToFeatures(elements, 10, { railways: true });
        expect(features.map(f => [f.properties.osm_id, f.properties.highway_type, f.properties.railway_type])).toEqual([[1, null, 'rail'], [2, 'primary', null]]);
        expect(features.map(f => f.properties.osm_node_ids)).toEqual([[10, 11], [11, 12]]);
        expect(buildRoadQuery([1, 2, 3, 4], { railways: true })).toBe('[out:json][timeout:25];(way["highway"](2,1,4,3);way["railway"](2,1,4,3););out geom;');
    });

    it('clips a city-wide box to a scene around its centre, just inside the span limit', () => {
        const clipped = clipRoadsBbox([20.0, 44.5, 21.0, 45.0]);
        expect(clipped[2] - clipped[0]).toBeLessThan(ROAD_MAX_SPAN_DEG);
        expect(clipped[3] - clipped[1]).toBeLessThan(ROAD_MAX_SPAN_DEG);
        clipRoadsBbox([20.43, 44.80, 20.45, 44.82]).forEach((v, i) => expect(v).toBeCloseTo([20.43, 44.80, 20.45, 44.82][i], 9));
        expect(clipRoadsBbox([1, 1, 1, 2])).toBeNull();
    });

    it('builds a bbox query for every highway way and refuses city-wide boxes', () => {
        expect(buildRoadQuery([20.43, 44.80, 20.45, 44.82])).toBe('[out:json][timeout:25];way["highway"](44.8,20.43,44.82,20.45);out geom;');
        expect(roadsBboxTooLarge([20.43, 44.80, 20.45, 44.82])).toBe(false);
        expect(roadsBboxTooLarge([20.0, 44.5, 21.0, 45.0])).toBe(true);
    });
});

describe('GET /osm-road fallback', () => {
    it('serves the table when it has rows and never asks Overpass', async () => {
        let asked = 0;
        const rows = [{ geometry: { type: 'LineString', coordinates: [[20.43, 44.81], [20.44, 44.81]] }, properties: { osm_id: 1, highway_type: 'residential', tags: {} } }];
        const res = await request(appWith(fakePool(rows), async () => { asked++; return { features: [], truncated: false }; })).get(`/osm-road?${BBOX}`);
        expect(res.status).toBe(200);
        expect(res.body.features).toHaveLength(1);
        expect(res.body.source).toBe('osm_road');
        expect(asked).toBe(0);
    });

    it('asks Overpass for a small bbox the table does not cover and returns its ways', async () => {
        const calls = [];
        const fetchOverpassRoads = async (bbox) => {
            calls.push(bbox);
            return { features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[20.43, 44.81], [20.44, 44.81]] }, properties: { osm_id: 5, highway_type: 'tertiary', tags: { highway: 'tertiary' }, source: 'overpass' } }], truncated: false, partial: false };
        };
        const res = await request(appWith(fakePool([]), fetchOverpassRoads)).get(`/osm-road?${BBOX}`);
        expect(res.status).toBe(200);
        expect(calls).toEqual([[20.43, 44.80, 20.45, 44.82]]);
        expect(res.body.source).toBe('overpass');
        expect(res.body.features).toHaveLength(1);
        expect(res.body.features[0].properties.highway_type).toBe('tertiary');
    });

    it('answers a city-wide bbox the table does not cover for a scene-sized box around its centre', async () => {
        const calls = [];
        const res = await request(appWith(fakePool([]), async (bbox) => { calls.push(bbox); return { features: [], truncated: false }; }))
            .get('/osm-road?bbox=20.0,44.5,21.0,45.0&crs=EPSG:4326');
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        const [w, s, e, n] = calls[0];
        expect((w + e) / 2).toBeCloseTo(20.5, 9);
        expect((s + n) / 2).toBeCloseTo(44.75, 9);
        expect(roadsBboxTooLarge(calls[0])).toBe(false);
        expect(res.body).toMatchObject({ source: 'overpass', clipped: true, bbox: calls[0] });
    });

    it('asks for railways too, from the table and Overpass, only with railways=1', async () => {
        const sql = [];
        const pool = { async query(text) { sql.push(text); return { rows: [] }; } };
        const streets = [], both = [];
        const app = appWith(pool, async (b) => { streets.push(b); return { features: [] }; }, async (b) => { both.push(b); return { features: [] }; });
        await request(app).get(`/osm-road?${BBOX}`);
        await request(app).get(`/osm-road?${BBOX}&railways=1`);
        expect(streets).toHaveLength(1);
        expect(both).toHaveLength(1);
        expect(sql[0]).toContain('AND r.highway_type IS NOT NULL');
        expect(sql[1]).toContain('(r.highway_type IS NOT NULL OR r.railway_type IS NOT NULL)');
        expect(sql[1]).toContain("'osm_node_ids', r.osm_node_ids");
    });

    it('still answers the empty table result when Overpass fails', async () => {
        const res = await request(appWith(fakePool([]), async () => { throw Object.assign(new Error('busy'), { status: 503 }); })).get(`/osm-road?${BBOX}`);
        expect(res.status).toBe(200);
        expect(res.body.features).toEqual([]);
        expect(res.body.source).toBe('osm_road');
        expect(res.body.overpass).toBe('unavailable');
    });
});
