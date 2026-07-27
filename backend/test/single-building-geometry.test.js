// Unit tests for frontend/js/single-building-geometry.js. The headline pin is the Mercator fix: a
// building declared N×M ground metres must actually be N×M on the ground, at Zagreb's latitude —
// not shrunk by cos(φ) as the old in-Mercator-space math did.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const {
    buildRectangleRing,
    isSimpleRing,
    moveGeometryCenter,
    projectedGeometryCenter,
    rotateGeometry,
    translateGeometry
} = require('../../frontend/js/single-building-geometry.js');

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

    it('returns a closed ring and null for bad input', () => {
        const ring = buildRectangleRing(projector, ZAGREB, { widthM: 10, lengthM: 10 });
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(buildRectangleRing(projector, ZAGREB, { widthM: NaN, lengthM: 10 })).toBeNull();
        expect(buildRectangleRing(null, ZAGREB, { widthM: 10, lengthM: 10 })).toBeNull();
    });
});

describe('freeform polygon editing', () => {
    const square = buildRectangleRing(projector, ZAGREB, { widthM: 20, lengthM: 20 });

    it('rejects self-crossing and duplicate-vertex rings', () => {
        expect(isSimpleRing([[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]])).toBe(false);
        expect(isSimpleRing([[0, 0], [1, 0], [1, 1], [1, 0], [0, 0]])).toBe(false);
        expect(isSimpleRing([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])).toBe(true);
    });

    it('translates and recentres the whole geometry without changing its area', () => {
        const feature = turf.polygon([square]);
        const originalArea = turf.area(feature);
        const shifted = translateGeometry(projector, feature.geometry, 100, -50);
        const recentred = moveGeometryCenter(projector, shifted, { lat: 45.812, lng: 15.985 });

        expect(turf.area(turf.feature(shifted))).toBeCloseTo(originalArea, 0);
        expect(turf.area(turf.feature(recentred))).toBeCloseTo(originalArea, 0);
        const center = turf.centroid(turf.feature(recentred)).geometry.coordinates;
        expect(center[0]).toBeCloseTo(15.985, 4);
        expect(center[1]).toBeCloseTo(45.812, 4);
    });

    it('rotates the polygon in place while preserving area and its centre', () => {
        const feature = turf.polygon([square]);
        const beforeCenter = turf.centroid(feature).geometry.coordinates;
        const rotated = rotateGeometry(projector, feature.geometry, 5);
        const after = turf.feature(rotated);
        const afterCenter = turf.centroid(after).geometry.coordinates;

        expect(turf.area(after)).toBeCloseTo(turf.area(feature), 0);
        expect(afterCenter[0]).toBeCloseTo(beforeCenter[0], 7);
        expect(afterCenter[1]).toBeCloseTo(beforeCenter[1], 7);
        expect(rotated.coordinates[0]).not.toEqual(feature.geometry.coordinates[0]);
    });

    it('treats a positive angle as counterclockwise on the map', () => {
        const feature = turf.polygon([square]);
        const center = projectedGeometryCenter(projector, feature.geometry);
        const quarterTurn = rotateGeometry(projector, feature.geometry, 90);
        const [beforeX, beforeY] = projector.project({ lat: square[0][1], lng: square[0][0] });
        const [afterX, afterY] = projector.project({
            lat: quarterTurn.coordinates[0][0][1],
            lng: quarterTurn.coordinates[0][0][0]
        });

        expect(beforeX).toBeLessThan(center[0]);
        expect(beforeY).toBeLessThan(center[1]);
        expect(afterX).toBeGreaterThan(center[0]);
        expect(afterY).toBeLessThan(center[1]);
    });
});
