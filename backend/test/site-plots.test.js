// Unit tests for frontend/js/proposals/site-plots.js: synthetic plots cut from a drawn site along a
// frontage edge, for detached and row houses on bare ground. Every plot must lie exactly inside the
// site (the plots' union binds what the site binds), the plots must cover it, and none may be empty.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;
const require = createRequire(import.meta.url);
const plots = require('../../frontend/js/proposals/site-plots.js');
const { bindingFromParcels } = require('../../frontend/js/proposals/site-binding.js');

const LAT = 45.81, LNG = 15.98;
// Ground metres on turf's sphere (R = 6378137 m), the frame site-plots measures in.
const MY = 180 / (Math.PI * 6378137), MX = MY / Math.cos(LAT * Math.PI / 180);
const deg = ([x, y]) => [LNG + x * MX, LAT + y * MY];
const site = (...rings) => turf.polygon(rings.map(r => [...r, r[0]].map(deg))).geometry;
const toM = ([lng, lat]) => [(lng - LNG) / MX, (lat - LAT) / MY];

const RECT = site([[0, 0], [100, 0], [100, 40], [0, 40]]);
const TRAPEZOID = site([[0, 0], [120, 0], [90, 50], [20, 50]]);
const L_SHAPE = site([[0, 0], [80, 0], [80, 30], [30, 30], [30, 70], [0, 70]]);
const U_SHAPE = site([[0, 0], [90, 0], [90, 60], [65, 60], [65, 20], [25, 20], [25, 60], [0, 60]]);

const areaOf = g => turf.area(g.type === 'Feature' ? g : turf.feature(g));
const unionOf = features => features.reduce((acc, f) => (acc ? turf.union(acc, f) : f), null);

// Ring of neighbours around a site, so "binds exactly what the site binds" has something to catch.
function neighbourhood(siteGeometry) {
    const [minX, minY, maxX, maxY] = turf.bbox(siteGeometry);
    const pad = 0.0005;
    const box = turf.bboxPolygon([minX - pad, minY - pad, maxX + pad, maxY + pad]);
    const around = turf.difference(box, turf.feature(siteGeometry));
    const parcels = [{ id: 'SITE', geometry: siteGeometry }];
    (around.geometry.type === 'Polygon' ? [around.geometry.coordinates] : around.geometry.coordinates)
        .forEach((rings, i) => parcels.push({ id: `N${i}`, geometry: { type: 'Polygon', coordinates: rings } }));
    return parcels;
}

function expectPlotsExactlyCoverSite(siteGeometry, cut) {
    expect(cut.length).toBeGreaterThan(0);
    cut.forEach(plot => {
        expect(plot.geometry.type).toBe('Polygon');
        expect(plot.properties.areaM2).toBeGreaterThan(0);
        expect(plot.properties.synthetic).toBe(true);
    });
    const total = cut.reduce((sum, p) => sum + areaOf(p), 0);
    expect(Math.abs(total - areaOf(siteGeometry)) / areaOf(siteGeometry)).toBeLessThan(0.001);
    const parcels = neighbourhood(siteGeometry);
    const bound = bindingFromParcels(unionOf(cut).geometry, parcels, { toleranceM: 0 }).parcels.map(p => p.parcelId);
    expect(bound).toEqual(['SITE']);
    cut.forEach(plot => expect(bindingFromParcels(plot.geometry, parcels, { toleranceM: 0 }).parcels.map(p => p.parcelId)).toEqual(['SITE']));
}

describe('frontage edges', () => {
    it('lists the exterior ring edges with ground lengths', () => {
        const edges = plots.frontageEdges(RECT);
        expect(edges.map(e => e.index)).toEqual([0, 1, 2, 3]);
        expect(edges.map(e => Math.round(e.lengthM))).toEqual([100, 40, 100, 40]);
        expect(toM(edges[1].a).map(Math.round)).toEqual([100, 0]);
    });

    it('defaults to the longest edge', () => {
        expect(plots.defaultFrontageEdge(RECT)).toBe(0);
        expect(plots.defaultFrontageEdge(TRAPEZOID)).toBe(0);
        expect(plots.defaultFrontageEdge(site([[0, 0], [30, 0], [30, 90], [0, 90]]))).toBe(1);
    });

    it('exports the default plot widths', () => {
        expect(plots.DETACHED_PLOT_WIDTH_M).toBe(20);
        expect(plots.ROW_PLOT_WIDTH_M).toBe(7);
    });
});

describe('cutPlots', () => {
    it('cuts a rectangle into frontage / width plots of equal width, covering it exactly', () => {
        const cut = plots.cutPlots(RECT, { plotWidthM: plots.DETACHED_PLOT_WIDTH_M });
        expect(cut).toHaveLength(5);
        cut.forEach(p => expect(p.properties.frontageM).toBeCloseTo(20, 1));
        expect(cut.map(p => p.properties.plotIndex)).toEqual([0, 1, 2, 3, 4]);
        expect(cut.map(p => p.properties.id)).toEqual(['site-plot:0', 'site-plot:1', 'site-plot:2', 'site-plot:3', 'site-plot:4']);
        expectPlotsExactlyCoverSite(RECT, cut);
    });

    it('spreads the remainder evenly instead of leaving a narrow last plot', () => {
        const cut = plots.cutPlots(RECT, { plotWidthM: 7 }); // 100 / 7 = 14.3 → 14 plots of 7.14 m
        expect(cut).toHaveLength(14);
        cut.forEach(p => expect(p.properties.frontageM).toBeCloseTo(100 / 14, 1));
        expectPlotsExactlyCoverSite(RECT, cut);
    });

    it('orients the strips by the chosen frontage edge', () => {
        const along = plots.cutPlots(RECT, { frontageEdgeIndex: 0, plotWidthM: 20 });
        const across = plots.cutPlots(RECT, { frontageEdgeIndex: 1, plotWidthM: 20 });
        expect(across).toHaveLength(2);
        // Along the 100 m edge every plot spans the 40 m depth; across it, the full 100 m.
        const height = p => { const [, s, , n] = turf.bbox(p); return (n - s) / MY; };
        const width = p => { const [w, , e] = turf.bbox(p); return (e - w) / MX; };
        along.forEach(p => { expect(height(p)).toBeCloseTo(40, 1); expect(width(p)).toBeCloseTo(20, 1); });
        across.forEach(p => { expect(width(p)).toBeCloseTo(100, 1); expect(height(p)).toBeCloseTo(20, 1); });
        expectPlotsExactlyCoverSite(RECT, across);
    });

    it('cuts a trapezoid perpendicular to its slanted side too', () => {
        expectPlotsExactlyCoverSite(TRAPEZOID, plots.cutPlots(TRAPEZOID, { plotWidthM: 20 }));
        expectPlotsExactlyCoverSite(TRAPEZOID, plots.cutPlots(TRAPEZOID, { frontageEdgeIndex: 1, plotWidthM: 7 }));
    });

    it('cuts an L-shaped site with no empty plots', () => {
        for (const edge of [0, 1, 5]) {
            expectPlotsExactlyCoverSite(L_SHAPE, plots.cutPlots(L_SHAPE, { frontageEdgeIndex: edge, plotWidthM: 20 }));
        }
    });

    it('splits a strip that crosses both arms of a concave site into separate plots', () => {
        const cut = plots.cutPlots(U_SHAPE, { frontageEdgeIndex: 1, plotWidthM: 20 }); // strips across the arms
        expect(cut).toHaveLength(5); // one across the base, two in each arm
        expectPlotsExactlyCoverSite(U_SHAPE, cut);
    });

    it('merges a sliver into its neighbour', () => {
        // A hook of the peninsula reaches 2 m across the 40 m cut line, cut off from the rest of its
        // strip: on its own it would be a 2 m wide plot.
        const hooked = site([[0, 0], [60, 0], [60, 30], [58, 30], [58, 50], [38, 50], [38, 45], [42, 45], [42, 30], [0, 30]]);
        const cut = plots.cutPlots(hooked, { frontageEdgeIndex: 0, plotWidthM: 20 });
        expect(cut).toHaveLength(3);
        cut.forEach(p => expect(p.properties.frontageM).toBeGreaterThanOrEqual(10));
        expectPlotsExactlyCoverSite(hooked, cut);
    });

    it('limits the plots to depthM from the frontage line', () => {
        const cut = plots.cutPlots(RECT, { plotWidthM: 20, depthM: 25 });
        const total = cut.reduce((sum, p) => sum + areaOf(p), 0);
        expect(total).toBeCloseTo(100 * 25, -1);
        cut.forEach(p => { const [, s, , n] = turf.bbox(p); expect((n - s) / MY).toBeCloseTo(25, 1); });
    });

    it('refuses a missing width or a bad site', () => {
        expect(() => plots.cutPlots(RECT, {})).toThrow(RangeError);
        expect(() => plots.cutPlots({ type: 'Point', coordinates: [0, 0] }, { plotWidthM: 20 })).toThrow(TypeError);
        expect(() => plots.cutPlots(RECT, { plotWidthM: 20, frontageEdgeIndex: 9 })).toThrow(RangeError);
    });
});

describe('frontage from streets', () => {
    // RECT's edges: 0 south (y = 0), 1 east (x = 100), 2 north (y = 40), 3 west (x = 0).
    const street = (name, points, extra = {}) => ({
        type: 'Feature',
        properties: { name, highway_type: 'residential', ...extra },
        geometry: { type: 'LineString', coordinates: points.map(deg) }
    });

    it('faces the street along an edge, with its name and distance', () => {
        const result = plots.frontageFromStreets(RECT, [street('Ilica', [[-50, -8], [150, -8]])]);
        expect(result).toMatchObject({ frontageEdgeIndex: 0, basis: 'street', street: { name: 'Ilica', highway: 'residential' } });
        expect(result.distanceM).toBeCloseTo(8, 0);
    });

    it('picks the street side over the longest edge', () => {
        // The south edge (index 0) ties for the longest; the street runs along the north.
        expect(plots.defaultFrontageEdge(RECT)).toBe(0);
        const result = plots.frontageFromStreets(RECT, [street('Vlaška', [[-20, 47], [120, 47]])]);
        expect(result).toMatchObject({ frontageEdgeIndex: 2, basis: 'street', street: { name: 'Vlaška' } });
    });

    it('on a corner site the long edge on a street beats a short one nearer another', () => {
        const streets = [street('Short', [[108, -30], [108, 70]]), street('Long', [[-20, 55], [120, 55]])];
        const scores = plots.frontageScores(RECT, streets);
        expect(scores.map(s => s.index)).toEqual([2, 1]);
        expect(plots.frontageFromStreets(RECT, streets).street.name).toBe('Long');
    });

    it('a parallel street a little farther beats a perpendicular one at the midpoint', () => {
        const streets = [street('Across', [[105, 20], [200, 20]]), street('Along', [[112, -40], [112, 80]])];
        const result = plots.frontageFromStreets(RECT, streets);
        expect(result).toMatchObject({ frontageEdgeIndex: 1, street: { name: 'Along' } });
    });

    it('falls back to the longest edge when no street faces the site', () => {
        expect(plots.frontageFromStreets(RECT, [])).toEqual({ frontageEdgeIndex: 0, basis: 'longest' });
        // too far
        expect(plots.frontageFromStreets(RECT, [street('Far', [[-20, 75], [120, 75]])]).basis).toBe('longest');
        // perpendicular only
        expect(plots.frontageFromStreets(RECT, [street('Across', [[105, 20], [200, 20]])]).basis).toBe('longest');
        // through the site, not past it
        expect(plots.frontageFromStreets(RECT, [street('Through', [[-50, 20], [150, 20]])]).basis).toBe('longest');
    });

    it('reads the interior side of a clockwise ring too', () => {
        const clockwise = site([[0, 0], [0, 40], [100, 40], [100, 0]]);
        const edges = plots.frontageEdges(clockwise);
        const result = plots.frontageFromStreets(clockwise, [street('Ilica', [[-50, -8], [150, -8]])]);
        expect(result.basis).toBe('street');
        const edge = edges[result.frontageEdgeIndex];
        expect(toM(edge.a)[1]).toBeCloseTo(0, 6);
        expect(toM(edge.b)[1]).toBeCloseTo(0, 6);
    });

    it('reports an unnamed street by its kind, and reads MultiLineStrings and street_name', () => {
        const unnamed = { type: 'Feature', properties: { highway: 'service' }, geometry: { type: 'MultiLineString', coordinates: [[[-50, -6], [150, -6]].map(deg)] } };
        expect(plots.frontageFromStreets(RECT, [unnamed]).street).toEqual({ name: null, highway: 'service', id: null });
        const register = { type: 'Feature', properties: { street_name: 'Ulica grada Vukovara', street_id: 'Z1' }, geometry: { type: 'LineString', coordinates: [[-50, 46], [150, 46]].map(deg) } };
        expect(plots.frontageFromStreets(RECT, [register]).street).toEqual({ name: 'Ulica grada Vukovara', highway: null, id: 'Z1' });
    });

    it('cuts the plots along the chosen street edge', () => {
        const { frontageEdgeIndex } = plots.frontageFromStreets(RECT, [street('Vlaška', [[-20, 47], [120, 47]])]);
        const cut = plots.cutPlots(RECT, { frontageEdgeIndex, plotWidthM: 20 });
        expect(cut).toHaveLength(5);
        cut.forEach(plot => expect(plot.properties.frontageM).toBeCloseTo(20, 0));
    });
});
