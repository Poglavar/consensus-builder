// Two parcels are neighbours when their outlines RUN ALONG each other — not when they happen to
// store that boundary as the same pair of vertices.
//
// The old rule hashed vertex pairs into edge keys, so a boundary the two sides split differently
// made them strangers. Our own corridor cuts do exactly that (turf.difference re-emits a remainder
// with fresh vertices along a boundary its uncut neighbour still stores whole), the flood fill could
// not cross, and "select whole block" came back as a ring with the middle of the block missing.
//
// Coordinates are METRES here, as they are in the caller (HTRS96): the tolerances are lengths.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neighborPairs, DEFAULTS } = require('../../frontend/js/parcels/parcel-adjacency.js');

// A closed rectangle ring.
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const parcel = (id, ...rings) => ({ id, rings });
const keys = pairs => pairs.map(p => [p.a, p.b].sort().join('~')).sort();

describe('parcels that share a boundary', () => {
    it('links two rectangles that meet along a full edge', () => {
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 0, 20, 10))
        ]);
        expect(keys(pairs)).toEqual(['A~B']);
        expect(pairs[0].sharedM).toBeCloseTo(10, 6);
    });

    it('links across a T-junction, where one side stores the boundary whole', () => {
        // A's right edge runs 0→10 in one segment; B and C split the same line at y = 4.
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 0, 20, 4)),
            parcel('C', rect(10, 4, 20, 10))
        ]);
        expect(keys(pairs)).toEqual(['A~B', 'A~C', 'B~C']);
    });

    it('links a cut remainder to the uncut parcel beside it', () => {
        // What a corridor cut leaves: the same boundary, re-emitted with extra vertices on it and
        // the ring starting somewhere else. The edge keys share nothing; the boundary is identical.
        const uncut = parcel('HR-A', rect(0, 0, 10, 10));
        const remainder = parcel('HR-B#p1fbi2a1', [
            [10, 3], [10, 7], [10, 10], [18, 10], [18, 0], [10, 0], [10, 3]
        ]);
        expect(keys(neighborPairs([uncut, remainder]))).toEqual(['HR-A~HR-B#p1fbi2a1']);
    });

    it('survives the survey noise a real cadastre carries', () => {
        // The two sides of one boundary, recorded 4 cm apart and a fraction of a degree off.
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', [[10.04, 0.01], [20, 0], [20, 10], [10.04, 9.99], [10.04, 0.01]])
        ]);
        expect(keys(pairs)).toEqual(['A~B']);
    });
});

describe('parcels that do not', () => {
    it('does not link a corner touch', () => {
        expect(neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 10, 20, 20))
        ])).toEqual([]);
    });

    it('does not link parcels far apart on the same infinite line', () => {
        // Both have an edge on x = 10, 500 m apart. Same line, nothing in common.
        expect(neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 500, 20, 510))
        ])).toEqual([]);
    });

    it('does not link boundaries that merely run parallel', () => {
        expect(neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(11, 0, 20, 10))
        ])).toEqual([]);
    });

    it('treats a brush past the corner as a touch, not a boundary', () => {
        // 30 cm of shared edge — under the half-metre a boundary has to run to count.
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 9.7, 20, 20))
        ]);
        expect(pairs).toEqual([]);
        // ...and it is a threshold, not a blind spot: ask for less and it is there.
        expect(keys(neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 9.7, 20, 20))
        ], { minSharedM: 0.2 }))).toEqual(['A~B']);
    });

    it('never links a parcel to itself', () => {
        // A ring that doubles back on its own line — degenerate, but it must not self-link.
        expect(neighborPairs([parcel('A', rect(0, 0, 10, 10), rect(10, 0, 20, 10))]))
            .toEqual([]);
    });
});

describe('rings other than the first', () => {
    it('links a parcel to the one sitting in its hole', () => {
        const donut = parcel('OUTER', rect(0, 0, 30, 30), rect(10, 10, 20, 20));
        const inner = parcel('INNER', rect(10, 10, 20, 20));
        expect(keys(neighborPairs([donut, inner]))).toEqual(['INNER~OUTER']);
    });

    it('links along the second polygon of a multipolygon', () => {
        const split = parcel('SPLIT', rect(0, 0, 10, 10), rect(100, 0, 110, 10));
        const beside = parcel('B', rect(110, 0, 120, 10));
        expect(keys(neighborPairs([split, beside]))).toEqual(['B~SPLIT']);
    });
});

describe('measurement', () => {
    it('reports how far the two run together, longest first', () => {
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 0, 20, 4)),
            parcel('C', rect(10, 4, 20, 10))
        ]);
        const byKey = Object.fromEntries(pairs.map(p => [[p.a, p.b].sort().join('~'), p.sharedM]));
        expect(byKey['A~B']).toBeCloseTo(4, 6);
        expect(byKey['A~C']).toBeCloseTo(6, 6);
        expect(pairs[0].sharedM).toBeGreaterThanOrEqual(pairs[pairs.length - 1].sharedM);
    });

    it('adds up a boundary that spans several cells without counting it twice', () => {
        // 200 m of shared edge, far longer than the 25 m bucketing cell.
        const pairs = neighborPairs([
            parcel('A', rect(0, 0, 10, 200)),
            parcel('B', rect(10, 0, 20, 200))
        ]);
        expect(pairs[0].sharedM).toBeCloseTo(200, 6);
    });

    it('states its tolerances rather than hiding them', () => {
        expect(DEFAULTS.minSharedM).toBe(0.5);
        expect(DEFAULTS.offsetToleranceM).toBe(0.25);
    });
});
