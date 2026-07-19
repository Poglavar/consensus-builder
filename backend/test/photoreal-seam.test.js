// Unit tests for exact streamed-mesh intersections used to cap photoreal carve boundaries.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    intersectTriangleWithVerticalSegment,
    buildSegmentGrid,
    querySegmentGrid
} = require('../../frontend/js/photoreal-seam.js');

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
