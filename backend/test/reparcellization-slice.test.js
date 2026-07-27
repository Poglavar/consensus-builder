// Unit tests for frontend/js/reparcellization-slice.js — the sweep-line subdivision that hands each
// owner a share-sized slice of the super-parcel. The headline pin is the land-allocation bug: a
// 0%-share owner must receive NOTHING and must not steal the next owner's land.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { sliceWithSweepLine } = require('../../frontend/js/reparcellization-slice.js');

const deps = { turf, computeFeatureArea: (f) => (f ? turf.area(f) : 0) };

// A rectangle in lng/lat. Area is proportional to width, so a cumulative-area cut lands at the
// proportional X — predictable shares.
function rect(west, south, east, north) {
    return turf.polygon([[
        [west, south], [east, south], [east, north], [west, north], [west, south]
    ]]);
}

const owner = (key, percent) => ({ ownerKey: key, displayName: key, color: '#000', percent });

function areaOf(slice) {
    return turf.area(turf.feature(slice.geometry));
}

describe('sliceWithSweepLine', () => {
    const parcel = rect(15.9, 45.8, 16.0, 45.9);
    const totalArea = turf.area(parcel);

    it('splits two equal owners into two ~equal slices with the right owners', () => {
        const slices = sliceWithSweepLine(parcel, [owner('A', 0.5), owner('B', 0.5)], deps);
        expect(slices).toHaveLength(2);
        expect(slices.map(s => s.ownerKey).sort()).toEqual(['A', 'B']);
        for (const s of slices) {
            expect(areaOf(s) / totalArea).toBeCloseTo(0.5, 1);
        }
    });

    it('gives a 0%-share owner NOTHING and does not shift the others (the land bug)', () => {
        const slices = sliceWithSweepLine(
            parcel,
            [owner('A', 0.5), owner('B', 0.0), owner('C', 0.5)],
            deps
        );
        const byOwner = Object.fromEntries(slices.map(s => [s.ownerKey, s]));
        // B (0%) gets no slice at all.
        expect(byOwner.B).toBeUndefined();
        // A and C each get their real half — C is NOT starved.
        expect(byOwner.A).toBeDefined();
        expect(byOwner.C).toBeDefined();
        expect(areaOf(byOwner.A) / totalArea).toBeCloseTo(0.5, 1);
        expect(areaOf(byOwner.C) / totalArea).toBeCloseTo(0.5, 1);
    });

    it('honours uneven shares in order', () => {
        const slices = sliceWithSweepLine(
            parcel,
            [owner('A', 0.25), owner('B', 0.25), owner('C', 0.5)],
            deps
        );
        const byOwner = Object.fromEntries(slices.map(s => [s.ownerKey, s]));
        expect(areaOf(byOwner.A) / totalArea).toBeCloseTo(0.25, 1);
        expect(areaOf(byOwner.B) / totalArea).toBeCloseTo(0.25, 1);
        expect(areaOf(byOwner.C) / totalArea).toBeCloseTo(0.5, 1);
        // Slices cover the whole parcel (no lost land).
        const covered = slices.reduce((sum, s) => sum + areaOf(s), 0);
        expect(covered / totalArea).toBeCloseTo(1, 1);
    });

    it('returns [] for no owners or a degenerate parcel', () => {
        expect(sliceWithSweepLine(parcel, [], deps)).toEqual([]);
        expect(sliceWithSweepLine(rect(0, 0, 0, 0), [owner('A', 1)], deps)).toEqual([]);
    });

    it('gives a single owner the whole parcel', () => {
        const slices = sliceWithSweepLine(parcel, [owner('A', 1)], deps);
        expect(slices).toHaveLength(1);
        expect(slices[0].ownerKey).toBe('A');
        expect(areaOf(slices[0]) / totalArea).toBeCloseTo(1, 1);
    });
});
