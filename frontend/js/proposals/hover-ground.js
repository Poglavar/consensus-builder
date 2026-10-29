// proposals/hover-ground.js — which of a proposal's parcels are the ground it STANDS ON.
//
// A formation mints two kinds of child parcel: the plot its body occupies, and the remainder it
// hands back to the host parcel. A remainder can dwarf the proposal that minted it — UPU Borovje's
// building M1-11 cuts a 2,310 m² plot out of the 58,226 m² cadastral parcel 1791/69 and mints the
// remaining ~55,900 m² back as one piece — so highlighting every child drew a boundary around half
// the plan and left "which building is this row about?" unanswerable. A highlight keeps the
// children the body actually touches; the rest are ground this proposal gave up, not ground it holds.
//
// Pure: the caller injects the reach test, so this is testable without turf or a map.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__hoverGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function usable(features) {
        return (Array.isArray(features) ? features : []).filter(f => f && f.geometry);
    }

    // parcelFeatures: every parcel the proposal holds. bodyFeatures: its own authored geometry.
    // ctx: { reaches(body, parcel) -> boolean }: does the body stand on the parcel — the shared rule
    // (geometry-tolerances.js reachesInto), so a shared border or cutting debris is not standing on it.
    function groundUnderBody(parcelFeatures, bodyFeatures, ctx) {
        const parcels = usable(parcelFeatures);
        const bodies = usable(bodyFeatures);

        // Nothing to stand on — a record with no authored geometry.
        // Then every parcel it holds is the honest answer.
        if (!bodies.length || !ctx || typeof ctx.reaches !== 'function') return parcels;
        if (!parcels.length) return parcels;

        const kept = parcels.filter(parcel => bodies.some(body => {
            try { return ctx.reaches(body, parcel) === true; } catch (_) { return false; }
        }));

        // A body that touches none of its own parcels means the two sets disagree (stale children,
        // a moved footprint). Show the parcels rather than nothing: a highlight going silent hides
        // a real relationship, which is worse than showing too much.
        return kept.length ? kept : parcels;
    }

    return { groundUnderBody };
});
