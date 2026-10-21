// The rooster's score is a pure rule. Keep it executable outside the map so the 10 × 10 m
// threshold and rotated parcels cannot drift with the animation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    parcelDimensionsMeters,
    isFineGrainParcel,
    startingParcelIds,
    scoreParcelCount,
    scorePlan
} = require('../../frontend/js/proposals/grain-score-rules.js');

const R = 6378137;

function rotatedPolygon(corners, angleDegrees, center = [15.98, 45.81]) {
    const theta = angleDegrees * Math.PI / 180;
    const geographic = corners.map(([x, y]) => [
        x * Math.cos(theta) - y * Math.sin(theta),
        x * Math.sin(theta) + y * Math.cos(theta)
    ]).map(([x, y]) => [
        center[0] + (x / (R * Math.cos(center[1] * Math.PI / 180))) * 180 / Math.PI,
        center[1] + (y / R) * 180 / Math.PI
    ]);
    geographic.push(geographic[0]);
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [geographic] } };
}

function rotatedRectangle(widthM, depthM, angleDegrees, center = [15.98, 45.81]) {
    return rotatedPolygon([
        [-widthM / 2, -depthM / 2],
        [widthM / 2, -depthM / 2],
        [widthM / 2, depthM / 2],
        [-widthM / 2, depthM / 2]
    ], angleDegrees, center);
}

describe('parcel measurement', () => {
    it('is independent of map orientation', () => {
        const dimensions = parcelDimensionsMeters(rotatedRectangle(8, 9, 37));
        expect(dimensions.widthMeters).toBeCloseTo(8, 1);
        expect(dimensions.depthMeters).toBeCloseTo(9, 1);
        expect(isFineGrainParcel(dimensions)).toBe(true);
    });

    it('requires both directions to be strictly under ten metres', () => {
        expect(isFineGrainParcel({ widthMeters: 9.9, depthMeters: 9.9 })).toBe(true);
        expect(isFineGrainParcel({ widthMeters: 9, depthMeters: 12 })).toBe(false);
        expect(isFineGrainParcel({ widthMeters: 10, depthMeters: 8 })).toBe(false);
    });

    it('uses the convex envelope when a cadastral parcel has concave dents', () => {
        const parcel = rotatedPolygon([
            [-4, -4.5], [0, -3.5], [4, -4.5], [3, 0],
            [4, 4.5], [0, 3.5], [-4, 4.5], [-3, 0]
        ], 23);
        const dimensions = parcelDimensionsMeters(parcel);
        expect(dimensions.widthMeters).toBeCloseTo(8, 1);
        expect(dimensions.depthMeters).toBeCloseTo(9, 1);
        expect(isFineGrainParcel(dimensions)).toBe(true);
    });

    it('declines to invent dimensions for non-polygon geometry', () => {
        expect(parcelDimensionsMeters({ type: 'LineString', coordinates: [[15, 45], [16, 46]] })).toBeNull();
        expect(parcelDimensionsMeters(null)).toBeNull();
    });
});

describe('plan fabric and score', () => {
    it('counts only original ground before a chain of derived parcels', () => {
        const ids = startingParcelIds({
            produced: ['derived-1', 'derived-2'],
            consumed: ['base-1', 'derived-1'],
            builtOn: ['derived-2', 'base-2']
        });
        expect(new Set(ids)).toEqual(new Set(['base-1', 'base-2']));
    });

    it('scores an increase, no change and a decrease explicitly', () => {
        expect(scoreParcelCount(3, 5)).toEqual({ score: 100, delta: 2, direction: 'increase' });
        expect(scoreParcelCount(3, 3)).toEqual({ score: 50, delta: 0, direction: 'unchanged' });
        expect(scoreParcelCount(5, 3)).toEqual({ score: 0, delta: -2, direction: 'decrease' });
    });

    it('does not penalize the plan for geometry the client could not measure', () => {
        const result = scorePlan({
            beforeParcelCount: 2,
            afterParcelCount: 3,
            parcels: [
                { id: 'small', widthMeters: 8, depthMeters: 9 },
                { id: 'large', widthMeters: 9, depthMeters: 14 },
                { id: 'missing', widthMeters: null, depthMeters: null }
            ]
        });
        expect(result.parcelCount.score).toBe(100);
        expect(result.fineGrain).toMatchObject({ score: 50, eaten: 1, measured: 2, total: 3, missing: 1 });
        expect(result.totalScore).toBe(75);
        expect(result.verdict).toBe('good');
    });
});
