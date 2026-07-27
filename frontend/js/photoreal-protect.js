// Which standing buildings must SURVIVE the photo-mode carve.
//
// The carve is a half-space test, not a height: everything inside the road mask and above the road's
// local formation floor is discarded, all the way up. That is deliberate — nothing of Google's may
// survive where our own road surface goes (its asphalt, kerbs, parked cars, signs, wires). But a
// road parcel very often runs right up to a building, and the pavement fill deliberately reaches the
// building line, so the column being cleared contains the FACADE. The wall was being sheared off.
//
// The context the cut is missing is simply "a building still stands here". This module supplies it:
// the footprints of buildings that survive the applied proposals, dilated a little (the mesh's skin,
// eaves and balconies sit slightly proud of the cadastral outline), minus anything a proposal
// deliberately removes. Painting those into the mask as "no cut" keeps the wall and still clears the
// road right up to its foot — the uncut sliver of Google ground beneath is hidden under our own
// pavement slab, which is drawn on top of it.
//
// Failure direction matters: if a geometry operation throws, DROP the protector rather than keep it.
// Losing protection restores the old (visible, survivable) shearing; keeping a bad one could leave a
// demolished building standing in the render, which is a lie about the proposal.
(function (global) {
    'use strict';

    // The cut mask has no depth buffer and every class writes with NoBlending, so DRAW ORDER decides
    // which class owns a texel. Keeping the whole ladder in one place is what makes the invariant
    // checkable: protection must be strictly last, or a tie lets three's material sort decide
    // whether a facade lives. (The road quilt and the protect pass were both 3 for exactly one
    // commit — a coin flip per material.)
    const MASK_ORDER = {
        keepVeg: 0,   // parks: ground layer only
        full: 1,      // razed buildings, proposed-building covers
        roadEntry: 2, // generic road footprints
        roadPatch: 3, // the exact per-station road quilt
        protect: 4    // standing buildings: the last word
    };

    // The mesh skin sits proud of the outline, and eaves/balconies overhang it. Protect a collar so
    // the facade is kept whole rather than shaved to the cadastral line.
    const BUILDING_PROTECT_DILATE_M = 1.0;
    // Removals are rasterised dilated by the same core buffer; subtract them at that size so a razed
    // building cannot be re-protected by the collar of a surviving neighbour.
    const BUILDING_PROTECT_REMOVAL_BUFFER_M = 1.2;

    const isPolygonal = geometry => !!geometry
        && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon');

    function featureOf(geometry) {
        return { type: 'Feature', properties: {}, geometry: geometry };
    }

    function bboxOf(turf, geometry) {
        try {
            const box = turf.bbox(featureOf(geometry));
            return (Array.isArray(box) && box.length >= 4 && box.every(Number.isFinite)) ? box : null;
        } catch (_) { return null; }
    }

    function boxesOverlap(a, b) {
        if (!a || !b) return true; // unknown extent: do not exclude on a guess
        return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }

    function bufferGeometry(turf, geometry, metres) {
        if (!metres) return geometry;
        try {
            const out = turf.buffer(featureOf(geometry), metres, { units: 'meters' });
            return (out && out.geometry) ? out.geometry : null;
        } catch (_) { return null; }
    }

    // A proposal's own buildings are drawn by us and must replace the mesh underneath, so they are
    // never protectors. Everything else in the collected set has already had demolition records
    // applied — fully razed features are gone, partial ones carry their remainder.
    function isStandingSurveyBuilding(feature) {
        if (!feature || !isPolygonal(feature.geometry)) return false;
        const props = feature.properties || {};
        return props.proposalId === undefined || props.proposalId === null;
    }

    // features: GeoJSON building Features in lat/lng (collectLoadedCorridorBuildings output).
    // options.removals: geometries the carve must keep cutting (razed buildings, proposed-building
    //   covers). Subtracted from every protector.
    // options.bounds: [minX, minY, maxX, maxY] limiting work to the carve window.
    // Returns an array of polygonal geometries to paint as "no cut".
    function selectProtectedBuildingFootprints(features, options) {
        options = options || {};
        const turf = options.turf || global.turf;
        if (!turf || !Array.isArray(features) || !features.length) return [];
        const dilate = Number.isFinite(Number(options.dilateM))
            ? Number(options.dilateM) : BUILDING_PROTECT_DILATE_M;
        const removalBuffer = Number.isFinite(Number(options.removalBufferM))
            ? Number(options.removalBufferM) : BUILDING_PROTECT_REMOVAL_BUFFER_M;
        const bounds = Array.isArray(options.bounds) && options.bounds.length >= 4
            ? options.bounds : null;

        const removals = [];
        (Array.isArray(options.removals) ? options.removals : []).forEach(function (geometry) {
            if (!isPolygonal(geometry)) return;
            const grown = bufferGeometry(turf, geometry, removalBuffer);
            if (!isPolygonal(grown)) return;
            removals.push({ geometry: grown, box: bboxOf(turf, grown) });
        });

        const out = [];
        features.forEach(function (feature) {
            if (!isStandingSurveyBuilding(feature)) return;
            const box = bboxOf(turf, feature.geometry);
            if (bounds && !boxesOverlap(box, bounds)) return;
            const grown = bufferGeometry(turf, feature.geometry, dilate);
            if (!isPolygonal(grown)) return;
            let kept = grown;
            for (let i = 0; i < removals.length; i++) {
                if (!boxesOverlap(box, removals[i].box)) continue;
                try {
                    const clipped = turf.difference(featureOf(kept), featureOf(removals[i].geometry));
                    kept = (clipped && clipped.geometry) ? clipped.geometry : null;
                } catch (_) {
                    kept = null; // fail toward cutting, never toward a building that should be gone
                }
                if (!isPolygonal(kept)) break;
            }
            if (isPolygonal(kept)) out.push(kept);
        });
        return out;
    }

    const api = {
        MASK_ORDER: MASK_ORDER,
        selectProtectedBuildingFootprints: selectProtectedBuildingFootprints,
        isStandingSurveyBuilding: isStandingSurveyBuilding,
        BUILDING_PROTECT_DILATE_M: BUILDING_PROTECT_DILATE_M,
        BUILDING_PROTECT_REMOVAL_BUFFER_M: BUILDING_PROTECT_REMOVAL_BUFFER_M
    };

    global.__photorealProtect = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
