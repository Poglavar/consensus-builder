// Ground geometry (frontend/js/life/ground-geometry.js): ribbon width and winding, mitred and
// rounded bends, junction discs versus dead ends, the pavement plane and degenerate input.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroundGeometry, ribbonEdges, MITRE_LIMIT, DISC_SEGMENTS } = require('../../frontend/js/life/ground-geometry.js');

const P = (part, i) => [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]];
function triangleArea2(part, t) {
    const [a, b, c] = [P(part, part.indices[t * 3]), P(part, part.indices[t * 3 + 1]), P(part, part.indices[t * 3 + 2])];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
const totalArea = part => { let s = 0; for (let t = 0; t < part.triangles; t++) s += triangleArea2(part, t) / 2; return s; };
const build = (carriageways, bounds = null) => buildGroundGeometry({ carriageways, bounds });
const hasVertex = (part, x, y) => {
    for (let i = 0; i < part.positions.length; i += 3) {
        if (Math.abs(part.positions[i] - x) < 1e-5 && Math.abs(part.positions[i + 1] - y) < 1e-5) return true;
    }
    return false;
};

describe('roadbed ribbons', () => {
    it('lays a straight carriageway as one quad of length × width', () => {
        const { roadbed, stats } = build([{ pts: [[0, 0], [100, 0]], halfWidth: 3.5 }]);
        expect(roadbed.triangles).toBe(2);
        expect(totalArea(roadbed)).toBeCloseTo(700, 6);
        expect(stats.roadAreaM2).toBe(700);
        expect(stats.junctions).toBe(0);
    });

    it('winds every triangle counter-clockwise, also through a sharp inner bend', () => {
        const { roadbed } = build([{ pts: [[0, 0], [20, 0], [20.5, 4], [0, 4]], halfWidth: 3 }]);
        for (let t = 0; t < roadbed.triangles; t++) expect(triangleArea2(roadbed, t)).toBeGreaterThan(0);
    });

    it('keeps the width through a right-angle bend with a sharp mitre', () => {
        const { left, right, capped } = ribbonEdges([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2);
        expect(capped).toEqual([]);
        // Travelling +x then +y is a left turn: the left edge is the inside corner, the right the outside.
        expect(left[1][0]).toBeCloseTo(8, 9); expect(left[1][1]).toBeCloseTo(2, 9);
        expect(right[1][0]).toBeCloseTo(12, 9); expect(right[1][1]).toBeCloseTo(-2, 9);
    });

    it('caps a hairpin mitre and rounds that vertex with a disc', () => {
        const pts = [[0, 0], [10, 0], [0, 1]];
        const edges = ribbonEdges(pts.map(p => [p[0], p[1], 0]), 2);
        expect(edges.capped).toEqual([1]);
        expect(Math.hypot(edges.left[1][0] - 10, edges.left[1][1])).toBeCloseTo(2 * MITRE_LIMIT, 6);
        const { roadbed, stats } = build([{ pts, halfWidth: 2 }]);
        expect(stats.roundedBends).toBe(1);
        expect(roadbed.triangles).toBeGreaterThanOrEqual(4 + DISC_SEGMENTS - 1);
        for (let i = 0; i < roadbed.positions.length; i++) expect(Number.isFinite(roadbed.positions[i])).toBe(true);
    });

    it('carries the centreline z onto the ribbon', () => {
        const { roadbed } = build([{ pts: [[0, 0, 4], [10, 0, 6]], halfWidth: 1 }]);
        const zs = Array.from({ length: roadbed.positions.length / 3 }, (_, i) => roadbed.positions[i * 3 + 2]).sort();
        expect(zs).toEqual([4, 4, 6, 6]);
    });
});

describe('junctions', () => {
    it('fills a T junction with a disc as wide as the widest way, once per node', () => {
        const through = { pts: [[-50, 0], [0, 0], [50, 0]], halfWidth: 5 };
        const side = { pts: [[0, 0], [0, 40]], halfWidth: 2.5 };
        const other = { pts: [[0, -40], [0, 0]], halfWidth: 2.5 };
        const { roadbed, stats } = build([through, side, other]);
        expect(stats.junctions).toBe(1);
        // 2 + 1 + 1 quads and one disc.
        expect(roadbed.triangles).toBe(8 + DISC_SEGMENTS);
        // A rim vertex one disc step round sits at the widest way's half-width, not the side way's.
        const step = (2 * Math.PI) / DISC_SEGMENTS;
        expect(hasVertex(roadbed, 5 * Math.cos(step), 5 * Math.sin(step))).toBe(true);
        expect(hasVertex(roadbed, 2.5 * Math.cos(step), 2.5 * Math.sin(step))).toBe(false);
    });

    it('snaps vertices within half a metre into one junction and leaves dead ends square', () => {
        const { stats } = build([
            { pts: [[0, 0], [50, 0], [100, 0]], halfWidth: 3 },
            { pts: [[50.2, 0.2], [50, 60]], halfWidth: 3 },
            { pts: [[200, 0], [300, 0]], halfWidth: 3 }
        ]);
        expect(stats.junctions).toBe(1);
        expect(stats.ways).toBe(3);
    });

    it('needs no disc where two ways cross through a shared interior vertex', () => {
        const { roadbed, stats } = build([
            { pts: [[-50, 0], [0, 0], [50, 0]], halfWidth: 3 },
            { pts: [[0, -50], [0, 0], [0, 50]], halfWidth: 3 }
        ]);
        expect(stats.junctions).toBe(0);
        expect(roadbed.triangles).toBe(8);
    });
});

describe('pavement plane and input hygiene', () => {
    it('spans the bounds as two triangles at z 0', () => {
        const { plane, stats } = build([], [-100, -50, 100, 50]);
        expect(plane.triangles).toBe(2);
        expect(totalArea(plane)).toBeCloseTo(200 * 100, 6);
        expect(Array.from(plane.positions).filter((_, i) => i % 3 === 2)).toEqual([0, 0, 0, 0]);
        expect(stats.triangles).toBe(2);
    });

    it('makes no plane without valid bounds and no roadbed from degenerate ways', () => {
        const { plane, roadbed, stats } = build([
            { pts: [[0, 0], [0.001, 0]], halfWidth: 3 },
            { pts: [[0, 0], [10, 0]], halfWidth: 0 },
            { pts: [[NaN, 0], [10, 0]], halfWidth: 3 },
            null
        ], [0, 0, 0, 10]);
        expect(plane).toBeNull();
        expect(roadbed.triangles).toBe(0);
        expect(stats.ways).toBe(0);
    });

    it('uploads typed arrays', () => {
        const { roadbed } = build([{ pts: [[0, 0], [10, 0]], halfWidth: 1 }]);
        expect(roadbed.positions).toBeInstanceOf(Float32Array);
        expect(roadbed.indices).toBeInstanceOf(Uint32Array);
    });
});
