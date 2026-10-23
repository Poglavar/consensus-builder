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
    validFootprint,
    withFootprintRing,
    importedHeight,
    moveGeometry,
    moveGeometryCenter,
    rotateGeometry,
    placeModelFootprint
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

describe('placeModelFootprint', () => {
    const MODEL_CENTER = { lat: 45, lng: 10 };
    const lShape = {
        type: 'Polygon',
        coordinates: [
            [[-5,-5],[5,-5],[5,0],[0,0],[0,5],[-5,5],[-5,-5]],
            [[-4,-4],[-4,-2],[-2,-2],[-2,-4],[-4,-4]]
        ]
    };

    it('preserves a concave outline and hole at native metric scale', () => {
        const placed = placeModelFootprint(lShape, MODEL_CENTER);
        expect(placed.type).toBe('Feature');
        expect(placed.geometry.type).toBe('Polygon');
        expect(placed.geometry.coordinates.map(ring => ring.length)).toEqual([7, 5]);
        expect(placed.geometry.coordinates[0][3]).not.toEqual(placed.geometry.coordinates[0][1]);
        sides(placed.geometry.coordinates[1]).slice(0, 4).forEach(length => expect(length).toBeCloseTo(2, 3));
    });

    it('places the origin at the requested centre and rotates counterclockwise in metres', () => {
        const footprint = { type: 'Polygon', coordinates: [[[-2,-1],[2,-1],[2,1],[-2,1],[-2,-1]]] };
        const placed = placeModelFootprint(footprint, MODEL_CENTER, 90);
        const ring = placed.geometry.coordinates[0];
        // (-2,-1) rotated +90° is (1,-2): east and south from the placement centre.
        expect(inverse([MODEL_CENTER.lng, MODEL_CENTER.lat], ring[0])).toBeCloseTo(Math.sqrt(5), 0);
        expect(ring[0][0]).toBeGreaterThan(MODEL_CENTER.lng);
        expect(ring[0][1]).toBeLessThan(MODEL_CENTER.lat);
        sides(ring).forEach((length, index) => expect(length).toBeCloseTo([4, 2, 4, 2][index], 3));
    });

    it('rejects missing, non-Polygon, and non-finite outlines', () => {
        expect(placeModelFootprint(null, MODEL_CENTER)).toBeNull();
        expect(placeModelFootprint(lShape, MODEL_CENTER, null)).toBeNull();
        expect(placeModelFootprint({ type: 'MultiPolygon', coordinates: [] }, MODEL_CENTER)).toBeNull();
        expect(placeModelFootprint({ type: 'Polygon', coordinates: [[[0,0],[1,0],[NaN,1],[0,0]]] }, MODEL_CENTER)).toBeNull();
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


describe('complete imported building footprints', () => {
    const exterior = [[16,45],[16.002,45],[16.002,45.002],[16,45.002],[16,45]];
    const hole = [[16.0005,45.0005],[16.0005,45.001],[16.001,45.001],[16.001,45.0005],[16.0005,45.0005]];
    const courtyard = turf.polygon([exterior, hole], { height: 18, source: 'survey' });

    it('allows editing a courtyard ring without replacing the exterior or source metadata', () => {
        const nextHole = structuredClone(hole);
        nextHole[1][1] += 0.0001;
        const changed = withFootprintRing(courtyard, 0, 1, nextHole);
        expect(validFootprint(changed, turf)).toBe(true);
        expect(changed.geometry.coordinates[0]).toEqual(exterior);
        expect(changed.geometry.coordinates[1]).toEqual(nextHole);
        expect(changed.properties).toEqual(courtyard.properties);
        expect(courtyard.geometry.coordinates[1]).toEqual(hole);
        const changedOuter = withFootprintRing(changed, 0, 0, exterior.map(([x,y]) => [x - 0.0001,y]));
        expect(changedOuter.geometry.coordinates[1]).toEqual(nextHole);
    });

    it('validates every courtyard rather than only the exterior', () => {
        expect(validFootprint(courtyard, turf)).toBe(true);
        expect(validFootprint(turf.polygon([exterior, hole.map(([x,y]) => [x + 0.01,y])]), turf)).toBe(false);
        expect(validFootprint(turf.polygon([exterior, hole, hole]), turf)).toBe(false);
        const crossing = [[16.0002,45.0002],[16.0015,45.0015],[16.0002,45.0015],[16.0015,45.0002],[16.0002,45.0002]];
        expect(validFootprint(turf.polygon([exterior, crossing]), turf)).toBe(false);
    });

    it('preserves every multipart ring through move and rotate and edits only the selected ring', () => {
        const multipart = turf.multiPolygon([[exterior, hole], [exterior.map(([x,y]) => [x + 0.01,y])]], { height: 18 });
        const moved = moveGeometry(multipart.geometry, { lat: 45.001, lng: 16.006 }, { lat: 46, lng: 16 });
        const rotated = rotateGeometry(moved, 25);
        expect(rotated.coordinates.map(rings => rings.map(ring => ring.length))).toEqual([[5,5],[5]]);
        const ring = multipart.geometry.coordinates[1][0].map(([x,y]) => [x + 0.001,y]);
        const changed = withFootprintRing(multipart, 1, 0, ring);
        expect(changed.geometry.coordinates[0]).toEqual(multipart.geometry.coordinates[0]);
        expect(changed.geometry.coordinates[1][0]).toEqual(ring);
        expect(validFootprint(changed, turf)).toBe(true);
    });

    it('accepts narrow valid corners and a courtyard touching the exterior at one point', () => {
        const narrow = [[16,45],[16.000002,45],[16.000002,45.000002],[16.000001,45.000002],[16.000001,45.0000019],[16,45.0000019],[16,45]];
        expect(isSimpleRing(narrow)).toBe(true);
        const touching = [[16,45],[16.0005,45.001],[16.001,45.0005],[16,45]];
        expect(validFootprint(turf.polygon([exterior,touching]),turf)).toBe(true);
    });

    it('uses uploaded heights and floors before editor defaults', () => {
        expect(importedHeight({ height: 18, floors: 2 }, 10)).toBe(18);
        expect(importedHeight({ heightM: 21 }, 10)).toBe(21);
        expect(importedHeight({ floors: 4 }, 10)).toBe(12);
        expect(importedHeight({}, 10)).toBe(10);
    });
});
