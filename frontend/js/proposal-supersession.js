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

    function coordinatedPlanId(proposal) {
        const value = proposal?.coordinatedPlanId;
        return value === undefined || value === null ? '' : String(value).trim();
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

    // Which cadastral parcels a proposal stands ON.
    //
    // A block, a row or a parcel-based design is CONTENT on existing parcels: the parcel is what it
    // occupies, and its building rings are merely where it put them. Comparing footprints therefore
    // misses the case that matters — two block designs over overlapping parcels, whose rings sit in
    // different places and do not touch, both applied, both standing on the same ground. The parcel
    // is the unit a design competes for, so it is the unit that decides.
    function occupiedParcelIds(proposal) {
        const ids = new Set();
        const add = list => (Array.isArray(list) ? list : []).forEach(id => {
            if (id === null || id === undefined) return;
            const text = String(id);
            if (text) ids.add(text);
        });
        add(proposal && proposal.parentParcelIds);
        add(proposal && proposal.cadastreParcelIds);
        add(proposal && proposal.parcelIds);
        add(proposal && proposal.buildingProposal && proposal.buildingProposal.parentParcelIds);
        return ids;
    }

    function sharesAnyParcel(left, right) {
        if (!left || !left.size || !right || !right.size) return false;
        for (const id of right) {
            if (left.has(id)) return true;
        }
        return false;
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

    // Explicit application is a choice, not merely another replay request. Return every currently
    // applied alternative that must stand down before the chosen record is replayed:
    //   1. another member of the immutable replacement family; or
    //   2. an independent building proposal meaningfully overlapped by the chosen proposal.
    // The 2 m² floor is the same one used by the building-demolition scanner.
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

        const targetParcels = isBuildingContentProposal(proposal) ? occupiedParcelIds(proposal) : null;
        const targetPlanId = coordinatedPlanId(proposal);

        return list.filter(candidate => {
            const candidateId = proposalRecordId(candidate);
            if (!candidateId || candidateId === targetId || !proposalIsAppliedForReplacement(candidate)) return false;
            if (familyIds.has(candidateId)) return true;
            if (!isBuildingContentProposal(candidate)) return false;
            const sameCoordinatedPlan = !!targetPlanId && coordinatedPlanId(candidate) === targetPlanId;
            // One design per parcel: two building designs claiming the same parcel are two answers
            // to the same question, however far apart the buildings themselves landed. Members of
            // one coordinated plan are the exception: their original cadastral parents describe
            // the plan's input ground, while its readjustment gives each building a distinct live
            // plot. They coexist unless their authored building footprints actually overlap.
            if (!sameCoordinatedPlan && sharesAnyParcel(targetParcels, occupiedParcelIds(candidate))) return true;
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
