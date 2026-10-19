// The bounding box a proposal thumbnail frames, shared by the browser capture (map-screenshot.js
// captureViaTileStitch) and the server renderer (backend/thumbnails/tile-stitch.js).
//
// Coordinates reaching this module are GeoJSON [lng, lat]: callers state their input order and
// normalize before calling. Nothing here guesses or "fixes" an order: a box that is not a plausible
// WGS84 box is an error carrying the offending values. (The old guess swapped any box with a
// longitude above 90°, i.e. every proposal east of 90°E such as Tokyo, into an invalid one, and
// silently rotated real places between 40-50°E and 10-20°N.)
//
// Pure: no DOM, no Leaflet. Browser global `window.__thumbnailBbox`; CommonJS in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__thumbnailBbox = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // A single proposal spanning more than this many degrees is a malformed input, not a picture.
    const MAX_SPAN_DEG = 10;

    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function emptyBbox() {
        return { lngMin: Infinity, lngMax: -Infinity, latMin: Infinity, latMax: -Infinity };
    }

    // Grows `bbox` (mutated and returned) by every [lng, lat] position nested anywhere in `coords`
    // (a position, ring, polygon, multipolygon or list of them).
    function extendBbox(bbox, coords) {
        const walk = (node) => {
            if (!Array.isArray(node)) return;
            if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
                if (node[0] < bbox.lngMin) bbox.lngMin = node[0];
                if (node[0] > bbox.lngMax) bbox.lngMax = node[0];
                if (node[1] < bbox.latMin) bbox.latMin = node[1];
                if (node[1] > bbox.latMax) bbox.latMax = node[1];
                return;
            }
            node.forEach(walk);
        };
        walk(coords);
        return bbox;
    }

    function bboxOfLngLat(coords) {
        return extendBbox(emptyBbox(), coords);
    }

    // -> null when the box is a plausible WGS84 box for one proposal, else a reason string.
    function bboxProblem(bbox) {
        if (!bbox) return 'no bbox';
        const { lngMin, lngMax, latMin, latMax } = bbox;
        if (![lngMin, lngMax, latMin, latMax].every(isNum)) return 'no finite coordinates';
        if (lngMin > lngMax || latMin > latMax) return 'min above max';
        if (lngMin < -180 || lngMax > 180) return 'longitude outside [-180, 180]';
        if (latMin < -90 || latMax > 90) return 'latitude outside [-90, 90] (lat/lng swapped?)';
        if (lngMax - lngMin > MAX_SPAN_DEG || latMax - latMin > MAX_SPAN_DEG) {
            return `spans more than ${MAX_SPAN_DEG}° (mixed coordinate orders?)`;
        }
        return null;
    }

    // Throws an Error naming the problem and the values, so a bad input never becomes a bad image.
    function assertValidBbox(bbox, context = 'thumbnail') {
        const problem = bboxProblem(bbox);
        if (!problem) return bbox;
        const values = bbox ? JSON.stringify({ lngMin: bbox.lngMin, lngMax: bbox.lngMax, latMin: bbox.latMin, latMax: bbox.latMax }) : 'null';
        const error = new Error(`[${context}] invalid bounding box: ${problem} ${values}`);
        error.code = 'invalid-thumbnail-bbox';
        error.bbox = bbox;
        throw error;
    }

    // Flattens GeoJSON polygon coordinates (Polygon rings, MultiPolygon, or a list of either) into
    // one [lng, lat] point list, in input order. Used for the mint image's "combined polygon".
    function lngLatPointsOf(coords) {
        const points = [];
        const walk = (node) => {
            if (!Array.isArray(node)) return;
            if (node.length >= 2 && isNum(node[0]) && isNum(node[1])) {
                points.push([node[0], node[1]]);
                return;
            }
            node.forEach(walk);
        };
        walk(coords);
        return points;
    }

    return { MAX_SPAN_DEG, extendBbox, bboxOfLngLat, bboxProblem, assertValidBbox, lngLatPointsOf };
});
