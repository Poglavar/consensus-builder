// The parcel-layout geometry rules (frontend/js/parcel-layout-validation.js): plots are valid
// polygons of at least the minimum plot area that tile the pool — inside it, covering it, never
// overlapping — and a site subdivision tiles its site.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { validate, MIN_PLOT_AREA_M2 } = require('../../frontend/js/parcel-layout-validation.js');

// Metres from an origin at 45.81 N, so turf areas are real square metres.
const M_LAT = 111132;
const M_LNG = 111320 * Math.cos(45.81 * Math.PI / 180);
const at = (east, north) => [15.97 + east / M_LNG, 45.81 + north / M_LAT];
const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]] });
const plots = (...geometries) => geometries.map(geometry => ({ geometry, source: 'manual' }));
const codes = result => result.errors.map(error => error.code);
const POOL = box(0, 0, 100, 50);

describe('parcel-layout validation', () => {
    it('accepts plots that tile the pool, and measures it', () => {
        const result = validate({ pool: POOL, plots: plots(box(0, 0, 40, 50), box(40, 0, 100, 50)) }, { turf });
        expect(result).toMatchObject({ valid: true, errors: [], warnings: [] });
        expect(result.metrics.poolAreaM2).toBeCloseTo(turf.area(POOL), 3);
        expect(result.metrics.uncoveredAreaM2).toBeLessThan(0.01);
        expect(result.areas).toHaveLength(2);
    });

    it('needs at least one plot and a pool', () => {
        expect(codes(validate({ pool: POOL, plots: [] }, { turf }))).toEqual(['missing-plots']);
        expect(codes(validate({ plots: plots(POOL) }, { turf }))).toEqual(['missing-pool']);
    });

    it('reports land the plots leave uncovered, with its area', () => {
        const result = validate({ pool: POOL, plots: plots(box(0, 0, 40, 50), box(50, 0, 100, 50)) }, { turf });
        expect(codes(result)).toEqual(['coverage-gap']);
        expect(result.errors[0].areaM2).toBeCloseTo(500, -1);
        expect(result.errors[0].message).toMatch(/^The plots leave 5\d\d(\.\d)? m² of the pool uncovered\.$/);
    });

    it('reports plots that reach beyond the pool', () => {
        const result = validate({ pool: POOL, plots: plots(box(0, 0, 40, 50), box(40, 0, 120, 50)) }, { turf });
        expect(codes(result)).toEqual(['coverage-excess']);
        expect(result.errors[0].areaM2).toBeCloseTo(1000, -1);
    });

    it('reports overlapping plots by number, even when the overlap and a gap would cancel out', () => {
        const result = validate({ pool: POOL, plots: plots(box(0, 0, 60, 50), box(40, 0, 80, 50), box(80, 0, 100, 50)) }, { turf });
        expect(result.errors.find(error => error.code === 'overlapping-plots')).toMatchObject({ plotIndex: 1 });
        expect(result.valid).toBe(false);
    });

    it('refuses a plot under the minimum plot area', () => {
        const sliver = box(0, 0, 0.5, 1);
        expect(turf.area(sliver)).toBeLessThan(MIN_PLOT_AREA_M2);
        const result = validate({ pool: box(0, 0, 10, 1), plots: plots(sliver, box(0.5, 0, 10, 1)) }, { turf });
        expect(result.errors[0]).toMatchObject({ code: 'plot-too-small', plotIndex: 0 });
    });

    it('refuses geometry that is not a polygon, by plot number', () => {
        const bowtie = { type: 'Polygon', coordinates: [[at(0, 0), at(100, 50), at(100, 0), at(0, 50), at(0, 0)]] };
        const result = validate({ pool: POOL, plots: [{ geometry: bowtie }, { geometry: { type: 'Point', coordinates: at(1, 1) } }] }, { turf });
        expect(result.errors.map(error => [error.code, error.plotIndex])).toEqual([['invalid-plot', 0], ['invalid-plot', 1]]);
    });

    it('tolerates a gap under the conservation budget', () => {
        // 0.5 m² of the pool left between two plots is a numerical seam, not missing land.
        const result = validate({ pool: POOL, plots: plots(box(0, 0, 40, 50), box(40.01, 0, 100, 50)) }, { turf });
        expect(result.metrics.uncoveredAreaM2).toBeGreaterThan(0.1);
        expect(result.valid).toBe(true);
    });

    it('checks a subdivision against its site, not the pool it carries', () => {
        const site = box(0, 0, 60, 50);
        const layout = { pool: POOL, poolSource: 'site', plots: plots(box(0, 0, 30, 50), box(30, 0, 60, 50)) };
        expect(validate(layout, { turf }).valid).toBe(false);
        expect(validate(layout, { turf, site }).valid).toBe(true);
    });

    it('allows a pool of separate parts', () => {
        const pool = { type: 'MultiPolygon', coordinates: [box(0, 0, 40, 50).coordinates, box(60, 0, 100, 50).coordinates] };
        expect(validate({ pool, plots: plots(box(0, 0, 40, 50), box(60, 0, 100, 50)) }, { turf }).valid).toBe(true);
    });

    it('says so when there is no geometry engine', () => {
        expect(codes(validate({ pool: POOL, plots: plots(POOL) }, { turf: {} }))).toEqual(['geometry-unavailable']);
    });
});

// A real Zagreb block (32 cadastral parcels, Keep existing borders) with its courtyard carved out as a
// plot of its own. In the page's turf bundle a raw union of these plots produced a three-point sliver
// ring and refused the layout as "The pool outline could not be checked"; the shared parcel clip's
// grid handles it. Node's turf build happens to union them either way, so this guards acceptance,
// not the browser-only failure (verified in the browser, 2026-10-28).
it('accepts a block layout with its courtyard carved out as a plot', () => {
    const layout = require('./fixtures/parcel-layout-courtyard-carve.json');
    const result = validate(layout, { turf });
    expect(result.errors.map(error => error.code)).not.toContain('invalid-pool');
    expect(result.metrics.poolAreaM2).toBeGreaterThan(0);
});
