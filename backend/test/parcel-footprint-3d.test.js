// Unit tests for frontend/js/parcel-footprint-3d.js — projecting parcel rings into the local metric
// frame used to lay a footprint flat under an uploaded building model (no THREE, no DOM).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { projectRingsToLocalMeters, ringsCentroid } = require('../../frontend/js/parcel-footprint-3d.js');

// ~0.0009° ≈ 100 m near Zagreb (lat 45.81).
function squareRing(west, south, side) {
    return [
        [west, south], [west + side, south], [west + side, south + side], [west, south + side], [west, south]
    ];
}

describe('ringsCentroid', () => {
    it('averages the vertices', () => {
        const c = ringsCentroid([squareRing(15.97, 45.81, 0.0009)]);
        // Average of the 5 points (last repeats the first) is slightly off the true centre — fine as an anchor.
        expect(c.lng).toBeGreaterThan(15.97);
        expect(c.lat).toBeGreaterThan(45.81);
    });

    it('returns null with no finite points', () => {
        expect(ringsCentroid([])).toBeNull();
        expect(ringsCentroid([[['a', 'b']]])).toBeNull();
    });
});

describe('projectRingsToLocalMeters', () => {
    it('centres the footprint on its anchor and scales to metres', () => {
        const result = projectRingsToLocalMeters([squareRing(15.97, 45.81, 0.0009)]);
        expect(result).not.toBeNull();
        const pts = result.rings[0];
        const xs = pts.map(p => p.x);
        const ys = pts.map(p => p.y);
        // ~100 m span on each axis.
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(80); // 0.0009° lng ≈ 70 m at 45.8°
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(90);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(110);
        // Centred: min and max straddle zero.
        expect(Math.min(...xs)).toBeLessThan(0);
        expect(Math.max(...xs)).toBeGreaterThan(0);
    });

    it('honours an explicit anchor', () => {
        const anchor = { lng: 15.97, lat: 45.81 };
        const result = projectRingsToLocalMeters([squareRing(15.97, 45.81, 0.0009)], anchor);
        // First vertex sits exactly at the anchor → origin.
        expect(result.rings[0][0].x).toBeCloseTo(0, 6);
        expect(result.rings[0][0].y).toBeCloseTo(0, 6);
    });

    it('drops degenerate rings and returns null when nothing usable', () => {
        expect(projectRingsToLocalMeters([])).toBeNull();
        expect(projectRingsToLocalMeters([[[15.97, 45.81]]])).toBeNull(); // < 3 points
        expect(projectRingsToLocalMeters(null)).toBeNull();
    });
});
