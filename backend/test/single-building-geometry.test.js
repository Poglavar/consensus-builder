// Unit tests for frontend/js/single-building-geometry.js. The headline pin is the Mercator fix: a
// building declared N×M ground metres must actually be N×M on the ground, at Zagreb's latitude —
// not shrunk by cos(φ) as the old in-Mercator-space math did.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { buildRectangleRing } = require('../../frontend/js/single-building-geometry.js');

// A spherical Web-Mercator projector, the same model L.CRS.EPSG3857 uses. project returns metres.
const R = 6378137;
const projector = {
    project: ({ lat, lng }) => {
        const x = R * (lng * Math.PI / 180);
        const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
        return [x, y];
    },
    unproject: ([x, y]) => {
        const lng = (x / R) * 180 / Math.PI;
        const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
        return [lat, lng];
    }
};

const ZAGREB = { lat: 45.81, lng: 15.98 };

function areaOf(ring) {
    return turf.area(turf.polygon([ring]));
}

describe('buildRectangleRing', () => {
    it('produces the intended GROUND area at Zagreb latitude (the Mercator fix)', () => {
        const ring = buildRectangleRing(projector, ZAGREB, { widthM: 20, lengthM: 20 });
        // Must be ~400 m², not ~194 m² (which is 400·cos²(45.81°), the old shrunk size).
        expect(areaOf(ring)).toBeGreaterThan(390);
        expect(areaOf(ring)).toBeLessThan(410);
    });

    it('scales linearly: a 40×20 building is ~800 m²', () => {
        const ring = buildRectangleRing(projector, ZAGREB, { widthM: 40, lengthM: 20 });
        expect(areaOf(ring)).toBeGreaterThan(780);
        expect(areaOf(ring)).toBeLessThan(820);
    });

    it('is correct at the equator too (where cos φ = 1)', () => {
        const ring = buildRectangleRing(projector, { lat: 0, lng: 0 }, { widthM: 20, lengthM: 20 });
        expect(areaOf(ring)).toBeGreaterThan(395);
        expect(areaOf(ring)).toBeLessThan(405);
    });

    it('rotation preserves area', () => {
        const flat = areaOf(buildRectangleRing(projector, ZAGREB, { widthM: 30, lengthM: 15 }));
        const turned = areaOf(buildRectangleRing(projector, ZAGREB, { widthM: 30, lengthM: 15, rotationDeg: 37 }));
        expect(turned).toBeCloseTo(flat, -1); // same to within ~10 m²
    });

    it('chamfer cuts the corners, reducing area a little', () => {
        const plain = areaOf(buildRectangleRing(projector, ZAGREB, { widthM: 20, lengthM: 20 }));
        const chamfered = areaOf(buildRectangleRing(projector, ZAGREB, { widthM: 20, lengthM: 20, chamferM: 4 }));
        expect(chamfered).toBeLessThan(plain);
        expect(chamfered).toBeGreaterThan(plain * 0.8); // corners only
    });

    it('returns a closed ring and null for bad input', () => {
        const ring = buildRectangleRing(projector, ZAGREB, { widthM: 10, lengthM: 10 });
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(buildRectangleRing(projector, ZAGREB, { widthM: NaN, lengthM: 10 })).toBeNull();
        expect(buildRectangleRing(null, ZAGREB, { widthM: 10, lengthM: 10 })).toBeNull();
    });
});
