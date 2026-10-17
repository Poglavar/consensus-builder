// An edit that is allowed unconditionally still has to be REPORTABLE.
//
// Removing a node where three plots meet transferred 3,940 m² between owners with nothing on
// screen to say so; the only evidence was a number in the plot list that had quietly changed. The
// editor can now name it, and these tests pin the two pieces that let it: classifyNodeRemoval,
// which decides what a removal MEANS, and areaShift, which measures what it did. Both are pure, so
// the popup that describes an edit and the code that performs it read the same answer.
//
// conformGeometries is here too, for the other half of the same problem: two plots only share an
// edge when both rings carry the same two nodes, so a neighbour with an extra vertex on the same
// line leaves a boundary that nothing can act on — which is why some boundaries could be erased and
// others, looking identical, could not.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const topo = require('../../frontend/js/proposals/plot-topology.js');
const plotEdit = require('../../frontend/js/proposals/plot-edit.js');
const cut = require('../../frontend/js/proposals/plot-cut.js');

const polygon = coords => ({ type: 'Polygon', coordinates: [coords] });
const box = (west, south, east, north) => polygon([
    [west, south], [east, south], [east, north], [west, north], [west, south]
]);
const areaOf = geometry => turf.area({ type: 'Feature', properties: {}, geometry });

// A pool cut into three: the west half, and the east half split north/south. All three meet at
// (16.001, 45.8005) — and the west plot does NOT carry that vertex, which is exactly the
// non-conforming state these tests are about: its east side is one edge while its two neighbours
// each have half of it, so no boundary there is shared by two plots.
const POOL = box(16.000, 45.800, 16.002, 45.801);
const WEST = { geometry: box(16.000, 45.800, 16.001, 45.801) };
const NORTH_EAST = { geometry: box(16.001, 45.8005, 16.002, 45.801) };
const SOUTH_EAST = { geometry: box(16.001, 45.800, 16.002, 45.8005) };
const THREE = [WEST, NORTH_EAST, SOUTH_EAST];

const topologyFor = plots => topo.annotateBoundary(topo.buildTopology(plots), topo.boundaryIndexOf(POOL));
const nodeAt = (topology, coord) => topology.nodes.find(n =>
    Math.abs(n.coord[0] - coord[0]) < 1e-9 && Math.abs(n.coord[1] - coord[1]) < 1e-9);

describe('classifyNodeRemoval', () => {
    it('calls a junction a MERGE — the boundary it holds up stops existing', () => {
        const topology = topologyFor(THREE);
        const junction = nodeAt(topology, [16.001, 45.8005]);

        const verdict = topo.classifyNodeRemoval(junction, topology);

        // This is the node whose removal moved 3,940 m² without a word. It is not a bend.
        expect(verdict.kind).toBe('merge');
        expect(verdict.plots.length).toBeGreaterThanOrEqual(2);
    });

    it('calls a bend a STRAIGHTEN — the line loses a corner but stays', () => {
        // A dividing line with a kink in the middle: the middle node has one cut either side.
        const west = { geometry: polygon([
            [16.000, 45.800], [16.001, 45.800], [16.0012, 45.8005], [16.001, 45.801],
            [16.000, 45.801], [16.000, 45.800]
        ]) };
        const east = { geometry: polygon([
            [16.001, 45.800], [16.002, 45.800], [16.002, 45.801], [16.001, 45.801],
            [16.0012, 45.8005], [16.001, 45.800]
        ]) };
        const topology = topologyFor([west, east]);
        const bend = nodeAt(topology, [16.0012, 45.8005]);

        expect(topo.classifyNodeRemoval(bend, topology).kind).toBe('straighten');
    });

    it('refuses a corner of the pooled outline, which is not this plan to redraw', () => {
        const topology = topologyFor(THREE);
        const corner = nodeAt(topology, [16.000, 45.800]);

        expect(topo.classifyNodeRemoval(corner, topology).kind).toBe('outline');
    });
});

describe('areaShift', () => {
    it('names the land an edit moved, biggest change first', () => {
        const before = [WEST.geometry, NORTH_EAST.geometry, SOUTH_EAST.geometry];
        // The north-east plot swallows the south-east one.
        const after = [WEST.geometry, box(16.001, 45.800, 16.002, 45.801), null];

        const shift = plotEdit.areaShift(before, after, { turf });

        expect(shift.dissolved).toEqual([2]);
        expect(shift.perPlot.find(e => e.index === 1).delta).toBeGreaterThan(0);
        expect(shift.perPlot.find(e => e.index === 2).delta).toBeLessThan(0);
        expect(shift.moved).toBeCloseTo(areaOf(SOUTH_EAST.geometry), 3);
    });

    it('says nothing about an edit that moved nothing', () => {
        const same = [WEST.geometry, NORTH_EAST.geometry];

        const shift = plotEdit.areaShift(same, same.map(g => JSON.parse(JSON.stringify(g))), { turf });

        expect(shift.perPlot).toEqual([]);
        expect(shift.moved).toBe(0);
    });

    it('counts land once, not once for the giver and once for the taker', () => {
        const before = [box(16.000, 45.800, 16.001, 45.801), box(16.001, 45.800, 16.002, 45.801)];
        const after = [box(16.000, 45.800, 16.0015, 45.801), box(16.0015, 45.800, 16.002, 45.801)];

        const shift = plotEdit.areaShift(before, after, { turf });
        const gained = areaOf(after[0]) - areaOf(before[0]);

        expect(shift.moved).toBeCloseTo(gained, 3);
        expect(shift.perPlot.length).toBe(2);
    });
});

describe('conformGeometries', () => {
    it('gives a neighbour the vertex that already sits on its edge', () => {
        // Its neighbours' shared corner sits halfway up the west plot's east side, and the west
        // plot has no vertex there — so none of the three shares that boundary as an edge.
        const before = topologyFor(THREE);
        const orphans = before.edges.filter(e => (e.plots || []).length === 1 && !e.onBoundary).length;

        const conformed = cut.conformGeometries(THREE.map(p => p.geometry));
        const after = topologyFor(conformed.map(geometry => ({ geometry })));

        expect(orphans).toBeGreaterThan(0);
        expect(after.edges.filter(e => (e.plots || []).length === 1 && !e.onBoundary).length).toBe(0);
        expect(cut.boundaryGroups(after).length).toBeGreaterThan(cut.boundaryGroups(before).length);
    });

    it('adds vertices without moving any land', () => {
        const before = THREE.reduce((sum, p) => sum + areaOf(p.geometry), 0);

        const conformed = cut.conformGeometries(THREE.map(p => p.geometry));

        // Inserting a vertex ON a segment does not move the segment. If this ever drifts, the
        // "repair" is quietly redrawing the plan.
        expect(conformed.reduce((sum, g) => sum + areaOf(g), 0)).toBeCloseTo(before, 6);
    });

    it('converges — a second pass has nothing left to do', () => {
        const once = cut.conformGeometries(THREE.map(p => p.geometry));
        const twice = cut.conformGeometries(once);

        expect(once.inserted).toBeGreaterThan(0);
        expect(twice.inserted).toBe(0);
    });

    it('leaves an already-conforming layout untouched', () => {
        const plots = [box(16.000, 45.800, 16.001, 45.801), box(16.001, 45.800, 16.002, 45.801)];

        expect(cut.conformGeometries(plots).inserted).toBe(0);
    });
});
