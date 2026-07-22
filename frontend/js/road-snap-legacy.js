// Turns the existing-road reference layer's GeoJSON (osm_road LineStrings) into snap segments the
// road-drawing tool can start a new road from — so a proposed road can begin exactly on an existing
// one. Pure GeoJSON → [{ segment: [{lat,lng}...] }] conversion, no DOM/map, so it is unit-testable.
// legacy-road-centerlines.js feeds it the fetched features; road-drawing.js consumes the segments.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RoadSnapLegacy = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function lineToSegment(coords) {
        if (!Array.isArray(coords)) return null;
        const seg = [];
        coords.forEach(pt => {
            if (!Array.isArray(pt) || pt.length < 2) return;
            const lng = Number(pt[0]);
            const lat = Number(pt[1]);
            if (Number.isFinite(lng) && Number.isFinite(lat)) seg.push({ lat, lng });
        });
        return seg.length >= 2 ? seg : null;
    }

    // geojson: a FeatureCollection (or array of features) of LineString/MultiLineString roads.
    // Returns [{ segment: [{lat,lng}...], legacy: true }] — one entry per (multi)line part.
    function geojsonToSnapSegments(geojson) {
        const features = Array.isArray(geojson) ? geojson
            : (geojson && Array.isArray(geojson.features) ? geojson.features : []);
        const entries = [];
        features.forEach(feature => {
            const geom = feature && feature.geometry;
            if (!geom || !geom.coordinates) return;
            if (geom.type === 'LineString') {
                const seg = lineToSegment(geom.coordinates);
                if (seg) entries.push({ segment: seg, legacy: true });
            } else if (geom.type === 'MultiLineString') {
                geom.coordinates.forEach(line => {
                    const seg = lineToSegment(line);
                    if (seg) entries.push({ segment: seg, legacy: true });
                });
            }
        });
        return entries;
    }

    return { geojsonToSnapSegments };
});
