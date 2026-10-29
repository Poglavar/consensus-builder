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

    return Object.freeze({ GRID_DECIMALS, snapCoordinates, snapGeometry, snapFeature });
});
