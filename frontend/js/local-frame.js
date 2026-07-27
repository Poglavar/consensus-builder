// One local tangent-plane frame: WGS84 degrees ⇄ ground metres about an anchor point, using the
// standard 111320·cos(lat) / 110540 metres-per-degree. Several building tools re-implemented this
// inline (building-blocks.js, row-house.js) and two others used Leaflet's Web-Mercator CRS instead
// (single-building.js, three-mode.js) — and Mercator inflates distance by 1/cos(lat), ≈1.43× at
// Zagreb's latitude, so a "20 m" building built in Mercator metres is ~14 m on the ground. This
// module is the one ground-truth frame; adopting it removes that discrepancy.
//
// Pure math — no DOM, no Leaflet — so it is unit-tested headless.

(function (global) {
    'use strict';

    // A frame anchored at (anchorLng, anchorLat). toMeters maps a lng/lat to [x,y] ground metres
    // east/north of the anchor; toDegrees is its inverse.
    function makeLocalFrame(anchorLng, anchorLat) {
        const metersPerDegLng = 111320 * Math.cos(anchorLat * Math.PI / 180);
        const metersPerDegLat = 110540;
        return {
            metersPerDegLng,
            metersPerDegLat,
            toMeters(lng, lat) {
                return [(lng - anchorLng) * metersPerDegLng, (lat - anchorLat) * metersPerDegLat];
            },
            toDegrees(x, y) {
                return [anchorLng + x / metersPerDegLng, anchorLat + y / metersPerDegLat];
            }
        };
    }

    // building-blocks.js-compatible helper: [x,y] metres of (lng,lat) relative to anchor {lng,lat},
    // or null for non-finite input.
    function projectToLocalMeters(lng, lat, anchor) {
        const aLng = anchor?.lng ?? 0;
        const aLat = anchor?.lat ?? 0;
        const ln = Number(lng);
        const lt = Number(lat);
        if (!Number.isFinite(ln) || !Number.isFinite(lt)) return null;
        return makeLocalFrame(aLng, aLat).toMeters(ln, lt);
    }

    const api = { makeLocalFrame, projectToLocalMeters };

    if (typeof window !== 'undefined') {
        window.LocalFrame = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
