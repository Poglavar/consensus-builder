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

    function materializedParcelIds(features) {
        return normalizeIds((Array.isArray(features) ? features : []).map(feature => (
            feature?.properties?.parcelId ?? feature?.properties?.parcel_id ?? feature?.properties?.id
        )));
    }

    // The one parcel this proposal IS, or null when it does not have one. Materialized features
    // come from LiveParcelFabric.producedBy(proposalId); the proposal never stores their IDs.
    function ownParcelId(proposal, materializedFeatures) {
        if (!proposal || typeof proposal !== 'object') return null;
        const features = Array.isArray(materializedFeatures) ? materializedFeatures : [];
        const ids = materializedParcelIds(features);
        if (!ids.length) return null;
        if (ids.length === 1) return ids[0];
        for (let i = 0; i < features.length; i++) {
            const feature = features[i];
            const properties = (feature && feature.properties) || {};
            if (properties.isCorridor === true || properties.isCorridor === 'true') {
                return String(properties.parcelId ?? properties.parcel_id ?? properties.id);
            }
        }
        // Several children and none is a corridor: a reparcellization is its slices, not one parcel.
        return null;
    }

    return {
        materializedParcelIds: materializedParcelIds,
        ownParcelId: ownParcelId
    };
});
