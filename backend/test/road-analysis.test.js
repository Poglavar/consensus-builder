// Unit tests for the frontend's road geometry helpers (pure math — no DOM, no Leaflet, no map).
// These used to live in e2e/tests/road-tools.spec.ts, where they paid a full Chromium boot to
// compute a line intersection.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    findIntersections,
    lineIntersection,
    isPointInPolygon,
    closestPointOnLineSegment,
    filterWidthOutliers,
    createRoadWidthHistogramBuckets
} = require('../../frontend/js/road-analysis.js');

describe('lineIntersection', () => {
    it('finds the crossing point of two intersecting segments', () => {
        const intersection = lineIntersection([0, 0], [10, 10], [0, 10], [10, 0]);
        expect(intersection).not.toBeNull();
        expect(intersection[0]).toBeCloseTo(5, 6);
        expect(intersection[1]).toBeCloseTo(5, 6);
    });

    it('returns null for parallel segments', () => {
        expect(lineIntersection([0, 0], [10, 0], [0, 5], [10, 5])).toBeNull();
    });

    it('returns null for collinear segments (zero denominator)', () => {
        expect(lineIntersection([0, 0], [10, 0], [2, 0], [8, 0])).toBeNull();
    });

    it('returns null when the infinite lines cross but the segments do not', () => {
        // The lines y=x and y=-x+20 cross at (10,10), which lies beyond both segments.
        expect(lineIntersection([0, 0], [4, 4], [0, 20], [4, 16])).toBeNull();
    });

    it('reports an endpoint touch as an intersection', () => {
        const intersection = lineIntersection([0, 0], [10, 0], [10, 0], [10, 10]);
        expect(intersection).toEqual([10, 0]);
    });
});

describe('isPointInPolygon', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

    it('classifies a point inside the polygon', () => {
        expect(isPointInPolygon([5, 5], square)).toBe(true);
    });

    it('classifies a point outside the polygon', () => {
        expect(isPointInPolygon([15, 15], square)).toBe(false);
        expect(isPointInPolygon([-1, 5], square)).toBe(false);
    });

    it('handles a concave polygon — the notch is outside', () => {
        // An L-shape: the square minus its top-right quadrant.
        const lShape = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0]];
        expect(isPointInPolygon([2, 2], lShape)).toBe(true);
        expect(isPointInPolygon([2, 8], lShape)).toBe(true);
        expect(isPointInPolygon([8, 2], lShape)).toBe(true);
        expect(isPointInPolygon([8, 8], lShape)).toBe(false); // the removed quadrant
    });
});

describe('findIntersections', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

    it('finds both crossings when a line passes clean through a polygon', () => {
        const hits = findIntersections([[-5, 5], [15, 5]], square);
        expect(hits).toHaveLength(2);
        const xs = hits.map(([x]) => x).sort((a, b) => a - b);
        expect(xs[0]).toBeCloseTo(0, 6);
        expect(xs[1]).toBeCloseTo(10, 6);
        hits.forEach(([, y]) => expect(y).toBeCloseTo(5, 6));
    });

    it('finds a single crossing when the line starts inside the polygon', () => {
        const hits = findIntersections([[5, 5], [15, 5]], square);
        expect(hits).toHaveLength(1);
        expect(hits[0][0]).toBeCloseTo(10, 6);
    });

    it('finds nothing when the line misses the polygon entirely', () => {
        expect(findIntersections([[20, 20], [30, 30]], square)).toEqual([]);
    });
});

describe('closestPointOnLineSegment', () => {
    it('projects a point onto the segment', () => {
        expect(closestPointOnLineSegment([5, 5], [0, 0], [10, 0])).toEqual([5, 0]);
    });

    it('clamps to the segment endpoints when the projection falls outside', () => {
        expect(closestPointOnLineSegment([-5, 5], [0, 0], [10, 0])).toEqual([0, 0]);
        expect(closestPointOnLineSegment([50, 5], [0, 0], [10, 0])).toEqual([10, 0]);
    });

    it('returns the segment point when the segment is degenerate', () => {
        expect(closestPointOnLineSegment([5, 5], [2, 2], [2, 2])).toEqual([2, 2]);
    });
});

describe('filterWidthOutliers', () => {
    const emptyMeta = (n) => ({ positions: Array(n).fill(null), widthLines: Array(n).fill(null), segment: null });

    it('passes through small samples (< 3) with basic stats', () => {
        const out = filterWidthOutliers({ widths: [3, 4], ...emptyMeta(2) });
        expect(out.avgWidth).toBe(3.5);
        expect(out.minWidth).toBe(3);
        expect(out.maxWidth).toBe(4);
        expect(out.outlierPercentage).toBe(0);
    });

    it('drops a high outlier so the average reflects the real road', () => {
        // A cluster around 3 m with one absurd 30 m reading — the 30 must be rejected.
        const widths = [3, 3.1, 3.2, 3.0, 3.1, 2.9, 3.0, 30];
        const out = filterWidthOutliers({ widths, ...emptyMeta(widths.length) });
        expect(out.filteredWidths).not.toContain(30);
        expect(out.avgWidth).toBeLessThan(4);
        expect(out.outlierPercentage).toBeGreaterThan(0);
    });

    it('keeps a tight distribution intact (no false outliers)', () => {
        const widths = [3, 3.1, 3.2, 3.0, 3.1, 2.9];
        const out = filterWidthOutliers({ widths, ...emptyMeta(widths.length) });
        expect(out.filteredWidths).toHaveLength(widths.length);
        expect(out.outlierPercentage).toBe(0);
    });
});

describe('createRoadWidthHistogramBuckets', () => {
    it('covers 0..maxWidth in steps plus an overflow bucket', () => {
        const buckets = createRoadWidthHistogramBuckets(1, 0.5);
        // 0-0.5, 0.5-1, then the "1+ " overflow
        expect(buckets).toHaveLength(3);
        expect(buckets[0]).toMatchObject({ min: 0, max: 0.5 });
        expect(buckets[buckets.length - 1]).toMatchObject({ min: 1, max: Infinity });
    });

    it('every non-overflow bucket is contiguous with the next', () => {
        const buckets = createRoadWidthHistogramBuckets(2, 0.5);
        for (let i = 0; i < buckets.length - 2; i++) {
            expect(buckets[i].max).toBeCloseTo(buckets[i + 1].min, 6);
        }
    });
});
