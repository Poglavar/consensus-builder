// Replacement-state helpers for roads copied and extended into a new proposal.
// They mutate proposal records only; ProposalManager remains responsible for map geometry and storage.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Legacy fallback only: pre-split in-memory records that never carried the `applied` boolean.
    const appliedLike = status => {
        const normalized = String(status || '').toLowerCase();
        return normalized === 'applied' || normalized === 'executed';
    };

    // Map-application axis. The explicit boolean wins on either the sub-proposal or the proposal
    // (mirrors proposals/status.js isApplied); only pre-split rows with no boolean fall to legacy.
    function roadProposalIsApplied(proposal) {
        if (!proposal || !proposal.roadProposal) return false;
        const rp = proposal.roadProposal;
        if (typeof rp.applied === 'boolean') return rp.applied;
        if (typeof proposal.applied === 'boolean') return proposal.applied;
        return appliedLike(rp.status) || appliedLike(proposal.status);
    }

    function roadProposalKey(proposal, fallback = null) {
        if (!proposal) return fallback;
        return proposal.proposalId || proposal.id || proposal.hash || fallback;
    }

    function supersedeCopiedRoadSource(replacement, replacementId, findProposal) {
        if (!replacement || !replacement.roadProposal || typeof findProposal !== 'function') return null;
        const copiedFrom = replacement.sourceProposalId
            || replacement.replacementOfProposalId
            || replacement.copiedFromProposalId;
        if (!copiedFrom) return null;
        const source = findProposal(String(copiedFrom));
        if (!source || !source.roadProposal || source === replacement || !roadProposalIsApplied(source)) return null;

        const resolvedReplacementId = String(roadProposalKey(replacement, replacementId) || replacementId || '');
        const sourceId = String(roadProposalKey(source, copiedFrom) || copiedFrom);
        if (!resolvedReplacementId || sourceId === resolvedReplacementId) return null;

        source.appliedBeforeSuperseded = typeof source.applied === 'boolean' ? source.applied : true;
        // Save the lifecycle so an Executed road comes back Executed, then park it. Superseding is an
        // application-axis event: the road leaves the map (applied=false) while parked.
        source.lifecycleBeforeSuperseded = source.lifecycleStatus || 'Active';
        source.roadProposal.applied = false;
        source.lifecycleStatus = 'Active';
        source.applied = false; // superseded roads leave the map until restored
        source.roadProposal.supersededByProposalId = resolvedReplacementId;
        source.supersededByProposalId = resolvedReplacementId;

        const existing = Array.isArray(replacement.roadProposal.supersedesProposalIds)
            ? replacement.roadProposal.supersedesProposalIds.map(String)
            : [];
        replacement.roadProposal.supersedesProposalIds = Array.from(new Set([...existing, sourceId]));
        replacement.supersedesProposalIds = replacement.roadProposal.supersedesProposalIds.slice();
        return source;
    }

    function restoreSupersededRoadSources(replacement, replacementId, findProposal) {
        if (!replacement || !replacement.roadProposal || typeof findProposal !== 'function') return [];
        const resolvedReplacementId = String(roadProposalKey(replacement, replacementId) || replacementId || '');
        const sourceIds = Array.from(new Set([
            ...(Array.isArray(replacement.roadProposal.supersedesProposalIds) ? replacement.roadProposal.supersedesProposalIds : []),
            ...(Array.isArray(replacement.supersedesProposalIds) ? replacement.supersedesProposalIds : [])
        ].map(String).filter(Boolean)));
        const restored = [];

        sourceIds.forEach(sourceId => {
            const source = findProposal(sourceId);
            if (!source || !source.roadProposal) return;
            const marker = source.roadProposal.supersededByProposalId || source.supersededByProposalId;
            if (String(marker || '') !== resolvedReplacementId) return;
            const restoredApplied = typeof source.appliedBeforeSuperseded === 'boolean' ? source.appliedBeforeSuperseded : true;
            source.applied = restoredApplied;
            // Restore the lifecycle we parked (Executed stays Executed; Applied → Active).
            source.lifecycleStatus = source.lifecycleBeforeSuperseded || 'Active';
            source.roadProposal.applied = restoredApplied;
            delete source.appliedBeforeSuperseded;
            delete source.lifecycleBeforeSuperseded;
            delete source.roadProposal.supersededByProposalId;
            delete source.supersededByProposalId;
            restored.push(source);
        });

        delete replacement.roadProposal.supersedesProposalIds;
        delete replacement.supersedesProposalIds;
        return restored;
    }

    function activeRoadSuperseder(proposal, findProposal) {
        if (!proposal || !proposal.roadProposal || typeof findProposal !== 'function') return null;
        const targetId = proposal.roadProposal.supersededByProposalId || proposal.supersededByProposalId;
        if (!targetId) return null;
        const target = findProposal(String(targetId));
        return roadProposalIsApplied(target) ? target : null;
    }

    function appliedRoadProposalForFeature(feature, findProposal) {
        const properties = feature && feature.properties;
        if (!properties || properties.isCorridor !== true || properties.isRoad !== true || typeof findProposal !== 'function') {
            return null;
        }
        const candidates = [properties.ancestorProposal, properties.proposalId]
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
        supersedeCopiedRoadSource,
        restoreSupersededRoadSources,
        activeRoadSuperseder,
        appliedRoadProposalForFeature
    };
});
