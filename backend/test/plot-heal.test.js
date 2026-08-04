// plot-heal.js — a parcellation is kept tiling its pool by REPAIR, not by refusing edits.
// Removing a boundary node is legitimate: the boundary stops existing and the land joins the plot
// beside it. Remove every internal node and one plot should be left covering the whole pool.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let heal;
let topo;
let turf;

beforeAll(() => {
    heal = require('../../frontend/js/proposals/plot-heal.js');
    topo = require('../../frontend/js/proposals/plot-topology.js');
    turf = require('@turf/turf');
});

// A pool 100 m on a side (in degrees this is tiny, so use a metric-ish patch near the equator where
// turf.area is well behaved). Coordinates are degrees; areas come out in m².
const POOL = {
    type: 'Polygon',
    coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]
};

// Split down the middle at x = 0.0005.
function splitPlots() {
    return [
        { type: 'Polygon', coordinates: [[[0, 0], [0.0005, 0], [0.0005, 0.001], [0, 0.001], [0, 0]]] },
        { type: 'Polygon', coordinates: [[[0.0005, 0], [0.001, 0], [0.001, 0.001], [0.0005, 0.001], [0.0005, 0]]] }
    ];
}

const areaOf = geometry => turf.area({ type: 'Feature', properties: {}, geometry });

describe('a layout that already tiles', () => {
    it('is left alone', () => {
        const result = heal.healTiling(splitPlots(), POOL, { turf });
        expect(result.changed).toBe(false);
        expect(result.gapsFilled).toBe(0);
        expect(result.overlaps).toBe(0);
    });
});

describe('gaps are absorbed, never left unclaimed', () => {
    it('gives a hole to the plot it borders', () => {
        // Drop the right-hand plot entirely: half the pool is unclaimed.
        const torn = [splitPlots()[0]];
        const poolArea = areaOf(POOL);
        const result = heal.healTiling(torn, POOL, { turf });
        expect(result.gapsFilled).toBe(1);
        expect(result.geometries.filter(Boolean)).toHaveLength(1);
        expect(areaOf(result.geometries[0])).toBeCloseTo(poolArea, 0);
    });

    it('leaves nothing of the pool unaccounted for', () => {
        const torn = [splitPlots()[0]];
        const result = heal.healTiling(torn, POOL, { turf });
        const covered = result.geometries.filter(Boolean)
            .reduce((sum, geometry) => sum + areaOf(geometry), 0);
        expect(covered).toBeCloseTo(areaOf(POOL), 0);
    });

    it('ignores slivers below the minimum, which are rounding rather than land', () => {
        const plots = splitPlots();
        // Pull the shared boundary a hair off, leaving a sub-centimetre strip.
        plots[1] = {
            type: 'Polygon',
            coordinates: [[[0.00050001, 0], [0.001, 0], [0.001, 0.001], [0.00050001, 0.001], [0.00050001, 0]]]
        };
        const result = heal.healTiling(plots, POOL, { turf });
        expect(result.gapsFilled).toBe(0);
    });
});

describe('overlaps are resolved so no land is claimed twice', () => {
    it('trims the later plot back', () => {
        const plots = splitPlots();
        // Make the right plot swallow the left one too.
        plots[1] = POOL;
        const result = heal.healTiling(plots, POOL, { turf });
        expect(result.overlaps).toBe(1);
        const covered = result.geometries.filter(Boolean)
            .reduce((sum, geometry) => sum + areaOf(geometry), 0);
        expect(covered).toBeCloseTo(areaOf(POOL), 0);   // not double-counted
    });
});

describe('anything outside the pool is clipped away', () => {
    it('keeps only the part inside', () => {
        const outside = {
            type: 'Polygon',
            coordinates: [[[0.0005, 0], [0.002, 0], [0.002, 0.001], [0.0005, 0.001], [0.0005, 0]]]
        };
        const result = heal.healTiling([splitPlots()[0], outside], POOL, { turf });
        expect(result.clipped).toBe(1);
        const covered = result.geometries.filter(Boolean)
            .reduce((sum, geometry) => sum + areaOf(geometry), 0);
        expect(covered).toBeCloseTo(areaOf(POOL), 0);
    });
});

describe('removing nodes until nothing divides the pool', () => {
    it('ends with one plot covering the whole pool, never orphaned land', () => {
        let plots = splitPlots().map(geometry => ({ geometry }));
        const poolArea = areaOf(POOL);
        let guard = 0;

        // Strip the internal boundary one node at a time, healing after each, exactly as the editor
        // does. The dividing line dissolves and the land merges — it does not vanish.
        while (guard++ < 20) {
            const topology = topo.annotateBoundary(
                topo.buildTopology(plots),
                topo.boundaryIndexOf(POOL, { tolerance: 1e-9 })
            );
            const interior = topology.nodes.find(node => !topo.isOnBoundary(node));
            if (!interior) break;
            const removal = topo.removeNode(plots, topology, interior.id);
            const settled = heal.healTiling(
                removal.removed ? removal.geometries : plots.map(p => p.geometry),
                POOL,
                { turf }
            );
            plots = settled.geometries.filter(Boolean).map(geometry => ({ geometry }));
            if (!removal.removed) break;
        }

        const covered = plots.reduce((sum, plot) => sum + areaOf(plot.geometry), 0);
        expect(covered).toBeCloseTo(poolArea, 0);   // every square metre still belongs to something
    });

    it('a plot that loses all its land is dropped rather than left at zero', () => {
        // The right plot is entirely swallowed by the left one.
        const plots = [POOL, splitPlots()[1]];
        const result = heal.healTiling(plots, POOL, { turf });
        expect(result.geometries[0]).toBeTruthy();
        expect(result.geometries[1]).toBeFalsy();   // nothing left → the caller drops the row
    });
});

describe('degenerate input', () => {
    it('returns the input unchanged when there is no pool', () => {
        const plots = splitPlots();
        const result = heal.healTiling(plots, null, { turf });
        expect(result.changed).toBe(false);
        expect(result.geometries).toHaveLength(2);
    });

    it('survives turf being unavailable', () => {
        const plots = splitPlots();
        const result = heal.healTiling(plots, POOL, { turf: null });
        expect(result.changed).toBe(false);
    });
});
