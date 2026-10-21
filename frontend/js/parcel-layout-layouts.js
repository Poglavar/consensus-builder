// The automatic layouts of the parcel-layout editor, as pure geometry: equal plots swept across the
// pool, and the Schelling plan's plots clipped to the pool with the ground they leave as plots too.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelLayoutLayouts = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const COUNT = Object.freeze({ min: 2, max: 64 });
    const load = (name, file) => root[name] || (typeof require === 'function' ? require(file) : null);
    const asFeature = value => (value && value.type === 'Feature') ? value : { type: 'Feature', properties: {}, geometry: value };

    // The separate polygons of a Polygon or MultiPolygon geometry.
    function parts(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry];
        if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }));
        return [];
    }

    function clampCount(value) {
        const count = Math.round(Number(value));
        if (!Number.isFinite(count)) return COUNT.min;
        return Math.min(COUNT.max, Math.max(COUNT.min, count));
    }

    function minPlotAreaM2() {
        const validation = load('ParcelLayoutValidation', './parcel-layout-validation.js');
        return validation ? validation.MIN_PLOT_AREA_M2 : 1;
    }

    // A clip that throws is a ClipFailure (parcel-arrangement.js), never "no overlap": a layout with
    // a plot silently left out would not tile its pool.
    function clip(turf, operation, a, b, site) {
        try { return turf[operation](a, b); } catch (error) {
            const arrangement = (typeof window !== 'undefined' && window.__parcelArrangement)
                || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
            throw arrangement ? arrangement.clipFailure(operation, error, { site }, [a, b]) : error;
        }
    }

    // Union a list of features pairwise, so the intermediate shapes stay small.
    function unionAll(turf, features) {
        let layer = features.slice();
        while (layer.length > 1) {
            const next = [];
            for (let i = 0; i < layer.length; i += 2) {
                next.push(i + 1 < layer.length ? clip(turf, 'union', layer[i], layer[i + 1], 'parcel-layout-layouts.union') : layer[i]);
            }
            layer = next;
        }
        return layer[0] || null;
    }

    /**
     * Equal plots: the pool cut into `count` strips of equal area by the sweep line
     * (reparcellization-slice.js), the strips running toward `bearing` (degrees, 0 = north) about
     * `pivot` [lng, lat]. deps = { turf, computeFeatureArea, ReparcellizationSlice }.
     * Returns [{ geometry, source: 'equal' }], one per strip that holds land.
     */
    function equalPlots(pool, count, bearing, pivot, deps = {}) {
        const slicer = deps.ReparcellizationSlice || load('ReparcellizationSlice', './reparcellization-slice.js');
        const n = clampCount(count);
        // The slicer divides the pool by shares; equal plots are n shares of 1/n.
        const shares = Array.from({ length: n }, () => ({ percent: 1 / n }));
        const options = { turf: deps.turf, computeFeatureArea: deps.computeFeatureArea, pivot };
        const strips = bearing && Array.isArray(pivot)
            ? slicer.sliceAlongBearing(asFeature(pool), shares, bearing, options)
            : slicer.sliceWithSweepLine(asFeature(pool), shares, options);
        return strips.map(strip => ({ geometry: strip.geometry, source: 'equal' }));
    }

    /**
     * Schelling plots: the plots of Schelling plan `plan` (schelling-grid.js planFor) at plot level
     * `level` (null = whole blocks) that touch the pool, each clipped to it, plus the pool ground
     * they leave uncovered (the street strips) as plots of source 'schelling-remainder', so the
     * result tiles the pool. Pieces under the minimum plot area are not plots: a clipped sliver is
     * left to the remainder, and a remainder sliver joins the neighbour it shares a border with.
     * deps = { turf, SchellingGrid }. Returns { plots: [{ geometry, source }], code }.
     */
    function schellingPlots(pool, plan, level, deps = {}) {
        const turf = deps.turf || root.turf;
        const grid = deps.SchellingGrid || load('SchellingGrid', './parcels/schelling-grid.js');
        const minArea = minPlotAreaM2();
        const area = geometry => turf.area(asFeature(geometry));
        const poolFeature = asFeature(pool && pool.type === 'Feature' ? pool.geometry : pool);
        const bbox = turf.bbox(poolFeature);
        const planPlots = level === null
            ? grid.featuresInBbox(plan, bbox).filter(feature => feature.properties.kind === 'block')
            : grid.plotsInBbox(plan, bbox, level);
        const plots = [];
        for (const planPlot of planPlots) {
            const hit = clip(turf, 'intersect', poolFeature, planPlot, 'parcel-layout-layouts.schellingPlot');
            if (!hit) continue;
            parts(hit.geometry).forEach(part => {
                if (area(part) >= minArea) plots.push({ geometry: part, source: 'schelling' });
            });
        }
        const covered = unionAll(turf, plots.map(plot => asFeature(plot.geometry)));
        const rest = covered ? clip(turf, 'difference', poolFeature, covered, 'parcel-layout-layouts.remainder') : poolFeature;
        const remainders = [];
        parts(rest && rest.geometry).forEach(part => {
            const partArea = area(part);
            if (!(partArea > 0)) return;
            if (partArea >= minArea) remainders.push({ geometry: part, source: 'schelling-remainder' });
            else mergeSliver(turf, part, plots.concat(remainders));
        });
        return { plots: plots.concat(remainders), code: plan.code };
    }

    // A remainder too small to be a plot joins the first neighbour whose union with it is still one
    // polygon (they share a border, not just a corner). With no such neighbour it is left out: its
    // area is under the minimum plot area, within the tiling tolerance.
    function mergeSliver(turf, sliver, candidates) {
        const sliverFeature = asFeature(sliver);
        const box = turf.bbox(sliverFeature);
        for (const candidate of candidates) {
            const other = turf.bbox(asFeature(candidate.geometry));
            if (other[0] > box[2] || other[2] < box[0] || other[1] > box[3] || other[3] < box[1]) continue;
            const merged = clip(turf, 'union', asFeature(candidate.geometry), sliverFeature, 'parcel-layout-layouts.sliver');
            if (merged && merged.geometry && merged.geometry.type === 'Polygon') {
                candidate.geometry = merged.geometry;
                return true;
            }
        }
        return false;
    }

    return { equalPlots, schellingPlots, clampCount, COUNT };
});
