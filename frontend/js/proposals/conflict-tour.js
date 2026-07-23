// Pure state for the shared-plan conflict tour (rethink-proposals.md §12): when replaying a plan
// over a dirty slate hits a CROSS-plan occupation, the user decides per conflict — replace the
// existing proposal or keep it and skip the incoming one — optionally once for all remaining
// conflicts. This module owns only the decision bookkeeping; the modal, the map highlights and
// the actual unapply/apply live in sharing-routes.js.

(function (global) {
    'use strict';

    const ACTIONS = Object.freeze(['replace', 'keep']);

    function createTourState() {
        return { decisions: Object.create(null), blanket: null, stops: 0 };
    }

    // One conflict is identified by the incoming proposal AND the set of occupiers: after a
    // "replace", the same proposal can legitimately conflict again with a DIFFERENT occupier,
    // and that is a new question, not a repeat of the old one.
    function stopKey(incomingId, occupierIds) {
        const occ = (Array.isArray(occupierIds) ? occupierIds : [])
            .map(id => String(id)).filter(Boolean).sort();
        return String(incomingId || '') + '|' + occ.join(',');
    }

    // 'replace' | 'keep' when already decided (directly or by blanket), 'ask' otherwise.
    function resolveAction(state, key) {
        if (!state) return 'ask';
        const direct = state.decisions[String(key || '')];
        if (ACTIONS.indexOf(direct) !== -1) return direct;
        if (ACTIONS.indexOf(state.blanket) !== -1) return state.blanket;
        return 'ask';
    }

    function recordDecision(state, key, action, applyToAll) {
        if (!state) return state;
        const normalized = ACTIONS.indexOf(action) !== -1 ? action : 'keep';
        state.decisions[String(key || '')] = normalized;
        if (applyToAll === true) state.blanket = normalized;
        state.stops += 1;
        return state;
    }

    const api = { ACTIONS, createTourState, stopKey, resolveAction, recordDecision };

    if (typeof window !== 'undefined') window.__conflictTour = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
