// Unit tests for the pure proposal-warning logic (frontend/js/proposal-warnings.js): the decisions
// behind the gentle "…proceed?" nudges shown before committing an oversized block or row houses on
// dissimilar parcels. Pure number-in/number-out, so no DOM, no turf, no browser.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    walkAroundMinutes,
    assessBlockSize,
    assessRowHouseSimilarity,
    OVERSIZED_BLOCK_WALK_MINUTES
} = require('../../frontend/js/proposal-warnings.js');

describe('walkAroundMinutes', () => {
    it('turns a perimeter into minutes at ~5 km/h', () => {
        // 800 m perimeter (a 200×200 block) ≈ 9.5 minutes.
        expect(walkAroundMinutes(800)).toBeCloseTo(9.52, 1);
    });
    it('is zero for non-positive or bad input', () => {
        expect(walkAroundMinutes(0)).toBe(0);
        expect(walkAroundMinutes(-100)).toBe(0);
        expect(walkAroundMinutes(NaN)).toBe(0);
        expect(walkAroundMinutes(undefined)).toBe(0);
    });
});

describe('assessBlockSize', () => {
    it('does NOT flag a block at the recommended 200×200 m upper bound', () => {
        const r = assessBlockSize(800); // perimeter of 200×200
        expect(r.oversized).toBe(false);
        expect(r.roundedMinutes).toBe(10);
    });

    it('does NOT flag a block a bit over the recommendation (under the 15-minute threshold)', () => {
        const r = assessBlockSize(1000); // 250×250-ish, ~12 min
        expect(r.oversized).toBe(false);
    });

    it('flags a block once the walk-around passes the 15-minute threshold', () => {
        const r = assessBlockSize(1400); // ~350 m sides, ~17 min
        expect(r.oversized).toBe(true);
        expect(r.minutes).toBeGreaterThan(OVERSIZED_BLOCK_WALK_MINUTES);
    });

    it('quotes a large, sensible minute count for a huge block', () => {
        const r = assessBlockSize(1400); // ~350 m sides
        expect(r.oversized).toBe(true);
        expect(r.roundedMinutes).toBeGreaterThanOrEqual(16);
    });

    it('never quotes zero minutes (rounds up to at least 1)', () => {
        expect(assessBlockSize(30).roundedMinutes).toBe(1);
    });
});

describe('assessRowHouseSimilarity', () => {
    it('does not flag parcels of similar size and shape', () => {
        const r = assessRowHouseSimilarity([
            { area: 500, perimeter: 90 },
            { area: 560, perimeter: 95 },
            { area: 520, perimeter: 92 }
        ]);
        expect(r.dissimilar).toBe(false);
        expect(r.count).toBe(3);
    });

    it('flags parcels that differ by more than ~3× in size', () => {
        const r = assessRowHouseSimilarity([
            { area: 200, perimeter: 60 },
            { area: 700, perimeter: 110 }
        ]);
        expect(r.dissimilar).toBe(true);
        expect(r.areaRatio).toBeGreaterThan(3);
    });

    it('flags parcels of similar size but very different shape (compactness)', () => {
        const r = assessRowHouseSimilarity([
            { area: 400, perimeter: 80 },   // near-square, compact
            { area: 400, perimeter: 200 }   // long thin sliver
        ]);
        expect(r.dissimilar).toBe(true);
        expect(r.compactnessSpread).toBeGreaterThan(0.35);
    });

    it('never flags a single parcel (a row degenerates to one building there)', () => {
        expect(assessRowHouseSimilarity([{ area: 500, perimeter: 90 }]).dissimilar).toBe(false);
    });

    it('ignores unmeasurable parcels and is safe on empty input', () => {
        expect(assessRowHouseSimilarity([]).dissimilar).toBe(false);
        expect(assessRowHouseSimilarity([{ area: 0 }, { area: NaN }]).dissimilar).toBe(false);
    });
});
