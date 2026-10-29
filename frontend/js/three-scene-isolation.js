// What a filtered 3D view keeps (the parcel view: one parcel; the design view: one design's parcels),
// and hiding the rest so that leaving the view shows exactly what it hid, with no rebuild. Layers own
// their groups' `visible`; a filtered view only hides children, so a layer toggled meanwhile keeps its state.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__threeSceneIsolation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // An object tagged with a parcel stays when the parcel is in the set. An untagged existing
    // building stays when `contains` puts its footprint centre on that ground; anything else goes.
    function standsOn(userData, parcelIds, contains) {
        const data = userData || {};
        if (data.parcelId != null) return parcelIds.has(String(data.parcelId));
        if (data.isNearbyBuilding3D && data.footprintLatLng) return !!contains(data.footprintLatLng);
        return false;
    }

    // Hides every shown child of the groups that `keep` rejects, adding it to `hidden`, which it returns.
    // A child already hidden is left out, so showing `hidden` again cannot reveal what a layer hid.
    function hideChildren(groups, keep = () => false, hidden = []) {
        for (const group of groups) {
            if (!group || !Array.isArray(group.children)) continue;
            for (const child of group.children) {
                if (!child || child.visible === false || keep(child)) continue;
                child.visible = false;
                hidden.push(child);
            }
        }
        return hidden;
    }

    // Shows what hideChildren hid; returns the empty list to keep for the next view.
    function showAgain(hidden) {
        for (const object of hidden || []) object.visible = true;
        return [];
    }

    return { standsOn, hideChildren, showAgain };
});
