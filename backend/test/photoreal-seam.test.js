// Unit tests for exact streamed-mesh intersections used to cap photoreal carve boundaries.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    maskEdgeContract,
    intersectTriangleWithVerticalSegment,
    buildSeamFasciaQuads,
    triangleDoubleArea,
    densifyClosedRing,
    buildSegmentGrid,
    querySegmentGrid
} = require('../../frontend/js/photoreal-seam.js');

describe('photoreal mask edge ownership', () => {
    it('converts the complete nearest-texel uncertainty band into a true-metre buffer', () => {
        const contract = maskEdgeContract(512, 2048, 1.43477, 0.1);

        expect(contract.texelSceneM).toBeCloseTo(0.5, 12);
        expect(contract.halfDiagonalSceneM).toBeCloseTo(Math.SQRT1_2 * 0.5, 12);
        expect(contract.ownershipSceneM).toBeCloseTo(contract.halfDiagonalSceneM + 0.1, 12);
        expect(contract.bufferTrueM * 1.43477).toBeCloseTo(contract.ownershipSceneM, 12);
        expect(contract.retainedOverlapSceneM).toBeGreaterThanOrEqual(contract.halfDiagonalSceneM + 0.1);
        expect(contract.inwardWidthSceneM).toBe(contract.ownershipSceneM);
    });
});

function sortedEndpoints(hit) {
    return [hit.start.position, hit.end.position].sort((a, b) => a[1] - b[1] || a[2] - b[2]);
}

describe('photoreal seam intersection', () => {
    it('returns the exact sloped-surface cut and barycentric coordinates', () => {
        const triangle = [[0, 0, 0], [1, 0, 1], [0, 1, 2]];
        const hit = intersectTriangleWithVerticalSegment(triangle, { a: [0.5, -1], b: [0.5, 2] });
        const endpoints = sortedEndpoints(hit);

        expect(endpoints[0]).toEqual([0.5, 0, 0.5]);
        expect(endpoints[1]).toEqual([0.5, 0.5, 1.5]);
        for (const endpoint of [hit.start, hit.end]) {
            expect(endpoint.barycentric.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
        }
    });

    it('captures a vertical facade instead of relying on an XY heightfield', () => {
        const triangle = [[0, 0, 0], [1, 0, 0], [0, 0, 10]];
        const hit = intersectTriangleWithVerticalSegment(triangle, { a: [0.5, -1], b: [0.5, 1] });
        const heights = [hit.start.position[2], hit.end.position[2]].sort((a, b) => a - b);

        expect(heights[0]).toBeCloseTo(0, 12);
        expect(heights[1]).toBeCloseTo(5, 12);
    });

    it('builds a non-degenerate cross-plane fascia for a vertical facade hit', () => {
        const triangle = [[0, 0, 0], [1, 0, 0], [0, 0, 10]];
        const segment = { a: [0.5, -1], b: [0.5, 1], inward: [-1, 0] };
        const hit = intersectTriangleWithVerticalSegment(triangle, segment);
        const quads = buildSeamFasciaQuads(hit, segment, {
            bottomAt: () => 0,
            retainedOverlapM: 0.5,
            inwardWidthM: 0.8,
            inwardTopOffsetM: 0.04
        });
        const across = quads.find(quad => quad.kind === 'across');

        expect(across).toBeTruthy();
        expect(triangleDoubleArea(across.vertices[0], across.vertices[1], across.vertices[2])).toBeGreaterThan(0);
        expect(across.vertices.flat().every(Number.isFinite)).toBe(true);
        expect(across.vertices[0][0]).toBeCloseTo(1, 12);
        expect(across.vertices[1][0]).toBeCloseTo(-0.3, 12);
    });

    it('extends a horizontal roof cut down to the local road formation', () => {
        const triangle = [[0, 0, 8], [1, 0, 8], [0, 1, 8]];
        const segment = { a: [0.5, -1], b: [0.5, 2], inward: [-1, 0] };
        const hit = intersectTriangleWithVerticalSegment(triangle, segment);
        const down = buildSeamFasciaQuads(hit, segment, { bottomAt: () => -1.25 })
            .find(quad => quad.kind === 'down');

        expect(down).toBeTruthy();
        expect(Math.min(...down.vertices.map(vertex => vertex[2]))).toBeCloseTo(-1.25, 12);
        expect(triangleDoubleArea(down.vertices[0], down.vertices[1], down.vertices[2])).toBeGreaterThan(0);
    });

    it('keeps the inward source-textured flange below the replacement road surface', () => {
        const triangle = [[0, 0, 8], [1, 0, 8], [0, 1, 8]];
        const segment = { a: [0.5, -1], b: [0.5, 2], inward: [-1, 0] };
        const hit = intersectTriangleWithVerticalSegment(triangle, segment);
        const across = buildSeamFasciaQuads(hit, segment, {
            bottomAt: () => 1,
            retainedOverlapM: 0.45,
            inwardWidthM: 0.8,
            inwardTopOffsetM: 0.04
        }).find(quad => quad.kind === 'across');

        expect(across).toBeTruthy();
        const inward = across.vertices.filter(vertex => vertex[0] < 0);
        const retained = across.vertices.filter(vertex => vertex[0] > 0.5);
        expect(inward).toHaveLength(2);
        expect(inward.every(vertex => vertex[2] <= 1.04 + 1e-9)).toBe(true);
        expect(retained.every(vertex => vertex[2] === 8)).toBe(true);
    });

    it('can bury both sides of the cosmetic flange below a continuous foundation', () => {
        const triangle = [[0, 0, 8], [1, 0, 8], [0, 1, 8]];
        const segment = { a: [0.5, -1], b: [0.5, 2], inward: [-1, 0] };
        const hit = intersectTriangleWithVerticalSegment(triangle, segment);
        const across = buildSeamFasciaQuads(hit, segment, {
            bottomAt: () => 1,
            retainedOverlapM: 0.45,
            inwardWidthM: 0.8,
            retainedTopOffsetM: 0.03,
            inwardTopOffsetM: 0.03
        }).find(quad => quad.kind === 'across');

        expect(across).toBeTruthy();
        expect(across.vertices.every(vertex => vertex[2] <= 1.03 + 1e-9)).toBe(true);
    });

    it('clips the plane intersection to the finite proposal boundary edge', () => {
        const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
        expect(intersectTriangleWithVerticalSegment(triangle, { a: [0.5, 2], b: [0.5, 3] })).toBeNull();
    });
});

describe('photoreal seam segment grid', () => {
    it('returns only nearby boundary segments and de-duplicates multi-cell edges', () => {
        const near = { a: [0, 0], b: [30, 0], name: 'near' };
        const far = { a: [200, 200], b: [210, 210], name: 'far' };
        const grid = buildSegmentGrid([near, far], 10);

        expect(querySegmentGrid(grid, { minX: 5, minY: -1, maxX: 25, maxY: 1 }).map(s => s.name)).toEqual(['near']);
        expect(querySegmentGrid(grid, { minX: 500, minY: 500, maxX: 510, maxY: 510 })).toEqual([]);
    });
});

describe('photoreal road boundary sampling', () => {
    it('closes sparse rings and limits every curtain/seam edge to the requested spacing', () => {
        const dense = densifyClosedRing([[0, 0], [10, 0], [10, 5]], 4);

        expect(dense[0]).toEqual(dense.at(-1));
        expect(dense).toContainEqual([10, 0]);
        for (let i = 1; i < dense.length; i++) {
            expect(Math.hypot(
                dense[i][0] - dense[i - 1][0],
                dense[i][1] - dense[i - 1][1]
            )).toBeLessThanOrEqual(4 + 1e-9);
        }
    });
});
