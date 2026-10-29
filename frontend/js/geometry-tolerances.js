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
    // diameter has area π(w/2)², so anything smaller cannot hold one and skips the buffer. And every
    // point within r of the boundary lies in one of the n stadiums around its edges, of total area at
    // most 2rP + nπr²; anything larger holds a point farther than r from the boundary, so it is
    // ground without the buffer (most parcels and pieces, which leaves the buffer to thin shapes).
    function isGround(t, feature, toleranceM = 0) {
        if (!feature || !t) return false;
        const widthM = Math.max(Number(toleranceM) || 0, NOISE_M);
        const r = widthM / 2;
        const area = t.area(feature);
        if (!(area >= Math.PI * r * r)) return false;
        const g = feature.geometry || feature;
        let vertices = 0;
        const count = c => { if (typeof c[0] === 'number') vertices += 1; else c.forEach(count); };
        if (g && Array.isArray(g.coordinates)) count(g.coordinates);
        let perimeterM = Infinity;
        try { perimeterM = t.length(feature, { units: 'kilometers' }) * 1000; } catch (_) { perimeterM = Infinity; }
        if (area > 2 * r * perimeterM + vertices * Math.PI * r * r) return true;
        return survivesInwardBuffer(t, feature, r);
    }

    // The one answer to "does `shape` take, stand on, consume or anchor to `parcel`": their overlap,
    // cut by the shared clip (parcel-arrangement.js clipWith, on this grid), is ground. `context`
    // names the caller when the clip fails.
    function reachesInto(t, shape, parcel, toleranceM = 0, context = {}) {
        if (!shape || !parcel || boxesApart(t, shape, parcel)) return false;
        const overlap = arrangementApi().clipWith(t, 'intersect', shape, parcel, { site: 'geometry-tolerances.reachesInto', ...context });
        return !!(overlap && overlap.geometry) && isGround(t, overlap, toleranceM);
    }

    // The part of `shape` that none of `covers` covers, each cut by the shared clip, or null when
    // nothing is left. "Does the shape stand wholly on these" is then !isGround(t, uncoveredBy(...)).
    function uncoveredBy(t, shape, covers, context = {}) {
        let rest = asFeature(shape);
        for (const cover of covers || []) {
            if (!rest) return null;
            if (!cover || boxesApart(t, rest, cover)) continue;
            rest = asFeature(arrangementApi().clipWith(t, 'difference', rest, cover, { site: 'geometry-tolerances.uncoveredBy', ...context }));
        }
        return rest;
    }

    // A formed piece: `shape` cut to the parcels it consumes (`hosts`), by the shared clip. What is
    // cut off is what uncoveredBy leaves, which the caller has already judged debris
    // (!isGround(uncoveredBy(...))), so no vertex of the piece lies outside its own hosts.
    function cutTo(t, shape, hosts, context = {}) {
        const piece = asFeature(shape);
        const rest = uncoveredBy(t, piece, hosts, context);
        if (!rest) return piece;
        return asFeature(arrangementApi().clipWith(t, 'difference', piece, rest, { site: 'geometry-tolerances.cutTo', ...context }));
    }

    // A design record's own allowance (its toleranceM), normalized as binding normalizes it
    // (site-binding.js normalizeTolerance), so applying a design honours exactly what binding did.
    function designToleranceM(record) {
        const binding = (typeof window !== 'undefined' && window.__siteBinding)
            || (typeof require === 'function' ? require('./proposals/site-binding.js') : null);
        return binding.normalizeTolerance(record && record.toleranceM);
    }

    function arrangementApi() {
        return (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    }

    function asFeature(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry ? value : null;
        return value.type ? { type: 'Feature', properties: {}, geometry: value } : null;
    }

    // Shapes whose bounding boxes are apart share no ground; four comparisons save a clip.
    function boxesApart(t, a, b) {
        let x = null;
        let y = null;
        try { x = t.bbox(a); y = t.bbox(b); } catch (_) { return false; }
        return x[0] > y[2] || y[0] > x[2] || x[1] > y[3] || y[1] > x[3];
    }

    return Object.freeze({ GRID_DECIMALS, NOISE_M, snapCoordinates, snapGeometry, snapFeature, survivesInwardBuffer, isGround, reachesInto, uncoveredBy, cutTo, designToleranceM });
});
