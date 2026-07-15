// Unit tests for frontend/js/footprint-geometry.js — robust sanitize/inset/union/chamfer of
// building-block polygons. turf is set on the global in THIS realm (not a vm context) so turf's
// internal instanceof checks work across the boundary.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf; // the module reads `turf` from the global at call time

const require = createRequire(import.meta.url);
const {
    sanitizePolygonFeature,
    robustNegativeBuffer,
    robustUnion,
    toSingleLargestPolygon,
    applySelectiveChamferToPolygonGeometry,
    computeMinEdgeLengthMeters,
    incrementalInsetPolygon
} = require('../../frontend/js/footprint-geometry.js');

// A metric-ish square around Zagreb: ~0.0009° ≈ 100 m.
function square(west, south, side) {
    return turf.polygon([[
        [west, south], [west + side, south], [west + side, south + side], [west, south + side], [west, south]
    ]]);
}
const S = () => square(15.97, 45.80, 0.0018); // ~200 m box

describe('toSingleLargestPolygon', () => {
    it('returns a Polygon feature unchanged', () => {
        const f = S();
        expect(toSingleLargestPolygon(f)).toBe(f);
    });

    it('picks the largest polygon out of a MultiPolygon', () => {
        const big = square(15.97, 45.80, 0.002).geometry.coordinates;
        const small = square(16.00, 45.80, 0.0005).geometry.coordinates;
        const multi = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [small, big] } };
        const out = toSingleLargestPolygon(multi);
        expect(out.geometry.type).toBe('Polygon');
        // The kept polygon is the big one.
        expect(turf.area(out)).toBeCloseTo(turf.area(square(15.97, 45.80, 0.002)), -1);
    });

    it('returns null/passthrough for junk', () => {
        expect(toSingleLargestPolygon(null)).toBeNull();
    });
});

describe('robustNegativeBuffer', () => {
    it('shrinks a polygon (inset) to a smaller area', () => {
        const f = S();
        const inset = robustNegativeBuffer(f, 20); // 20 m inset
        expect(inset).not.toBeNull();
        expect(turf.area(inset)).toBeLessThan(turf.area(f));
    });

    it('returns null when the inset consumes the whole polygon', () => {
        const small = square(15.97, 45.80, 0.0002); // ~2 m box
        expect(robustNegativeBuffer(small, 50)).toBeNull();
    });
});

describe('robustUnion', () => {
    it('merges two overlapping squares into one polygon with a larger area than either', () => {
        const a = square(15.97, 45.80, 0.0018);
        const b = square(15.971, 45.80, 0.0018); // overlaps a
        const u = robustUnion([a, b]);
        expect(u).not.toBeNull();
        expect(turf.area(u)).toBeGreaterThan(turf.area(a));
    });

    it('returns null for an empty list', () => {
        expect(robustUnion([])).toBeNull();
    });
});

describe('sanitizePolygonFeature', () => {
    it('returns a valid polygon feature for a clean input', () => {
        const out = sanitizePolygonFeature(S());
        expect(out).toBeTruthy();
        expect(turf.area(out)).toBeGreaterThan(0);
    });

    it('returns null for null input', () => {
        expect(sanitizePolygonFeature(null)).toBeNull();
    });
});

describe('computeMinEdgeLengthMeters', () => {
    it('returns the shortest edge (length + endpoints) of a ring in metres', () => {
        const ring = S().geometry.coordinates[0];
        const { minLen, minPair } = computeMinEdgeLengthMeters(ring);
        // A ~200 m square: the shortest edge is ~200 m (well over 100).
        expect(minLen).toBeGreaterThan(100);
        expect(Array.isArray(minPair)).toBe(true);
    });

    it('returns Infinity/null for a degenerate ring', () => {
        expect(computeMinEdgeLengthMeters([[0, 0]]).minLen).toBe(Infinity);
    });
});

describe('applySelectiveChamferToPolygonGeometry', () => {
    it('leaves geometry unchanged when chamfer length is 0', () => {
        const geom = S().geometry;
        expect(applySelectiveChamferToPolygonGeometry(geom, 0)).toBe(geom);
    });

    it('cuts convex corners, reducing area slightly', () => {
        const geom = S().geometry;
        const chamfered = applySelectiveChamferToPolygonGeometry(geom, 10, 100);
        const before = turf.area(turf.feature(geom));
        const after = turf.area(turf.feature(chamfered));
        expect(after).toBeLessThanOrEqual(before);
        expect(after).toBeGreaterThan(before * 0.9); // corners cut, not the whole shape
    });
});

describe('incrementalInsetPolygon', () => {
    it('insets toward a target while respecting the min edge length', () => {
        const f = S();
        const out = incrementalInsetPolygon(f, 20, 5);
        expect(out).toBeTruthy();
        expect(out.feature ? turf.area(out.feature) : turf.area(out)).toBeLessThan(turf.area(f));
    });
});
