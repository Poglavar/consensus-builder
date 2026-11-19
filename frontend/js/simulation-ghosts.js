// simulation-ghosts.js — designs the agents drew in the last few simulation turns, shown on the map
// as ghosts that fade turn by turn without being applied. Pure bookkeeping (which designs, how
// strong); design-display.js draws them in 2D and 3D in the designs' own look.
// Nothing here writes a proposal or a parcel, so Stop and New game simply clear the list.
// UMD, so backend/test/frontend-simulation-ghosts.test.js loads it without a DOM.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationGhosts = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // A design shows at full strength in the turn it was drawn and is gone FADE_TURNS turns later.
    const FADE_TURNS = 3;
    const CHANGE_EVENT = 'simulationghostschange';

    // Pure: how strong a ghost drawn `age` turns ago is, 1 when new, 0 once it has faded.
    function ghostStrength(age, fadeTurns = FADE_TURNS) {
        if (!Number.isInteger(age) || age < 0 || !Number.isInteger(fadeTurns) || age >= fadeTurns) return 0;
        return (fadeTurns - age) / fadeTurns;
    }

    // Pure: the ghosts still showing at `turn`, newest first, each with its strength.
    function liveGhosts(entries, turn, fadeTurns = FADE_TURNS) {
        return (entries || [])
            .map(entry => ({ ...entry, strength: ghostStrength(turn - entry.turn, fadeTurns) }))
            .filter(entry => entry.strength > 0)
            .sort((a, b) => b.turn - a.turn);
    }

    let entries = [];
    let currentTurn = 0;

    function notify() {
        try { root?.dispatchEvent?.(new root.CustomEvent(CHANGE_EVENT)); } catch (_) { }
        publish();
    }

    // A turn ended: its new designs join at full strength and older ones fade a step.
    function recordTurn(turn, proposalIds) {
        if (!Number.isInteger(turn)) return;
        currentTurn = turn;
        const fresh = new Set((proposalIds || []).filter(id => id !== null && id !== undefined).map(String));
        entries = liveGhosts(entries.filter(entry => !fresh.has(entry.proposalId)), turn)
            .map(({ proposalId, turn: drawn }) => ({ proposalId, turn: drawn }));
        fresh.forEach(proposalId => entries.push({ proposalId, turn }));
        notify();
    }

    function strengthOf(proposalId) {
        if (proposalId === null || proposalId === undefined) return 0;
        const entry = entries.find(item => item.proposalId === String(proposalId));
        return entry ? ghostStrength(currentTurn - entry.turn) : 0;
    }

    function list() {
        return liveGhosts(entries, currentTurn);
    }

    function clear() {
        if (!entries.length) return;
        entries = [];
        notify();
    }

    // The ghosts as Design display entries (design-display.js draws them in 2D and 3D, in the
    // designs' own look). A design that was applied meanwhile stands on the map itself.
    function publish() {
        const display = root?.DesignDisplay;
        const storage = root?.proposalStorage;
        if (!display || !storage) return;
        display.setLayer('ghosts', list().map(({ proposalId, strength }) => {
            const design = storage.getProposal(proposalId);
            if (!design || root.isProposalApplied?.(design)) return null;
            return { key: proposalId, design, opacity: strength, fresh: strength === 1, open: { type: 'design', id: proposalId } };
        }).filter(Boolean));
    }

    return { FADE_TURNS, CHANGE_EVENT, ghostStrength, liveGhosts, recordTurn, strengthOf, list, clear };
});
