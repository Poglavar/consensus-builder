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
        // Four metres of road plus the half-metre topology clearance on either side leaves five
        // metres of genuine land connection.
        expect(pairs[0].sharedM).toBeCloseTo(5, 1);
    });

    it('does not squeeze through a sub-half-metre clipping seam beside live road ground', () => {
        const land = [
            parcel('A', ring(0, 0, 10, 10)),
            parcel('B', ring(10, 0, 20, 10))
        ];
        // The clipper left the road 40 cm short of the apparent shared boundary. That is numerical
        // clearance, not a real pedestrian-scale land connection between two street blocks.
        const road = [parcel('ROAD', ring(8, -1, 9.6, 11))];

        expect(neighborPairs(land, road)).toEqual([]);
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

describe('block connectivity comes only from shared boundaries', () => {
    it('keeps the circled northwest Sibenik parcel in parcel 616\'s road-bounded block', () => {
        const sharedVertex = [449438.50003761967, 4846084.400017597];
        const land = [
            parcel('P-616', [[449425.58001269406, 4846067.289978717], sharedVertex]),
            parcel('P-603', [[449426.53440963506, 4846068.553886445], sharedVertex])
        ];

        expect(keys(neighborPairs(land, []))).toEqual(['P-603~P-616']);
        expect(neighborPairs(land, [])[0].sharedM).toBeCloseTo(19.856, 2);
    });

    it('does not invent a connection because one overlapping parcel contains another', () => {
        const land = [
            parcel('OUTER', ring(0, 0, 20, 20)),
            parcel('INNER', ring(8, 8, 12, 12))
        ];

        expect(neighborPairs(land, [])).toEqual([]);
    });

    it('still connects a genuine enclave along the enclosing parcel hole boundary', () => {
        const enclaveBoundary = ring(8, 8, 12, 12);
        const land = [
            parcel('OUTER', ring(0, 0, 20, 20), enclaveBoundary),
            parcel('INNER', enclaveBoundary)
        ];

        expect(keys(neighborPairs(land, []))).toEqual(['INNER~OUTER']);
        expect(neighborPairs(land, [])[0].sharedM).toBeCloseTo(16, 6);
    });
});
