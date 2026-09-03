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

    // A direct edit points at its immutable source, but alternatives form an undirected family for
    // map application: choosing the source again must park its replacement just as choosing the
    // replacement parks the source. Follow the whole component so A -> B -> C can be toggled in any
    // direction without leaving another member standing.
    function proposalReplacementFamilyIds(proposal, records) {
        const targetId = proposalRecordId(proposal);
        if (!targetId) return new Set();
        const adjacency = new Map();
        const link = (left, right) => {
            if (!left || !right || left === right) return;
            if (!adjacency.has(left)) adjacency.set(left, new Set());
            if (!adjacency.has(right)) adjacency.set(right, new Set());
            adjacency.get(left).add(right);
            adjacency.get(right).add(left);
        };
        (Array.isArray(records) ? records : []).forEach(record => {
            const id = proposalRecordId(record);
            const sourceId = proposalReplacementSourceId(record);
            if (id && sourceId) link(id, sourceId);
        });

        const family = new Set([targetId]);
        const queue = [targetId];
        while (queue.length) {
            const id = queue.shift();
            (adjacency.get(id) || []).forEach(neighbour => {
                if (family.has(neighbour)) return;
                family.add(neighbour);
                queue.push(neighbour);
            });
        }
        return family;
    }

    function isBuildingContentProposal(proposal) {
        return !!(proposal && (
            proposal.buildingProposal
            || proposal.buildingGeometry
            || (proposal.geometry && Array.isArray(proposal.geometry.buildings)
                && proposal.geometry.buildings.length)
        ));
    }

    // These are the apply paths that clear proposed buildings under their authored footprint.
    // Reparcellization is intentionally absent: reshaping parcel fabric is not, by itself, choosing
    // a different building design.
    function displacesBuildingContent(proposal) {
        return !!(proposal && (
            isBuildingContentProposal(proposal)
            || proposal.roadProposal
            || proposal.structureProposal
        ));
    }

    function resolvePlanOrder(options) {
        if (options?.planOrder) return options.planOrder;
        try {
            if (typeof window !== 'undefined' && window.__planOrder) return window.__planOrder;
        } catch (_) { }
        try {
            if (typeof require === 'function') return require('./proposals/plan-order.js');
        } catch (_) { }
        return null;
    }

    // Which applied proposals are in the way of this one, and so must be unapplied before it can
    // be applied.
    //
    // The test is GEOMETRIC: an applied proposal is in the way only when the ground it holds
    // actually overlaps the ground this one takes. Sharing a cadastral parcel is NOT enough. Roads
    // and land readjustments cut a cadastral parcel into many plots and a plan puts a different
    // building on each, so judging by parcel identity made every one of them a rival: on the
    // 299-member Sibenik plan that left 34 of 166 buildings applied, each new member unapplying
    // the one before it, while the summary still reported 298 applied.
    //
    // One exception, and it is about identity rather than ground: members of an immutable
    // replacement family are versions of each other, so choosing either unapplies the other however
    // far apart their footprints sit.
    //
    // The 2 m² floor is the same one the building-demolition scanner uses.
    function collectAppliedProposalAlternatives(proposal, records, options = {}) {
        const targetId = proposalRecordId(proposal);
        if (!targetId) return [];
        const list = Array.isArray(records) ? records.filter(Boolean) : [];
        const familyIds = proposalReplacementFamilyIds(proposal, list);
        const planOrder = resolvePlanOrder(options);
        const minimumOverlapM2 = Number.isFinite(Number(options.minimumOverlapM2))
            ? Math.max(0, Number(options.minimumOverlapM2))
            : 2;
        const targetFootprint = displacesBuildingContent(proposal)
            && planOrder && typeof planOrder.footprintOf === 'function'
            ? planOrder.footprintOf(proposal)
            : null;

        return list.filter(candidate => {
            const candidateId = proposalRecordId(candidate);
            if (!candidateId || candidateId === targetId || !proposalIsAppliedForReplacement(candidate)) return false;
            if (familyIds.has(candidateId)) return true;
            // A standing park, square or lake holds its ground as exclusively as a building does:
            // a plan member whose footprint lies inside an applied park must be refused, not
            // stacked on top of it (Šibenik, 2026-09-03: a plan re-applied two buildings inside
            // freshly created structures because only buildings counted as rivals).
            if (!isBuildingContentProposal(candidate) && !candidate.structureProposal) return false;
            // No measurable footprint on either side means no demonstrable overlap, and ground that
            // cannot be shown to be taken is left free: refusing here would block on a suspicion.
            if (!targetFootprint || !planOrder || typeof planOrder.footprintOf !== 'function'
                || typeof planOrder.intersectionArea !== 'function') return false;
            const candidateFootprint = planOrder.footprintOf(candidate);
            return candidateFootprint
                ? planOrder.intersectionArea(targetFootprint, candidateFootprint) >= minimumOverlapM2
                : false;
        });
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
        proposalReplacementFamilyIds,
        collectAppliedProposalAlternatives,
        commitReplacementSupersession
    };
});
