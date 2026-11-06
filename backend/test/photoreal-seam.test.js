// Unit tests for exact streamed-mesh intersections used to cap photoreal carve boundaries.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createCoverageTest,
    maskEdgeContract,
    intersectTriangleWithVerticalSegment,
    buildSeamFasciaQuads,
    buildClearanceCurtainPositions,
    buildClearanceCurtainsSliced,
    ringFacingCut,
    triangleDoubleArea,
    densifyClosedRing,
    buildSegmentGrid,
    querySegmentGrid
} = require('../../frontend/js/photoreal-seam.js');
const { forEach } = require('../../frontend/js/three-scene-work.js');

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

describe('photoreal cut coverage owners', () => {
    it('names the cuts that contain every point, skipping the asking cut and holes', () => {
        const square = (x0, y0, size) => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];
        const coverage = createCoverageTest([
            { rings: [square(0, 0, 100), square(40, 40, 20)], owner: 0 }, // a park with a hole
            { rings: [square(10, 10, 20)], owner: 1 },                    // a plot in the park
            { rings: [square(12, 12, 5)], owner: 2 }                      // a building in the plot
        ]);
        const building = square(12, 12, 5);

        expect(coverage.ownersContainingAll(building, 2)).toEqual([0, 1]);
        expect(coverage.ownersContainingAll(square(45, 45, 5), undefined)).toEqual([]);
        expect(coverage.ownersContainingAll([[5, 5], [150, 5]], undefined)).toEqual([]);
    });
});

describe('photoreal road clearance curtain', () => {
    it('builds one anchored neutral wall beneath a high visible canopy', () => {
        const built = buildClearanceCurtainPositions(
            [[0, 0], [4, 0]],
            () => 1,
            () => 8,
            { bottomOffsetM: 0.03, minimumClearanceM: 0.5, topMarginM: 0.1 }
        );

        expect(built.segmentCount).toBe(1);
        expect(built.positions).toHaveLength(18);
        const heights = built.positions.filter((_, index) => index % 3 === 2);
        expect(Math.min(...heights)).toBeCloseTo(1.03, 12);
        expect(Math.max(...heights)).toBeCloseTo(8.1, 12);
    });

    it('emits no wall where visible ground is within the clearance threshold', () => {
        const built = buildClearanceCurtainPositions(
            [[0, 0], [4, 0]],
            () => 1,
            () => 1.4,
            { bottomOffsetM: 0.03, minimumClearanceM: 0.5 }
        );

        expect(built).toEqual({ positions: [], segmentCount: 0 });
    });

    it('refines a segment that meets a crown so the wall top follows it, not a straight line', () => {
        // Open ground up to x = 1, then a crown 8 m up: probes 4 m apart would ramp the top.
        const visibleAt = x => (x >= 1 ? 8 : 1);
        const topAt = (built, x) => {
            let best = -Infinity;
            for (let i = 0; i < built.positions.length; i += 3) {
                if (Math.abs(built.positions[i] - x) < 1e-9) best = Math.max(best, built.positions[i + 2]);
            }
            return best;
        };
        const coarse = buildClearanceCurtainPositions([[0, 0], [4, 0]], () => 1, visibleAt);
        const refined = buildClearanceCurtainPositions([[0, 0], [4, 0]], () => 1, visibleAt, { refineM: 0.5 });

        expect(topAt(coarse, 1)).toBe(-Infinity);
        expect(topAt(refined, 1)).toBeCloseTo(8.1, 12);
        // Open ground before the crown stays without a wall.
        expect(topAt(refined, 0.5)).toBeCloseTo(1.03, 12);
    });

    it('builds walls in slices that yield to the frame and match the one-shot build', async () => {
        const ring = [[0, 0], [4, 0], [8, 0], [8, 4]];
        const job = { ringXY: ring, supportAt: () => 1, visibleAt: x => (x >= 1 ? 8 : 1), options: { refineM: 0.5 } };
        let clock = 0, yields = 0;
        // Every probe costs 2 ms on this clock, so a 6 ms budget must yield between segments.
        const timed = { ...job, visibleAt: (x, y) => { clock += 2; return job.visibleAt(x, y); } };
        const results = await buildClearanceCurtainsSliced([timed], {
            forEach, budgetMs: 6, now: () => clock, yieldTask: async () => { yields += 1; }
        });

        expect(yields).toBeGreaterThan(0);
        expect(results[0]).toEqual(buildClearanceCurtainPositions(ring, job.supportAt, job.visibleAt, job.options));
    });

    it('abandons a sliced wall build that a newer rebuild has replaced', async () => {
        let current = true;
        const results = await buildClearanceCurtainsSliced(
            [{ ringXY: [[0, 0], [4, 0], [8, 0]], supportAt: () => 1, visibleAt: () => 8 }],
            { forEach, budgetMs: 1e-9, isCurrent: () => current, yieldTask: async () => { current = false; } }
        );

        expect(results).toBeNull();
    });

    it('orders a ring so its wall faces the cut, for an outer ring and a hole, either winding', () => {
        // Front faces follow three's counter-clockwise rule: normal = (v1 - v0) x (v2 - v0). Each
        // segment emits two triangles (18 numbers); the first one's normal is compared with the
        // direction from that segment's midpoint to the square's centre.
        const towardsCentre = positions => {
            const out = [];
            for (let q = 0; q < positions.length; q += 18) {
                const v = i => positions.slice(q + i * 3, q + i * 3 + 3);
                const [a, b, c] = [v(0), v(1), v(2)];
                const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2];
                const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
                out.push(nx * (5 - mx) + ny * (5 - my) > 0);
            }
            return out;
        };
        const ccw = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
        const cw = ccw.slice().reverse();
        const wall = ring => buildClearanceCurtainPositions(ring, () => 0, () => 8).positions;
        for (const ring of [ccw, cw]) {
            // Outer ring: the cut is inside it, so every wall faces the centre.
            expect(towardsCentre(wall(ringFacingCut(ring, false)))).toEqual([true, true, true, true]);
            // Hole: the cut is outside it, so every wall faces away from the centre.
            expect(towardsCentre(wall(ringFacingCut(ring, true)))).toEqual([false, false, false, false]);
        }
    });

    it('fails closed instead of inventing a wall without formation support', () => {
        const built = buildClearanceCurtainPositions(
            [[0, 0], [4, 0]],
            () => null,
            () => 12
        );

        expect(built).toEqual({ positions: [], segmentCount: 0 });
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

describe('createCoverageTest', () => {
    const square = (x0, y0, size) => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];

    it('finds the cut a point lies in, skipping the asking cut and holes', () => {
        const covered = createCoverageTest([
            { rings: [square(0, 0, 10)], owner: 0 },
            { rings: [square(10, 0, 10), square(13, 3, 4)], owner: 1 }
        ]);
        // A ring point of cut 0 that lies 1 m into its neighbour: covered by cut 1.
        expect(covered(11, 5, 0)).toBe(true);
        // A ring point that lies outside every other cut: retained Google mesh, so a wall is built.
        expect(covered(-1, 5, 0)).toBe(false);
        // Inside cut 0 only: not covered by any other cut.
        expect(covered(5, 5, 0)).toBe(false);
        // In the hole of cut 1.
        expect(covered(15, 5, 0)).toBe(false);
        expect(covered(5, 5)).toBe(true);
    });
});

