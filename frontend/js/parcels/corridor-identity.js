// Is this ground a corridor — a road or a track that BOUNDS blocks rather than sitting inside one?
//
// The question is asked by every flood fill and by the block enumeration, and getting it wrong in
// the permissive direction is expensive: a corridor a fill can walk down joins the blocks on both
// sides of the street into one, whose outline then measures the far kerb and fails every enclosure
// test. That happened for a reason worth stating, because it is invisible from the call site: the
// road SET is keyed by cadastral parcel, and it has never seen a piece id. The moment one of our
// own corridors clips an existing street, the leftover strip is `HR-…-123#a4f9c1` — not in the set,
// carrying no isCorridor flag of its own, and so no longer a road to anything that asks by id.
//
// Hence the ancestry: a piece is road ground when the ground it was CUT FROM is.
//
// Pure — no map, no layers, no storage. The caller supplies the properties, the id, whatever the
// persisted record says, and a predicate that answers for the road set.
(function (global) {
    'use strict';

    // Ids this parcel could be known by in a set keyed by cadastral parcel: its own, whatever it
    // records as its origin, and its id with the piece hash taken off.
    function ancestryOf(parcelId, properties) {
        const props = properties || {};
        const ids = [];
        const add = value => {
            if (value === undefined || value === null) return;
            const text = String(value);
            if (text && ids.indexOf(text) === -1) ids.push(text);
        };
        add(parcelId);
        add(props.rootParcelId);
        add(props.parentParcelId);
        (Array.isArray(props.baseParcelIds) ? props.baseParcelIds : []).forEach(add);
        if (parcelId !== undefined && parcelId !== null) add(String(parcelId).split('#')[0]);
        return ids;
    }

    /**
     * @param {object} input
     * @param {string|number|null} input.parcelId
     * @param {object} [input.properties]           the live feature's properties
     * @param {object|function} [input.persistedProperties]  what storage remembers about this
     *        parcel, or a function returning it — passed as a function it is only read when nothing
     *        cheaper has answered, which matters in a flood fill that asks once per parcel.
     * @param {(id: string) => boolean} [input.isRoadInSet]  the curated road-parcel set
     * @returns {boolean}
     */
    function isCorridorGround(input) {
        const { parcelId = null, properties = {}, persistedProperties = null, isRoadInSet = null } = input || {};

        // isRoad travels onto a remainder from the parcel it was cut from (parcel-arrangement.js
        // keeps it deliberately), so it answers for legacy road parcels the set knows by another id.
        if (properties.isCorridor === true || properties.isTrack === true || properties.isRoad === true) return true;

        if (typeof isRoadInSet === 'function') {
            const ancestry = ancestryOf(parcelId, properties);
            for (const id of ancestry) {
                let answer = false;
                try { answer = !!isRoadInSet(id); } catch (_) { answer = false; }
                if (answer) return true;
            }
        }

        const persisted = (typeof persistedProperties === 'function' ? persistedProperties() : persistedProperties) || {};
        return persisted.isCorridor === true || persisted.isTrack === true;
    }

    const api = { ancestryOf, isCorridorGround };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__corridorIdentity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
