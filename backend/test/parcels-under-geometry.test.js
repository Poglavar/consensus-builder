// POST /parcels/under — the parcels a footprint actually covers.
//
// Everything else in the parcels API answers "what is near this point / in this box / at these ids".
// Nothing answered "what is under this shape", and that gap is why the client approximated a
// footprint by its bounding box: the imported 17 km track occupies 9.35 ha inside a 56.6 km² box, so
// the approximation asked for 37,164 parcels to find the 661 that touch it, and the tab died
// ingesting them.
//
// The load-bearing detail is ST_Subdivide. A GIST index prefilters on BOUNDING BOXES, so handing it
// one long diagonal geometry defeats it just as thoroughly as the client's box did — measured on the
// real corridor, 20.2 s whole versus 0.32 s subdivided, same 661 parcels. A future edit that
// "simplifies" the query by dropping the subdivision would keep every test green while making the
// endpoint 60× slower, so the SQL shape is pinned here alongside the behaviour.

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupParcelsRoute } from '../routes/parcels.js';

const CORRIDOR = {
    type: 'Polygon',
    coordinates: [[[15.90, 43.73], [15.91, 43.73], [15.91, 43.74], [15.90, 43.74], [15.90, 43.73]]]
};

let lastSql;
let response;

function appWith(poolResult) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    const pool = {
        query: async (sql, params) => {
            lastSql = sql;
            if (typeof poolResult === 'function') return poolResult(sql, params);
            return poolResult;
        }
    };
    setupParcelsRoute(app, pool);
    return app;
}

// coverage arrives as a ratio computed in SQL; footprint_m2 is geodesic.
const rowsPayload = (rows, footprintM2, coverage) => ({
    rows: [{ rows, footprint_m2: footprintM2, coverage }]
});

const parcelRow = (id, taken) => ({
    cestica_id: 1000 + id,
    broj_cestice: String(id),
    maticni_broj_ko: 330337,
    parcelid: `HR-330337-${id}`,
    geometry: { type: 'Polygon', coordinates: [] },
    calculated_area: 800,
    taken_m2: taken,
    ownership_details: null
});

beforeEach(() => { lastSql = null; response = null; });

describe('the query is shaped so the spatial index can work', () => {
    it('subdivides the footprint instead of asking for it whole', async () => {
        await request(appWith(rowsPayload([], 100, 0))).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/ST_Subdivide\(/);
        // The bbox operator is what the index uses, and it must be applied to the PIECES.
        expect(lastSql).toMatch(/p\.geom && parts\.part/);
        expect(lastSql).toMatch(/ST_Intersects\(p\.geom, parts\.part\)/);
    });

    it('only ever considers current parcels', async () => {
        await request(appWith(rowsPayload([], 100, 0))).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/p\.current = true/);
    });

    it('drops parcels that merely abut the footprint, so it agrees with the client', async () => {
        // ST_Intersects counts a shared edge, which takes no area and makes no parent. Without this
        // the server offered 661 parcels where the client resolved 649 — and "one source of truth"
        // has to mean the same set, not merely a similar one.
        await request(appWith(rowsPayload([], 100, 0))).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/taken_m2 > 0\.25/);
    });

    it('repairs an invalid authored footprint rather than throwing on it', async () => {
        await request(appWith(rowsPayload([], 100, 0))).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/ST_MakeValid\(/);
    });
});

describe('the answer', () => {
    it('returns the parcels as features the existing ingest already understands', async () => {
        response = await request(appWith(rowsPayload([parcelRow(628, 770), parcelRow(680, 120)], 93542, 0.978)))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(200);
        expect(response.body.type).toBe('FeatureCollection');
        expect(response.body.count).toBe(2);
        const props = response.body.features[0].properties;
        expect(props.parcelId).toBe('HR-330337-628');
        expect(props.CESTICA_ID).toBe(1628);
        expect(props.BROJ_CESTICE).toBe('628');
        expect(props.MATICNI_BROJ_KO).toBe(330337);
        // How much of THIS parcel the footprint takes — the number a cut has to agree with.
        expect(props.taken_m2).toBe(770);
    });

    it('reports coverage of the footprint, which is the whole reason to ask the database', async () => {
        response = await request(appWith(rowsPayload([parcelRow(628, 770)], 93542, 91462 / 93542)))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.body.coverage).toBeCloseTo(91462 / 93542, 6);
    });

    it('clamps coverage at 1 — parcels tessellate, so more than the footprint is rounding noise', async () => {
        response = await request(appWith(rowsPayload([parcelRow(628, 100)], 1000, 1.0000004)))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.body.coverage).toBe(1);
    });

    it('reports zero coverage for a degenerate footprint rather than dividing by zero', async () => {
        response = await request(appWith(rowsPayload([], 0, 0))).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.body.coverage).toBe(0);
        expect(Number.isFinite(response.body.coverage)).toBe(true);
    });
});

describe('refusals', () => {
    it('rejects a missing geometry', async () => {
        response = await request(appWith(rowsPayload([], 1, 0))).post('/parcels/under').send({});
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/geometry/i);
    });

    it('rejects a geometry that is not an area', async () => {
        response = await request(appWith(rowsPayload([], 1, 0)))
            .post('/parcels/under').send({ geometry: { type: 'LineString', coordinates: [[15.9, 43.7], [15.91, 43.71]] } });
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/LineString/);
    });

    it('accepts a Feature wrapper, because callers hold features', async () => {
        response = await request(appWith(rowsPayload([], 100, 0)))
            .post('/parcels/under').send({ geometry: { type: 'Feature', properties: {}, geometry: CORRIDOR } });
        expect(response.status).toBe(200);
    });

    it('refuses a geometry that covers absurdly much ground instead of serving it slowly', async () => {
        const many = Array.from({ length: 5001 }, (_, i) => parcelRow(i, 1));
        response = await request(appWith(rowsPayload(many, 1e9, 1e9)))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(413);
        expect(response.body.count).toBe(5001);
    });

    it('reads a malformed geometry as the caller’s fault, not the server’s', async () => {
        const app = appWith(() => { throw new Error('parse error: invalid GeoJSON representation'); });
        response = await request(app).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/Could not read the geometry/);
    });

    it('still reports a genuine server fault as 500', async () => {
        const app = appWith(() => { throw new Error('connection terminated unexpectedly'); });
        response = await request(app).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(500);
    });
});
