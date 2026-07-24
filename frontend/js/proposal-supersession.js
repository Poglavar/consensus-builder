// Purpose: track source supersession and restoration for immutable replacement proposals.
(function attachProposalSupersession(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function proposalSupersessionFactory() {
    'use strict';

    // Resolver alias for the canonical applied accessor: the browser global wins; node tests require it.
    const appliedOf = (typeof isApplied === 'function') ? isApplied : require('./proposals/status.js').isApplied;

    // Sub-proposal keys whose applied state also makes a source applied-for-replacement.
    const SUB_KEYS = ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal', 'ownershipTransferProposal'];

    const STATUS_PATHS = [
        ['status'],
        ['roadProposal', 'status'],
        ['buildingProposal', 'status'],
        ['structureProposal', 'status'],
        ['reparcellization', 'status'],
        ['decideLaterProposal', 'status'],
        ['ownershipTransferProposal', 'status']
    ];

    function clone(value) {
        if (value === undefined || value === null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function valueAtPath(target, path) {
        return path.reduce((value, key) => value?.[key], target);
    }

    // A source is applied-for-replacement if the proposal itself is applied, or any of its
    // sub-proposals is applied — mirroring the old STATUS_PATHS traversal on the applied axis.
    function proposalIsAppliedForReplacement(proposal) {
        if (!proposal) return false;
        if (appliedOf(proposal)) return true;
        return SUB_KEYS.some(key => proposal[key] && appliedOf(proposal, proposal[key]));
    }

    function proposalReplacementSourceId(proposal) {
        const value = proposal?.sourceProposalId
            || proposal?.replacementOfProposalId
            || proposal?.copiedFromProposalId
            || null;
        return value === undefined || value === null || !String(value) ? null : String(value);
    }

    function proposalRecordId(proposal, fallback) {
        const value = proposal?.proposalId || proposal?.id || proposal?.hash || fallback || null;
        return value === undefined || value === null || !String(value) ? null : String(value);
    }

    function statusSnapshot(proposal) {
        const snapshot = {};
        STATUS_PATHS.forEach(path => {
            const value = valueAtPath(proposal, path);
            if (value !== undefined) snapshot[path.join('.')] = value;
        });
        return snapshot;
    }

    function beginReplacementSupersession(replacement, replacementId, findProposal) {
        if (!replacement || typeof findProposal !== 'function') return null;
        const sourceId = proposalReplacementSourceId(replacement);
        const resolvedReplacementId = proposalRecordId(replacement, replacementId);
        if (!sourceId || !resolvedReplacementId || sourceId === resolvedReplacementId) return null;
        const source = findProposal(sourceId);
        if (!source || source === replacement) return null;

        const existing = replacement.replacementLifecycle;
        if (existing && String(existing.sourceProposalId || '') === sourceId) {
            return { source, sourceId, replacementId: resolvedReplacementId, lifecycle: existing, wasApplied: existing.sourceWasApplied === true };
        }

        const lifecycle = {
            sourceProposalId: sourceId,
            replacementProposalId: resolvedReplacementId,
            sourceWasApplied: proposalIsAppliedForReplacement(source),
            sourceStatusSnapshot: statusSnapshot(source),
            state: 'pending',
            preparedAt: new Date().toISOString()
        };
        replacement.replacementLifecycle = lifecycle;
        return { source, sourceId, replacementId: resolvedReplacementId, lifecycle, wasApplied: lifecycle.sourceWasApplied };
    }

    function commitReplacementSupersession(replacement, replacementId, findProposal) {
        if (!replacement || typeof findProposal !== 'function') return null;
        const transaction = beginReplacementSupersession(replacement, replacementId, findProposal);
        if (!transaction) return null;
        const { source, sourceId, replacementId: resolvedReplacementId, lifecycle } = transaction;
        lifecycle.state = 'active';
        lifecycle.appliedAt = new Date().toISOString();
        delete lifecycle.restorationError;
        source.supersededByProposalId = resolvedReplacementId;
        source.supersededByReplacement = true;
        const existing = Array.isArray(replacement.supersedesProposalIds)
            ? replacement.supersedesProposalIds.map(String)
            : [];
        replacement.supersedesProposalIds = [...new Set([...existing, sourceId])];
        return transaction;
    }

    function activeReplacementSuperseder(proposal, findProposal) {
        if (!proposal || typeof findProposal !== 'function') return null;
        const replacementId = proposal.supersededByProposalId;
        if (!replacementId) return null;
        const replacement = findProposal(String(replacementId));
        return proposalIsAppliedForReplacement(replacement) ? replacement : null;
    }

    function releaseReplacementSource(replacement, replacementId, findProposal) {
        if (!replacement || typeof findProposal !== 'function') return null;
        const lifecycle = replacement.replacementLifecycle;
        const fallbackSource = proposalReplacementSourceId(replacement);
        const sourceId = lifecycle?.sourceProposalId || fallbackSource;
        if (!sourceId) return null;
        const source = findProposal(String(sourceId));
        const resolvedReplacementId = proposalRecordId(replacement, replacementId);
        if (source && String(source.supersededByProposalId || '') === String(resolvedReplacementId || '')) {
            delete source.supersededByProposalId;
            delete source.supersededByReplacement;
        }
        const result = {
            source,
            sourceId: String(sourceId),
            replacementId: resolvedReplacementId,
            // Only a committed ('active') supersession released the source in the first place; a
            // 'pending' lifecycle from a failed apply must not trigger a spurious re-apply.
            shouldReapply: lifecycle?.state === 'active' && lifecycle?.sourceWasApplied === true,
            sourceStatusSnapshot: clone(lifecycle?.sourceStatusSnapshot || {})
        };
        delete replacement.replacementLifecycle;
        if (Array.isArray(replacement.supersedesProposalIds)) {
            replacement.supersedesProposalIds = replacement.supersedesProposalIds.filter(id => String(id) !== String(sourceId));
            if (!replacement.supersedesProposalIds.length) delete replacement.supersedesProposalIds;
        }
        return result;
    }

    function markReplacementRestorationFailed(replacement, sourceId, error) {
        if (!replacement) return;
        replacement.replacementRestorationError = {
            sourceProposalId: sourceId || null,
            message: error?.message || String(error || 'Source restoration failed.'),
            failedAt: new Date().toISOString()
        };
    }

    return {
        proposalIsAppliedForReplacement,
        proposalReplacementSourceId,
        beginReplacementSupersession,
        commitReplacementSupersession,
        activeReplacementSuperseder,
        releaseReplacementSource,
        markReplacementRestorationFailed
    };
});
