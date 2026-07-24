// Route tests for the server-side carve: POST /buildings/near?proposals and POST /buildings/carve.
// These prove the three outcomes end-to-end through the route — a tunnelled building comes back
// intact, a cut one comes back smaller, a demolished one does not come back at all — and that a
// request WITHOUT `proposals` is byte-for-byte what it always was.
//
// Every demolition record is keyed by the GDI object_id — the same id the meshes carry — so the
// server matches records to meshes by id. There is no id-resolution query any more.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as turf from '@turf/turf';
import { setupBuildingsRoute } from '../routes/buildings.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

let pool;
let app;

beforeEach(() => {
    pool = createMockPool();
    app = createRouteApp(setupBuildingsRoute, pool);
});

const LAT0 = 45.81;

function box(lng, lat, wLng, hLat) {
    return {
        type: 'Polygon',
        coordinates: [[
            [lng, lat], [lng + wLng, lat], [lng + wLng, lat + hLat], [lng, lat + hLat], [lng, lat]
        ]]
    };
}

// One `gdi_building_3d` row as the Zagreb provider returns it: faces in EPSG:4326 with ABSOLUTE Z.
function meshRow(objectId, lng, zMin = 120, zMax = 135) {
    const ring = box(lng, LAT0, 0.00036, 0.00025).coordinates[0];
    return {
        object_id: objectId,
        z_min: zMin,
        z_max: zMax,
        faces: [
            { type: 'Polygon', coordinates: [ring.map(c => [c[0], c[1], zMin])] },
            { type: 'Polygon', coordinates: [ring.map(c => [c[0], c[1], zMax])] }
        ]
    };
}

// Three buildings in a row, and one corridor that treats each of them differently:
//   TUNNELLED (61) — the corridor crosses it, the user tunnelled, so NO record was ever written
//   CUT       (62) — a record clips a slice off it and carries the surviving remainder
//   RAZED     (63) — a record takes the whole footprint (no remainder)
const TUNNELLED_LNG = 15.9700;
const CUT_LNG = 15.9710;
const RAZED_LNG = 15.9720;

const BUILDINGS = [
    meshRow(61, TUNNELLED_LNG),
    meshRow(62, CUT_LNG),
    meshRow(63, RAZED_LNG)
];

const CUT_FOOTPRINT = box(CUT_LNG, LAT0, 0.00036, 0.00025);

const CORRIDOR = {
    // A band running west→east across all three buildings.
    polygon: box(15.9695, LAT0 + 0.0001, 0.0035, 0.00005),
    // Record ids are GDI object_ids — the same key the meshes above carry.
    tunnels: [{ id: 'building-tunnel:x', edgeKey: 'a|b', buildingIds: ['61'] }],
    demolishedBuildings: [
        // 62 loses its western third and keeps the rest. Both halves are on the record, because
        // the subtraction happened at draw time against this object's own GDI footprint.
        {
            id: '62',
            geometry: CUT_FOOTPRINT,
            demolishedPart: box(CUT_LNG, LAT0, 0.00012, 0.00025),
            remainder: box(CUT_LNG + 0.00012, LAT0, 0.00024, 0.00025)
        },
        // 63 goes entirely (a full record carries no remainder).
        { id: '63', geometry: box(RAZED_LNG, LAT0, 0.00036, 0.00025) }
    ]
};

const PROPOSAL_ROW = {
    proposal_id: 'p-carve-test',
    id: 900,
    status: 'Applied',
    city: 'zagreb',
    roadProposal: { status: 'applied', definition: CORRIDOR },
    structureProposal: null,
    buildingProposal: null
};

// Query order on /buildings/near: the provider fetches the meshes, then carve.js fetches the
// proposals. That is ALL — the records already name their meshes, so there is nothing to resolve.
function primePool() {
    pool.setResults([
        { rows: BUILDINGS, rowCount: BUILDINGS.length },
        { rows: [PROPOSAL_ROW], rowCount: 1 }
    ]);
}

const NEAR_BODY = { geometry: { type: 'Point', coordinates: [15.971, LAT0] }, buffer_meters: 300 };

describe('POST /buildings/near with `proposals`', () => {
    it('leaves the response untouched when `proposals` is absent', async () => {
        pool.setResult({ rows: BUILDINGS, rowCount: BUILDINGS.length });

        const res = await request(app).post('/buildings/near').send(NEAR_BODY);

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(3);
        expect(res.body.buildings.map(b => b.object_id)).toEqual([61, 62, 63]);
        // The meshes come back exactly as the provider gave them — no re-extrusion.
        expect(res.body.buildings[1]).toEqual(BUILDINGS[1]);
        // And no proposal lookup was made at all.
        expect(pool.getCalls()).toHaveLength(1);
    });

    it('returns the tunnelled building INTACT, the cut one REDUCED, and the demolished one ABSENT', async () => {
        primePool();

        const res = await request(app)
            .post('/buildings/near')
            .send({ ...NEAR_BODY, proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        const byId = new Map(res.body.buildings.map(b => [b.object_id, b]));

        // RAZED: gone.
        expect(byId.has(63)).toBe(false);
        expect(res.body.count).toBe(2);

        // TUNNELLED: byte-identical to the source mesh — the road passes under it, and no record
        // names it, so nothing can reach it.
        expect(byId.get(61)).toEqual(BUILDINGS[0]);

        // CUT: same object_id, a smaller footprint, still at its original elevation.
        const cut = byId.get(62);
        expect(cut).toBeTruthy();
        const before = turf.area(CUT_FOOTPRINT);
        const after = turf.area(turf.convex(turf.featureCollection(
            cut.faces.flatMap(f => f.coordinates[0].map(c => turf.point([c[0], c[1]])))
        )));
        expect(after).toBeLessThan(before * 0.75);
        expect(after).toBeGreaterThan(before * 0.5);
        expect(cut.z_min).toBe(120);
        expect(cut.z_max).toBe(135);
        expect(cut.faces).not.toEqual(BUILDINGS[1].faces);
    });

    it('makes exactly two queries — the meshes and the proposals, and nothing to resolve ids with', async () => {
        primePool();

        await request(app).post('/buildings/near').send({ ...NEAR_BODY, proposals: ['p-carve-test'] });

        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls.some(call => /dgu_gdi_building_match|building_3d_match/.test(call.sql))).toBe(false);
    });

    it('accepts `proposals` as a comma-separated string', async () => {
        primePool();

        const res = await request(app)
            .post('/buildings/near')
            .send({ ...NEAR_BODY, proposals: 'p-carve-test' });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
    });

    it('uses the ids explicitly selected by the caller, independent of browser-local applied state', async () => {
        pool.setResults([
            { rows: BUILDINGS, rowCount: 3 },
            { rows: [{ ...PROPOSAL_ROW, status: 'Active', applied: false, roadProposal: { status: 'unapplied', applied: false, definition: CORRIDOR } }], rowCount: 1 }
        ]);

        const res = await request(app)
            .post('/buildings/near')
            .send({ ...NEAR_BODY, proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.buildings.find(b => b.object_id === 63)).toBeUndefined();
    });

    it('carves when applied=true even though the legacy status still reads unapplied (the 474 fix)', async () => {
        // Proposal 474's exact shape after the backfill: lifecycle Active, road sub status still
        // 'unapplied', but the new applied boolean is true. The cut/razed buildings must resolve.
        pool.setResults([
            { rows: BUILDINGS, rowCount: 3 },
            { rows: [{ ...PROPOSAL_ROW, status: 'Active', applied: true, roadProposal: { status: 'unapplied', applied: true, definition: CORRIDOR } }], rowCount: 1 }
        ]);

        const res = await request(app)
            .post('/buildings/near')
            .send({ ...NEAR_BODY, proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        // 63 razed (gone), 61 tunnelled + 62 cut remain → 2 buildings back.
        expect(res.body.count).toBe(2);
        expect(res.body.buildings.find(b => b.object_id === 63)).toBeUndefined();
    });

    it('never touches a mesh no record names, however much the corridor overlaps it', async () => {
        // The corridor's polygon crosses all three buildings, but only 62 and 63 have records.
        // 61 comes back whole. Under footprint-overlap matching the corridor region would have
        // prism-ified it; there is no such path left.
        primePool();

        const res = await request(app)
            .post('/buildings/near')
            .send({ ...NEAR_BODY, proposals: ['p-carve-test'] });

        expect(res.body.buildings.find(b => b.object_id === 61)).toEqual(BUILDINGS[0]);
    });
});

describe('POST /buildings/carve', () => {
    it('rejects a request with no proposals', async () => {
        const res = await request(app).post('/buildings/carve').send({ city: 'zagreb' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/proposals/);
    });

    it('reports a verdict for the AFFECTED buildings only', async () => {
        // /buildings/carve looks the proposals up FIRST (it derives the area from their records),
        // and only then runs the provider.
        pool.setResults([
            { rows: [PROPOSAL_ROW], rowCount: 1 },
            { rows: BUILDINGS, rowCount: BUILDINGS.length }
        ]);

        const res = await request(app).post('/buildings/carve').send({ proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);

        const byId = new Map(res.body.carves.map(c => [c.object_id, c]));
        // The tunnelled building is not in the list at all — nothing happened to it.
        expect(byId.has(61)).toBe(false);

        expect(byId.get(63).verdict).toBe('razed');
        expect(byId.get(63).remainder).toBeNull();

        const cut = byId.get(62);
        expect(cut.verdict).toBe('cut');
        expect(cut.remainder.type).toMatch(/Polygon/);
        expect(cut.z_min).toBe(120);
        expect(cut.z_max).toBe(135);
        expect(turf.area(cut.remainder)).toBeLessThan(turf.area(CUT_FOOTPRINT));

        // A cut ships the mesh already re-extruded from its remainder, so no consumer needs an
        // extruder of its own — the walk sim swaps these faces into the feature it already has.
        expect(Array.isArray(cut.faces)).toBe(true);
        expect(cut.faces.length).toBeGreaterThan(0);
        // The faces sit at the building's real elevation, not at sea level.
        const zs = cut.faces.flatMap(f => f.coordinates[0].map(c => c[2]));
        expect(Math.min(...zs)).toBe(120);
        expect(Math.max(...zs)).toBe(135);
    });

    it('returns an empty carve list when the ids match no applied proposal', async () => {
        pool.setResults([{ rows: [], rowCount: 0 }]);

        const res = await request(app).post('/buildings/carve').send({ proposals: ['p-nope'] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ carves: [], count: 0, source: null });
        // No building query was made — an unmatched id must not trigger an unbounded scan.
        expect(pool.getCalls()).toHaveLength(1);
    });

    it('carves the mesh a record NAMES, by object_id, with no match-table lookup', async () => {
        pool.setResults([
            { rows: [PROPOSAL_ROW], rowCount: 1 },
            { rows: BUILDINGS, rowCount: BUILDINGS.length }
        ]);

        const res = await request(app).post('/buildings/carve').send({ proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        // The whole point: no dgu_gdi_building_match query is issued, because a record already
        // names its mesh. Two queries total — proposals, then meshes.
        const calls = pool.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls.some(call => /dgu_gdi_building_match|building_3d_match/.test(call.sql))).toBe(false);

        const byId = new Map(res.body.carves.map(c => [c.object_id, c]));
        expect(byId.get(63).verdict).toBe('razed');
        expect(byId.get(62).verdict).toBe('cut');
        expect(byId.has(61)).toBe(false);
    });

    it('spares every mesh when the records name object_ids that are not in the scene', async () => {
        // The records now name meshes 8001/8002, which the provider never returned. Nothing in the
        // scene may be carved: identity is the id, and no geometry can override it.
        const elsewhere = {
            ...PROPOSAL_ROW,
            roadProposal: {
                status: 'applied',
                definition: {
                    ...CORRIDOR,
                    demolishedBuildings: [
                        { id: '8001', geometry: CUT_FOOTPRINT },
                        { id: '8002', geometry: box(RAZED_LNG, LAT0, 0.00036, 0.00025) }
                    ]
                }
            }
        };
        pool.setResults([
            { rows: [elsewhere], rowCount: 1 },
            { rows: BUILDINGS, rowCount: BUILDINGS.length }
        ]);

        const res = await request(app).post('/buildings/carve').send({ proposals: ['p-carve-test'] });

        expect(res.status).toBe(200);
        expect(res.body.carves).toEqual([]);
    });
});
