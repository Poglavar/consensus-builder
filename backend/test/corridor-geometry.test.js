// Unit tests for frontend/js/corridor-geometry.js. The headline pin is determinism: the road
// footprint used to pick its direction with Math.random() for coincident points, so the same
// centerline saved a different polygon and geometryHash each run. Projection is injected (identity),
// matching the pattern in corridor-profile.test.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRectangularRoadSegment } = require('../../frontend/js/corridor-geometry.js');

// Identity-ish projection: treat (lat,lng) as (x=lng, y=lat) metres and back. Enough to exercise
// the geometry deterministically without proj4.
const deps = {
    wgs84ToHTRS96: (lat, lng) => [lng, lat],
    htrs96ToWGS84: (x, y) => [y, x],
    latLng: (lat, lng) => ({ lat, lng })
};

function ring(seg) {
    return seg.map(p => [Number(p.lat.toFixed(9)), Number(p.lng.toFixed(9))]);
}

describe('createRectangularRoadSegment', () => {
    it('is deterministic for coincident points (the Math.random bug)', () => {
        const p = { lat: 45.8, lng: 15.9 };
        const a = createRectangularRoadSegment(p, { ...p }, 4, deps);
        const b = createRectangularRoadSegment(p, { ...p }, 4, deps);
        expect(a).not.toBeNull();
        expect(ring(a)).toEqual(ring(b)); // identical footprint every run
    });

    it('nudges coincident points due east, giving a 0.1 m × width rectangle', () => {
        const p = { lat: 0, lng: 0 };
        const seg = createRectangularRoadSegment(p, { ...p }, 4, deps);
        // With east nudge (dx=0.1, dy=0): perpendicular is (0, +1) → corners spread ±2 in lat (y),
        // and 0..0.1 in lng (x).
        const lats = seg.map(c => c.lat);
        const lngs = seg.map(c => c.lng);
        expect(Math.min(...lats)).toBeCloseTo(-2, 6);
        expect(Math.max(...lats)).toBeCloseTo(2, 6);
        expect(Math.min(...lngs)).toBeCloseTo(0, 6);
        expect(Math.max(...lngs)).toBeCloseTo(0.1, 6);
    });

    it('builds a width-wide rectangle along a normal east-west segment', () => {
        const seg = createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, 4, deps);
        expect(seg).toHaveLength(5); // closed ring
        expect(seg[0]).toEqual(seg[4]); // closed
        const lats = seg.map(c => c.lat);
        expect(Math.min(...lats)).toBeCloseTo(-2, 6);
        expect(Math.max(...lats)).toBeCloseTo(2, 6);
    });

    it('returns null for invalid inputs', () => {
        expect(createRectangularRoadSegment(null, { lat: 0, lng: 0 }, 4, deps)).toBeNull();
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, 0, deps)).toBeNull();
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: NaN, lng: 1 }, 4, deps)).toBeNull();
    });

    it('returns null when projection functions are unavailable', () => {
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, 4, {})).toBeNull();
    });
});
