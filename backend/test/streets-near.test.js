// Frontage streets around a site (backend/streets/near.js, GET /streets/near): osm_road answers inside
// its own extent (Croatia), Overpass outside it (explore cities), one answer shape for both.
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildStreetQuery, overpassStreetsToGeoJSON, resetStreetsNearCache, streetsNear } from '../streets/near.js';
import { setupStreetsRoute } from '../routes/streets.js';

const CROATIA = { w: 13.4, s: 42.3, e: 19.5, n: 46.6 };

function fakePool({ extent = CROATIA, roads = [] } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/ST_Extent/.test(sql)) return { rows: [extent] };
            if (/FROM osm_road r/.test(sql)) return { rows: roads };
            throw new Error(`unexpected SQL: ${sql}`);
        }
    };
}

beforeEach(() => resetStreetsNearCache());

describe('overpassStreetsToGeoJSON', () => {
    it('turns highway ways into named LineStrings and skips the rest', () => {
        const fc = overpassStreetsToGeoJSON([
            { type: 'way', id: 7, tags: { highway: 'residential', name: 'Ilica' }, geometry: [{ lat: 45.8, lon: 15.9 }, { lat: 45.81, lon: 15.91 }] },
            { type: 'way', id: 8, tags: { highway: 'service' }, geometry: [{ lat: 45.8, lon: 15.9 }] },
            { type: 'node', id: 9, tags: { highway: 'crossing' } },
            { type: 'way', id: 10, tags: { building: 'yes' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] }
        ]);
        expect(fc.features).toEqual([{
            type: 'Feature',
            id: 'w7',
            geometry: { type: 'LineString', coordinates: [[15.9, 45.8], [15.91, 45.81]] },
            properties: { osm_id: 'w7', name: 'Ilica', highway: 'residential', source: 'overpass' }
        }]);
        expect(fc.truncated).toBe(false);
    });

    it('caps and flags truncation', () => {
        const way = id => ({ type: 'way', id, tags: { highway: 'residential' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] });
        const fc = overpassStreetsToGeoJSON([way(1), way(2), way(3)], 2);
        expect(fc.features).toHaveLength(2);
        expect(fc.truncated).toBe(true);
    });

    it('queries frontage highways and named service roads, bbox south,west,north,east', () => {
        const q = buildStreetQuery([139.7, 35.6, 139.71, 35.61]);
        expect(q).toContain('(35.6,139.7,35.61,139.71)');
        expect(q).toContain('residential');
        expect(q).not.toContain('footway');
        expect(q).toContain('way["highway"="service"]["name"]');
    });
});

describe('streetsNear', () => {
    it('reads osm_road inside its extent', async () => {
        const pool = fakePool({ roads: [{ geometry: { type: 'LineString', coordinates: [[15.9, 45.8], [15.91, 45.8]] }, osm_id: 42, name: 'Vlaška', highway_type: 'secondary' }] });
        const fc = await streetsNear(pool, [15.9, 45.79, 15.91, 45.81], { fetchOverpass: () => { throw new Error('must not ask Overpass'); } });
        expect(fc.source).toBe('osm_road');
        expect(fc.features[0].properties).toEqual({ osm_id: '42', name: 'Vlaška', highway: 'secondary', source: 'osm_road' });
        const roadCall = pool.calls.find(call => /FROM osm_road r/.test(call.sql));
        expect(roadCall.params.slice(0, 4)).toEqual([15.9, 45.79, 15.91, 45.81]);
        expect(roadCall.params[4]).toContain('residential');
    });

    it('asks Overpass outside the osm_road extent', async () => {
        const pool = fakePool();
        const asked = [];
        const fc = await streetsNear(pool, [139.7, 35.6, 139.71, 35.61], {
            fetchOverpass: async bbox => { asked.push(bbox); return { type: 'FeatureCollection', features: [], truncated: false, partial: false }; }
        });
        expect(fc.source).toBe('overpass');
        expect(asked).toEqual([[139.7, 35.6, 139.71, 35.61]]);
        expect(pool.calls.some(call => /FROM osm_road r/.test(call.sql))).toBe(false);
    });

    it('caches the extent', async () => {
        const pool = fakePool();
        await streetsNear(pool, [15.9, 45.79, 15.91, 45.81]);
        await streetsNear(pool, [15.9, 45.79, 15.91, 45.81]);
        expect(pool.calls.filter(call => /ST_Extent/.test(call.sql))).toHaveLength(1);
    });

    it('refuses a malformed or oversized bbox', async () => {
        await expect(streetsNear(fakePool(), [1, 2, 3])).rejects.toMatchObject({ status: 400 });
        await expect(streetsNear(fakePool(), [15, 45, 15.5, 45.1])).rejects.toMatchObject({ status: 400 });
        await expect(streetsNear(fakePool(), [15.9, 45.8, 15.8, 45.81])).rejects.toMatchObject({ status: 400 });
    });
});

describe('GET /streets/near', () => {
    const appWith = pool => {
        const app = express();
        setupStreetsRoute(app, pool);
        return app;
    };

    it('answers from osm_road with its source', async () => {
        const res = await request(appWith(fakePool())).get('/streets/near?bbox=15.9,45.79,15.91,45.81');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ type: 'FeatureCollection', features: [], source: 'osm_road' });
    });

    it('says 400 for a bad bbox', async () => {
        const res = await request(appWith(fakePool())).get('/streets/near?bbox=1,2');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid bbox/);
    });
});
