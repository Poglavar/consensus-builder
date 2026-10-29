// POST /buildings/under — the demolition scan's question for a whole plan in one request.
//
// A replay of 300 members used to ask /buildings/footprints once per member: hundreds of round
// trips, mostly cold-cache, and the earlier "prewarm the whole city" idea died on measurement —
// one plan-wide fetch came back `truncated: true` at 4,000 buildings, and a scan against a
// truncated pool silently records FEWER demolitions. Per-region the cap never binds (a block
// touches a handful of buildings), and when it somehow does, the whole answer is voided rather
// than trusted, because the cap cannot say which region is short.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupBuildingsRoute } from '../routes/buildings.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupBuildingsRoute, pool);
});

const square = (lng = 15.9, lat = 43.73) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]]
});

// The caller names the building dataset; neither the place nor a city selects one (87a04d800,
// buildings/index.js). The database-backed demolition scan is Zagreb's observed GDI stock, 'gdi-3d'.
const SOURCE = 'gdi-3d';
const post = (body) => request(app).post('/buildings/under').send({ source: SOURCE, ...body });

describe('what it asks the database', () => {
    it('asks ANY-intersection, not the urban rule\'s "mostly inside"', async () => {
        pool.setResult({ rows: [] });
        await post({ regions: [{ key: 'p-1', geometry: square() }] });
        const sql = pool.getCalls().map(call => call.sql).join('\n');
        expect(sql).toContain('WHERE ST_Intersects(v.geom, r.geom)');
        // An authored MultiPolygon of edge-touching buildings is OGC-invalid, and ST_Intersects
        // THROWS on invalid input — one bad region among 300 500'd the whole first live replay.
        expect(sql).toMatch(/ST_MakeValid\(ST_Transform\(\s*ST_SetSRID\(ST_GeomFromGeoJSON/);
        // The 50% filter belongs to /buildings/footprints. Here a building overlapped by 2 m² is
        // exactly the partial-demolition case the scan exists to find.
        expect(sql).not.toContain('0.5 * ST_Area');
    });

    it('joins all regions in one statement via jsonb, not one query per region', async () => {
        pool.setResult({ rows: [] });
        await post({ regions: [{ key: 'a', geometry: square() }, { key: 'b', geometry: square(15.91) }] });
        const underCalls = pool.getCalls().filter(call => /jsonb_to_recordset/.test(call.sql));
        expect(pool.getCalls()).toHaveLength(1);
        expect(underCalls).toHaveLength(1);
        const payload = JSON.parse(underCalls[0].params[0]);
        expect(payload.map(entry => entry.key)).toEqual(['a', 'b']);
        expect(payload[0].geometry.type).toBe('Polygon');
    });
});

describe('the coverage contract', () => {
    it('answers EVERY requested key, empty meaning "scanned, nothing there"', async () => {
        pool.setResult({
            rows: [{ key: 'a', id: 7, height_m: 12.5, geometry: square() }]
        });
        const res = await post({ regions: [{ key: 'a', geometry: square() }, { key: 'b', geometry: square(15.91) }] });
        expect(res.status).toBe(200);
        expect(res.body.supported).toBe(true);
        // 'b' matched nothing — it must still be present, or the client cannot tell "no buildings"
        // from "this region was never scanned", and that ambiguity is a silent under-demolition.
        expect(res.body.regions.a).toHaveLength(1);
        expect(res.body.regions.b).toEqual([]);
        expect(res.body.regions.a[0]).toEqual(expect.objectContaining({ id: 7, height_m: 12.5, floors: null }));
    });

    it('scans the source the caller names, whatever the place or city', async () => {
        pool.setResult({ rows: [] });
        const res = await post({ regions: [{ key: 'a', geometry: square() }], city: 'sibenik' });
        expect(res.status).toBe(200);
        expect(res.body.supported).toBe(true);
        expect(res.body.source).toBe('gdi');
        expect(res.body.regions).toEqual({ a: [] });
    });

    it('refuses a request that names no building source, before any query', async () => {
        const res = await request(app).post('/buildings/under').send({ regions: [{ key: 'a', geometry: square() }], city: 'sibenik' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid-building-source');
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe('what it refuses', () => {
    it('an empty region list', async () => {
        expect((await post({ regions: [] })).status).toBe(400);
        expect((await post({})).status).toBe(400);
    });

    it('more than 400 regions', async () => {
        const regions = Array.from({ length: 401 }, (_, i) => ({ key: `k${i}`, geometry: square() }));
        const res = await post({ regions });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/400/);
    });

    it('a region with no key, a duplicate key, or a non-areal geometry', async () => {
        expect((await post({ regions: [{ geometry: square() }] })).status).toBe(400);
        expect((await post({
            regions: [{ key: 'a', geometry: square() }, { key: 'a', geometry: square(15.91) }]
        })).status).toBe(400);
        expect((await post({
            regions: [{ key: 'a', geometry: { type: 'LineString', coordinates: [[15.9, 43.73], [15.91, 43.74]] } }]
        })).status).toBe(400);
        // A validation failure must happen BEFORE any query runs — half-validated input must not
        // reach the database.
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe('truncation voids the answer', () => {
    it('reports truncated and returns no per-region lists to be half-trusted', async () => {
        // 4001 rows: one past the cap. The provider cannot know which region the missing rows
        // belonged to, so a truncated answer with lists would read as complete for every region.
        pool.setResult({
            rows: Array.from({ length: 4001 }, (_, i) => ({
                key: 'a', id: i, height_m: null, geometry: square()
            }))
        });
        const res = await post({ regions: [{ key: 'a', geometry: square() }] });
        expect(res.status).toBe(200);
        expect(res.body.truncated).toBe(true);
        expect(res.body.regions.a).toEqual([]);
    });
});
