// Ground geometry (frontend/js/life/ground-geometry.js): ribbon width and winding, mitred and
// rounded bends, junction discs versus dead ends, the sunk roadbed with its lid and kerb walls,
// junction openings in the kerb, the pavement plane and degenerate input.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroundGeometry, ribbonEdges, splitAtSharpBends, MITRE_LIMIT, DISC_SEGMENTS } = require('../../frontend/js/life/ground-geometry.js');

const P = (part, i) => [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]];
function triangleArea2(part, t) {
    const [a, b, c] = [P(part, part.indices[t * 3]), P(part, part.indices[t * 3 + 1]), P(part, part.indices[t * 3 + 2])];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
const totalArea = part => { let s = 0; for (let t = 0; t < part.triangles; t++) s += triangleArea2(part, t) / 2; return s; };
const build = (carriageways, bounds = null) => buildGroundGeometry({ carriageways, bounds });
const hasVertex = (part, x, y, z = null) => {
    for (let i = 0; i < part.positions.length; i += 3) {
        if (Math.abs(part.positions[i] - x) < 1e-5 && Math.abs(part.positions[i + 1] - y) < 1e-5 && (z === null || Math.abs(part.positions[i + 2] - z) < 1e-5)) return true;
    }
    return false;
};
const zs = part => Array.from({ length: part.positions.length / 3 }, (_, i) => part.positions[i * 3 + 2]);
// Kerb walls as { a, b, height } from the four vertices each quad uploads (a bottom, b bottom, b top, a top).
const walls = kerb => Array.from({ length: kerb.positions.length / 12 }, (_, q) => {
    const a = P(kerb, q * 4), b = P(kerb, q * 4 + 1), top = P(kerb, q * 4 + 2);
    return { a, b, height: top[2] - b[2], length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
});
const along = (list, axis, value) => list.filter(w => Math.abs(w.a[axis] - value) < 1e-6 && Math.abs(w.b[axis] - value) < 1e-6);
const sumLength = list => list.reduce((s, w) => s + w.length, 0);

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

    it('caps a hairpin mitre, splits the ribbon there and rounds the bend with a disc', () => {
        const pts = [[0, 0, 0], [10, 0, 0], [0, 1, 0]];
        const edges = ribbonEdges(pts, 2);
        expect(edges.capped).toEqual([1]);
        expect(Math.hypot(edges.left[1][0] - 10, edges.left[1][1])).toBeCloseTo(2 * MITRE_LIMIT, 6);
        const { pieces, bends } = splitAtSharpBends(pts, 2);
        expect(pieces).toEqual([[[0, 0, 0], [10, 0, 0]], [[10, 0, 0], [0, 1, 0]]]);
        expect(bends).toEqual([[10, 0, 0]]);
        const { roadbed, stats } = build([{ pts, halfWidth: 2 }]);
        expect(stats.roundedBends).toBe(1);
        expect(roadbed.triangles).toBe(4 + DISC_SEGMENTS);
        // The first leg keeps its full width right up to the bend instead of pinching to the centreline.
        expect(hasVertex(roadbed, 10, -2)).toBe(true);
        expect(hasVertex(roadbed, 10, 2)).toBe(true);
        for (let i = 0; i < roadbed.positions.length; i++) expect(Number.isFinite(roadbed.positions[i])).toBe(true);
    });

    it('carries the centreline z onto the ribbon', () => {
        const { roadbed } = build([{ pts: [[0, 0, 4], [10, 0, 6]], halfWidth: 1 }]);
        expect(zs(roadbed).sort()).toEqual([4, 4, 6, 6]);
    });
});

describe('sunk roadbed, lid and kerb', () => {
    const straight = () => build([{ pts: [[0, 0], [100, 0]], halfWidth: 3.5, drop: 0.15 }]);

    it('sinks the asphalt by the drop and keeps the lid at pavement level on the same triangles', () => {
        const { roadbed, lid } = straight();
        expect(zs(roadbed).every(z => Math.abs(z + 0.15) < 1e-6)).toBe(true);
        expect(zs(lid).every(z => z === 0)).toBe(true);
        expect(lid.indices).toBe(roadbed.indices);
        expect(lid.triangles).toBe(roadbed.triangles);
        for (let i = 0; i < lid.positions.length; i += 3) {
            expect(lid.positions[i]).toBe(roadbed.positions[i]);
            expect(lid.positions[i + 1]).toBe(roadbed.positions[i + 1]);
        }
    });

    it('walls a straight street on both sides and across its dead ends, kerb high, normals horizontal', () => {
        const { kerb, stats } = straight();
        const list = walls(kerb);
        expect(list).toHaveLength(4);
        expect(sumLength(along(list, 1, 3.5))).toBeCloseTo(100, 6);
        expect(sumLength(along(list, 1, -3.5))).toBeCloseTo(100, 6);
        expect(sumLength(along(list, 0, 0))).toBeCloseTo(7, 6);
        expect(sumLength(along(list, 0, 100))).toBeCloseTo(7, 6);
        list.forEach(w => { expect(w.height).toBeCloseTo(0.15, 6); expect(w.a[2]).toBeCloseTo(-0.15, 6); });
        expect(stats.kerbM).toBe(214);
        expect(stats.kerbTriangles).toBe(8);
        for (let i = 0; i < kerb.normals.length; i += 3) {
            expect(kerb.normals[i + 2]).toBe(0);
            expect(Math.hypot(kerb.normals[i], kerb.normals[i + 1])).toBeCloseTo(1, 9);
        }
    });

    it('makes no kerb and no sinking without a drop', () => {
        const { roadbed, kerb, stats } = build([{ pts: [[0, 0], [100, 0]], halfWidth: 3.5 }]);
        expect(zs(roadbed).every(z => z === 0)).toBe(true);
        expect(kerb.triangles).toBe(0);
        expect(stats.kerbM).toBe(0);
    });

    it('opens the main street kerb exactly across a side street and starts the side kerb at the main edge', () => {
        const through = { pts: [[-50, 0], [0, 0], [50, 0]], halfWidth: 5, drop: 0.15 };
        const side = { pts: [[0, 0], [0, 40]], halfWidth: 2.5, drop: 0.15 };
        const { kerb, stats } = build([through, side]);
        const list = walls(kerb);
        // North kerb of the main street: two runs that stop within a few cm of the side street's edges.
        const north = along(list, 1, 5);
        expect(north).toHaveLength(2);
        north.forEach(w => expect(Math.min(w.a[0], w.b[0]) >= 2.4 || Math.max(w.a[0], w.b[0]) <= -2.4).toBe(true));
        expect(Math.max(...north.map(w => Math.min(w.a[0], w.b[0])))).toBeCloseTo(2.5, 1);
        expect(Math.min(...north.map(w => Math.max(w.a[0], w.b[0])))).toBeCloseTo(-2.5, 1);
        expect(sumLength(north)).toBeCloseTo(95, 0);
        // South kerb untouched, dead-end caps on all three free ends.
        expect(sumLength(along(list, 1, -5))).toBeCloseTo(100, 6);
        expect(sumLength(along(list, 0, -50))).toBeCloseTo(10, 6);
        expect(sumLength(along(list, 0, 50))).toBeCloseTo(10, 6);
        expect(sumLength(along(list, 1, 40))).toBeCloseTo(5, 6);
        // The side street's kerbs begin at the main street's north edge, not at the centreline.
        [2.5, -2.5].forEach(x => {
            const run = along(list, 0, x);
            expect(run).toHaveLength(1);
            expect(Math.min(run[0].a[1], run[0].b[1])).toBeCloseTo(5, 1);
            expect(Math.max(run[0].a[1], run[0].b[1])).toBeCloseTo(40, 6);
        });
        expect(stats.kerbM).toBeGreaterThan(285);
        expect(stats.kerbM).toBeLessThan(295);
    });

    it('kerbs the rounded outside of a hairpin and sinks a junction disc to the deepest way there', () => {
        const hairpin = build([{ pts: [[0, 0], [10, 0], [0, 1]], halfWidth: 2, drop: 0.15 }]);
        const rim = walls(hairpin.kerb).filter(w => (w.a[0] + w.b[0]) / 2 > 10.5);
        expect(rim.length).toBeGreaterThan(3);
        rim.forEach(w => expect(w.a[2]).toBeCloseTo(-0.15, 6));

        const mixed = build([
            { pts: [[-50, 0], [0, 0], [50, 0]], halfWidth: 5, drop: 0.15 },
            { pts: [[0, 0], [0, 40]], halfWidth: 2.5 }
        ]);
        expect(mixed.stats.junctions).toBe(1);
        expect(hasVertex(mixed.roadbed, 0, 0, -0.15)).toBe(true);   // the disc centre
        expect(hasVertex(mixed.roadbed, 2.5, 40, 0)).toBe(true);    // the flush side street
        // The flush side street has no kerb of its own but still opens the main street's.
        expect(along(walls(mixed.kerb), 0, 2.5)).toHaveLength(0);
        expect(along(walls(mixed.kerb), 1, 5)).toHaveLength(2);
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
        const { plane, roadbed, kerb, stats } = build([
            { pts: [[0, 0], [0.001, 0]], halfWidth: 3 },
            { pts: [[0, 0], [10, 0]], halfWidth: 0 },
            { pts: [[NaN, 0], [10, 0]], halfWidth: 3 },
            null
        ], [0, 0, 0, 10]);
        expect(plane).toBeNull();
        expect(roadbed.triangles).toBe(0);
        expect(kerb.triangles).toBe(0);
        expect(stats.ways).toBe(0);
    });

    it('uploads typed arrays', () => {
        const { roadbed, lid, kerb } = build([{ pts: [[0, 0], [10, 0]], halfWidth: 1, drop: 0.1 }]);
        expect(roadbed.positions).toBeInstanceOf(Float32Array);
        expect(roadbed.indices).toBeInstanceOf(Uint32Array);
        expect(lid.positions).toBeInstanceOf(Float32Array);
        expect(kerb.positions).toBeInstanceOf(Float32Array);
        expect(kerb.normals).toBeInstanceOf(Float32Array);
        expect(kerb.indices).toBeInstanceOf(Uint32Array);
    });
});
