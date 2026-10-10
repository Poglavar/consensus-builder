// One local frame about an anchor: WGS84 degrees ⇄ ground metres. It is the AFFINE tangent plane
// of the metric frame at the anchor (metric-frame.js, projections.md §2): the WGS84 ellipsoid's true
// metres per degree of latitude (meridional radius M) and of longitude (N·cos φ) at the anchor. It
// replaces the old fixed 110 540 / 111 320·cos φ, which was 0.5% off at 45° in latitude alone.
//
// Affine on purpose: reparcellization-slice.js rotates a pool through this frame and needs straight
// lng/lat edges to stay straight, so a cut point lands back on its edge to float precision (a
// transverse Mercator would not be affine in lng/lat). The price is distortion growing with distance
// from the anchor — ~3e-5 at 400 m, below the 5e-5 construction tolerance for a building block, so
// use it for local work only; anything bigger is built in metric-frame.js itself.
//
// Several building tools re-implemented this inline (building-blocks.js, row-house.js) and two others
// used Leaflet's Web-Mercator CRS instead (single-building.js, three-mode.js) — and Mercator inflates
// distance by 1/cos(lat), ≈1.43× at Zagreb's latitude, so a "20 m" building built in Mercator metres
// is ~14 m on the ground. Pure math — no DOM, no Leaflet — so it is unit-tested headless.

(function (global) {
    'use strict';

    const A = 6378137;
    const F = 1 / 298.257223563;
    const E2 = F * (2 - F);

    // A frame anchored at (anchorLng, anchorLat). toMeters maps a lng/lat to [x,y] ground metres
    // east/north of the anchor; toDegrees is its inverse.
    function makeLocalFrame(anchorLng, anchorLat) {
        const phi = anchorLat * Math.PI / 180;
        const w = 1 - E2 * Math.sin(phi) * Math.sin(phi);
        const metersPerDegLat = (A * (1 - E2) / Math.pow(w, 1.5)) * Math.PI / 180;
        const metersPerDegLng = (A / Math.sqrt(w)) * Math.cos(phi) * Math.PI / 180;
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
