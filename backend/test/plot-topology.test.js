// plot-topology.js — a parcellation read as nodes and edges, so a shared boundary moves for
// every plot that touches it instead of tearing a gap between neighbours.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let topo;

beforeAll(() => {
    topo = require('../../frontend/js/proposals/plot-topology.js');
});

// Two plots sharing the vertical boundary x = 10:
//   left  (0,0)-(10,10)      right (10,0)-(20,10)
function plot(x0, y0, x1, y1) {
    return {
        geometry: {
            type: 'Polygon',
            coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
        }
    };
}

const LEFT = plot(0, 0, 10, 10);
const RIGHT = plot(10, 0, 20, 10);
const PAIR = [LEFT, RIGHT];

const ringOf = (geometries, i) => geometries[i].coordinates[0];
const has = (ring, x, y) => ring.some(c => Math.abs(c[0] - x) < 1e-9 && Math.abs(c[1] - y) < 1e-9);

describe('buildTopology', () => {
    it('finds the shared nodes of two abutting plots', () => {
        const t = topo.buildTopology(PAIR);
        // 6 distinct corners: (0,0) (10,0) (10,10) (0,10) (20,0) (20,10)
        expect(t.nodes).toHaveLength(6);
        const shared = t.nodes.filter(n => n.plots.length > 1);
        expect(shared).toHaveLength(2);
        expect(shared.every(n => Math.abs(n.coord[0] - 10) < 1e-9)).toBe(true);
    });

    it('marks the shared edge as belonging to both plots', () => {
        const t = topo.buildTopology(PAIR);
        const shared = t.edges.filter(e => e.plots.length > 1);
        expect(shared).toHaveLength(1);
    });

    it('treats near-identical coordinates as one node', () => {
        const drifted = plot(10.00000001, 0, 20, 10);
        const t = topo.buildTopology([LEFT, drifted]);
        expect(t.nodes.filter(n => n.plots.length > 1)).toHaveLength(2);
    });

    it('reads MultiPolygon plots and ignores degenerate rings', () => {
        const multi = { geometry: { type: 'MultiPolygon', coordinates: [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[5, 5], [6, 5]]]
        ] } };
        const t = topo.buildTopology([multi]);
        expect(t.nodes).toHaveLength(4);
    });
});

describe('moveNode', () => {
    it('moves a shared corner in BOTH plots, so no gap opens', () => {
        const t = topo.buildTopology(PAIR);
        const shared = t.nodes.find(n => n.plots.length > 1 && Math.abs(n.coord[1]) < 1e-9); // (10,0)
        const out = topo.moveNode(PAIR, t, shared.id, [12, 0]);
        expect(has(ringOf(out, 0), 12, 0)).toBe(true);
        expect(has(ringOf(out, 1), 12, 0)).toBe(true);
        expect(has(ringOf(out, 0), 10, 0)).toBe(false);
        expect(has(ringOf(out, 1), 10, 0)).toBe(false);
    });

    it('moves a private corner in one plot only', () => {
        const t = topo.buildTopology(PAIR);
        const own = t.nodes.find(n => n.plots.length === 1 && Math.abs(n.coord[0]) < 1e-9 && Math.abs(n.coord[1]) < 1e-9);
        const out = topo.moveNode(PAIR, t, own.id, [-3, -3]);
        expect(has(ringOf(out, 0), -3, -3)).toBe(true);
        expect(ringOf(out, 1)).toEqual(RIGHT.geometry.coordinates[0]);
    });

    it('keeps the ring closed when the first vertex moves', () => {
        const t = topo.buildTopology([LEFT]);
        const first = t.nodes.find(n => Math.abs(n.coord[0]) < 1e-9 && Math.abs(n.coord[1]) < 1e-9);
        const ring = ringOf(topo.moveNode([LEFT], t, first.id, [-1, -1]), 0);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
    });

    it('never mutates the input', () => {
        const t = topo.buildTopology(PAIR);
        const before = JSON.stringify(PAIR);
        topo.moveNode(PAIR, t, t.nodes[0].id, [99, 99]);
        expect(JSON.stringify(PAIR)).toBe(before);
    });
});

describe('insertNodeOnEdge', () => {
    it('inserts on the shared edge in both plots', () => {
        const t = topo.buildTopology(PAIR);
        const shared = t.edges.find(e => e.plots.length > 1);
        const out = topo.insertNodeOnEdge(PAIR, t, shared.id, [10, 5]);
        expect(has(ringOf(out, 0), 10, 5)).toBe(true);
        expect(has(ringOf(out, 1), 10, 5)).toBe(true);
    });

    it('leaves other plots untouched for a private edge', () => {
        const t = topo.buildTopology(PAIR);
        const nodes = new Map(t.nodes.map(n => [n.id, n]));
        const priv = t.edges.find(e => e.plots.length === 1
            && Math.abs(nodes.get(e.a).coord[0]) < 1e-9 && Math.abs(nodes.get(e.b).coord[0]) < 1e-9);
        const out = topo.insertNodeOnEdge(PAIR, t, priv.id, [0, 5]);
        expect(has(ringOf(out, 0), 0, 5)).toBe(true);
        expect(ringOf(out, 1)).toEqual(RIGHT.geometry.coordinates[0]);
    });
});

describe('removeNode', () => {
    it('removes a vertex that is not needed to keep a polygon', () => {
        const five = { geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [5, 12], [0, 10], [0, 0]]] } };
        const t = topo.buildTopology([five]);
        const spike = t.nodes.find(n => Math.abs(n.coord[1] - 12) < 1e-9);
        const res = topo.removeNode([five], t, spike.id);
        expect(res.removed).toBe(true);
        expect(has(res.geometries[0].coordinates[0], 5, 12)).toBe(false);
        expect(res.geometries[0].coordinates[0][0]).toEqual(res.geometries[0].coordinates[0].slice(-1)[0]);
    });

    it('refuses when a plot would drop below a triangle', () => {
        const tri = { geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [5, 8], [0, 0]]] } };
        const t = topo.buildTopology([tri]);
        const res = topo.removeNode([tri], t, t.nodes[0].id);
        expect(res.removed).toBe(false);
        expect(res.reason).toBe('would-degenerate');
    });
});

describe('edgeMidpoints', () => {
    it('gives one insertion target per edge and flags the shared one', () => {
        const t = topo.buildTopology(PAIR);
        const mids = topo.edgeMidpoints(t);
        expect(mids).toHaveLength(t.edges.length);
        const sharedMid = mids.find(m => m.shared);
        expect(sharedMid.coord[0]).toBeCloseTo(10, 9);
        expect(sharedMid.coord[1]).toBeCloseTo(5, 9);
    });
});

describe('open shapes (road centrelines)', () => {
    // Two centrelines meeting at a junction (10,0)
    const legA = { geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } };
    const legB = { geometry: { type: 'LineString', coordinates: [[10, 0], [20, 5]] } };

    it('shares the junction node between both legs', () => {
        const t = topo.buildTopology([legA, legB]);
        const shared = t.nodes.filter(n => n.plots.length > 1);
        expect(shared).toHaveLength(1);
        expect(shared[0].coord).toEqual([10, 0]);
    });

    it('moves the junction in both legs at once', () => {
        const t = topo.buildTopology([legA, legB]);
        const junction = t.nodes.find(n => n.plots.length > 1);
        const out = topo.moveNode([legA, legB], t, junction.id, [12, 2]);
        expect(out[0].coordinates).toEqual([[0, 0], [12, 2]]);
        expect(out[1].coordinates).toEqual([[12, 2], [20, 5]]);
    });

    it('never closes an open line when its first or last vertex moves', () => {
        const t = topo.buildTopology([legA]);
        const first = t.nodes.find(n => n.coord[0] === 0);
        const out = topo.moveNode([legA], t, first.id, [-5, -5]);
        expect(out[0].coordinates).toEqual([[-5, -5], [10, 0]]);
    });

    it('lets a line fall to two points but no further', () => {
        const three = { geometry: { type: 'LineString', coordinates: [[0, 0], [5, 1], [10, 0]] } };
        const t = topo.buildTopology([three]);
        const mid = t.nodes.find(n => n.coord[0] === 5);
        expect(topo.removeNode([three], t, mid.id).removed).toBe(true);
        const two = { geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } };
        const t2 = topo.buildTopology([two]);
        expect(topo.removeNode([two], t2, t2.nodes[0].id).removed).toBe(false);
    });
});

describe('shape conversion for non-GeoJSON callers', () => {
    it('round-trips open shapes', () => {
        const shapes = [{ points: [[0, 0], [10, 0]], closed: false }];
        const plots = topo.shapesToPlots(shapes);
        expect(plots[0].geometry.type).toBe('LineString');
        const back = topo.plotsToShapes(plots.map(p => p.geometry), shapes);
        expect(back[0].points).toEqual([[0, 0], [10, 0]]);
        expect(back[0].closed).toBe(false);
    });

    it('closes and re-opens closed shapes without duplicating the last point', () => {
        const shapes = [{ points: [[0, 0], [10, 0], [10, 10]], closed: true }];
        const plots = topo.shapesToPlots(shapes);
        expect(plots[0].geometry.coordinates[0]).toHaveLength(4);
        const back = topo.plotsToShapes(plots.map(p => p.geometry), shapes);
        expect(back[0].points).toEqual([[0, 0], [10, 0], [10, 10]]);
    });
});
