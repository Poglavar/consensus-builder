// The one estimator of a building's height in metres, from whatever a feature's properties happen
// to carry. It exists because three-mode.js (the 3D view, which also feeds the € gain calc) and
// photoreal-mode.js each had their own copy and the copies disagreed: three-mode required a NUMBER
// height so a GeoJSON-imported `height: "12"` fell through to the 10 m default, while photoreal
// coerced it to 12; and three-mode read upper-case `LEVELS`/`STORIES` while photoreal did not. Same
// building, different massing in the two views. One tested copy ends that.
//
// Accepts either a GeoJSON feature or a raw properties object, so existing call sites in both files
// pass unchanged. No DOM, no THREE — plain object in, number out.

(function (global) {
    'use strict';

    // One storey height for drawing and for layouts: the extrusion's (building-extrusion.js), which
    // raises a block with a storey count by 3 m per storey on the server and in the browser alike.
    // A layout planned with another height would put a different number of storeys in the block.
    const STOREY_HEIGHT_M = ((typeof window !== 'undefined' && window.BuildingExtrusion)
        || require('./building-extrusion.js')).STOREY_M;
    // The source the building atlas's satellite-derived height estimates carry (footprint-provider.js).
    const ATLAS_ESTIMATE_SOURCE = 'global-building-atlas';

    function positiveNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function estimateBuildingHeightMeters(featureOrProps) {
        const props = (featureOrProps && featureOrProps.properties)
            ? featureOrProps.properties
            : (featureOrProps || {});

        const measured = positiveNumber(props.height)
            ?? positiveNumber(props.HEIGHT)
            ?? positiveNumber(props.elevation);
        if (measured !== null) {
            return measured;
        }

        const levels = positiveNumber(props.levels)
            ?? positiveNumber(props.storeys)
            ?? positiveNumber(props.stories)
            ?? positiveNumber(props.LEVELS)
            ?? positiveNumber(props.STORIES);
        if (levels !== null) {
            return levels * STOREY_HEIGHT_M;
        }

        return 10; // ~3 storeys, the shared default for an unknown building
    }

    // The height an estimated flat layout may use for an existing building, cheapest truth first:
    // its footprint's measured height, then its storey count (× STOREY_HEIGHT_M), then the drawn 3D
    // block's height when a source gave it (a city model's mesh, a measured height or storeys), and
    // last the building atlas's satellite estimate, flagged `estimated: 'satellite'`. A seeded
    // default guess (an `estimated` block with no outside source) is no height for flats: null.
    // `props`: the footprint's properties (height_m, floors, or any tag the estimator reads);
    // `record`: the 3D block record or null; `recordHeightM`: that block's drawn height in metres.
    function flatsHeight(props, record = null, recordHeightM = null) {
        const p = props || {};
        const measured = positiveNumber(p.height_m);
        if (measured !== null) return { heightM: measured, estimated: null };
        const floors = positiveNumber(p.floors);
        if (floors !== null) return { heightM: floors * STOREY_HEIGHT_M, estimated: null };
        if (p.height || p.levels || p.storeys) return { heightM: estimateBuildingHeightMeters(p), estimated: null };
        const drawn = positiveNumber(recordHeightM);
        if (!record || drawn === null) return null;
        if (!record.height_source || record.height_source === 'measured' || record.height_source === 'levels') {
            return { heightM: drawn, estimated: null };
        }
        if (record.height_source === 'estimated' && record.height_estimate_source === ATLAS_ESTIMATE_SOURCE) {
            return { heightM: drawn, estimated: 'satellite' };
        }
        return null;
    }

    if (typeof window !== 'undefined') {
        window.estimateBuildingHeightMeters = estimateBuildingHeightMeters;
        window.STOREY_HEIGHT_M = STOREY_HEIGHT_M; // shared with three-mode's floor lines
        window.BuildingHeight = { flatsHeight, STOREY_HEIGHT_M };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { estimateBuildingHeightMeters, flatsHeight, STOREY_HEIGHT_M };
    }
})(typeof window !== 'undefined' ? window : globalThis);
