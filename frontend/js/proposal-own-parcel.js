// Which parcel does a proposal itself become? A road is one corridor parcel however many parcels it
// crosses (the rest of its children are the remainders it cut off), a merge is one merged parcel —
// while a reparcellization is many, none of which is "the proposal's own". Selecting a proposal
// opens that parcel's info alongside the proposal, so pure lookup logic lives here, testable
// without a map. Consumed by proposals/layer-render.js.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalOwnParcel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function normalizeIds(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const out = [];
        value.forEach(function (id) {
            if (id === undefined || id === null) return;
            const key = String(id);
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(key);
        });
        return out;
    }

    // Child ids as recorded by the apply path: canonically on the proposal, with the per-type
    // sub-object (roadProposal / reparcellization) as the older location.
    function childParcelIds(proposal) {
        if (!proposal || typeof proposal !== 'object') return [];
        const roots = [
            proposal.childParcelIds,
            proposal.roadProposal && proposal.roadProposal.childParcelIds,
            proposal.reparcellization && proposal.reparcellization.childParcelIds
        ];
        for (let i = 0; i < roots.length; i++) {
            const ids = normalizeIds(roots[i]);
            if (ids.length) return ids;
        }
        return [];
    }

    // The one parcel this proposal IS, or null when it does not have one. `lookupFeature(id)`
    // returns a parcel GeoJSON feature (or null) and is only consulted when the proposal has
    // several children — the corridor flag is what tells a road apart from its own remainders.
    function ownParcelId(proposal, lookupFeature) {
        const ids = childParcelIds(proposal);
        if (!ids.length) return null;
        if (ids.length === 1) return ids[0];
        if (typeof lookupFeature !== 'function') return null;
        for (let i = 0; i < ids.length; i++) {
            let feature = null;
            try { feature = lookupFeature(ids[i]); } catch (_) { feature = null; }
            const properties = (feature && feature.properties) || {};
            if (properties.isCorridor === true || properties.isCorridor === 'true') return ids[i];
        }
        // Several children and none is a corridor: a reparcellization is its slices, not one parcel.
        return null;
    }

    return {
        childParcelIds: childParcelIds,
        ownParcelId: ownParcelId
    };
});
