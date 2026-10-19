// Proposal-panel presentation: view intent and source availability remain separate from map state.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPanelPresentation = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function resolve({ requested, sameProposal = false, visible = false, minimized = false } = {}) {
        if (requested === 'compact' || requested === 'details') return requested;
        return sameProposal && visible && minimized ? 'compact' : 'details';
    }
    function parcelReferenceState({ hasGeometry = false, replacedInModel = false } = {}) {
        if (replacedInModel) return 'replaced';
        return hasGeometry ? 'available' : 'unloaded';
    }
    return Object.freeze({ resolve, parcelReferenceState });
});
