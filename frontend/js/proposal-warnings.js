// Pure, DOM-free helpers that decide when to gently nudge the user before committing certain
// proposals, and the numbers those nudges quote. No turf, no DOM: callers measure the geometry and
// pass in plain metres, so this stays unit-testable without a browser. Consumed by
// saveBlockifyDesignForProposal (building-blocks.js) and saveRowHouseDesignForProposal (row-house.js).
(function (global) {
    'use strict';

    // Average walking speed ~5 km/h ≈ 84 m/min — turns a block's perimeter into the "minutes to walk
    // around it" figure the oversized-block warning quotes.
    const WALK_SPEED_M_PER_MIN = 84;

    // Recommended block footprint: ~50×50 m to ~200×200 m. A 200×200 block has an ~800 m perimeter
    // → ~9.5 min to walk around; we only nudge once the estimated walk-around passes 15 minutes, so
    // blocks a bit over the recommendation don't get flagged.
    const RECOMMENDED_BLOCK_MIN_SIDE_M = 50;
    const RECOMMENDED_BLOCK_MAX_SIDE_M = 200;
    const OVERSIZED_BLOCK_WALK_MINUTES = 15;

    // Row houses read best on parcels of similar size and shape. "Very different" = either a >3×
    // spread in area, or a wide spread in compactness (4πA/P², where 1 = a perfect circle).
    const ROW_HOUSE_AREA_RATIO_THRESHOLD = 3;
    const ROW_HOUSE_COMPACTNESS_SPREAD_THRESHOLD = 0.35;

    function walkAroundMinutes(perimeterM) {
        const p = Number(perimeterM);
        if (!Number.isFinite(p) || p <= 0) return 0;
        return p / WALK_SPEED_M_PER_MIN;
    }

    // Decide whether a block is large enough to warrant the oversized nudge, and hand back the walk
    // time to quote. `oversized` flips true once the estimated walk-around exceeds the recommended max.
    function assessBlockSize(perimeterM) {
        const minutes = walkAroundMinutes(perimeterM);
        return {
            oversized: minutes > OVERSIZED_BLOCK_WALK_MINUTES,
            minutes,
            roundedMinutes: Math.max(1, Math.round(minutes))
        };
    }

    // Polsby–Popper compactness: 1 for a circle, →0 for a long thin sliver. Used to compare parcel
    // shapes independently of their size. Returns null for unusable inputs.
    function compactness(area, perimeter) {
        const a = Number(area), p = Number(perimeter);
        if (!Number.isFinite(a) || !Number.isFinite(p) || a <= 0 || p <= 0) return null;
        return (4 * Math.PI * a) / (p * p);
    }

    // Decide whether the selected parcels are dissimilar enough to warn before proposing row houses.
    // `parcels` is [{ area, perimeter }] in metres. Fewer than 2 measurable parcels → never flagged.
    function assessRowHouseSimilarity(parcels) {
        const areas = [];
        const comps = [];
        (Array.isArray(parcels) ? parcels : []).forEach(parcel => {
            const a = Number(parcel && parcel.area);
            if (Number.isFinite(a) && a > 0) areas.push(a);
            const c = compactness(parcel && parcel.area, parcel && parcel.perimeter);
            if (c !== null) comps.push(c);
        });
        if (areas.length < 2) {
            return { dissimilar: false, areaRatio: 1, compactnessSpread: 0, count: areas.length };
        }
        const areaRatio = Math.max(...areas) / Math.min(...areas);
        const compactnessSpread = comps.length >= 2 ? (Math.max(...comps) - Math.min(...comps)) : 0;
        return {
            dissimilar: areaRatio > ROW_HOUSE_AREA_RATIO_THRESHOLD
                || compactnessSpread > ROW_HOUSE_COMPACTNESS_SPREAD_THRESHOLD,
            areaRatio,
            compactnessSpread,
            count: areas.length
        };
    }

    const api = {
        WALK_SPEED_M_PER_MIN,
        RECOMMENDED_BLOCK_MIN_SIDE_M,
        RECOMMENDED_BLOCK_MAX_SIDE_M,
        OVERSIZED_BLOCK_WALK_MINUTES,
        ROW_HOUSE_AREA_RATIO_THRESHOLD,
        ROW_HOUSE_COMPACTNESS_SPREAD_THRESHOLD,
        walkAroundMinutes,
        assessBlockSize,
        compactness,
        assessRowHouseSimilarity
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.ProposalWarnings = api;
})(typeof window !== 'undefined' ? window : globalThis);
