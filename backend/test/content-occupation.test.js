// content-occupation.js — proposed fabric standing on ground a formation would take
// (rethink §15 decision 3). Proposed buildings are never cut in half: an occupation is a
// conflict the user resolves by un-applying, so only MATERIAL occupations may block.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let co;

beforeAll(() => {
    co = require('../../frontend/js/proposals/content-occupation.js');
});

// Rectangles in metres, so area/intersection are exact and thresholds testable.
function rect(x0, y0, x1, y1) {
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
}

const ctx = {
    area: r => Math.max(0, (r.maxX - r.minX)) * Math.max(0, (r.maxY - r.minY)),
    intersectionArea: (a, b) => {
        const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        return (w > 0 && h > 0) ? w * h : 0;
    }
};

// A 10 m wide corridor running along y = 0..10.
const CORRIDOR = rect(0, 0, 200, 10);

function candidate(key, goal, footprint, extra = {}) {
    return { key, footprint, proposal: { goal, title: `${key} title`, ...extra } };
}

describe('occupationsOf', () => {
    it('flags a building materially bitten by the corridor', () => {
        // 20x20 = 400 m² building, 20x5 = 100 m² inside the corridor → 25%
        const hits = co.occupationsOf(CORRIDOR, [candidate('c-b1', 'single', rect(20, 5, 40, 25))], ctx);
        expect(hits).toHaveLength(1);
        expect(hits[0].occupiedM2).toBe(100);
        expect(hits[0].occupiedPct).toBe(25);
        expect(hits[0].title).toBe('c-b1 title');
    });

    it('ignores a sliver — imprecise tracing is not a consent question', () => {
        // 400 m² building, 20x0.5 = 10 m² inside → 2.5%: under both thresholds
        const hits = co.occupationsOf(CORRIDOR, [candidate('c-b2', 'single', rect(20, 9.5, 40, 29.5))], ctx);
        expect(hits).toEqual([]);
    });

    it('flags a small proposal that is mostly swallowed, however few m² that is', () => {
        // 4x4 = 16 m² shed fully inside the corridor: 100% but only 16 m²
        const hits = co.occupationsOf(CORRIDOR, [candidate('c-shed', 'single', rect(50, 3, 54, 7))], ctx);
        expect(hits).toHaveLength(1);
        expect(hits[0].occupiedPct).toBe(100);
    });

    it('never flags the ground-authoring layers — a road crossing drawn plots is normal', () => {
        const hits = co.occupationsOf(CORRIDOR, [
            candidate('c-rep', 'reparcellization', rect(0, 0, 200, 100)),
            candidate('c-later', 'decide-later', rect(0, 0, 200, 100))
        ], ctx);
        expect(hits).toEqual([]);
    });

    it('flags structures too — a park owns its parcel', () => {
        const hits = co.occupationsOf(CORRIDOR, [candidate('c-park', 'park', rect(60, 0, 100, 40))], ctx);
        expect(hits).toHaveLength(1);
        expect(hits[0].goal).toBe('park');
    });

    it('skips itself and explicitly exempt keys', () => {
        const cands = [
            candidate('c-self', 'road-track', rect(0, 0, 200, 10)),
            candidate('c-exempt', 'single', rect(20, 5, 40, 25))
        ];
        expect(co.occupationsOf(CORRIDOR, cands, ctx, { selfKey: 'c-self', exemptKeys: ['c-exempt'] })).toEqual([]);
    });

    it('orders by how much of the victim is taken, worst first', () => {
        const hits = co.occupationsOf(CORRIDOR, [
            candidate('c-small', 'single', rect(20, 5, 40, 25)),   // 25%
            candidate('c-big', 'single', rect(60, 0, 80, 30))      // 20x10 / 600 = 33%
        ], ctx);
        expect(hits.map(h => h.key)).toEqual(['c-big', 'c-small']);
    });

    it('returns nothing without a footprint or usable context', () => {
        expect(co.occupationsOf(null, [candidate('c-b', 'single', rect(0, 0, 10, 10))], ctx)).toEqual([]);
        expect(co.occupationsOf(CORRIDOR, [candidate('c-b', 'single', rect(0, 0, 10, 10))], null)).toEqual([]);
    });

    it('honours explicit thresholds', () => {
        const cands = [candidate('c-b2', 'single', rect(20, 9.5, 40, 29.5))]; // 10 m², 2.5%
        expect(co.occupationsOf(CORRIDOR, cands, ctx, { minAreaM2: 5, minPct: 1 })).toHaveLength(1);
    });
});

describe('describeOccupations', () => {
    it('names what blocks the apply, with the share taken', () => {
        const hits = co.occupationsOf(CORRIDOR, [candidate('c-b1', 'single', rect(20, 5, 40, 25))], ctx);
        const text = co.describeOccupations(hits);
        expect(text).toContain('c-b1 title (25%)');
        expect(text).toContain('Un-apply');
    });

    it('is empty when nothing is occupied', () => {
        expect(co.describeOccupations([])).toBe('');
    });
});
