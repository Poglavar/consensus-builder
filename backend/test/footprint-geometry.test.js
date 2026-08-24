// Unit tests for frontend/js/footprint-geometry.js — robust sanitize/inset/union/chamfer of
// building-block polygons. turf is set on the global in THIS realm (not a vm context) so turf's
// internal instanceof checks work across the boundary.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf; // the module reads `turf` from the global at call time

const require = createRequire(import.meta.url);
const {
    CORRIDOR_PROFILE_PRESETS,
    corridorStripSpans,
    corridorStripRingPlanar,
    ringSelfIntersectsXY
} = require('../../frontend/js/corridor-profile.js');
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

    it('repairs the folded inside lane of a sharp 3D road turn into meshable polygons', () => {
        // A 165-degree reversal is the characteristic failure: roughly the inside half of a wide
        // cross-section folds into bow-ties and three-mode's triangulation guard drops those lanes.
        const angle = 165 * Math.PI / 180;
        const centerline = [[-100, 0], [0, 0], [100 * Math.cos(angle), 100 * Math.sin(angle)]];
        const folded = corridorStripSpans({ strips: CORRIDOR_PROFILE_PRESETS[18] })
            .map(span => corridorStripRingPlanar(centerline, span.left, span.right))
            .find(ring => ringSelfIntersectsXY(ring));
        expect(folded).toBeTruthy();

        // Put the metric test geometry near Zagreb before Turf operates on it as WGS84.
        const origin = [15.98, 45.80];
        const ring = [...folded, folded[0]].map(([x, y]) => [
            origin[0] + x / 80000,
            origin[1] + y / 111000
        ]);
        const repaired = sanitizePolygonFeature(turf.polygon([ring]));
        expect(repaired).toBeTruthy();
        expect(['Polygon', 'MultiPolygon']).toContain(repaired.geometry.type);
        expect(turf.area(repaired)).toBeGreaterThan(0);

        const polygons = repaired.geometry.type === 'Polygon'
            ? [repaired.geometry.coordinates]
            : repaired.geometry.coordinates;
        const toMetric = ([lng, lat]) => [
            (lng - origin[0]) * 80000,
            (lat - origin[1]) * 111000
        ];
        polygons.forEach(rings => {
            rings.forEach(outputRing => {
                expect(ringSelfIntersectsXY(outputRing.slice(0, -1).map(toMetric))).toBe(false);
            });
        });
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

    // Metric helpers for the cluster tests: a ring built in metres near Zagreb, so chamfer
    // lengths mean what they say.
    const ORIGIN = [15.97, 45.80];
    const M_PER_LNG = 111320 * Math.cos(ORIGIN[1] * Math.PI / 180);
    const M_PER_LAT = 110540;
    const toDeg = ([x, y]) => [ORIGIN[0] + x / M_PER_LNG, ORIGIN[1] + y / M_PER_LAT];
    const metricPolygon = (pts) => {
        const ring = pts.map(toDeg);
        ring.push(ring[0]);
        return { type: 'Polygon', coordinates: [ring] };
    };

    it('cuts a corner that arrives as a small vertex cluster as ONE full chamfer', () => {
        // Buffer/simplify/clip leave some corners as 2 vertices a few decimetres apart. Per-vertex
        // chamfering capped each cut at 0.4× the tiny glue edge, so exactly those corners came out
        // looking square while their neighbours got the full cut.
        const geom = metricPolygon([
            [0, 0], [100, 0],
            [100, 99.4], [99.4, 100], // the clustered corner
            [0, 100]
        ]);
        const chamfered = applySelectiveChamferToPolygonGeometry(geom, 3, 165);
        const cut = turf.area(turf.feature(geom)) - turf.area(turf.feature(chamfered));
        // Full 3 m chamfers on all four corners: ≥ 4 × 4.5 m². The old behaviour cut ~13.7 m²
        // (three real chamfers + two 0.24 m nicks on the clustered corner).
        expect(cut).toBeGreaterThan(17);
        // And the cluster's own vertices are gone — replaced by the single diagonal.
        const ring = chamfered.coordinates[0];
        const near = (p, m) => Math.hypot((p[0] - ORIGIN[0]) * M_PER_LNG - m[0], (p[1] - ORIGIN[1]) * M_PER_LAT - m[1]) < 0.05;
        expect(ring.some(p => near(p, [100, 99.4]))).toBe(false);
        expect(ring.some(p => near(p, [99.4, 100]))).toBe(false);
    });

    it('ignores collinear chatter when measuring the walls next to a corner', () => {
        // The buffer/union pipeline leaves stray collinear vertices mid-wall (a real block ring
        // carried 384 vertices for an 11-vertex parcel). The 0.4×edge cap then measured "wall
        // length" to the first artifact vertex — a corner with one 5 m away got a 2 m nick instead
        // of the requested 5 m chamfer, which is exactly how one corner of a ring stayed square
        // while its neighbours were cut.
        const geom = metricPolygon([
            [0, 0],
            [100, 0],
            [100, 5.07], [100, 5.08], [100, 5.085], // collinear chatter on the east wall
            [100, 100],
            [0, 100]
        ]);
        const chamfered = applySelectiveChamferToPolygonGeometry(geom, 5, 165);
        const cut = turf.area(turf.feature(geom)) - turf.area(turf.feature(chamfered));
        // All four corners get the full 5 m cut: 4 × 12.5 m². The old behaviour cut ~40 m²
        // (three full corners + a 2 m nick at [100, 0]).
        expect(cut).toBeGreaterThan(48);
        expect(chamfered.coordinates[0].length).toBe(9); // 8 chamfer points + closing vertex
    });

    it('cuts twin corners of one wall the same even when a gentle bend sits near one of them', () => {
        // The east wall of the real block bends 0.5° (a 14 cm deviation — invisible) 16 m from its
        // south corner. Capping the leg at 0.4× the distance to that VERTEX gave the south corner a
        // 6.6 m cut while the north corner got the full 10 m — visibly unequal chamfers on the same
        // wall. A leg must measure wall THROUGH gentle bends, stopping only at real corners.
        const geom = metricPolygon([
            [0, 0],
            [100, 0],
            [100.14, 16], // gentle bend near the SE corner (14 cm off the wall line — survives de-chatter)
            [100, 100],
            [0, 100]
        ]);
        const chamfered = applySelectiveChamferToPolygonGeometry(geom, 10, 165);
        const ring = chamfered.coordinates[0];
        const toM = (p) => [(p[0] - ORIGIN[0]) * M_PER_LNG, (p[1] - ORIGIN[1]) * M_PER_LAT];
        const legOf = (cornerM) => {
            // Longest chamfer diagonal touching this corner: the two ring points nearest to it.
            const near = ring.slice(0, -1).map(toM)
                .map(p => ({ p, d: Math.hypot(p[0] - cornerM[0], p[1] - cornerM[1]) }))
                .sort((a, b) => a.d - b.d).slice(0, 2).map(e => e.p);
            return Math.hypot(near[0][0] - near[1][0], near[0][1] - near[1][1]);
        };
        const se = legOf([100, 0]);
        const ne = legOf([100, 100]);
        // Both diagonals are the full 10·√2 ≈ 14.1 m, and equal to each other.
        expect(se).toBeGreaterThan(13.5);
        expect(Math.abs(se - ne)).toBeLessThan(0.5);
    });

    it('leaves a wide rounded arc alone — nothing sharp to cut', () => {
        // A 90° arc of radius 8 m (9 segments ≈ 1.4 m each): short same-sign edges, but the span is
        // far beyond a corner cluster. Collapsing it into one chamfer would flatten a deliberately
        // round corner, so it must pass through untouched.
        const arc = []; // centre (92,92), from (100,92) round to (92,100)
        for (let k = 9; k >= 0; k--) {
            const a = (Math.PI / 2) * (k / 9);
            arc.push([92 + 8 * Math.sin(a), 92 + 8 * Math.cos(a)]);
        }
        const geom = metricPolygon([[0, 0], [100, 0], ...arc, [0, 100]]);
        const before = turf.area(turf.feature(geom));
        const chamfered = applySelectiveChamferToPolygonGeometry(geom, 3, 165);
        const after = turf.area(turf.feature(chamfered));
        // The three square corners lose ~4.5 m² each; the arc corner loses ~nothing.
        expect(before - after).toBeGreaterThan(12);
        expect(before - after).toBeLessThan(3 * 4.5 + 1.5);
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
