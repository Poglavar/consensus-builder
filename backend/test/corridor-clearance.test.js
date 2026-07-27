// Unit tests for the corridor clearance module (pure planar geometry, no DOM or map).
// The scene most tests share: an east-west centerline with a building wall on each side,
// so left/right clearances, the pinch, and the fit shift all have hand-checkable values.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    corridorClearanceSamples,
    corridorClearanceStats,
    corridorFitShift,
    corridorShiftOffsets,
    offsetPolylineVariable,
    densifyPolylineXY,
    corridorHeldEndpoints,
    corridorClearanceHalo,
    corridorCompass8
} = require('../../frontend/js/corridor-clearance.js');

// A 100 m straight road heading east; travel direction +x, so left is +y (north).
const CENTERLINE = [[0, 0], [100, 0]];
const box = (id, x1, x2, y1, y2) => ({
    id,
    kind: 'building',
    rings: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]]
});
// North wall 5 m to the left, south wall 4 m to the right, both spanning x 40..60.
const NORTH = box('north', 40, 60, 5, 15);
const SOUTH = box('south', 40, 60, -12, -4);
const OPTIONS = { stationStep: 2, maxDistance: 50 };

const sampleScene = (obstacles = [NORTH, SOUTH]) => corridorClearanceSamples(CENTERLINE, obstacles, OPTIONS);

describe('corridorClearanceSamples', () => {
    it('measures the nearest obstacle on each side, and reports open sides as null', () => {
        const samples = sampleScene();
        const mid = samples.find(s => Math.abs(s.point[0] - 51) < 1e-6);
        expect(mid.left.distance).toBeCloseTo(5, 6);
        expect(mid.left.obstacleId).toBe('north');
        expect(mid.right.distance).toBeCloseTo(4, 6);
        expect(mid.right.obstacleId).toBe('south');

        const open = samples.find(s => s.point[0] < 30);
        expect(open.left).toBeNull();
        expect(open.right).toBeNull();
    });

    it('stations run the length of the line at the requested step', () => {
        const samples = sampleScene();
        expect(samples.length).toBe(50); // 1, 3, 5 … 99
        expect(samples[0].s).toBeCloseTo(1, 6);
        expect(samples[samples.length - 1].s).toBeCloseTo(99, 6);
    });

    it('picks the nearest of several obstacles on one side', () => {
        const nearer = box('nearer', 40, 60, 2, 3);
        const samples = corridorClearanceSamples(CENTERLINE, [NORTH, nearer], OPTIONS);
        const mid = samples.find(s => Math.abs(s.point[0] - 51) < 1e-6);
        expect(mid.left.distance).toBeCloseTo(2, 6);
        expect(mid.left.obstacleId).toBe('nearer');
    });
});

describe('corridorClearanceStats', () => {
    it('finds the pinch and the obstacles that form it', () => {
        const stats = corridorClearanceStats(sampleScene(), 8, OPTIONS);
        expect(stats.minWidth).toBeCloseTo(9, 6);
        expect(stats.minWidthUnbounded).toBe(false);
        expect(stats.pinch.leftObstacle.obstacleId).toBe('north');
        expect(stats.pinch.rightObstacle.obstacleId).toBe('south');
        expect(stats.minLeft).toBeCloseTo(5, 6);
        expect(stats.minRight).toBeCloseTo(4, 6);
        // Both walls pinch the same stretch, so the buildable width equals the total gap here.
        expect(stats.fitMaxWidth).toBeCloseTo(9, 6);
        expect(stats.fitMaxUnbounded).toBe(false);
        expect(stats.minLeftObstacle.obstacleId).toBe('north');
        expect(stats.minRightObstacle.obstacleId).toBe('south');
    });

    it('buildable width is minLeft+minRight, well below the total gap when the corridor winds', () => {
        // A left wall pins one stretch and a right wall a different stretch, so the total gap is
        // never tight (one side is always open) — yet a STRAIGHT road is limited to 3 + 3 m. This
        // is the case that used to headline the generous 53 m and then say "does not fit".
        const leftNear = box('leftnear', 10, 30, 3, 13);
        const rightNear = box('rightnear', 70, 90, -13, -3);
        const samples = corridorClearanceSamples(CENTERLINE, [leftNear, rightNear], OPTIONS);
        const stats = corridorClearanceStats(samples, 8, OPTIONS);
        expect(stats.minWidth).toBeCloseTo(53, 6);   // 3 + open(50): the total gap looks generous
        expect(stats.fitMaxWidth).toBeCloseTo(6, 6);  // the honest number — a straight road fits 3 + 3
        expect(stats.fitMaxUnbounded).toBe(false);
        expect(stats.minLeftObstacle.obstacleId).toBe('leftnear');
        expect(stats.minRightObstacle.obstacleId).toBe('rightnear');
        // fitMaxWidth (6) < road (8) predicts the fit is infeasible — and corridorFitShift agrees.
        expect(corridorFitShift(samples, 8, { ...OPTIONS, margin: 0 }).feasible).toBe(false);
        // Demolishing the left wall re-opens that side, lifting buildable width to 3 + 50.
        const withoutLeft = corridorClearanceStats(
            corridorClearanceSamples(CENTERLINE, [rightNear], OPTIONS), 8, OPTIONS);
        expect(withoutLeft.fitMaxWidth).toBeCloseTo(53, 6);
    });

    it('treats open stations as maxDistance of room, flagged unbounded', () => {
        const stats = corridorClearanceStats(sampleScene(), 8, OPTIONS);
        expect(stats.maxWidth).toBeCloseTo(100, 6); // 50 + 50 on the open stretch
        expect(stats.maxWidthUnbounded).toBe(true);
    });

    it('fitsAsIs needs half the road on each side at every station', () => {
        expect(corridorClearanceStats(sampleScene(), 8, OPTIONS).fitsAsIs).toBe(true);   // needs 4 | 4
        expect(corridorClearanceStats(sampleScene(), 10, OPTIONS).fitsAsIs).toBe(false); // needs 5, south has 4
    });

    it('what-if: removing the pinch obstacle re-opens the corridor', () => {
        const without = corridorClearanceStats(sampleScene([NORTH]), 10, OPTIONS);
        expect(without.minWidth).toBeCloseTo(55, 6); // 5 north + open south
        expect(without.fitsAsIs).toBe(true);
    });
});

describe('corridorFitShift', () => {
    it('returns zero shift when the road already fits in place', () => {
        const fit = corridorFitShift(sampleScene(), 8, { ...OPTIONS, margin: 0 });
        expect(fit.feasible).toBe(true);
        expect(fit.shift).toBe(0);
    });

    it('computes the smallest move that fits, positive toward the roomier (left) side', () => {
        const fit = corridorFitShift(sampleScene(), 8.5, { ...OPTIONS, margin: 0 });
        expect(fit.feasible).toBe(true);
        expect(fit.shift).toBeCloseTo(0.25, 6); // needs 4.25 a side; south offers 4 → move 0.25 left
        expect(fit.dMax).toBeCloseTo(0.75, 6);  // north wall caps the move at 5 − 4.25
    });

    it('reports infeasible when the road is wider than the corridor min width', () => {
        const fit = corridorFitShift(sampleScene(), 10, { ...OPTIONS, margin: 0 });
        expect(fit.feasible).toBe(false);
        expect(fit.shift).toBeNull();
    });
});

describe('corridorShiftOffsets', () => {
    const LINE = [[0, 0], [50, 0], [100, 0]];

    it('is the full shift everywhere when nothing is held', () => {
        expect(corridorShiftOffsets(LINE, 2, {})).toEqual([2, 2, 2]);
    });

    it('eases to zero toward a held endpoint', () => {
        const offsets = corridorShiftOffsets(LINE, 2, { holdStart: true, taperMeters: 15 });
        expect(offsets[0]).toBe(0);
        expect(offsets[1]).toBeCloseTo(2, 6); // 50 m in, well past the taper
        expect(offsets[2]).toBeCloseTo(2, 6);
        const both = corridorShiftOffsets(LINE, 2, { holdStart: true, holdEnd: true, taperMeters: 15 });
        expect(both[0]).toBe(0);
        expect(both[2]).toBe(0);
        expect(both[1]).toBeCloseTo(2, 6);
    });
});

describe('offsetPolylineVariable', () => {
    it('translates a straight line by a constant offset', () => {
        expect(offsetPolylineVariable([[0, 0], [100, 0]], [2, 2])).toEqual([[0, 2], [100, 2]]);
    });

    it('keeps vertex count and mitres a right-angle corner exactly', () => {
        const result = offsetPolylineVariable([[0, 0], [10, 0], [10, 10]], [1, 1, 1]);
        expect(result.length).toBe(3);
        // Offsetting 1 m left: first edge lands on y=1, second on x=9; the mitred corner is their crossing.
        expect(result[0][1]).toBeCloseTo(1, 6);
        expect(result[1][0]).toBeCloseTo(9, 6);
        expect(result[1][1]).toBeCloseTo(1, 6);
        expect(result[2][0]).toBeCloseTo(9, 6);
    });

    it('a zero offset leaves the polyline untouched', () => {
        const line = [[0, 0], [10, 0], [10, 10]];
        expect(offsetPolylineVariable(line, [0, 0, 0])).toEqual(line);
    });
});

describe('densifyPolylineXY', () => {
    it('splits long edges without moving the original vertices', () => {
        const result = densifyPolylineXY([[0, 0], [10, 0]], 4);
        expect(result.length).toBe(4); // ceil(10/4) = 3 pieces
        expect(result[0]).toEqual([0, 0]);
        expect(result[3]).toEqual([10, 0]);
        expect(result[1][0]).toBeCloseTo(10 / 3, 6);
    });

    it('leaves short edges alone', () => {
        expect(densifyPolylineXY([[0, 0], [3, 0]], 4).length).toBe(2);
    });
});

describe('corridorHeldEndpoints', () => {
    it('holds an endpoint that touches another centerline, within tolerance', () => {
        const held = corridorHeldEndpoints([[0, 0], [50, 0]], [[[0.5, -10], [0.5, 10]]], 0.75);
        expect(held.start).toBe(true);
        expect(held.end).toBe(false);
    });

    it('holds nothing for a standalone segment', () => {
        expect(corridorHeldEndpoints([[0, 0], [50, 0]], [], 0.75)).toEqual({ start: false, end: false });
    });
});

describe('corridorClearanceHalo', () => {
    it('builds one ring from the per-side clearances, capped for open sides', () => {
        const samples = sampleScene();
        const ring = corridorClearanceHalo(samples, 30);
        expect(ring.length).toBe(samples.length * 2);
        // At the pinch the halo hugs the measured walls; on the open stretch it sits at the cap.
        const mid = samples.findIndex(s => Math.abs(s.point[0] - 51) < 1e-6);
        expect(ring[mid][1]).toBeCloseTo(5, 6);   // left boundary at the north wall
        expect(ring[0][1]).toBeCloseTo(30, 6);    // open side capped
    });
});

describe('corridorCompass8', () => {
    it('names the eight directions from a planar vector (x east, y north)', () => {
        expect(corridorCompass8([0, 1])).toBe('n');
        expect(corridorCompass8([1, 0])).toBe('e');
        expect(corridorCompass8([1, 1])).toBe('ne');
        expect(corridorCompass8([0, -1])).toBe('s');
        expect(corridorCompass8([-1, -1])).toBe('sw');
        expect(corridorCompass8([0, 0])).toBeNull();
    });
});
