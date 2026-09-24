// Client-side mirror of the backend's viewport-size guard, so the map never asks for a view the
// API would reject with a 400. Pure (no DOM): the government-roads layer checks it before fetching.
(function (global) {
    'use strict';

    // Must equal backend/utils/helpers.js MAX_VIEW_BBOX_KM2 (a test pins the two together).
    const MAX_VIEW_BBOX_KM2 = 400;

    // Same formula as backend/utils/helpers.js wgs84BboxAreaKm2 (equirectangular at mid-latitude).
    function wgs84BboxAreaKm2(minLon, minLat, maxLon, maxLat) {
        const midLatRad = ((minLat + maxLat) / 2) * Math.PI / 180;
        const widthKm = Math.abs(maxLon - minLon) * 111.32 * Math.cos(midLatRad);
        const heightKm = Math.abs(maxLat - minLat) * 110.57;
        return widthKm * heightKm;
    }

    // /planned-road takes an EPSG:3765 (metres) bbox string and measures it as a metric rectangle —
    // backend/routes/planned-roads.js. Returns null for anything unparseable (the backend 400s it too).
    function metricBboxAreaKm2(bbox) {
        const parts = String(bbox == null ? '' : bbox).split(',').map(v => Number(v.trim()));
        if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null;
        const [minX, minY, maxX, maxY] = parts;
        if (minX >= maxX || minY >= maxY) return null;
        return ((maxX - minX) * (maxY - minY)) / 1e6;
    }

    // Leaflet-bounds-shaped input ({getSouthWest, getNorthEast}) → km², or null.
    function boundsAreaKm2(bounds) {
        if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof bounds.getNorthEast !== 'function') return null;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const values = [sw && sw.lng, sw && sw.lat, ne && ne.lng, ne && ne.lat];
        if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
        return wgs84BboxAreaKm2(sw.lng, sw.lat, ne.lng, ne.lat);
    }

    function isViewTooLarge(areaKm2, maxKm2 = MAX_VIEW_BBOX_KM2) {
        return typeof areaKm2 === 'number' && Number.isFinite(areaKm2) && areaKm2 > maxKm2;
    }

    const api = { MAX_VIEW_BBOX_KM2, wgs84BboxAreaKm2, metricBboxAreaKm2, boundsAreaKm2, isViewTooLarge };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.ViewBboxLimit = api;
})(typeof window !== 'undefined' ? window : globalThis);
