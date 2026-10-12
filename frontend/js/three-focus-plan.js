// How 3D mode takes the camera to a proposal opened from a list, a link, a search or the activity
// feed while the scene is already up (three-mode.js focusThreeModeOnProposals). The scene is a
// snapshot built around one anchor, so a proposal is either inside it, and the camera can frame its
// ground where it stands, or outside it, and the scene has to be rebuilt around the proposal. Pure:
// the caller resolves the proposal's ground and passes what it found.
//
//   planProposalFocus({ targets, originLatLng, radiusM }) -> { action, features, reason }
//     targets      [{ id, parcelIds, features, siteFeature }]: the parcels the proposal claims,
//                  the ones of them the scene could resolve, and the site of an open-ground proposal
//     originLatLng { lat, lng } the scene's anchor
//     radiusM      how far around the anchor the built context was loaded
//     action       'frame' (camera onto `features`), 'relocate' (rebuild around the proposal),
//                  'none' (nothing to go to: unknown proposal, no ground, no site)
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeFocusPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const EARTH_RADIUS_M = 6371008.8;

    function distanceM(a, b) {
        const toRad = v => v * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
    }

    function eachPosition(coords, visit) {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') { visit(coords); return; }
        coords.forEach(c => eachPosition(c, visit));
    }

    // Centre of the bounding box of every position in the features; null when there is none.
    function featuresCenter(features) {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        features.forEach(f => eachPosition(f && f.geometry && f.geometry.coordinates, p => {
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
            if (p[0] < minLng) minLng = p[0];
            if (p[0] > maxLng) maxLng = p[0];
            if (p[1] < minLat) minLat = p[1];
            if (p[1] > maxLat) maxLat = p[1];
        }));
        if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
        return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    }

    function planProposalFocus(input) {
        const targets = Array.isArray(input && input.targets) ? input.targets.filter(Boolean) : [];
        if (!targets.length) return { action: 'none', features: [], reason: 'no proposal' };
        const features = [];
        let groundMissing = false;
        targets.forEach(target => {
            const parcelIds = Array.isArray(target.parcelIds) ? target.parcelIds : [];
            const resolved = (Array.isArray(target.features) ? target.features : []).filter(f => f && f.geometry);
            if (parcelIds.length) {
                // A proposal whose ground is only partly in the scene would be framed on a hole.
                if (resolved.length < parcelIds.length) groundMissing = true;
                features.push(...resolved);
            } else if (target.siteFeature && target.siteFeature.geometry) {
                features.push(target.siteFeature);
            }
        });
        if (groundMissing) return { action: 'relocate', features, reason: 'ground not in scene' };
        const center = featuresCenter(features);
        if (!center) return { action: 'none', features: [], reason: 'no ground' };
        const origin = input.originLatLng;
        const radius = Number(input.radiusM);
        if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) && Number.isFinite(radius) && radius > 0) {
            const d = distanceM(origin, center);
            if (d > radius) return { action: 'relocate', features, reason: `${Math.round(d)} m from the anchor, context radius ${Math.round(radius)} m` };
        }
        return { action: 'frame', features, reason: 'in scene' };
    }

    return Object.freeze({ planProposalFocus, featuresCenter, distanceM });
});
