// proposals/ground-sweep.js — who has to come off the map when a corridor divides a parcel.
//
// A cut is not negotiable: whatever stood on ground the cut divided cannot simply be adjusted. But
// "the design" is not one shape. A block is a dozen buildings, one per parcel, placed independently
// — and the UNION of them can never fit inside a single piece of a single parcel once the design
// spans more than one. Testing that union therefore condemned an entire block whenever a road
// divided any parcel it happened to build on, with the cut fifty metres from every building.
//
// So the question is asked per BUILDING: a building that still sits wholly inside one piece is
// undisturbed, whatever happened to its neighbours' ground. A design falls only when the cut runs
// through one of its own parts. Parks, squares and lakes take whole parcels by definition and have
// exactly one part, so for them "stands on divided ground" is still the whole test.
//
// Pure and DOM-free (the geometry ops are injected) so node can test it; the browser gets
// window.__groundSweep.

(function (global) {
    'use strict';

    // Below this a "touch" is a shared boundary or a rounding artefact, not standing on the ground.
    const TOUCHES_M2 = 0.25;
    // A part is whole when a single piece holds essentially all of it; the slack is for the sliver
    // a cut leaves along a shared edge.
    const WHOLE_FRACTION = 0.999;

    /** The independently placed parts of a design. A building design is its buildings; everything
        else is one shape. Falls back to the footprint whenever the parts cannot be read. */
    function designParts(record, isBuildingDesign, footprint) {
        if (!isBuildingDesign) return footprint ? [footprint] : [];
        const lists = [
            record && record.geometry && record.geometry.buildings,
            record && record.buildingProposal && record.buildingProposal.buildings
        ];
        for (const list of lists) {
            if (!Array.isArray(list) || !list.length) continue;
            const parts = list
                .map(entry => (entry && entry.type === 'Feature') ? entry : (entry ? { type: 'Feature', properties: {}, geometry: entry } : null))
                .filter(part => part && part.geometry && /Polygon/.test(part.geometry.type || ''));
            if (parts.length) return parts;
        }
        return footprint ? [footprint] : [];
    }

    /** Does this design stand on the divided ground, and did the cut go through any of its parts?
        ops: { intersectionArea(a, b) -> m², area(a) -> m² } — injected so this stays pure. */
    function inspectDesignAgainstPieces(parts, pieces, ops, options) {
        const settings = options || {};
        const touchesM2 = Number.isFinite(settings.touchesM2) ? settings.touchesM2 : TOUCHES_M2;
        const wholeFraction = Number.isFinite(settings.wholeFraction) ? settings.wholeFraction : WHOLE_FRACTION;
        const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
        const grounds = Array.isArray(pieces) ? pieces.filter(Boolean) : [];
        const out = { standsHere: false, severed: false, severedParts: 0 };
        if (!list.length || !grounds.length || !ops || typeof ops.intersectionArea !== 'function') return out;

        list.forEach(part => {
            const partM2 = (typeof ops.area === 'function') ? ops.area(part) : 0;
            let touches = false;
            let whole = false;
            for (const piece of grounds) {
                const shared = ops.intersectionArea(part, piece) || 0;
                if (shared > touchesM2) touches = true;
                if (partM2 > 0 && (shared / partM2) > wholeFraction) { whole = true; break; }
            }
            if (!touches) return;                 // this part is nowhere near the cut
            out.standsHere = true;
            if (!whole) { out.severed = true; out.severedParts += 1; }
        });
        return out;
    }

    const api = { TOUCHES_M2, WHOLE_FRACTION, designParts, inspectDesignAgainstPieces };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') global.__groundSweep = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
