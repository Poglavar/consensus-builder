// The one coordinate grid every stage puts geometry on (docs/geometry-tolerances.md): parcels when they
// arrive, whatever served them, every clip, and authored geometry when it is saved. Two stages that
// run the same function on the same grid cannot disagree, so they need no tolerance between them.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GeometryTolerances = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // 9 decimal degrees, about 0.1 mm: what the server already serves and the clip grid already
    // used. Rounding is integer rounding, never toFixed, which rounds some halves the other way.
    const GRID_DECIMALS = 9;
    const GRID_FACTOR = 1e9;

    function snapCoordinates(value, factor = GRID_FACTOR) {
        if (!Array.isArray(value)) return value;
        return typeof value[0] === 'number'
            ? value.map(n => Math.round(n * factor) / factor)
            : value.map(entry => snapCoordinates(entry, factor));
    }

    // A geometry with every coordinate on the grid (a new object; GeometryCollections member by member).
    function snapGeometry(geometry, decimals = GRID_DECIMALS) {
        if (!geometry || typeof geometry !== 'object') return geometry;
        if (geometry.type === 'GeometryCollection') {
            return { ...geometry, geometries: (geometry.geometries || []).map(member => snapGeometry(member, decimals)) };
        }
        if (!Array.isArray(geometry.coordinates)) return geometry;
        return { ...geometry, coordinates: snapCoordinates(geometry.coordinates, Math.pow(10, decimals)) };
    }

    // A feature with its geometry on the grid; properties are kept as they are.
    function snapFeature(feature, decimals = GRID_DECIMALS) {
        if (!feature || !feature.geometry) return feature;
        return { ...feature, geometry: snapGeometry(feature.geometry, decimals) };
    }

    // The one noise value. Measured on the published Zagreb designs and the cadastre under them: once
    // everything is on the grid, neighbouring parcels share their edges exactly, cutting leaves debris
    // at most 0.4 mm wide, and the narrowest real reach of a design into a parcel is 39 mm. Ground
    // narrower than this is debris; anything wider is ground. Binding has always used it.
    const NOISE_M = 0.001;

    // turf.buffer (JSTS) returns nothing for a polygon only centimetres across, so a small piece is
    // scaled up about its bbox centre first (uniform in ground metres, since one degree of lng/lat is
    // a constant number of metres locally) and eroded by the scaled radius: erosion commutes with
    // uniform scaling.
    const MIN_BUFFER_EXTENT_M = 50;

    function scaledForBuffer(t, feature) {
        const [minX, minY, maxX, maxY] = t.bbox(feature);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const extentM = Math.max((maxX - minX) * 111320 * Math.cos(cy * Math.PI / 180), (maxY - minY) * 110540);
        if (!(extentM > 0) || extentM >= MIN_BUFFER_EXTENT_M) return { feature, k: 1 };
        const k = MIN_BUFFER_EXTENT_M / extentM;
        const walk = c => (typeof c[0] === 'number' ? [cx + (c[0] - cx) * k, cy + (c[1] - cy) * k] : c.map(walk));
        const g = feature.geometry || feature;
        return { feature: { type: 'Feature', properties: {}, geometry: { type: g.type, coordinates: walk(g.coordinates) } }, k };
    }

    // Whether a circle of radius `radiusM` fits inside `feature` (its inward buffer leaves something).
    function survivesInwardBuffer(t, feature, radiusM) {
        if (!feature) return false;
        if (!(radiusM > 0)) return t.area(feature) > 0;
        const scaled = scaledForBuffer(t, feature);
        let eroded = null;
        try { eroded = t.buffer(scaled.feature, -radiusM * scaled.k, { units: 'meters' }); } catch (_) { eroded = null; }
        return !!(eroded && eroded.geometry && t.area(eroded) > 0);
    }

    // The one answer to "is this ground": somewhere wider than max(toleranceM, NOISE_M). A design's own
    // toleranceM (a per-record allowance, binding.js) widens it; nothing narrows it. A circle of that
    // diameter has area π(w/2)², so anything smaller cannot hold one and skips the buffer.
    function isGround(t, feature, toleranceM = 0) {
        if (!feature || !t) return false;
        const widthM = Math.max(Number(toleranceM) || 0, NOISE_M);
        const area = t.area(feature);
        if (!(area >= Math.PI * (widthM / 2) * (widthM / 2))) return false;
        return survivesInwardBuffer(t, feature, widthM / 2);
    }

    // The one answer to "does `shape` take, stand on, consume or anchor to `parcel`": their overlap,
    // cut by the shared clip (parcel-arrangement.js clipWith, on this grid), is ground. `context`
    // names the caller when the clip fails.
    function reachesInto(t, shape, parcel, toleranceM = 0, context = {}) {
        const arrangement = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        const overlap = arrangement.clipWith(t, 'intersect', shape, parcel, { site: 'geometry-tolerances.reachesInto', ...context });
        return !!(overlap && overlap.geometry) && isGround(t, overlap, toleranceM);
    }

    return Object.freeze({ GRID_DECIMALS, NOISE_M, snapCoordinates, snapGeometry, snapFeature, survivesInwardBuffer, isGround, reachesInto });
});
