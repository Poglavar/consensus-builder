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

    const STOREY_HEIGHT_M = 3.3;

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

    if (typeof window !== 'undefined') {
        window.estimateBuildingHeightMeters = estimateBuildingHeightMeters;
        window.STOREY_HEIGHT_M = STOREY_HEIGHT_M; // shared with three-mode's floor lines
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { estimateBuildingHeightMeters, STOREY_HEIGHT_M };
    }
})(typeof window !== 'undefined' ? window : globalThis);
