// Decides whether a map viewport needs fresh lane-topology evidence: it refuses spans the backend
// would reject, skips viewports already covered by what is loaded, and pads the fetched bbox so
// small pans stay free. Pure geometry so the auto-load rules can be tested without a browser.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyViewport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Mirrors MAX_BBOX_SPAN_DEG in backend/routes/lane-topology.js. The backend answers anything
    // larger with a 400, so the client refuses to ask rather than auto-firing failing requests.
    const MAX_SPAN_DEG = 0.08;
    const DEFAULT_PAD_RATIO = 0.25;
    const PRECISION = 7;

    function isBbox(bbox) {
        return Array.isArray(bbox)
            && bbox.length === 4
            && bbox.every(value => typeof value === 'number' && Number.isFinite(value))
            && bbox[2] > bbox[0]
            && bbox[3] > bbox[1];
    }

    function bboxSpan(bbox) {
        return [bbox[2] - bbox[0], bbox[3] - bbox[1]];
    }

    function round(value) {
        return Number(value.toFixed(PRECISION));
    }

    function bboxContains(outer, inner) {
        return outer[0] <= inner[0]
            && outer[1] <= inner[1]
            && outer[2] >= inner[2]
            && outer[3] >= inner[3];
    }

    // Grows the bbox by `ratio` of its own size, never past `maxSpanDeg` or the world edges, so a
    // pan of less than half the padding reuses what is already loaded instead of refetching.
    function padBbox(bbox, ratio, maxSpanDeg) {
        const pad = typeof ratio === 'number' && ratio >= 0 ? ratio : DEFAULT_PAD_RATIO;
        const maxSpan = typeof maxSpanDeg === 'number' && maxSpanDeg > 0 ? maxSpanDeg : MAX_SPAN_DEG;
        const [lonSpan, latSpan] = bboxSpan(bbox);
        const padLon = Math.max(0, Math.min(lonSpan * pad / 2, (maxSpan - lonSpan) / 2));
        const padLat = Math.max(0, Math.min(latSpan * pad / 2, (maxSpan - latSpan) / 2));
        return [
            round(Math.max(-180, bbox[0] - padLon)),
            round(Math.max(-90, bbox[1] - padLat)),
            round(Math.min(180, bbox[2] + padLon)),
            round(Math.min(90, bbox[3] + padLat))
        ];
    }

    // { action: 'load'|'skip', reason, bbox } — 'bbox' is what should be requested on a load.
    function planViewportLoad(options) {
        const viewport = options?.viewport;
        const maxSpanDeg = typeof options?.maxSpanDeg === 'number' ? options.maxSpanDeg : MAX_SPAN_DEG;
        if (!isBbox(viewport)) return { action: 'skip', reason: 'invalid', bbox: null };

        const [lonSpan, latSpan] = bboxSpan(viewport);
        if (lonSpan > maxSpanDeg || latSpan > maxSpanDeg) {
            return { action: 'skip', reason: 'too-large', bbox: null };
        }

        const loaded = isBbox(options?.loaded) ? options.loaded : null;
        if (loaded && !options?.force && bboxContains(loaded, viewport)) {
            return { action: 'skip', reason: 'covered', bbox: loaded };
        }

        return {
            action: 'load',
            reason: loaded ? 'moved' : 'first',
            bbox: padBbox(viewport, options?.padRatio, maxSpanDeg)
        };
    }

    return {
        MAX_SPAN_DEG,
        DEFAULT_PAD_RATIO,
        isBbox,
        bboxSpan,
        bboxContains,
        padBbox,
        planViewportLoad
    };
});
