// The shared coordinate grid (frontend/js/geometry-tolerances.js): one rounding for every stage, idempotent,
// and the same answer for a coordinate whoever computed it.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grid = require('../../frontend/js/geometry-tolerances.js');

describe('the shared coordinate grid', () => {
    it('rounds to 9 decimals with integer rounding, and a snapped coordinate stays put', () => {
        expect(grid.GRID_DECIMALS).toBe(9);
        const snapped = grid.snapCoordinates([15.95425814698254, 45.76064717685072]);
        expect(snapped).toEqual([15.954258147, 45.760647177]);
        expect(grid.snapCoordinates(snapped)).toEqual(snapped);
        // toFixed rounds some halves the other way; the grid never uses it.
        expect(grid.snapCoordinates([1.0000000005])).toEqual([Math.round(1.0000000005 * 1e9) / 1e9]);
    });

    it('snaps every ring of every part and keeps the feature as it was otherwise', () => {
        const feature = { type: 'Feature', id: 7, properties: { parcelId: 'HR-A' }, geometry: { type: 'MultiPolygon', coordinates: [
            [[[0.1234567891234, 0], [1, 0], [1, 1], [0.1234567891234, 0]]], [[[2, 2], [3, 2.0000000004], [3, 3], [2, 2]]]] } };
        const snapped = grid.snapFeature(feature);
        expect(snapped).not.toBe(feature);
        expect(snapped.id).toBe(7);
        expect(snapped.properties).toBe(feature.properties);
        expect(snapped.geometry.coordinates[0][0][0]).toEqual([0.123456789, 0]);
        expect(snapped.geometry.coordinates[1][0][1]).toEqual([3, 2]);
        expect(feature.geometry.coordinates[0][0][0][0]).toBe(0.1234567891234);
        expect(grid.snapGeometry({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1.00000000049, 2] }] }).geometries[0].coordinates).toEqual([1, 2]);
    });
});

describe('what counts as ground', () => {
    const turf = require('@turf/turf');
    const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
    // 1e-5 degrees of latitude is about 1.1 m; of longitude at 45° about 0.79 m.
    const parcel = box(16, 45, 16.001, 45.001);
    it('is anything wider than the measured noise (1 mm), or than the design toleranceM', () => {
        expect(grid.NOISE_M).toBe(0.001);
        expect(grid.isGround(turf, box(16, 45, 16.001, 45 + 0.004 / 111000))).toBe(true);   // 4 mm wide strip
        expect(grid.isGround(turf, box(16, 45, 16.001, 45 + 0.0004 / 111000))).toBe(false); // 0.4 mm: cutting debris
        expect(grid.isGround(turf, box(16, 45, 16.001, 45 + 0.004 / 111000), 0.01)).toBe(false); // narrower than its 1 cm allowance
        expect(grid.isGround(turf, null)).toBe(false);
    });
    it('answers for a shape too large to be all boundary band without eroding it', () => {
        const eroding = new Proxy(turf, { get: (target, key) => (key === 'buffer' ? () => { throw new Error('eroded'); } : target[key]) });
        expect(grid.isGround(eroding, parcel)).toBe(true);                                     // ~78 × 111 m
        const strip = box(16, 45, 16.001, 45 + 0.0015 / 111000);                               // 1.5 mm: could be all band
        expect(grid.isGround(turf, strip)).toBe(true);                                         // so it is eroded
        expect(grid.isGround(eroding, strip)).toBe(false);                                     // and a failed erosion is no ground
    });
    it('decides whether a shape reaches into a parcel by that rule on the shared clip', () => {
        const reach = d => box(15.9995, 45.0002, 16 + d / 78600, 45.0004); // reaches d metres past the parcel's west edge
        expect(grid.reachesInto(turf, reach(0.039), parcel)).toBe(true);
        expect(grid.reachesInto(turf, reach(0.0003), parcel)).toBe(false);
        expect(grid.reachesInto(turf, box(15.99, 45, 15.995, 45.001), parcel)).toBe(false);
    });
    it('names the part of a shape its covers leave uncovered, so standing wholly on them is one isGround', () => {
        const west = box(16, 45, 16.0005, 45.001);
        const east = box(16.0005, 45, 16.001, 45.001);
        expect(grid.uncoveredBy(turf, parcel, [west, east])).toBe(null);
        expect(grid.isGround(turf, grid.uncoveredBy(turf, parcel, [west]))).toBe(true);
        const sliver = box(16, 45, 16.001, 45.001 - 0.0004 / 111000); // leaves a 0.4 mm strip uncovered
        expect(grid.isGround(turf, grid.uncoveredBy(turf, parcel, [sliver]))).toBe(false);
    });
});
