// proposals/road-actions.js — the browser half of a selected road's actions: reads the facts
// proposals/road-actions-model.js decides on from the live page, and runs an action. Used by the
// proposal card a road click opens (details-panel.js) and by the command palette (ui/commands.js,
// `road.*`, via contextFacts on the selected proposal). Namespaced only (window.RoadActions).
(function (win) {
    'use strict';

    const model = () => {
        if (!win.RoadActionsModel) throw new Error('RoadActions: RoadActionsModel is not loaded');
        return win.RoadActionsModel;
    };

    // Facts for one road proposal (a record or its id). `overrides` lets a caller that already
    // knows a fact (the details panel computes appliedState) pass it instead of re-deriving it.
    function factsFor(proposalOrKey, overrides = {}) {
        const proposal = (proposalOrKey && typeof proposalOrKey === 'object')
            ? proposalOrKey
            : (typeof win.getProposalByIdOrHash === 'function' ? win.getProposalByIdOrHash(proposalOrKey) : null);
        if (!proposal) return null;
        const key = (typeof win.getProposalKey === 'function' ? win.getProposalKey(proposal) : null) || proposal.proposalId;
        const facts = {
            proposalKey: key === undefined || key === null ? null : String(key),
            hasEditableCorridor: typeof win.proposalHasEditableCorridor === 'function'
                && win.proposalHasEditableCorridor(proposal) === true,
            applied: typeof win.isProposalApplied === 'function'
                ? win.isProposalApplied(proposal) === true
                : proposal.applied === true,
            drawing: win.roadDrawingMode === true
        };
        return Object.assign(facts, overrides);
    }

    // The selected proposal's facts, or null when nothing is selected (its commands are then
    // unavailable in the palette).
    function contextFacts() {
        const key = win.ProposalSelection && typeof win.ProposalSelection.getKey === 'function'
            ? win.ProposalSelection.getKey()
            : null;
        return key ? factsFor(key) : null;
    }

    const RUNNERS = {
        crossSection: facts => {
            if (typeof win.openCorridorProfileEditor !== 'function') {
                throw new Error('RoadActions: openCorridorProfileEditor() is not defined');
            }
            return win.openCorridorProfileEditor(facts.proposalKey);
        }
    };

    function runAction(action, facts) {
        const runner = RUNNERS[action];
        if (!runner) throw new Error(`RoadActions: unknown action ${action}`);
        if (!model().isActionAvailable(action, facts)) {
            console.warn(`[RoadActions] ${action} is not available for`, facts && facts.proposalKey);
            return undefined;
        }
        return runner(facts);
    }

    win.RoadActions = Object.freeze({ factsFor, contextFacts, runAction });
})(window);
