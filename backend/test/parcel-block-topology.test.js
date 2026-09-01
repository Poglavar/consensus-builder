// Parcel outlines may be adjacent under live road ground. They are cadastral neighbours, but they
// are not in the same street block. The block topology layer owns that distinction.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neighborPairs, barrierContains } = require('../../frontend/js/parcels/block-topology.js');

const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const parcel = (id, ...rings) => ({ id, rings });
const keys = pairs => pairs.map(pair => [pair.a, pair.b].sort().join('~')).sort();

describe('live corridor ground is a street-block barrier', () => {
    it('removes a cadastral adjacency whose entire shared edge lies under a road', () => {
        const land = [
            parcel('NORTH', ring(0, 0, 10, 10)),
            parcel('SOUTH', ring(10, 0, 20, 10))
        ];
        const road = [parcel('ROAD', ring(9, -1, 11, 11))];

        expect(neighborPairs(land, road)).toEqual([]);
    });

    it('keeps the uncovered part when a road covers only part of a long boundary', () => {
        const land = [
            parcel('A', ring(0, 0, 10, 10)),
            parcel('B', ring(10, 0, 20, 10))
        ];
        const crossing = [parcel('ROAD', ring(9, 3, 11, 7))];
        const pairs = neighborPairs(land, crossing);

        expect(keys(pairs)).toEqual(['A~B']);
        expect(pairs[0].sharedM).toBeCloseTo(6, 1);
    });

    it('does not confuse a nearby road with a barrier on the shared boundary', () => {
        const land = [
            parcel('A', ring(0, 0, 10, 10)),
            parcel('B', ring(10, 0, 20, 10))
        ];
        const nearby = [parcel('ROAD', ring(11, 0, 12, 10))];

        expect(keys(neighborPairs(land, nearby))).toEqual(['A~B']);
        expect(neighborPairs(land, nearby)[0].sharedM).toBeCloseTo(10, 6);
    });

    it('honours holes and disjoint polygon rings in the corridor index', () => {
        const barrier = {
            rings: [
                ring(0, 0, 20, 20),
                ring(5, 5, 15, 15),
                ring(30, 30, 40, 40)
            ]
        };
        expect(barrierContains(barrier, 2, 2)).toBe(true);
        expect(barrierContains(barrier, 10, 10)).toBe(false);
        expect(barrierContains(barrier, 35, 35)).toBe(true);
    });
});
