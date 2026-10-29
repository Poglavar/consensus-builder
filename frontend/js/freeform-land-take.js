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
    // Every clip runs through the shared parcel clip (proposals/parcel-arrangement.js clipWith) with
    // the caller's turf, so authoring, validation and replay cut on the same grid.
    const arrangement = () => (typeof window !== 'undefined' && window.__parcelArrangement)
        || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    const clip = (turf, operation, a, b, site) => arrangement().clipWith(turf, operation, a, b, { site });
    function union(features, turf) {
        return features.filter(Boolean).reduce((result, item) => result ? clip(turf, 'union', result, item, 'freeform-land-take.union') : clone(item), null);
    }
    function contains(take, buildings, turf) {
        const land = feature(take);
        if (!land || !(turf.area(land) > 0)) return false;
        return buildings.every(building => {
            const body = feature(building);
            if (!body) return false;
            const outside = clip(turf, 'difference', body, land, 'freeform-land-take.contains');
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
            const intersection = clip(turf, 'intersect', footprint, host, 'freeform-land-take.plan');
            const overlapM2 = intersection ? turf.area(intersection) : 0;
            // Whole-parcel surroundings belong to a building on that parcel, not a separate paving tool.
            if (overlapM2 <= Math.min(0.001, turf.area(footprint) * 1e-6)) continue;
            const id = String(host.properties?.parcelId ?? host.id ?? '');
            const key = JSON.stringify([id, host.geometry]);
            const parcelM2 = turf.area(host);
            const savedRemainder = savedTake ? clip(turf, 'difference', host, feature(savedTake), 'freeform-land-take.plan') : null;
            const mode = whole.has(key) || (savedTake && (!savedRemainder || turf.area(savedRemainder) < Math.min(0.01, parcelM2 * 1e-6))) ? 'whole' : 'footprint';
            if (mode === 'whole') extra.push(host);
            rows.push({ key, id, feature: host, mode, overlapM2, parcelM2,
                take: mode === 'whole' ? host : intersection,
                remainder: mode === 'whole' ? null : clip(turf, 'difference', host, footprint, 'freeform-land-take.plan') });
        }
        const take = union([footprint, ...extra], turf);
        return { footprint, take, rows, areaM2: turf.area(take) };
    }
    // The ground a design is reviewed on: the live pieces as they stood before it, so Whole parcel
    // offers the piece a building stands on (a layout's plot), never the cadastral parcel under
    // every design. Other designs' pieces stay as they are. The design's own remainders of a
    // cadastral parcel join back into one piece; its building parcel, when it is no more than its
    // footprint, returns to the piece it was cut from (the piece of the same cadastral parcel it
    // shares the longest edge with), and otherwise stands as the whole land it took.
    function groundBefore({ pieces, ownId = null, ownFootprint = null, turf }) {
        const isOwn = piece => ownId !== null && String(piece?.properties?.producedByProposalId ?? '') === String(ownId);
        const own = pieces.filter(isOwn);
        if (!own.length) return pieces;
        const cadastreOf = piece => (piece.properties?.cadastreParcelIds || []).map(String);
        const shares = (a, b) => cadastreOf(a).some(id => cadastreOf(b).includes(id));
        const ground = pieces.filter(piece => !isOwn(piece)).map(piece => ({ piece, parts: [] }));
        for (const piece of own.filter(piece => !piece.properties?.buildingParcel)) {
            const group = ground.find(entry => entry.cadastral && shares(entry.piece, piece));
            if (group) group.parts.push(piece);
            else ground.push({ piece, parts: [], cadastral: true });
        }
        const edgeM = (a, b) => turf.lineOverlap(a, b, { tolerance: 0.0005 }).features
            .reduce((sum, line) => sum + turf.length(line) * 1000, 0);
        for (const building of own.filter(piece => piece.properties?.buildingParcel)) {
            const beyond = ownFootprint ? clip(turf, 'difference', building, feature(ownFootprint), 'freeform-land-take.groundBefore') : building;
            const withinFootprint = !beyond || turf.area(beyond) <= Math.min(0.01, turf.area(building) * 1e-6);
            const host = withinFootprint
                ? ground.filter(entry => shares(entry.piece, building))
                    .map(entry => ({ entry, edge: edgeM(building, entry.piece) }))
                    .filter(candidate => candidate.edge > 0)
                    .sort((a, b) => b.edge - a.edge)[0]?.entry
                : null;
            if (host) host.parts.push(building);
            else ground.push({ piece: building, parts: [] });
        }
        return ground.map(({ piece, parts }) => (parts.length
            ? { ...piece, properties: { ...piece.properties }, geometry: union([piece, ...parts], turf).geometry }
            : piece));
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
    return { plan, contains, union, groundBefore, demolitionPreview };
});
