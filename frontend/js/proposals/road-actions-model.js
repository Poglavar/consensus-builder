// proposals/road-actions-model.js — the pure half of a selected road's actions: which road-only
// actions (today: Edit cross-section) apply to a road proposal given facts already known about it.
// No DOM, no Leaflet; UMD so backend/test/frontend-road-actions.test.js loads it headlessly. The
// browser half is proposals/road-actions.js (facts + run), the button is drawn by details-panel.js
// and the palette entry lives in ui/commands.js (`road.<action>`).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RoadActionsModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Each id is also the suffix of its UiCommands command (`road.<id>`).
    const ACTIONS = Object.freeze(['crossSection']);

    // facts: { proposalKey, hasEditableCorridor, applied, drawing }. Missing facts count as "not
    // available" — never as a guess that it is.
    //
    // crossSection follows the same gate as the road's node handles (road-node-edit.js
    // selectedCorridorProposal): the road must be applied (it is on the map, so the editor's live
    // preview has something to draw) and must carry a lane cross-section — a road DESIGNATION has
    // none. Published/minted roads are NOT excluded: the edit lands on the local copy through
    // updateLocalCorridorGeometry, which detaches the published pointers; the server's and the
    // chain's copies stay as they were. While a corridor is being drawn, the drawing panel's own
    // "Edit cross-section" owns the editor.
    function isActionAvailable(action, facts) {
        const f = facts || {};
        const hasKey = typeof f.proposalKey === 'string' && f.proposalKey !== '';
        if (!hasKey) return false;
        switch (action) {
            case 'crossSection':
                return f.hasEditableCorridor === true && f.applied === true && f.drawing !== true;
            default:
                return false;
        }
    }

    function availableActions(facts) {
        return ACTIONS.filter(action => isActionAvailable(action, facts));
    }

    return { ACTIONS, isActionAvailable, availableActions };
});
