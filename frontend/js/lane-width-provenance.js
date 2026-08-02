// Which evidence decided a lane's width.
//
// This is what separates "actual" from "idealised", and it is not the algorithm — it is the record.
// Without it nobody can tell a measured 2.7 m lane from a defaulted 3.0 m one, and the output
// reverts to imagined while looking finished. It is also the answer to one-off cases: reality is
// full of lanes that break a rule, and they are not enumerable AS rules. Let evidence outrank the
// rule, and store the fact that it did.
//
// Order, most trusted first:
//
//   measured     rectified imagery — paint actually on the ground
//   road_parcel  the land bounds the carriageway, so it overrides a wider nominal cross-section
//   osm_tag      a surveyor stated width= on the way
//   default      a standard width for the highway class. A guess, and must read as one.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneWidthProvenance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Index is rank: earlier is more trusted. Nothing downstream should hardcode the order.
    const WIDTH_SOURCES = Object.freeze(['measured', 'road_parcel', 'osm_tag', 'default']);

    function rankOf(source) {
        const index = WIDTH_SOURCES.indexOf(source);
        return index === -1 ? WIDTH_SOURCES.length : index;
    }

    // The parcel is a BOUND, so it only claims authorship when it actually changed the width.
    // A parcel wider than the cross-section decided nothing, and saying otherwise would overstate
    // how much of the map is evidence-backed.
    function resolveWidthSource(evidence) {
        if (evidence?.measured) return 'measured';
        if (evidence?.parcelNarrowed) return 'road_parcel';
        const tagged = Number(evidence?.taggedWidthM);
        if (Number.isFinite(tagged) && tagged > 0) return 'osm_tag';
        return 'default';
    }

    function moreTrusted(left, right) {
        return rankOf(left) <= rankOf(right) ? left : right;
    }

    // Counts per source, plus the share that rests on a guess. `measuredShare` deliberately counts
    // ONLY the top of the hierarchy: a road narrowed by its parcel is constrained, not measured.
    function summarise(items, pick = item => item?.widthSource) {
        const counts = Object.fromEntries(WIDTH_SOURCES.map(source => [source, 0]));
        let total = 0;
        (items || []).forEach(item => {
            const source = pick(item);
            if (!source) return;
            total += 1;
            counts[source] = (counts[source] || 0) + 1;
        });
        return {
            counts,
            total,
            measuredShare: total ? Number((counts.measured / total).toFixed(3)) : 0,
            defaultShare: total ? Number((counts.default / total).toFixed(3)) : 0
        };
    }

    return { WIDTH_SOURCES, rankOf, resolveWidthSource, moreTrusted, summarise };
});
