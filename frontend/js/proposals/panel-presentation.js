// Explicit map-card/detail intent, with refreshes preserving the user's current view.
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
    return Object.freeze({ resolve });
});
