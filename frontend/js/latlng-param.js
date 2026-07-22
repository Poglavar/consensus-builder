// Parses a ?latlng= URL parameter into a map view, so any location on the planet can be deep-linked
// (e.g. ?latlng=45.8131,15.9775 or ?latlng=45.8131,15.9775,18 with an optional zoom). Pure string in,
// plain object out — no DOM, no map — so it is unit-testable headlessly. map-core.js reads the result
// and flies there on load, ahead of the city-config default view.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LatLngParam = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const LAT_RANGE = 90;
    const LNG_RANGE = 180;
    // Leaflet's usable web-mercator zoom band; anything outside is a typo, not an intent.
    const ZOOM_MIN = 0;
    const ZOOM_MAX = 22;

    // Accepts a raw query string ('?latlng=...' or 'latlng=...'), a URLSearchParams, or the bare
    // value ('45.81,15.98[,zoom]'). Returns { lat, lng, zoom|null } or null when absent/invalid.
    function parseLatLngParam(input) {
        const raw = extractRawValue(input);
        if (!raw) return null;

        const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
        if (parts.length < 2 || parts.length > 3) return null;

        const lat = Number(parts[0]);
        const lng = Number(parts[1]);
        if (!isFiniteInRange(lat, LAT_RANGE) || !isFiniteInRange(lng, LNG_RANGE)) return null;

        let zoom = null;
        if (parts.length === 3) {
            const parsedZoom = Number(parts[2]);
            if (!Number.isFinite(parsedZoom) || parsedZoom < ZOOM_MIN || parsedZoom > ZOOM_MAX) return null;
            zoom = parsedZoom;
        }

        return { lat, lng, zoom };
    }

    function extractRawValue(input) {
        if (input == null) return '';
        if (typeof input === 'object' && typeof input.get === 'function') {
            return (input.get('latlng') || '').trim();
        }
        const str = String(input).trim();
        if (!str) return '';
        // A full/partial query string — let URLSearchParams pull the named param out.
        if (str.indexOf('=') !== -1 || str.indexOf('?') === 0 || str.indexOf('&') !== -1) {
            const search = str.indexOf('?') === 0 ? str.slice(1) : str;
            return (new URLSearchParams(search).get('latlng') || '').trim();
        }
        // Otherwise treat the whole thing as the bare value.
        return str;
    }

    function isFiniteInRange(value, limit) {
        return Number.isFinite(value) && value >= -limit && value <= limit;
    }

    return { parseLatLngParam };
});
