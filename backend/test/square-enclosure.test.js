import { describe, expect, it } from 'vitest';
import rules from '../../frontend/js/proposals/square-enclosure.js';
import frame from '../../frontend/js/local-frame.js';

const local = frame.makeLocalFrame(77, 43.8);
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings.map(ring =>
    [...ring, ring[0]].map(point => local.toDegrees(...point))) });
const box = (west, south, east, north) => polygon([[west, south], [east, south], [east, north], [west, north]]);
const building = (geometry, heightM = null) => ({ geometry, heightM });

describe('square enclosure', () => {
    it('maps walls and gaps by side and includes facade setback in the height ratio', () => {
        const square = polygon([[0, 0], [20, 0], [40, 0], [40, 30], [0, 30]]);
        const result = rules.measure(square, [building(box(0, -12, 20, -8), 15)]);
        expect(result.sides).toHaveLength(4);
        expect(result.perimeterM).toBeCloseTo(140, 2);
        expect(result.wallM).toBeCloseTo(20, 2);
        expect(result.sides[0]).toMatchObject({ heightCoverage: 1 });
        expect(result.sides[0].widthM).toBeCloseTo(30, 2);
        expect(result.sides[0].heightToWidth).toBeCloseTo(15 / 38, 4);
        expect(result.sides[0].longestGapM).toBeCloseTo(20, 2);
        expect(result.sides[0].segments.map(segment => segment.wall)).toEqual([true, false]);
        expect(result.sides.slice(1).every(side => side.wallM === 0)).toBe(true);
    });

    it('counts buildings with unknown heights across a street and ignores ones beyond reach', () => {
        const square = box(0, 0, 100, 14);
        const result = rules.measure(square, [
            building(box(0, -13, 50, -8)), // Eight metres away along a 14 m wide square.
            building(box(50, -30, 100, -26), 12),
            building(box(126, 0, 134, 14), 20) // Beyond 25 m along the long axis.
        ]);
        expect(result.wallM).toBeCloseTo(50, 2);
        expect(result.sides[0].heightCoverage).toBe(0);
        expect(result.sides[0].heightToWidth).toBeNull();
        expect(result.sides[1].wallM).toBe(0);
    });

    it('looks outside clockwise and counterclockwise outlines the same way', () => {
        const square = box(0, 0, 40, 30);
        const wall = building(box(0, -10, 40, -6), 6);
        const clockwise = { ...square, coordinates: [square.coordinates[0].slice().reverse()] };
        expect(rules.measure(clockwise, [wall]).wallM).toBeCloseTo(rules.measure(square, [wall]).wallM, 4);
    });

    it('stops across a concave gap before reaching another arm of the same square', () => {
        const square = polygon([[0, 0], [100, 0], [100, 20], [48, 20], [48, 4], [40, 4], [40, 20], [0, 20]]);
        const result = rules.measure(square, [building(box(51, 10, 57, 17), 9)]);
        // Side six faces another arm across a notch. The building is inside that arm.
        expect(result.sides[5].wallM).toBe(0);
    });
});
