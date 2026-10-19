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
    function sourceAreaM2(feature, measureGeometry) {
        const stored = feature?.properties?.calculatedArea ?? feature?.properties?.calculated_area;
        if (Number.isFinite(stored) && stored > 0) return stored;
        if (!feature?.geometry || typeof measureGeometry !== 'function') return null;
        const measured = measureGeometry(feature.geometry);
        return Number.isFinite(measured) && measured > 0 ? measured : null;
    }
    function areaSummary({ hasSite = false, siteAreaM2 = null, sourceAreas = [], declaredCount = 0 } = {}) {
        const knownAreas = sourceAreas.filter(area => Number.isFinite(area) && area > 0);
        return {
            hasSite,
            siteAreaM2: hasSite && Number.isFinite(siteAreaM2) && siteAreaM2 > 0 ? siteAreaM2 : null,
            sourceAreaM2: knownAreas.length ? knownAreas.reduce((sum, area) => sum + area, 0) : null,
            sourceCount: knownAreas.length,
            declaredCount,
            sourceComplete: declaredCount > 0 && knownAreas.length === declaredCount
        };
    }
    return Object.freeze({ resolve, parcelReferenceState, sourceAreaM2, areaSummary });
});
