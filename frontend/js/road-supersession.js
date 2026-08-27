// Resolve a clicked corridor parcel back to its applied road proposal.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const appliedOf = (typeof isApplied === 'function')
        ? isApplied
        : require('./proposals/status.js').isApplied;

    function roadProposalIsApplied(proposal) {
        return !!(proposal && proposal.roadProposal && appliedOf(proposal, proposal.roadProposal));
    }

    function appliedRoadProposalForFeature(feature, findProposal) {
        const properties = feature && feature.properties;
        if (!properties || properties.isCorridor !== true || properties.isRoad !== true || typeof findProposal !== 'function') {
            return null;
        }
        const candidates = [properties.producedByProposalId, properties.ancestorProposal, properties.proposalId]
            .map(value => value !== undefined && value !== null ? String(value) : null)
            .filter(Boolean);
        for (const candidate of candidates) {
            const proposal = findProposal(candidate);
            if (roadProposalIsApplied(proposal)) return proposal;
        }
        return null;
    }

    return {
        roadProposalIsApplied,
        appliedRoadProposalForFeature
    };
});
