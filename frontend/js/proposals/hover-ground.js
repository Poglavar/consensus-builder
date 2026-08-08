// proposals/hover-ground.js — which of a proposal's parcels are the ground it STANDS ON.
//
// A formation mints two kinds of child parcel: the plot its body occupies, and the remainder it
// hands back to the host parcel. A remainder can dwarf the proposal that minted it — UPU Borovje's
// building M1-11 cuts a 2,310 m² plot out of the 58,226 m² cadastral parcel 1791/69 and mints the
// remaining ~55,900 m² back as one piece — so highlighting every child drew a boundary around half
// the plan and left "which building is this row about?" unanswerable. A highlight keeps the
// children the body actually touches; the rest are ground this proposal gave up, not ground it holds.
//
// Pure: the caller injects the area/intersection maths, so this is testable without turf or a map.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__hoverGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Below this an overlap is a shared border or cut kerf, not standing on it. The fabric is cut
    // at full precision (no more rounding slivers), so real contact is square metres, not fractions.
    const MIN_TOUCH_M2 = 1;

    function usable(features) {
        return (Array.isArray(features) ? features : []).filter(f => f && f.geometry);
    }

    // parcelFeatures: every parcel the proposal holds. bodyFeatures: its own authored geometry.
    // ctx: { intersectionArea(a, b) -> m² }.
    function groundUnderBody(parcelFeatures, bodyFeatures, ctx, options = {}) {
        const parcels = usable(parcelFeatures);
        const bodies = usable(bodyFeatures);
        const minTouch = Number.isFinite(options.minTouchM2) ? options.minTouchM2 : MIN_TOUCH_M2;

        // Nothing to stand on — a decide-later formation, or a record with no authored geometry.
        // Then every parcel it holds is the honest answer.
        if (!bodies.length || !ctx || typeof ctx.intersectionArea !== 'function') return parcels;
        if (!parcels.length) return parcels;

        const kept = parcels.filter(parcel => bodies.some(body => {
            let overlap = 0;
            try { overlap = Number(ctx.intersectionArea(parcel, body)) || 0; } catch (_) { overlap = 0; }
            return overlap >= minTouch;
        }));

        // A body that touches none of its own parcels means the two sets disagree (stale children,
        // a moved footprint). Show the parcels rather than nothing: a highlight going silent hides
        // a real relationship, which is worse than showing too much.
        return kept.length ? kept : parcels;
    }

    return { MIN_TOUCH_M2, groundUnderBody };
});
