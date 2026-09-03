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
        // A live parcel has one current producer stamp. `ancestorProposal` and `proposalId`
        // belonged to the retired replay graph and can point at an unrelated historical record
        // after the fabric has been replaced atomically.
        const producer = properties.producedByProposalId;
        if (producer === undefined || producer === null || String(producer).trim() === '') return null;
        const proposal = findProposal(String(producer));
        return roadProposalIsApplied(proposal) ? proposal : null;
    }

    return {
        roadProposalIsApplied,
        appliedRoadProposalForFeature
    };
});
