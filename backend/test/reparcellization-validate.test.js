// Unit tests for backend/routes/reparcellization.js — shared geometry validation and derived display
// areas/percentages. Percent is geometry metadata, not ownership title or a validation input.
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

function plan(percents, poolGeometry = null) {
    return {
        algorithm: 'sweep',
        parcelIds: ['HR-1', 'HR-2'],
        totalArea: 999999, // deliberately wrong; the server should recompute it
        ...(poolGeometry ? { poolGeometry } : {}),
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

    it('recomputes display percentages without treating stale client percentages as title shares', () => {
        const out = validateReparcellizationShares(plan([50, 50]));
        expect(out.validated).toBe(true);
        expect(out.validation.valid).toBe(true);
        expect(out.polygons[0].percent).toBeCloseTo(66.67, 1);
        expect(out.polygons[1].percent).toBeCloseTo(33.33, 1);
    });

    it('validates coverage against the declared partial take, not whole input parcels or old area fields', () => {
        const declaredPool = rect(15.969, 15.980);
        const out = validateReparcellizationShares(plan([66.7, 10], declaredPool));
        expect(out.validated).toBe(false);
        expect(out.validation.errors.map(error => error.code)).toContain('coverage-gap');
        expect(out.totalArea).toBeLessThan(turf.area(turf.feature(declaredPool)));
        expect(out.polygons[0].percent + out.polygons[1].percent).toBeCloseTo(100, 1);
    });

    it('returns null for a plan with no polygons', () => {
        expect(validateReparcellizationShares({ polygons: [] })).toBeNull();
        expect(validateReparcellizationShares(null)).toBeNull();
        expect(validateReparcellizationShares({})).toBeNull();
    });

    it('keeps an unmeasurable total and its percentages unknown instead of adding missing area as zero', () => {
        const malformed = plan([50, 50]);
        malformed.polygons[1].geometry = { type: 'Polygon', coordinates: [] };
        const out = validateReparcellizationShares(malformed);
        expect(out.validated).toBe(false);
        expect(out.totalArea).toBeNull();
        expect(out.polygons[0].area).toBeGreaterThan(0);
        expect(out.polygons[1].area).toBeNull();
        expect(out.polygons.map(polygon => polygon.percent)).toEqual([null, null]);
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
            .send({ reparcellization: plan([10, 90]) });
        expect(res.status).toBe(200);
        expect(res.body.validated).toBe(true);
        expect(res.body.polygons).toHaveLength(2);
        expect(res.body.polygons[0].percent).toBeCloseTo(66.67, 1);
    });

    it('400s without a polygons array', async () => {
        const res = await request(makeApp()).post('/reparcellization/validate').send({ reparcellization: {} });
        expect(res.status).toBe(400);
    });
});
