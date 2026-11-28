// The ring topology rule (frontend/js/polygon-topology.js) that replaced turf.kinks as the polygon
// check of parcel layouts, readjustments, MCP edits and plot edits: rings may meet at single points,
// never cross, share an edge, touch from outside or cut the interior apart.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { problem, messages } = require('../../frontend/js/polygon-topology.js');
const layout = require('../../frontend/js/parcel-layout-validation.js');
const plotEdit = require('../../frontend/js/proposals/plot-edit.js');
// A site merged from 77 Havering plots: 7 slivers between plots touch the outline or each other at corners.
const CALBOURNE = require('./fixtures/calbourne-site-touching-holes.json');

const S = 0.0001;
const at = (x, y) => [-0.2 + x * S, 51.5 + y * S];
const ring = (...points) => [...points.map(([x, y]) => at(x, y)), at(...points[0])];
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings });
const SHELL = ring([0, 0], [10, 0], [10, 10], [0, 10]);

describe('polygon ring topology', () => {
    it('accepts the Calbourne site, which turf.kinks refused', () => {
        expect(turf.kinks(turf.feature(CALBOURNE)).features.length).toBeGreaterThan(0);
        expect(problem(CALBOURNE)).toBeNull();
        expect(() => layout.polygon(CALBOURNE, turf)).not.toThrow();
    });

    it('accepts a hole touching the outline at a corner from inside, in either winding', () => {
        const hole = ring([0, 0], [4, 1], [1, 4]);
        expect(problem(polygon(SHELL, hole))).toBeNull();
        expect(problem(polygon([...SHELL].reverse(), [...hole].reverse()))).toBeNull();
    });

    it('accepts a hole whose corner lies on the middle of an outline edge', () => {
        expect(problem(polygon(SHELL, ring([5, 0], [7, 3], [3, 3])))).toBeNull();
    });

    it('accepts three rings meeting at one point', () => {
        expect(problem(polygon(SHELL, ring([5, 0], [4, 4], [1, 1]), ring([5, 0], [9, 1], [6, 4])))).toBeNull();
    });

    it('accepts MultiPolygon parts touching at a point', () => {
        const other = ring([10, 10], [20, 10], [20, 20], [10, 20]);
        expect(problem({ type: 'MultiPolygon', coordinates: [[SHELL], [other]] })).toBeNull();
    });

    it('refuses a bow-tie and a figure-8 shell', () => {
        expect(problem(polygon(ring([0, 0], [10, 10], [10, 0], [0, 10])))).toBe(messages.CROSSING);
        expect(problem(polygon(ring([0, 0], [5, 5], [10, 0], [10, 10], [5, 5], [0, 10])))).toBe(messages.CROSSING);
    });

    it('refuses a figure-8 hole', () => {
        expect(problem(polygon(SHELL, ring([2, 2], [5, 5], [8, 2], [8, 8], [5, 5], [2, 8])))).toBe(messages.CROSSING);
    });

    it('refuses a ring folding back along itself', () => {
        expect(problem(polygon(ring([0, 0], [10, 0], [5, 0], [5, 5])))).toBe(messages.CROSSING);
    });

    it('refuses a hole leaving the outline through a shared corner', () => {
        expect(problem(polygon(SHELL, ring([0, 0], [3, -1], [3, 3])))).toBe(messages.CROSSING);
    });

    it('refuses a hole touching the outline from outside', () => {
        // Inward and outward wedges meet the outline the same way; only the side tells them apart.
        expect(problem(polygon(SHELL, ring([0, 0], [-3, -1], [-1, -3])))).toBe(messages.CROSSING);
        expect(problem(polygon(SHELL, ring([5, 0], [6, -1], [4, -1])))).toBe(messages.CROSSING);
    });

    it('refuses a hole sharing a stretch of the outline', () => {
        expect(problem(polygon(SHELL, ring([2, 0], [6, 0], [4, 3])))).toBe(messages.SHARED_EDGE);
    });

    it('refuses a hole touching the outline at two points', () => {
        expect(problem(polygon(SHELL, ring([5, 0], [10, 5], [5, 5])))).toBe(messages.CUT_APART);
    });

    it('refuses two holes touching each other at two points', () => {
        expect(problem(polygon(SHELL, ring([2, 5], [5, 2], [5, 8]), ring([5, 2], [8, 5], [5, 8], [6, 5])))).toBe(messages.CUT_APART);
    });

    it('refuses three holes touching in a cycle', () => {
        const [X, Y, Z] = [[3, 3], [7, 3], [5, 7]];
        expect(problem(polygon(SHELL, ring(X, Y, [5, 1]), ring(Y, Z, [8, 6]), ring(Z, X, [2, 6])))).toBe(messages.CUT_APART);
    });

    it('is the polygon check of parcel layouts', () => {
        expect(() => layout.polygon(polygon(SHELL, ring([0, 0], [4, 1], [1, 4])), turf)).not.toThrow();
        expect(() => layout.polygon(polygon(SHELL, ring([5, 0], [10, 5], [5, 5])), turf)).toThrow(messages.CUT_APART);
    });
});

describe('plot edits and ring topology', () => {
    const pool = polygon(SHELL);
    it('still refuses a folded plot', () => {
        const folded = polygon(ring([0, 0], [10, 10], [10, 0], [0, 10]));
        expect(plotEdit.checkTiling(null, [folded], { turf }, { pool }).folded).toEqual([0]);
    });

    it('accepts a plot whose courtyard touches its outline at a corner', () => {
        const hole = ring([0, 0], [4, 1], [1, 4]);
        const courtyard = polygon([...hole].reverse());
        const result = plotEdit.checkTiling(null, [polygon(SHELL, hole), courtyard], { turf }, { pool });
        expect(result.folded).toEqual([]);
        expect(result.ok).toBe(true);
    });
});
