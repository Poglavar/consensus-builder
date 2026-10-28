// The centre lines of a road placed into a parcel (frontend/js/proposals/corridor-site-centreline.js,
// docs/road-in-parcel.md): straight streets read from facing kerbs, crossings shared as nodes, each
// arm's room the narrowest part it runs along, squares flagged and curves refused.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Centreline = require('../../frontend/js/proposals/corridor-site-centreline.js');

const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const turn = (ring, degrees) => {
    const t = degrees * Math.PI / 180;
    return ring.map(([x, y]) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)]);
};
const read = rings => Centreline.streetGraphOfRings(rings);
const close = (point, expected, digits = 6) => {
    expect(point[0]).toBeCloseTo(expected[0], digits);
    expect(point[1]).toBeCloseTo(expected[1], digits);
};

describe('streetGraphOfRings', () => {
    it('reads a strip as one street along its middle, as wide as the strip', () => {
        const graph = read([box(0, 0, 100, 12)]);
        expect(graph.issues).toEqual([]);
        expect(graph.lines).toHaveLength(1);
        close(graph.lines[0].points[0], [0, 6]);
        close(graph.lines[0].points[1], [100, 6]);
        expect(graph.lines[0].arms[0].widthM).toBeCloseTo(12, 6);
    });

    it('reads a strip at any angle', () => {
        const graph = read([turn(box(0, 0, 100, 12), 30)]);
        expect(graph.lines).toHaveLength(1);
        const [a, b] = graph.lines[0].points;
        close(a, turn([[0, 6]], 30)[0]);
        close(b, turn([[100, 6]], 30)[0]);
        expect(graph.lines[0].arms[0].widthM).toBeCloseTo(12, 6);
    });

    it('meets an L at one corner node both streets carry', () => {
        const graph = read([[[0, 0], [100, 0], [100, 80], [88, 80], [88, 12], [0, 12]]]);
        expect(graph.lines).toHaveLength(2);
        const ends = graph.lines.flatMap(line => [line.points[0], line.points[line.points.length - 1]]);
        expect(ends.filter(p => Math.abs(p[0] - 94) < 1e-6 && Math.abs(p[1] - 6) < 1e-6)).toHaveLength(2);
        expect(graph.nodes).toHaveLength(1);
    });

    it('runs the stem of a T on to the centre of the street it meets', () => {
        const graph = read([[[0, 0], [100, 0], [100, 12], [56, 12], [56, 80], [44, 80], [44, 12], [0, 12]]]);
        const through = graph.lines.find(line => line.axis === 'x');
        const stem = graph.lines.find(line => line.axis === 'y');
        expect(through.points).toHaveLength(3);
        close(through.points[1], [50, 6]);
        close(stem.points[0], [50, 6]);
        close(stem.points[1], [50, 80]);
        expect(through.nodeKeys[1]).toBe(stem.nodeKeys[0]);
    });

    it('reads a grid with blocks as holes: every street through every crossing, crossings shared', () => {
        const holes = [];
        for (const [x0, x1] of [[12, 120], [132, 240]]) for (const [y0, y1] of [[12, 120], [132, 240]]) holes.push(box(x0, y0, x1, y1).reverse());
        const graph = read([box(0, 0, 252, 252), ...holes]);
        expect(graph.issues).toEqual([]);
        expect(graph.lines).toHaveLength(6);
        expect(graph.nodes).toHaveLength(9);
        graph.lines.forEach(line => {
            expect(line.points).toHaveLength(3);
            line.arms.forEach(arm => expect(arm.widthM).toBeCloseTo(12, 6));
        });
        const keys = graph.lines.flatMap(line => line.nodeKeys);
        expect(new Set(keys).size).toBe(9);
    });

    it('fits a notch: the street keeps to the band all of it shares', () => {
        const graph = read([[[0, 0], [100, 0], [100, 12], [60, 12], [60, 9], [40, 9], [40, 12], [0, 12]]]);
        expect(graph.lines).toHaveLength(1);
        close(graph.lines[0].points[0], [0, 4.5]);
        expect(graph.lines[0].arms[0].widthM).toBeCloseTo(9, 6);
    });

    it('flags a lone square, whose street could run either way, and turns it on request', () => {
        const graph = read([box(0, 0, 50, 52)]);
        expect(graph.issues).toEqual([{ code: 'square' }]);
        expect(graph.lines[0].axis).toBe('y');
        const turned = Centreline.streetGraphOfRings([box(0, 0, 50, 52)], { turn: true });
        expect(turned.lines[0].axis).toBe('x');
        expect(turned.lines[0].arms[0].widthM).toBeCloseTo(52, 6);
    });

    it('reads a short wide rectangle along its length', () => {
        const graph = read([box(0, 0, 50, 90)]);
        expect(graph.issues).toEqual([]);
        expect(graph.lines[0].axis).toBe('y');
        expect(graph.lines[0].arms[0].widthM).toBeCloseTo(50, 6);
    });

    it('reads the streets of a real layout remainder whose oblique pool edges outweigh no kerb', () => {
        // A Schelling layout's street strips over cadastral parcel HR-339164-2930 (metres): a 12 m
        // grid crossing, ragged where the parcel's boundary cuts it at an angle.
        const ring = [[-66.3, 63.9], [-54.8, 58.4], [-57.9, 51.9], [38.6, 51.9], [38.6, -51.9], [-43.4, -51.9], [-43.4, -51.7], [-45.2, -55.4], [-27.1, -63.9], [31.1, -63.9], [38.5, -59.8], [66.3, -51.9], [50.7, -51.9], [50.7, 51.9], [64.3, 51.9], [56.2, 54.3], [46, 57.1], [31, 63.9], [-16, 63.9], [-21.4, 52.4], [-23.9, 53.6], [-27.3, 55.2], [-34.8, 58.7], [-37.4, 60], [-37.7, 60.1], [-41.1, 61.8], [-45.4, 63.9], [-66.3, 63.9]];
        const graph = read([ring]);
        expect(Math.abs(graph.theta)).toBeLessThan(1e-6);
        expect(graph.issues).toEqual([]);
        expect(graph.lines.map(line => line.axis).sort()).toEqual(['x', 'x', 'y']);
        graph.lines.forEach(line => line.arms.forEach(arm => expect(arm.widthM).toBeCloseTo(12, 0)));
    });

    it('refuses a lone rectangle too wide to be a street (a block)', () => {
        expect(read([box(0, 0, 150, 100)]).issues[0].code).toBe('not-a-grid');
    });

    it('refuses a curved strip', () => {
        const arc = [];
        for (let k = 0; k <= 20; k += 1) { const t = k / 20 * Math.PI / 2; arc.push([100 * Math.cos(t), 100 * Math.sin(t)]); }
        for (let k = 20; k >= 0; k -= 1) { const t = k / 20 * Math.PI / 2; arc.push([88 * Math.cos(t), 88 * Math.sin(t)]); }
        const graph = read([arc]);
        expect(graph.issues[0].code).toBe('not-a-grid');
        expect(graph.lines).toEqual([]);
    });
});
