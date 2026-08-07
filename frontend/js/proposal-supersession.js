// Applying an immutable replacement parks its source. Unapplying the replacement never restores
// the source; the cadastre is re-derived from the records that are still explicitly applied.
(function attachProposalSupersession(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function proposalSupersessionFactory() {
    'use strict';

    // Resolver alias for the canonical applied accessor: the browser global wins; node tests require it.
    const appliedOf = (typeof isApplied === 'function') ? isApplied : require('./proposals/status.js').isApplied;

    // A source is applied-for-replacement only when its canonical root record stands.
    function proposalIsAppliedForReplacement(proposal) {
        return appliedOf(proposal);
    }

    function proposalReplacementSourceId(proposal) {
        const value = proposal?.sourceProposalId
            || proposal?.replacementOfProposalId
            || null;
        return value === undefined || value === null || !String(value) ? null : String(value);
    }

    function proposalRecordId(proposal, fallback) {
        const value = proposal?.proposalId || proposal?.id || proposal?.hash || fallback || null;
        return value === undefined || value === null || !String(value) ? null : String(value);
    }

    function commitReplacementSupersession(replacement, replacementId, findProposal) {
        if (!replacement || typeof findProposal !== 'function') return null;
        const sourceId = proposalReplacementSourceId(replacement);
        const resolvedReplacementId = proposalRecordId(replacement, replacementId);
        if (!sourceId || !resolvedReplacementId || sourceId === resolvedReplacementId) return null;
        const source = findProposal(sourceId);
        if (!source || source === replacement || !proposalIsAppliedForReplacement(source)) return null;
        source.applied = false;
        delete source.appliedAt;
        return { source, sourceId, replacementId: resolvedReplacementId };
    }

    return {
        proposalIsAppliedForReplacement,
        proposalReplacementSourceId,
        commitReplacementSupersession
    };
});
