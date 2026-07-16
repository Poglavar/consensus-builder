// _applyBuildingProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyBuildings = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const unapplyConflictsSequentially = (
        typeof ProposalApplyConflicts !== 'undefined'
        && ProposalApplyConflicts
        && typeof ProposalApplyConflicts.unapplyConflictsSequentially === 'function'
    )
        ? ProposalApplyConflicts.unapplyConflictsSequentially
        : require('./conflicts.js').unapplyConflictsSequentially;

    return {
    async _applyBuildingProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyBuildingProposal] Starting application for ${idLabel}...`);

        if (!proposalData) {
            console.warn(`[_applyBuildingProposal] Invalid proposal data`);
            return false;
        }

        const step1Time = performance.now();
        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const parentIdsSource = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parentParcelIds;
        const parentParcelIds = Array.isArray(parentIdsSource) ? parentIdsSource.map(id => id && id.toString ? id.toString() : String(id)) : [];
        const uniqueParentIds = Array.from(new Set(parentParcelIds.filter(Boolean)));
        console.debug(`[_applyBuildingProposal] Step 1: Prepared parent parcel IDs (${(performance.now() - step1Time).toFixed(2)}ms) - ${uniqueParentIds.length} parents`);

        if (uniqueParentIds.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply building proposal: no ancestor parcels found.');
            }
            return false;
        }

        const step2Time = performance.now();
        // Parent availability + conflict decision. A building OVERLAYS its parents (it never hides or
        // splits them), so "apply anyway" simply renders the building over whatever parents are
        // present; but if another applied proposal already sits on / consumed these parcels, that's a
        // conflict the user should resolve first (e.g. two buildings on the same parcel).
        {
            const parentFeatures = this._resolveParcelFeaturesByIds(uniqueParentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: uniqueParentIds, parentFeatures, options });
            if (decision.defer) {
                return false;
            }
        }
        console.debug(`[_applyBuildingProposal] Step 2: Parent availability OK (${(performance.now() - step2Time).toFixed(2)}ms)`);

        const step3Time = performance.now();
        const ancestorKey = uniqueParentIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

        try {
            const allProposals = proposalStorage.getAllProposals();
            const conflicts = allProposals
                .filter(p => p.proposalId !== proposalId && this._isBuildingProposal(p))
                .filter(p => {
                    const otherKey = this._getBuildingAncestorKey(p);
                    return otherKey === ancestorKey && appliedOf(p, p.buildingProposal);
                });

            const conflictsCleared = await unapplyConflictsSequentially(this, conflicts, {
                skipRestoreSource: true
            });
            if (!conflictsCleared) {
                console.warn('Could not unapply a conflicting building proposal', { proposalId, ancestorKey });
                return false;
            }
        } catch (err) {
            console.warn('Failed to enforce unique building proposal constraint', err);
            return false;
        }
        console.debug(`[_applyBuildingProposal] Step 3: Enforced unique building constraint (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        const cloneFeature = (raw) => {
            if (!raw || typeof raw !== 'object') return null;
            try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
        };

        // Legacy buildingFeatures ignored; do not mutate

        const candidateFeatures = Array.isArray(proposalData?.geometry?.buildings)
            ? proposalData.geometry.buildings
                .map(raw => {
                    const cloned = cloneFeature(raw);
                    return cloned && cloned.geometry ? cloned : null;
                })
                .filter(Boolean)
            : [];

        if (!candidateFeatures.length) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalId });
            if (typeof updateStatus === 'function') updateStatus(message);
            return false;
        }

        const baseProperties = {
            ...(proposalData.buildingProperties || {}),
            ...(proposalData.properties || {})
        };
        const proposalState = lifecycleOf(proposalData) === 'Executed' ? 'executed' : 'applied';

        const preparedFeatures = candidateFeatures
            .map((raw, index) => {
                if (!raw || !raw.geometry) return null;
                const cloned = cloneFeature(raw);
                if (!cloned || !cloned.geometry) return null;
                const properties = {
                    ...baseProperties,
                    ...(cloned.properties || {}),
                    proposalId,
                    proposalState,
                    parentParcelIds: uniqueParentIds,
                    parentParcelNumbers: buildingProposal.parentParcelNumbers || null,
                    title: proposalData.title || null,
                    author: proposalData.author || null,
                    buildingIndex: index
                };
                return {
                    type: 'Feature',
                    geometry: cloned.geometry,
                    properties
                };
            })
            .filter(Boolean);

        if (!preparedFeatures.length) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalId });
            if (typeof updateStatus === 'function') updateStatus(message);
            return false;
        }
        console.debug(`[_applyBuildingProposal] Step 4: Prepared ${preparedFeatures.length} building feature(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        preparedFeatures.forEach(feature => {
            if (typeof upsertProposedBuildingFeature === 'function') {
                upsertProposedBuildingFeature(feature, { updateLayer: false, save: false });
            } else {
                if (typeof proposedBuildings === 'undefined') {
                    if (typeof window !== 'undefined') window.proposedBuildings = [];
                }
                if (typeof proposedBuildings !== 'undefined') {
                    if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
                    const existingIndex = proposedBuildings.findIndex(b => b && b.properties && b.properties.proposalId === proposalId && b.properties.buildingIndex === feature.properties.buildingIndex);
                    if (existingIndex > -1) {
                        proposedBuildings[existingIndex] = feature;
                    } else {
                        proposedBuildings.push(feature);
                    }
                }
            }
        });

        if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
        if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();

        const showBuildingsCheckbox = document.getElementById('showProposedBuildings');
        if (showBuildingsCheckbox && !showBuildingsCheckbox.checked) {
            showBuildingsCheckbox.checked = true;
        }

        buildingProposal.applied = true;
        buildingProposal.appliedAt = new Date().toISOString();
        buildingProposal.parentParcelIds = uniqueParentIds;
        buildingProposal.ancestorKey = ancestorKey;
        proposalData.buildingProposal = buildingProposal;

        if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
            proposalData.geometry = {};
        }
        proposalData.geometry.buildings = preparedFeatures.map(cloneFeature).filter(Boolean);

        persistAppliedProposal(proposalData, proposalId);

        this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);

        const step7Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentIds);
        console.debug(`[_applyBuildingProposal] Step 7: Linked to ${uniqueParentIds.length} ancestors (${(performance.now() - step7Time).toFixed(2)}ms)`);

        refreshProposalUIAfterApply(`Applied building proposal ${proposalData.title || idLabel}`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyBuildingProposal] ✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },
    };
});
