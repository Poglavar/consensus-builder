// Geometry checks for a parcel-layout design: every plot is a valid polygon of at least the minimum
// plot area, and together the plots tile the pool (inside it, covering it, never overlapping).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelLayoutValidation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    // A plot smaller than this is a sliver, never land anyone could use. parcel-layout-layouts.js
    // drops generated pieces under the same limit.
    const MIN_PLOT_AREA_M2 = 1;
    const MAX_PLOTS = 1000;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const squareMetres = value => `${Math.round(value * 10) / 10} m²`;
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
    // Match the fabric's absolute plus one-part-per-million conservation budget. Overlap is
    // checked separately, so a gap and an overlapping plot cannot cancel each other numerically.
    const coverageTolerance = area => 1 + area * 1e-6;
    const overlapTolerance = area => Math.min(coverageTolerance(area), Math.max(0.01, area * 1e-6));

    // A Polygon/MultiPolygon (or a Feature of one) as a Feature, or an Error saying what is wrong.
    function polygon(value, turf) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('Use polygon geometry.');
        const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!Array.isArray(parts) || !parts.length) throw new Error('Polygon geometry is empty.');
        let vertices = 0;
        const polygons = parts.map(rings => {
            if (!Array.isArray(rings) || !rings.length) throw new Error('Polygon rings are missing.');
            for (const ring of rings) {
                if (!Array.isArray(ring) || ring.length < 4 || (vertices += ring.length) > 100000
                    || ring.some(point => !Array.isArray(point) || point.length < 2 || !point.every(finite)
                        || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)
                    || ring[0].length !== ring[ring.length - 1].length
                    || ring[0].some((n, i) => n !== ring[ring.length - 1][i])
                    || new Set(ring.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size < 3) {
                    throw new Error('Rings need at least three distinct vertices and closed, finite longitude/latitude coordinates.');
                }
            }
            const part = feature({ type: 'Polygon', coordinates: rings });
            if (turf.kinks(part).features.length) throw new Error('Polygon boundaries intersect themselves.');
            const shell = feature({ type: 'Polygon', coordinates: [rings[0]] });
            const holes = rings.slice(1).map(ring => feature({ type: 'Polygon', coordinates: [ring] }));
            for (let i = 0; i < holes.length; i++) {
                const outside = turf.difference(holes[i], shell);
                if (outside && turf.area(outside) > 0.01) throw new Error('A hole lies outside its polygon.');
                for (let j = 0; j < i; j++) {
                    const hit = turf.intersect(holes[i], holes[j]);
                    if (hit && turf.area(hit) > 0.01) throw new Error('Polygon holes overlap.');
                }
            }
            if (!(turf.area(part) > 0)) throw new Error('A polygon must have positive area.');
            return part;
        });
        for (let i = 0; i < polygons.length; i++) for (let j = 0; j < i; j++) {
            const hit = turf.intersect(polygons[i], polygons[j]);
            if (hit && turf.area(hit) > 0.01) throw new Error('Parts of a polygon overlap.');
        }
        return feature(geometry);
    }

    // A clip that throws is recorded as a ClipFailure (counted in clipHealth()); validate() still
    // answers, with an invalid-pool error carrying the clip's message.
    // Plot unions and coverage differences use the shared clip (proposals/parcel-arrangement.js): the
    // same coordinate grid as every other parcel clip, with its coarser retries. A raw turf union of
    // a block's plots with its carved courtyard left a three-point sliver ring and refused the layout.
    function clipped(turf, operation, a, b) {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        if (!api) throw new Error('The parcel clipper is not loaded.');
        return api.clipWith(turf, operation, a, b, { site: 'parcel-layout-validation.pool' });
    }

    /**
     * Check a parcel-layout record ({ pool, plots: [{ geometry }] }) against the geometry rules.
     * options.site is the outline a site subdivision must tile; it replaces plan.pool when given.
     * Returns { valid, errors: [{ code, message, plotIndex?, areaM2? }], warnings, metrics, areas }.
     */
    function validate(plan, options = {}) {
        const errors = [], warnings = [];
        const issue = (code, message, extra = {}) => errors.push({ code, message, ...extra });
        const turf = options.turf || root.turf;
        const plots = Array.isArray(plan?.plots) ? plan.plots : [];
        const metrics = { poolAreaM2: null, plotAreaM2: null, uncoveredAreaM2: null, outsideAreaM2: null, overlapAreaM2: null };
        const areas = [];
        if (!plots.length) issue('missing-plots', 'Add at least one plot.');
        if (plots.length > MAX_PLOTS) issue('too-many-plots', `Use at most ${MAX_PLOTS} plots in one layout.`);
        if (!turf || ['area', 'intersect', 'difference', 'union', 'kinks'].some(key => typeof turf[key] !== 'function')) {
            issue('geometry-unavailable', 'Geometry validation is unavailable. Try again after the map loads.');
            return { valid: false, errors, warnings, metrics, areas };
        }
        if (!plots.length || plots.length > MAX_PLOTS) return { valid: false, errors, warnings, metrics, areas };
        const shapes = [];
        plots.forEach((plot, index) => {
            try {
                shapes[index] = polygon(plot?.geometry, turf);
                areas[index] = turf.area(shapes[index]);
                if (areas[index] < MIN_PLOT_AREA_M2) {
                    issue('plot-too-small', `Plot ${index + 1} is smaller than ${MIN_PLOT_AREA_M2} m².`, { plotIndex: index, areaM2: areas[index] });
                }
            } catch (error) { issue('invalid-plot', `Plot ${index + 1}: ${error.message}`, { plotIndex: index }); }
        });
        // Coverage needs every plot's shape; a broken plot is reported above and stops it here.
        if (shapes.filter(Boolean).length !== plots.length) return { valid: false, errors, warnings, metrics, areas };
        const rawPool = options.site || plan?.pool;
        if (!rawPool) {
            issue('missing-pool', 'The layout has no pool outline.');
            return { valid: false, errors, warnings, metrics, areas };
        }
        try {
            let union = null, overlapAreaM2 = 0;
            for (let i = 0; i < shapes.length; i++) {
                if (union) {
                    const hit = clipped(turf, 'intersect', union, shapes[i]);
                    const area = hit ? turf.area(hit) : 0;
                    overlapAreaM2 += area;
                    if (area > overlapTolerance(areas[i])) issue('overlapping-plots', `Plot ${i + 1} overlaps another plot.`, { plotIndex: i, areaM2: area });
                }
                union = union ? clipped(turf, 'union', union, shapes[i]) : shapes[i];
                if (!union) throw new Error('The union of the plots could not be computed.');
            }
            const pool = polygon(rawPool, turf);
            const area = turf.area(pool);
            const gap = clipped(turf, 'difference', pool, union), outside = clipped(turf, 'difference', union, pool);
            Object.assign(metrics, { poolAreaM2: area, plotAreaM2: areas.reduce((a, b) => a + b, 0),
                uncoveredAreaM2: gap ? turf.area(gap) : 0, outsideAreaM2: outside ? turf.area(outside) : 0, overlapAreaM2 });
            if (metrics.uncoveredAreaM2 > coverageTolerance(area)) {
                issue('coverage-gap', `The plots leave ${squareMetres(metrics.uncoveredAreaM2)} of the pool uncovered.`, { areaM2: metrics.uncoveredAreaM2 });
            }
            if (metrics.outsideAreaM2 > coverageTolerance(area)) {
                issue('coverage-excess', `The plots reach ${squareMetres(metrics.outsideAreaM2)} beyond the pool.`, { areaM2: metrics.outsideAreaM2 });
            }
        } catch (error) { issue('invalid-pool', `The pool could not be validated: ${error.message}`); }
        return { valid: errors.length === 0, errors, warnings, metrics, areas };
    }

    return { validate, polygon, coverageTolerance, overlapTolerance, MIN_PLOT_AREA_M2, MAX_PLOTS };
});
