// Unit tests for AI-scene frustum culling: which proposals were in the camera's view when the shot
// was taken. The math is Gribb–Hartmann plane extraction from a view-projection matrix; the tests use
// hand-built matrices (identity = the clip cube, plus a translate/scale "camera") so no THREE is
// needed. The behaviour that matters: a proposal in frame is kept, one off to the side is dropped, a
// long road crossing the frame with all raw vertices outside is still caught (densification), and any
// failure to build the frustum returns null so the caller keeps its full set.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    frustumPlanes,
    pointInsidePlanes,
    geometryRings,
    proposalsInView,
    featuresInFrustum
} = require('../../frontend/js/ai-scene-frustum.js');

// Column-major 4x4 (THREE.Matrix4 layout: elements[col*4 + row]).
const IDENTITY = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
];

// A view-projection that maps the world box centred at (cx,cy) with half-size h into the clip cube.
// Column-major: scale on the diagonal, translation in the last COLUMN (rows 0..2 of column 3).
function boxMatrix(cx, cy, h) {
    const s = 1 / h;
    return [
        s, 0, 0, 0,   // column 0
        0, s, 0, 0,   // column 1
        0, 0, s, 0,   // column 2
        -cx * s, -cy * s, 0, 1 // column 3: translation
    ];
}

// project(lat, lng) → [x, y]. Identity projector: scene XY == [lng, lat].
const idProject = (lat, lng) => [lng, lat];

const polygon = (coords) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } });
// A small square footprint (in lng/lat) centred at (x,y).
const squareAt = (x, y, r = 0.2) => polygon([
    [x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r]
]);

describe('frustumPlanes', () => {
    it('returns six normalized planes for the identity (clip cube)', () => {
        const planes = frustumPlanes(IDENTITY);
        expect(planes).toHaveLength(6);
        planes.forEach(p => {
            expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 9);
        });
    });

    it('returns null for a missing or short matrix', () => {
        expect(frustumPlanes(null)).toBeNull();
        expect(frustumPlanes([1, 2, 3])).toBeNull();
    });
});

describe('pointInsidePlanes (identity = clip cube [-1,1]^3)', () => {
    const planes = frustumPlanes(IDENTITY);
    it('accepts the origin and rejects points outside the cube', () => {
        expect(pointInsidePlanes(planes, 0, 0, 0)).toBe(true);
        expect(pointInsidePlanes(planes, 0.9, 0.9, 0.5)).toBe(true);
        expect(pointInsidePlanes(planes, 2, 0, 0)).toBe(false);   // past the right plane
        expect(pointInsidePlanes(planes, 0, -2, 0)).toBe(false);  // past the bottom plane
        expect(pointInsidePlanes(planes, 0, 0, 5)).toBe(false);   // past the far plane
    });

    it('honours the margin at the boundary', () => {
        // x = 1.05 is just outside the right plane (x ≤ 1); a 0.1 margin lets it in.
        expect(pointInsidePlanes(planes, 1.05, 0, 0, 0)).toBe(false);
        expect(pointInsidePlanes(planes, 1.05, 0, 0, 0.1)).toBe(true);
    });
});

describe('geometryRings', () => {
    it('extracts rings for Polygon and MultiPolygon', () => {
        expect(geometryRings({ type: 'Polygon', coordinates: [[[0, 0]]] })).toHaveLength(1);
        expect(geometryRings({
            type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[1, 1]]]]
        })).toHaveLength(2);
    });
    it('tolerates LineString and rejects the rest', () => {
        expect(geometryRings({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toHaveLength(1);
        expect(geometryRings({ type: 'Point', coordinates: [0, 0] })).toEqual([]);
        expect(geometryRings(null)).toEqual([]);
    });
});

describe('proposalsInView', () => {
    it('keeps a proposal in frame and drops one to the side', () => {
        // Camera framing the world box around (10,10), half-size 2 → sees lng/lat in [8,12].
        const elements = boxMatrix(10, 10, 2);
        const proposals = [
            { id: 'in', features: [squareAt(10, 10)] },   // dead centre
            { id: 'out', features: [squareAt(50, 50)] }   // far off to the side
        ];
        const result = proposalsInView(proposals, { elements, project: idProject });
        expect(result).toEqual(['in']);
    });

    it('catches a long road crossing the frame whose raw vertices are all outside it (densify)', () => {
        // A thin horizontal sliver from x=-5 to x=5 at y=0; the frame is the clip cube [-1,1].
        // Both end vertices sit far outside, but the road passes straight through the middle.
        const road = polygon([
            [-5, -0.02], [5, -0.02], [5, 0.02], [-5, 0.02], [-5, -0.02]
        ]);
        // densifyM in this test's tiny lng/lat units (the app's default 12 is metre-scale).
        const withDensify = proposalsInView([{ id: 'road', features: [road] }],
            { elements: IDENTITY, project: idProject, densifyM: 1 });
        expect(withDensify).toEqual(['road']);
        // With densification disabled, only the (outside) raw vertices are tested → missed.
        const noDensify = proposalsInView([{ id: 'road', features: [road] }],
            { elements: IDENTITY, project: idProject, densifyM: 0, marginM: 0 });
        expect(noDensify).toEqual([]);
    });

    it('returns an empty array when nothing is in frame (caller decides the fallback)', () => {
        const elements = boxMatrix(0, 0, 1);
        const result = proposalsInView([{ id: 'far', features: [squareAt(1000, 1000)] }],
            { elements, project: idProject });
        expect(result).toEqual([]);
    });

    it('returns null when the frustum cannot be built or no projector is given', () => {
        expect(proposalsInView([{ id: 'a', features: [squareAt(0, 0)] }],
            { elements: null, project: idProject })).toBeNull();
        expect(proposalsInView([{ id: 'a', features: [squareAt(0, 0)] }],
            { elements: IDENTITY, project: 'not-a-fn' })).toBeNull();
    });

    it('ignores proposals with no usable features instead of throwing', () => {
        const elements = boxMatrix(0, 0, 5);
        const result = proposalsInView([
            { id: 'empty', features: [] },
            { id: 'null-geom', features: [{ type: 'Feature', geometry: null }] },
            { id: 'good', features: [squareAt(0, 0)] }
        ], { elements, project: idProject });
        expect(result).toEqual(['good']);
    });

    it('skips proposals without an id', () => {
        const elements = boxMatrix(0, 0, 5);
        const result = proposalsInView([
            { features: [squareAt(0, 0)] },
            { id: 0, features: [squareAt(0, 0)] } // id 0 is valid (not null)
        ], { elements, project: idProject });
        expect(result).toEqual([0]);
    });
});

describe('featuresInFrustum height levels', () => {
    it('can catch a footprint only in view at an elevated z-level', () => {
        // A frustum shifted up in z so the ground (z=0) is out but a rooftop (z=10) is in.
        // Column-major: put the near/far window at z in roughly [9,11] by translating z.
        const planes = frustumPlanes([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, -10, 1 // shift world -10 in z into clip → clip z=0 corresponds to world z=10
        ]);
        const project = idProject;
        const feat = [squareAt(0, 0)];
        expect(featuresInFrustum(feat, planes, project, { zLevels: [0] })).toBe(false);
        expect(featuresInFrustum(feat, planes, project, { zLevels: [0, 10] })).toBe(true);
    });
});
