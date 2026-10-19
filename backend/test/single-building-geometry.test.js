// Unit tests for frontend/js/single-building-geometry.js: a building declared N×M ground metres is N×M
// on the ground — measured on the ellipsoid, to the millimetre — at any latitude, and stays so when
// it is moved (however far) or rotated. The editors used to work in Web-Mercator space, where a
// "20 m" building came out ~14 m at Zagreb and a move north rescaled it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { inverse } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const {
    GROUND_AREA_EPSILON_M2,
    buildRectangleRing,
    footprintWithinBoundary,
    geometryCenter,
    isSimpleRing,
    moveGeometry,
    moveGeometryCenter,
    rotateGeometry
} = require('../../frontend/js/single-building-geometry.js');

const ZAGREB = { lat: 45.81, lng: 15.98 };
const sides = ring => ring.slice(0, -1).map((point, i) => inverse(point, ring[i + 1]));
const expectSides = (ring, lengths) => sides(ring).forEach((length, i) => expect(Math.abs(length - lengths[i])).toBeLessThan(0.001));

describe('buildRectangleRing', () => {
    for (const [name, center] of [['Zagreb', ZAGREB], ['the equator', { lat: 0, lng: 0 }], ['Svalbard', { lat: 78.2, lng: 15.6 }], ['Sydney', { lat: -33.87, lng: 151.21 }]]) {
        it(`builds a 40×20 m rectangle that is 40×20 m on the ground at ${name}`, () => {
            const ring = buildRectangleRing(center, { widthM: 40, lengthM: 20 });
            expectSides(ring, [40, 20, 40, 20]);
        });
    }

    it('rotation keeps the sides', () => {
        expectSides(buildRectangleRing(ZAGREB, { widthM: 30, lengthM: 15, rotationDeg: 37 }), [30, 15, 30, 15]);
    });

    it('returns a closed ring and null for bad input', () => {
        const ring = buildRectangleRing(ZAGREB, { widthM: 10, lengthM: 10 });
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(buildRectangleRing(ZAGREB, { widthM: NaN, lengthM: 10 })).toBeNull();
        expect(buildRectangleRing(null, { widthM: 10, lengthM: 10 })).toBeNull();
    });
});

describe('freeform polygon editing', () => {
    const square = buildRectangleRing(ZAGREB, { widthM: 20, lengthM: 20 });

    it('rejects self-crossing and duplicate-vertex rings', () => {
        expect(isSimpleRing([[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]])).toBe(false);
        expect(isSimpleRing([[0, 0], [1, 0], [1, 1], [1, 0], [0, 0]])).toBe(false);
        expect(isSimpleRing([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])).toBe(true);
    });

    it('moves a footprint any distance keeping its ground size, and recentres it exactly', () => {
        const geometry = { type: 'Polygon', coordinates: [square] };
        // 300 km north: a Mercator move would have scaled it by ≈ 7%
        const moved = moveGeometry(geometry, ZAGREB, { lat: ZAGREB.lat + 2.7, lng: ZAGREB.lng });
        expectSides(moved.coordinates[0], [20, 20, 20, 20]);
        const target = { lat: 45.812, lng: 15.985 };
        const recentred = moveGeometryCenter(moved, target);
        expectSides(recentred.coordinates[0], [20, 20, 20, 20]);
        const center = geometryCenter(recentred);
        expect(center.lat).toBeCloseTo(target.lat, 9);
        expect(center.lng).toBeCloseTo(target.lng, 9);
    });

    it('rotates the polygon in place, keeping its sides and its centre', () => {
        const geometry = { type: 'Polygon', coordinates: [square] };
        const before = geometryCenter(geometry);
        const rotated = rotateGeometry(geometry, 5);
        expectSides(rotated.coordinates[0], [20, 20, 20, 20]);
        const after = geometryCenter(rotated);
        expect(after.lat).toBeCloseTo(before.lat, 9);
        expect(after.lng).toBeCloseTo(before.lng, 9);
        expect(rotated.coordinates[0]).not.toEqual(square);
    });

    it('treats a positive angle as counterclockwise on the map', () => {
        const geometry = { type: 'Polygon', coordinates: [square] };
        const center = geometryCenter(geometry);
        const quarterTurn = rotateGeometry(geometry, 90);
        // the first corner sits south-west of the centre; a quarter turn counter-clockwise takes it south-east
        expect(square[0][0]).toBeLessThan(center.lng);
        expect(square[0][1]).toBeLessThan(center.lat);
        expect(quarterTurn.coordinates[0][0][0]).toBeGreaterThan(center.lng);
        expect(quarterTurn.coordinates[0][0][1]).toBeLessThan(center.lat);
    });

    it('uses the authoritative 0.01 m² boundary tolerance', () => {
        const lat = 43.735;
        const metresToLat = metres => metres / 111320;
        const metresToLng = metres => metres / (111320 * Math.cos(lat * Math.PI / 180));
        const rectangle = (westM, southM, eastM, northM) => turf.polygon([[
            [metresToLng(westM), lat + metresToLat(southM)],
            [metresToLng(eastM), lat + metresToLat(southM)],
            [metresToLng(eastM), lat + metresToLat(northM)],
            [metresToLng(westM), lat + metresToLat(northM)],
            [metresToLng(westM), lat + metresToLat(southM)]
        ]]);
        const host = rectangle(0, 0, 10, 10);
        const outsideByAboutPointZeroTwo = rectangle(-0.004, 2, 5, 7);
        const outsideByAboutPointZeroZeroFive = rectangle(-0.001, 2, 5, 7);

        expect(GROUND_AREA_EPSILON_M2).toBe(0.01);
        expect(footprintWithinBoundary(outsideByAboutPointZeroTwo, host, turf)).toBe(false);
        expect(footprintWithinBoundary(outsideByAboutPointZeroZeroFive, host, turf)).toBe(true);
    });
});
