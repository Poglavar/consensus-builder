// POST /parcels/under — the candidate parcels under a footprint. Which of them it takes is the shared
// rule's (geometry-tolerances.js), run by the client, so the SQL answers candidates and nothing else.
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

const parcelRow = (id) => ({
    cestica_id: 1000 + id,
    broj_cestice: String(id),
    maticni_broj_ko: 330337,
    parcelid: `HR-330337-${id}`,
    geometry: { type: 'Polygon', coordinates: [] },
    calculated_area: 800,
    ownership_details: null
});

beforeEach(() => { lastSql = null; response = null; });

describe('the query is shaped so the spatial index can work', () => {
    it('subdivides the footprint instead of asking for it whole', async () => {
        await request(appWith({ rows: [] })).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/ST_Subdivide\(/);
        // The bbox operator is what the index uses, and it must be applied to the PIECES.
        expect(lastSql).toMatch(/p\.geom && parts\.part/);
        expect(lastSql).toMatch(/ST_Intersects\(p\.geom, parts\.part\)/);
    });

    it('only ever considers current parcels', async () => {
        await request(appWith({ rows: [] })).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/p\.current = true/);
    });

    it('answers candidates only: no take, coverage or area floor in SQL', async () => {
        // Which candidates a footprint takes is the shared rule (geometry-tolerances.js), run by the
        // client; a second implementation here, with its own 0.25 m² floor, used to disagree with it.
        await request(appWith({ rows: [] })).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).not.toMatch(/ST_Intersection\(/);
        expect(lastSql).not.toMatch(/ST_Union\(/);
        expect(lastSql).not.toMatch(/taken_m2|coverage|footprint_m2/i);
    });

    it('repairs an invalid authored footprint rather than throwing on it', async () => {
        await request(appWith({ rows: [] })).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(lastSql).toMatch(/ST_MakeValid\(/);
    });
});

describe('the answer', () => {
    it('returns the candidates as features the existing ingest already understands', async () => {
        response = await request(appWith({ rows: [parcelRow(628), parcelRow(680)] }))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(200);
        expect(response.body.type).toBe('FeatureCollection');
        expect(response.body.count).toBe(2);
        const props = response.body.features[0].properties;
        expect(props.parcelId).toBe('HR-330337-628');
        expect(props.CESTICA_ID).toBe(1628);
        expect(props.BROJ_CESTICE).toBe('628');
        expect(props.MATICNI_BROJ_KO).toBe(330337);
        expect(props.calculated_area).toBe(800);
        expect(Number.isFinite(response.body.queryMs)).toBe(true);
    });

    it('carries no take or coverage keys, so nobody reads a second answer to the shared rule', async () => {
        response = await request(appWith({ rows: [parcelRow(628)] }))
            .post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.body).not.toHaveProperty('coverage');
        expect(response.body).not.toHaveProperty('footprintM2');
        expect(response.body.features[0].properties).not.toHaveProperty('taken_m2');
    });
});

describe('refusals', () => {
    it('rejects a missing geometry', async () => {
        response = await request(appWith({ rows: [] })).post('/parcels/under').send({});
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/geometry/i);
    });

    it('rejects a geometry that is not an area', async () => {
        response = await request(appWith({ rows: [] }))
            .post('/parcels/under').send({ geometry: { type: 'LineString', coordinates: [[15.9, 43.7], [15.91, 43.71]] } });
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/LineString/);
    });

    it('accepts a Feature wrapper, because callers hold features', async () => {
        response = await request(appWith({ rows: [] }))
            .post('/parcels/under').send({ geometry: { type: 'Feature', properties: {}, geometry: CORRIDOR } });
        expect(response.status).toBe(200);
    });

    it('refuses a geometry that covers absurdly much ground instead of serving it slowly', async () => {
        // The refusal comes off the COUNT query, before any parcel geometry is built: doing the
        // full work first cost 17.2 s to answer 413 on a real box, and a caller that splits and
        // retries paid that price per attempt.
        let builtRows = 0;
        const app = appWith((sql) => {
            if (/count\(\*\) AS parcels/.test(sql)) return { rows: [{ parcels: 5001 }] };
            builtRows += 1;
            return { rows: [parcelRow(0)] };
        });
        response = await request(app).post('/parcels/under').send({ geometry: CORRIDOR });
        expect(response.status).toBe(413);
        expect(response.body.count).toBe(5001);
        expect(builtRows, 'the full query ran anyway').toBe(0);
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
