// Unit tests for backend/routes/reparcellization.js — server validation of the land shares. Pure
// turf over the stored child polygons: recompute area/percent, flag validated:false on mismatch.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as turf from '@turf/turf';
import { validateReparcellizationShares, setupReparcellizationRoute } from '../routes/reparcellization.js';

// Two rectangles: A is twice the width of B, so A should be ~66.7% and B ~33.3% of the total.
function rect(west, east) {
    return turf.polygon([[[west, 45.80], [east, 45.80], [east, 45.802], [west, 45.802], [west, 45.80]]]).geometry;
}
const A = rect(15.970, 15.976); // width 0.006
const B = rect(15.976, 15.979); // width 0.003  → half of A

function plan(percents) {
    return {
        algorithm: 'sweep',
        parcelIds: ['HR-1', 'HR-2'],
        totalArea: 999999, // deliberately wrong; the server should recompute it
        polygons: [
            { ownerKey: 'a', percent: percents[0], area: 1, geometry: A },
            { ownerKey: 'b', percent: percents[1], area: 1, geometry: B }
        ]
    };
}

describe('validateReparcellizationShares', () => {
    it('recomputes area + percent from geometry and validates when the client agrees', () => {
        const out = validateReparcellizationShares(plan([66.7, 33.3]));
        expect(out.validated).toBe(true);
        expect(out.source).toBe('server');
        // Geometry-derived percents (A is 2× B).
        expect(out.polygons[0].percent).toBeCloseTo(66.67, 1);
        expect(out.polygons[1].percent).toBeCloseTo(33.33, 1);
        // totalArea overwritten with the real sum, not the bogus 999999.
        expect(out.totalArea).toBeGreaterThan(0);
        expect(out.totalArea).toBeLessThan(999999);
        expect(out.polygons[0].area).toBeGreaterThan(out.polygons[1].area);
    });

    it('flags validated:false when a claimed percent does not match the geometry', () => {
        // Claim a 50/50 split when the polygons are actually 66/33.
        const out = validateReparcellizationShares(plan([50, 50]));
        expect(out.validated).toBe(false);
        // ...but still overwrites with the geometry-truth so the stored numbers are honest.
        expect(out.polygons[0].percent).toBeCloseTo(66.67, 1);
    });

    it('flags validated:false when the claimed percents do not sum to ~100', () => {
        const out = validateReparcellizationShares(plan([66.7, 10]));
        expect(out.validated).toBe(false);
    });

    it('returns null for a plan with no polygons', () => {
        expect(validateReparcellizationShares({ polygons: [] })).toBeNull();
        expect(validateReparcellizationShares(null)).toBeNull();
        expect(validateReparcellizationShares({})).toBeNull();
    });
});

describe('POST /reparcellization/validate', () => {
    function makeApp() {
        const app = express();
        app.use(express.json());
        setupReparcellizationRoute(app);
        return app;
    }

    it('returns the validated plan', async () => {
        const res = await request(makeApp())
            .post('/reparcellization/validate')
            .send({ reparcellization: plan([66.7, 33.3]) });
        expect(res.status).toBe(200);
        expect(res.body.validated).toBe(true);
        expect(res.body.polygons).toHaveLength(2);
    });

    it('400s without a polygons array', async () => {
        const res = await request(makeApp()).post('/reparcellization/validate').send({ reparcellization: {} });
        expect(res.status).toBe(400);
    });
});
