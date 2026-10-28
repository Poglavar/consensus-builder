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
    scorePlan,
    roosterPose,
    appliedPlanGround
} = require('../../frontend/js/proposals/grain-score-rules.js');

// The rooster reads an applied plan from the live map: the members' own anchors plus the ground
// their pieces stand on, the live entries over that ground, and the original parcels. A member
// that is not applied, or not on this device, leaves nothing to inspect.
describe('the applied plan on the map', () => {
    const records = [
        { proposalId: 'p-road', applied: true, cadastreParcelIds: ['A', 'B'] },
        { proposalId: 'p-layout', applied: true, cadastreParcelIds: ['B'] },
        { proposalId: 'p-park', applied: false, cadastreParcelIds: ['C'] }
    ];
    const ports = {
        records,
        cidOf: record => `cid:${record.proposalId}`,
        isApplied: record => record.applied === true,
        producedBy: id => (id === 'p-layout' ? [{ properties: { cadastreParcelIds: ['B', 'D'] } }] : []),
        entriesForCadastre: (ids, options) => ids.map(id => ({ properties: { parcelId: `${id}#live`, cadastreParcelIds: [id] }, options })),
        originalOf: id => (id === 'D' ? null : { properties: { parcelId: id } })
    };
    it('reads the members’ ground and pieces from the live fabric', () => {
        const ground = appliedPlanGround({ ...ports, members: [{ cid: 'cid:p-road' }, { cid: 'cid:p-layout' }] });
        expect(ground.ok).toBe(true);
        expect(ground.proposals.map(record => record.proposalId)).toEqual(['p-road', 'p-layout']);
        // A, B from the anchors; D from a piece the layout produced beyond its own anchors.
        expect(ground.cadastreIds).toEqual(['A', 'B', 'D']);
        expect(ground.materializedFeatures.map(feature => feature.properties.parcelId)).toEqual(['A#live', 'B#live', 'D#live']);
        expect(ground.materializedFeatures[0].options).toEqual({ includeCorridors: false });
        expect(ground.cadastralFeatures.map(feature => feature.properties.parcelId)).toEqual(['A', 'B']);
    });
    it('refuses a plan with an unapplied or missing member', () => {
        expect(appliedPlanGround({ ...ports, members: [{ cid: 'cid:p-road' }, { cid: 'cid:p-park' }] })).toMatchObject({ ok: false, missing: ['cid:p-park'], proposals: [] });
        expect(appliedPlanGround({ ...ports, members: [{ cid: 'cid:elsewhere' }] })).toMatchObject({ ok: false, missing: ['cid:elsewhere'] });
        expect(appliedPlanGround({ ...ports, members: [] })).toMatchObject({ ok: true, cadastreIds: [], materializedFeatures: [], cadastralFeatures: [] });
    });
});

const R = 6378137;

describe('beak contact pose', () => {
    it('mirrors around the beak contact point without moving the target', () => {
        const target = { x: 400, y: 300 }, width = 90, height = 110;
        const left = roosterPose({ target, width, height, facing: 1 });
        const right = roosterPose({ target, width, height, facing: -1 });
        expect(left.y).toBeCloseTo(right.y, 8);
        expect(left.x + right.x + width).toBeCloseTo(2 * target.x, 8);
        expect(left.x).toBeGreaterThan(target.x);
        expect(right.x).toBeLessThan(target.x - width);
    });
    it('translates with the parcel rather than clamping the bird away from the parcel', () => {
        const at = target => roosterPose({ target, width: 78, height: 78 * 220 / 180 });
        const a = at({ x: 10, y: 50 }), b = at({ x: 210, y: 350 });
        expect(b.x - a.x).toBeCloseTo(200, 8);
        expect(b.y - a.y).toBeCloseTo(300, 8);
    });
});

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
