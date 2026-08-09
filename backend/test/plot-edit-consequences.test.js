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
const heal = require('../../frontend/js/proposals/plot-heal.js');
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

        const shift = heal.areaShift(before, after, { turf });

        expect(shift.dissolved).toEqual([2]);
        expect(shift.perPlot.find(e => e.index === 1).delta).toBeGreaterThan(0);
        expect(shift.perPlot.find(e => e.index === 2).delta).toBeLessThan(0);
        expect(shift.moved).toBeCloseTo(areaOf(SOUTH_EAST.geometry), 3);
    });

    it('says nothing about an edit that moved nothing', () => {
        const same = [WEST.geometry, NORTH_EAST.geometry];

        const shift = heal.areaShift(same, same.map(g => JSON.parse(JSON.stringify(g))), { turf });

        expect(shift.perPlot).toEqual([]);
        expect(shift.moved).toBe(0);
    });

    it('counts land once, not once for the giver and once for the taker', () => {
        const before = [box(16.000, 45.800, 16.001, 45.801), box(16.001, 45.800, 16.002, 45.801)];
        const after = [box(16.000, 45.800, 16.0015, 45.801), box(16.0015, 45.800, 16.002, 45.801)];

        const shift = heal.areaShift(before, after, { turf });
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

describe('healLocally', () => {
    // Four plots in a row. An edit to the first two cannot possibly disturb the fourth.
    const strip = () => [
        box(16.000, 45.800, 16.001, 45.801),
        box(16.001, 45.800, 16.002, 45.801),
        box(16.002, 45.800, 16.003, 45.801),
        box(16.003, 45.800, 16.004, 45.801)
    ];
    const stripPool = box(16.000, 45.800, 16.004, 45.801);
    // Plot 0 pulls its east edge back, leaving a gap its neighbour must absorb.
    const withGap = () => {
        const after = strip();
        after[0] = box(16.000, 45.800, 16.0008, 45.801);
        return after;
    };

    it('reaches the same answer as the whole-layout pass', () => {
        const before = strip();
        const after = withGap();

        const global_ = heal.healTiling(after, stripPool, { turf });
        const local = heal.healLocally(before, after, stripPool, { turf });

        expect(local.fellBack).toBe(false);
        // This is the test that makes the optimisation trustworthy: scoping must be an
        // optimisation, not a different algorithm.
        local.geometries.forEach((geometry, index) => {
            expect(areaOf(geometry)).toBeCloseTo(areaOf(global_.geometries[index]), 6);
        });
    });

    it('leaves the plots the edit could not reach byte-identical', () => {
        const before = strip();
        const after = withGap();

        const local = heal.healLocally(before, after, stripPool, { turf });

        // Plot 3 is two plots away from anything that moved.
        expect(JSON.stringify(local.geometries[3])).toBe(JSON.stringify(before[3]));
        expect(local.scope).toBeLessThan(before.length);
    });

    it('conserves the land it was given', () => {
        const before = strip();
        const after = withGap();

        const local = heal.healLocally(before, after, stripPool, { turf });

        expect(local.geometries.reduce((sum, g) => sum + areaOf(g), 0))
            .toBeCloseTo(before.reduce((sum, g) => sum + areaOf(g), 0), 3);
    });

    it('does nothing at all when nothing changed', () => {
        const before = strip();

        const local = heal.healLocally(before, before.map(g => JSON.parse(JSON.stringify(g))), stripPool, { turf });

        expect(local.fellBack).toBe(false);
        expect(local.changed).toBe(false);
        expect(local.scope).toBe(0);
    });

    it('hands back to the global pass when the edit reaches most of the plan', () => {
        const before = strip();
        // Every plot moved: there is nothing local about this.
        const after = before.map((_, i) => box(16.000 + i * 0.001, 45.800, 16.0009 + i * 0.001, 45.801));

        expect(heal.healLocally(before, after, stripPool, { turf }).fellBack).toBe(true);
    });

    it('does not lose land to a plot that runs off the map', () => {
        const before = strip();
        const after = strip();
        // Plot 0 jumps clean out of the strip. Whether that is settled locally or handed to the
        // global pass is an implementation detail; the land not disappearing is not.
        after[0] = box(16.020, 45.820, 16.021, 45.821);

        const local = heal.healLocally(before, after, stripPool, { turf });
        const settled = local.fellBack
            ? heal.healTiling(after, stripPool, { turf }).geometries
            : local.geometries;

        // A plot whose land all went to its neighbours comes back as null — that is the shape the
        // caller already reads as "dissolved", not a missing measurement.
        const total = list => list.reduce((sum, g) => sum + (g ? areaOf(g) : 0), 0);
        expect(total(settled)).toBeCloseTo(total(before), 3);
    });
});

describe('healLocally after a split, where a plot became two', () => {
    // A cut adds plots, so before and after no longer line up index-for-index. The caller lines
    // them up by hand: the first piece of a split inherits its parent's "before", the rest get
    // null. Without that the whole plan is settled instead, and drawing one line across one plot
    // clipped thirty unrelated ones.
    // Eight plots — a plan small enough to read and big enough that scoping is worth doing. The
    // breadth guard refuses to scope an edit reaching most of the layout, so a four-plot fixture
    // would fall back on principle and prove nothing.
    const COUNT = 8;
    const strip = () => Array.from({ length: COUNT },
        (_, i) => box(16.000 + i * 0.001, 45.800, 16.001 + i * 0.001, 45.801));
    const stripPool = box(16.000, 45.800, 16.000 + COUNT * 0.001, 45.801);

    // Plot 0 is cut in half. The new list is [0a, 0b, 1, 2, …].
    const split = () => {
        const was = strip();
        return [box(16.000, 45.800, 16.0005, 45.801), box(16.0005, 45.800, 16.001, 45.801)]
            .concat(was.slice(1));
    };
    const aligned = () => {
        const was = strip();
        return [was[0], null].concat(was.slice(1));
    };

    it('settles the split without falling back to the whole plan', () => {
        const local = heal.healLocally(aligned(), split(), stripPool, { turf });

        expect(local.fellBack).toBe(false);
        expect(local.scope).toBeLessThan(COUNT);
    });

    it('leaves the plots the cut never reached byte-identical', () => {
        const before = strip();

        const local = heal.healLocally(aligned(), split(), stripPool, { turf });

        // The far end of the strip is nowhere near anything the cut touched. This is the
        // assertion that would have caught thirty plots being clipped by an unrelated edit.
        expect(JSON.stringify(local.geometries[COUNT])).toBe(JSON.stringify(before[COUNT - 1]));
        expect(JSON.stringify(local.geometries[COUNT - 1])).toBe(JSON.stringify(before[COUNT - 2]));
    });

    it('balances the books — the parent is counted once and its pieces add back up to it', () => {
        const before = strip();

        const local = heal.healLocally(aligned(), split(), stripPool, { turf });

        expect(local.geometries.reduce((sum, g) => sum + (g ? areaOf(g) : 0), 0))
            .toBeCloseTo(before.reduce((sum, g) => sum + areaOf(g), 0), 3);
    });
});
