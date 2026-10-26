// Freeform material and land are separate: a narrow building may take a whole yard.
// Pure geometry shared by authoring, validation and replay. Parcel keys are editor-only.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FreeformLandTake = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const feature = value => value?.type === 'Feature' ? value
        : value && /^(Multi)?Polygon$/.test(value.type) ? { type: 'Feature', properties: {}, geometry: value } : null;
    const clone = value => JSON.parse(JSON.stringify(value));
    function union(features, turf) {
        return features.filter(Boolean).reduce((result, item) => result ? turf.union(result, item) : clone(item), null);
    }
    function contains(take, buildings, turf) {
        const land = feature(take);
        if (!land || !(turf.area(land) > 0)) return false;
        return buildings.every(building => {
            const body = feature(building);
            if (!body) return false;
            const outside = turf.difference(body, land);
            return !outside || turf.area(outside) <= Math.min(0.01, turf.area(body) * 1e-6);
        });
    }
    function plan({ buildings, parcels, whole = new Set(), savedTake = null, turf }) {
        const footprint = union(buildings.map(feature), turf);
        if (!footprint || !(turf.area(footprint) > 0)) throw new Error('Freeform building footprint is empty.');
        const rows = [];
        const extra = [];
        for (const parcel of parcels) {
            const host = feature(parcel);
            const intersection = turf.intersect(footprint, host);
            const overlapM2 = intersection ? turf.area(intersection) : 0;
            // Whole-parcel surroundings belong to a building on that parcel, not a separate paving tool.
            if (overlapM2 <= Math.min(0.001, turf.area(footprint) * 1e-6)) continue;
            const id = String(host.properties?.parcelId ?? host.id ?? '');
            const key = JSON.stringify([id, host.geometry]);
            const parcelM2 = turf.area(host);
            const savedRemainder = savedTake ? turf.difference(host, feature(savedTake)) : null;
            const mode = whole.has(key) || (savedTake && (!savedRemainder || turf.area(savedRemainder) < Math.min(0.01, parcelM2 * 1e-6))) ? 'whole' : 'footprint';
            if (mode === 'whole') extra.push(host);
            rows.push({ key, id, feature: host, mode, overlapM2, parcelM2,
                take: mode === 'whole' ? host : intersection,
                remainder: mode === 'whole' ? null : turf.difference(host, footprint) });
        }
        const take = union([footprint, ...extra], turf);
        return { footprint, take, rows, areaM2: turf.area(take) };
    }
    function demolitionPreview(take, buildings, split, turf) {
        const removed = [], partial = [], retained = [];
        for (const building of buildings) {
            const result = split(building, feature(take), turf);
            if (!result) retained.push(building);
            else if (result.full) removed.push(building);
            else partial.push({ building, ...result });
        }
        return { removed, partial, retained };
    }
    return { plan, contains, union, demolitionPreview };
});
