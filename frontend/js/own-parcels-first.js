// Stable partition that floats the current user's own parcels to the front of a parcel-id list, so a
// proposal covering many parcels shows the ones that are mine first. Pure: an id list plus an
// isOwn(id) predicate in, a reordered id list out — no DOM, no storage — so it is unit-testable.
// The proposal details panel supplies the predicate (owner id === current user agent id).

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OwnParcelsFirst = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Own ids first (in their original relative order), then the rest (also in original order). The
    // list is returned unchanged when there is no usable predicate, so callers can pass it through.
    function sortOwnParcelsFirst(ids, isOwn) {
        if (!Array.isArray(ids)) return [];
        if (typeof isOwn !== 'function') return ids.slice();
        const own = [];
        const rest = [];
        ids.forEach(function (id) {
            let mine = false;
            try { mine = isOwn(id) === true; } catch (_) { mine = false; }
            (mine ? own : rest).push(id);
        });
        return own.concat(rest);
    }

    return { sortOwnParcelsFirst };
});
