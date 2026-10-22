// The automatic parcel layouts (frontend/js/parcel-layout-layouts.js): equal plots swept across the
// pool, and the Schelling plan's plots clipped to the pool with the street strips as plots too.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const layouts = require('../../frontend/js/parcel-layout-layouts.js');
const { validate } = require('../../frontend/js/parcel-layout-validation.js');
const SchellingGrid = require('../../frontend/js/parcels/schelling-grid.js');
const ReparcellizationSlice = require('../../frontend/js/reparcellization-slice.js');

const LNG0 = 15.97;
const LAT0 = 45.81;
const M_LAT = 111132;
const M_LNG = 111320 * Math.cos(LAT0 * Math.PI / 180);
const at = (east, north) => [LNG0 + east / M_LNG, LAT0 + north / M_LAT];
const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]] });
const area = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
const deps = { turf, ReparcellizationSlice, SchellingGrid };
const tiles = (pool, plots) => validate({ pool, plots }, { turf });

describe('equal plots', () => {
    const pool = box(0, 0, 100, 50);

    it('cuts the pool into the given number of plots of about equal area', () => {
        const plots = layouts.equalPlots(pool, 5, 0, null, deps);
        expect(plots).toHaveLength(5);
        expect(plots.every(plot => plot.source === 'equal')).toBe(true);
        expect(plots.reduce((sum, plot) => sum + area(plot.geometry), 0)).toBeCloseTo(area(pool), 0);
        plots.forEach(plot => expect(Math.abs(area(plot.geometry) / (area(pool) / 5) - 1)).toBeLessThan(0.05));
        expect(tiles(pool, plots).valid).toBe(true);
    });

    it('runs its cuts toward the sweep bearing about the pivot', () => {
        const pivot = turf.centroid(pool).geometry.coordinates;
        const north = layouts.equalPlots(pool, 4, 0, pivot, deps);
        const turned = layouts.equalPlots(pool, 4, 60, pivot, deps);
        expect(turned).toHaveLength(4);
        expect(turned.map(plot => plot.geometry)).not.toEqual(north.map(plot => plot.geometry));
        expect(tiles(pool, turned).valid).toBe(true);
    });

    it('keeps the count between 2 and 64', () => {
        expect(layouts.equalPlots(pool, 1, 0, null, deps)).toHaveLength(2);
        expect([layouts.clampCount(0), layouts.clampCount(7.4), layouts.clampCount(500), layouts.clampCount('x')]).toEqual([2, 7, 64, 2]);
        expect(layouts.COUNT).toEqual({ min: 2, max: 64 });
    });
});

describe('Schelling plots', () => {
    const plan = SchellingGrid.planFor({ lat: LAT0, targetBlockM: 120, streetWidthM: 12 });
    const stepLon = plan.local.stepLonSec / 3600;
    const stepLat = plan.local.stepLatSec / 3600;
    // A local north-south street east of the origin, and the block row it runs through.
    let i = Math.ceil(LNG0 / stepLon);
    while (SchellingGrid.isArterialLon(plan, i)) i += 1;
    const j = Math.floor(LAT0 / stepLat);
    const streetLng = SchellingGrid.lonOfLine(plan, i);
    const south = SchellingGrid.latOfLine(plan, j) + 20 / M_LAT;
    const north = SchellingGrid.latOfLine(plan, j + 1) - 20 / M_LAT;
    // 40 m either side of the street, 20 m clear of the cross streets: the street strip crosses it.
    const across = { type: 'Polygon', coordinates: [[
        [streetLng - 40 / M_LNG, south], [streetLng + 40 / M_LNG, south], [streetLng + 40 / M_LNG, north],
        [streetLng - 40 / M_LNG, north], [streetLng - 40 / M_LNG, south]
    ]] };

    it('clips the plan\'s plots to the pool and makes the street strip a plot, so the layout tiles the pool', () => {
        const { plots, code } = layouts.schellingPlots(across, plan, 3, deps);
        expect(code).toBe(plan.code);
        const remainders = plots.filter(plot => plot.source === 'schelling-remainder');
        expect(remainders).toHaveLength(1);
        // The strip is the street's width across the pool's whole depth.
        const depthM = (north - south) * M_LAT;
        expect(area(remainders[0].geometry)).toBeCloseTo(plan.streetWidthM * depthM, -1);
        expect(plots.filter(plot => plot.source === 'schelling').length).toBeGreaterThan(4);
        expect(plots.reduce((sum, plot) => sum + area(plot.geometry), 0)).toBeCloseTo(area(across), 0);
        const check = tiles(across, plots);
        expect(check.errors).toEqual([]);
        expect(check.metrics.overlapAreaM2).toBeLessThan(0.01);
    });

    it('takes whole blocks when the plan has no plots', () => {
        const { plots } = layouts.schellingPlots(across, plan, null, deps);
        expect(plots.filter(plot => plot.source === 'schelling')).toHaveLength(2);
        expect(plots.filter(plot => plot.source === 'schelling-remainder')).toHaveLength(1);
        expect(tiles(across, plots).valid).toBe(true);
    });

    it('is one plot when the pool lies inside one plan plot', () => {
        const [plot] = SchellingGrid.plotsInBbox(plan, turf.bbox(across), 0);
        const inner = turf.transformScale({ type: 'Feature', properties: {}, geometry: plot.geometry }, 0.5).geometry;
        const { plots } = layouts.schellingPlots(inner, plan, 0, deps);
        expect(plots).toHaveLength(1);
        expect(plots[0].source).toBe('schelling');
        expect(area(plots[0].geometry)).toBeCloseTo(area(inner), 1);
    });

    it('lays out a pool that is all street as one remainder plot', () => {
        const strip = { type: 'Polygon', coordinates: [[
            [streetLng - 3 / M_LNG, south], [streetLng + 3 / M_LNG, south], [streetLng + 3 / M_LNG, north],
            [streetLng - 3 / M_LNG, north], [streetLng - 3 / M_LNG, south]
        ]] };
        const { plots } = layouts.schellingPlots(strip, plan, 3, deps);
        expect(plots.map(plot => plot.source)).toEqual(['schelling-remainder']);
        expect(area(plots[0].geometry)).toBeCloseTo(area(strip), 1);
    });
});
