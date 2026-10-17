// Every edit to a readjustment's plots owns its result: node edits on a conforming layout keep the
// plots tiling the pool by themselves, and checkTiling refuses a layout an edit broke (a fold, a
// gap, an overlap, land outside the pool) instead of anything repairing it afterwards.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const topo = require('../../frontend/js/proposals/plot-topology.js');
const plotEdit = require('../../frontend/js/proposals/plot-edit.js');

// Plain degrees around (16, 45.8), scaled so a unit is ~80 m: plot areas land in the thousands of m².
const S = 0.001;
const at = (x, y) => [16 + x * S, 45.8 + y * S];
const polygon = (...points) => ({ type: 'Polygon', coordinates: [[...points.map(([x, y]) => at(x, y)), at(...points[0])]] });
const areaOf = geometry => turf.area({ type: 'Feature', properties: {}, geometry });

// A 2×1 pool: W is the west half; triangle T leans on W's east side; E wraps around T.
// T and E share the bend B at (1.5, 0.5); nothing else carries it.
const POOL = polygon([0, 0], [2, 0], [2, 1], [0, 1]);
const W = polygon([0, 0], [1, 0], [1, 1], [0, 1]);
const T = polygon([1, 0], [1.5, 0.5], [1, 1]);
const E = polygon([1, 0], [2, 0], [2, 1], [1, 1], [1.5, 0.5]);
const LAYOUT = () => [W, T, E].map(geometry => ({ geometry: JSON.parse(JSON.stringify(geometry)) }));
const B = at(1.5, 0.5);

const topologyOf = plots => topo.annotateBoundary(topo.buildTopology(plots), topo.boundaryIndexOf(POOL));
const nodeAt = (topology, coord) => topology.nodes.find(n =>
    Math.abs(n.coord[0] - coord[0]) < 1e-9 && Math.abs(n.coord[1] - coord[1]) < 1e-9);
const geometries = plots => plots.map(plot => plot.geometry);
const drag = (to) => {
    const plots = LAYOUT();
    const topology = topologyOf(plots);
    return { before: geometries(plots), after: topo.moveNode(plots, topology, nodeAt(topology, B).id, to) };
};

describe('checkTiling', () => {
    it('accepts the starting layout as a tiling of its pool', () => {
        const result = plotEdit.checkTiling(null, geometries(LAYOUT()), { turf }, { pool: POOL });
        expect(result.ok).toBe(true);
    });

    it('accepts a drag that keeps every plot on its own side', () => {
        const { before, after } = drag(at(1.3, 0.6));
        const result = plotEdit.checkTiling(before, after, { turf });
        expect(result.ok).toBe(true);
        // The land moved between T and E only, and none was lost.
        expect(areaOf(after[1]) + areaOf(after[2])).toBeCloseTo(areaOf(T) + areaOf(E), 0);
    });

    it('refuses a drag through a neighbour: T flips over W and E follows it, so W\'s land is claimed twice', () => {
        const { before, after } = drag(at(0.5, 0.5));
        const result = plotEdit.checkTiling(before, after, { turf });
        expect(result.ok).toBe(false);
        expect(result.overlaps.filter(([a, b]) => a === 0 || b === 0).map(([a, b]) => [a, b])).toEqual([[0, 1], [0, 2]]);
    });

    it('refuses a drag out of the pool: E folds over its own east side', () => {
        const { before, after } = drag(at(2.5, 0.5));
        const result = plotEdit.checkTiling(before, after, { turf });
        expect(result.ok).toBe(false);
        expect(result.folded).toContain(2);
    });

    it('accepts removing the bend: T dissolves and E, straightened across it, holds exactly its land', () => {
        const plots = LAYOUT();
        const topology = topologyOf(plots);
        const removal = topo.removeNode(plots, topology, nodeAt(topology, B).id, { dissolveDegenerate: true });
        expect(removal.removed).toBe(true);
        expect(removal.geometries[1]).toBeNull();

        const result = plotEdit.checkTiling(geometries(plots), removal.geometries, { turf });
        expect(result.ok).toBe(true);
        expect(areaOf(removal.geometries[2])).toBeCloseTo(areaOf(T) + areaOf(E), 0);
    });

    it('accepts a cut lined up with what it replaced: the first piece inherits the parent, the second is new', () => {
        const before = [W, null, E];
        const after = [polygon([0, 0], [0.5, 0], [0.5, 1], [0, 1]), polygon([0.5, 0], [1, 0], [1, 1], [0.5, 1]), E];
        expect(plotEdit.checkTiling(before, after, { turf }).ok).toBe(true);
    });

    it('refuses a layout missing land, measured against the pool', () => {
        const result = plotEdit.checkTiling(null, [W, E], { turf }, { pool: POOL });
        expect(result.ok).toBe(false);
        expect(result.gap).toBeCloseTo(areaOf(T), 0);
    });

    it('does nothing when nothing changed', () => {
        const plots = geometries(LAYOUT());
        expect(plotEdit.checkTiling(plots, JSON.parse(JSON.stringify(plots)), { turf })).toMatchObject({ ok: true, overlaps: [] });
    });
});
