// Maps a proposal goal to the fill/stroke used for its preview polygon, so the create-proposal
// screenshot hints the actual effect — blue water for a lake, green for a park, stone grey for a
// square — instead of a generic orange for everything. Pure lookup, no DOM; the map-screenshot
// preview and the dialog both read it. Returns null for goals with no distinctive effect so the
// caller keeps its default styling.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.ProposalGoalPreviewStyle = api;
        root.goalPreviewStyle = api.goalPreviewStyle;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const GOAL_PREVIEW_STYLES = {
        lake: { color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 0.38 },
        park: { color: '#15803d', fillColor: '#22c55e', fillOpacity: 0.34 },
        square: { color: '#57534e', fillColor: '#a8a29e', fillOpacity: 0.36 },
        station: { color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.34 },
        'road-track': { color: '#1f2937', fillColor: '#4b5563', fillOpacity: 0.42 },
        'road/track': { color: '#1f2937', fillColor: '#4b5563', fillOpacity: 0.42 },
        single: { color: '#9a3412', fillColor: '#fb923c', fillOpacity: 0.34 },
        buildings: { color: '#9a3412', fillColor: '#fb923c', fillOpacity: 0.34 }
    };

    // Returns a { color, fillColor, fillOpacity } style for the goal, or null when the goal has no
    // distinctive effect (merge, ownership, urban rule, unknown) — caller keeps its default.
    function goalPreviewStyle(goalKey) {
        const key = String(goalKey == null ? '' : goalKey).trim().toLowerCase();
        const style = GOAL_PREVIEW_STYLES[key];
        return style ? Object.assign({}, style) : null;
    }

    return { goalPreviewStyle, GOAL_PREVIEW_STYLES };
});
