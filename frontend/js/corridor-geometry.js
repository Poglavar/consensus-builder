// Pure road/corridor geometry, lifted out of road-drawing.js so it can be unit-tested headless.
// Everything here is plain math over {lat,lng} points and HTRS96 metres — the only couplings are
// the projection functions (wgs84ToHTRS96 / htrs96ToWGS84) and Leaflet's L.latLng factory, both of
// which are resolved from injected deps (node tests) or the browser globals. No map, no DOM.
//
// This module starts with createRectangularRoadSegment because it carried a live bug: the
// degenerate near-zero-length branch picked its direction with Math.random(), so two clicks in the
// same spot produced a different saved polygon — and a different geometryHash — on every run.
// proposal-manager.js had a second, DIVERGED copy that returned null in that case instead. One
// deterministic copy ends both problems.

(function (global) {
    'use strict';

    function resolveDep(deps, name) {
        if (deps && typeof deps[name] === 'function') return deps[name];
        if (typeof global[name] === 'function') return global[name];
        return null;
    }

    function makeLatLng(deps, lat, lng) {
        if (deps && typeof deps.latLng === 'function') return deps.latLng(lat, lng);
        if (global.L && typeof global.L.latLng === 'function') return global.L.latLng(lat, lng);
        return { lat, lng };
    }

    function isValidHtrsPoint(point) {
        return Array.isArray(point) && point.length === 2 && isFinite(point[0]) && isFinite(point[1]);
    }

    // Build the WGS84 corner ring of a width-wide rectangle running from point1 to point2.
    // Returns an array of latLng corners (closed ring) or null if the inputs can't form one.
    // deps (optional): { wgs84ToHTRS96, htrs96ToWGS84, latLng } — defaults to the browser globals.
    function createRectangularRoadSegment(point1, point2, width, deps = {}) {
        const wgs84ToHTRS96 = resolveDep(deps, 'wgs84ToHTRS96');
        const htrs96ToWGS84 = resolveDep(deps, 'htrs96ToWGS84');
        if (!wgs84ToHTRS96 || !htrs96ToWGS84) {
            console.warn('createRectangularRoadSegment: projection functions unavailable');
            return null;
        }

        if (!point1 || !point2 || !isFinite(width) || width <= 0) {
            console.warn('Invalid inputs to createRectangularRoadSegment');
            return null;
        }
        if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
            !isFinite(point2.lat) || !isFinite(point2.lng)) {
            console.warn('Invalid coordinates in createRectangularRoadSegment');
            return null;
        }

        const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
        let htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);
        if (!isValidHtrsPoint(htrsPoint1) || !isValidHtrsPoint(htrsPoint2)) {
            console.warn('Invalid HTRS points in createRectangularRoadSegment');
            return null;
        }

        let dx = htrsPoint2[0] - htrsPoint1[0];
        let dy = htrsPoint2[1] - htrsPoint1[1];
        let length = Math.sqrt(dx * dx + dy * dy);

        // Near-zero-length: nudge the far point a fixed 10 cm DUE EAST so the rectangle is still
        // well-formed. Deterministic on purpose — this was Math.random() and made the footprint
        // (and its geometryHash) irreproducible for coincident clicks.
        if (length < 0.001) {
            const minLength = 0.1; // 10 cm
            htrsPoint2 = [htrsPoint1[0] + minLength, htrsPoint1[1]];
            dx = minLength;
            dy = 0;
            length = minLength;
        }

        const perpX = -dy / length;
        const perpY = dx / length;
        const halfWidth = width / 2;

        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth],
            [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth],
            [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth],
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth],
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]
        ];

        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(makeLatLng(deps, lat, lng));
            }
        }

        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }
        return wgsCorners;
    }

    const api = { createRectangularRoadSegment, isValidHtrsPoint };

    if (typeof window !== 'undefined') {
        window.CorridorGeometry = api;
        window.createRectangularRoadSegment = createRectangularRoadSegment;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
