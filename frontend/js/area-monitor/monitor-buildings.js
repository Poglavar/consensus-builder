// Counts the building footprints that actually fall inside a monitored area (the /buildings endpoint
// returns everything in the polygon's bounding rectangle, which over-counts an irregular monitor).
// Pure turf read from the runtime global — GeoJSON in, {count, features} out — so it is unit-testable.
// area-monitor/ui.js fetches the footprints; this clips them to the monitor polygon before display.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.AreaMonitorBuildings = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function getTurf() {
        return (typeof turf !== 'undefined') ? turf : (typeof window !== 'undefined' ? window.turf : null);
    }

    function featureList(fc) {
        if (Array.isArray(fc)) return fc;
        if (fc && Array.isArray(fc.features)) return fc.features;
        return [];
    }

    // Keep only footprints whose representative point lies within `polygon` (a GeoJSON Polygon/
    // MultiPolygon or Feature). Returns { count, features }. On any failure the input is passed
    // through unclipped rather than lost, so a count is always shown.
    function countBuildingsInPolygon(fc, polygon) {
        const features = featureList(fc);
        const t = getTurf();
        const poly = polygon && polygon.type === 'Feature' ? polygon : (polygon ? { type: 'Feature', properties: {}, geometry: polygon } : null);
        if (!t || !poly || !poly.geometry) {
            return { count: features.length, features };
        }
        const inside = [];
        features.forEach(feature => {
            if (!feature || !feature.geometry) return;
            let point = null;
            try {
                point = t.pointOnFeature(feature);
            } catch (_) {
                try { point = t.centroid(feature); } catch (_) { point = null; }
            }
            if (!point) return;
            try {
                if (t.booleanPointInPolygon(point, poly)) inside.push(feature);
            } catch (_) { /* skip a bad geometry, don't fail the whole count */ }
        });
        return { count: inside.length, features: inside };
    }

    return { countBuildingsInPolygon };
});
