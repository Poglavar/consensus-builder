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
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The proposal record is empty — there is no building data to apply.' }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'no-parent-parcels', message: 'The building proposal names no ancestor parcels to stand on.' }); } catch (_) { }
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
            // Flat anchor (rethink-proposals.md §15a): content is positioned against the base
            // cadastral parcels, whatever generation the parcels it overlays belong to — one hop.
            try {
                const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
                const cadastreIds = formationEdit ? formationEdit.baseIdsOfFeatures(decision.parentFeatures || parentFeatures) : [];
                if (cadastreIds.length) proposalData.cadastreParcelIds = cadastreIds;
            } catch (_) { }
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
                skipRestoreSource: true,
                _mutationTransaction: options._mutationTransaction
            });
            if (!conflictsCleared) {
                console.warn('Could not unapply a conflicting building proposal', { proposalId, ancestorKey });
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'conflict-unapply-failed',
                        message: `Another building proposal already stands on the same ${uniqueParentIds.length} parcel(s) and could not be unapplied.`,
                        conflictTitles: conflicts.map(p => p && p.title).filter(Boolean),
                        conflictProposalIds: conflicts.map(p => p && p.proposalId).filter(Boolean)
                    });
                } catch (_) { }
                return false;
            }
        } catch (err) {
            console.warn('Failed to enforce unique building proposal constraint', err);
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'conflict-check-failed',
                    message: `Checking for conflicting building proposals on the same parcels threw: ${err && err.message ? err.message : err}`
                });
            } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'missing-building-geometry', message: 'The proposal stores no building footprints (geometry.buildings is empty).' }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'building-geometry-unusable', message: `All ${candidateFeatures.length} stored building footprint(s) were dropped while preparing geometry.` }); } catch (_) { }
            return false;
        }
        console.debug(`[_applyBuildingProposal] Step 4: Prepared ${preparedFeatures.length} building feature(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // §15a building formation: a FREEFORM building (goal 'single', one footprint) forms its
        // own parcel — footprint parcel by default, whole host parcels when
        // buildingProposal.takeWholeParcels is set. Refusals abort before anything renders.
        // Blocks/row/parcel-based buildings stay content on existing parcels (§9 table).
        let workingParentIds = uniqueParentIds;
        {
            const goalKey = (typeof window !== 'undefined' && window.__applyRoute && typeof window.__applyRoute.normalizeGoalKey === 'function')
                ? window.__applyRoute.normalizeGoalKey(proposalData.goal)
                : String(proposalData.goal || '');
            if (goalKey === 'single' && preparedFeatures.length === 1) {
                const formation = await this._formBuildingParcel(
                    proposalId, proposalData, buildingProposal, preparedFeatures[0].geometry, uniqueParentIds, idLabel);
                if (!formation.ok) return false;
                workingParentIds = formation.parentIds;
                preparedFeatures[0].properties.parentParcelIds = workingParentIds.slice();
            }
        }

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

        buildingProposal.parentParcelIds = workingParentIds;
        buildingProposal.ancestorKey = ancestorKey;
        proposalData.buildingProposal = buildingProposal;

        if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
            proposalData.geometry = {};
        }
        proposalData.geometry.buildings = preparedFeatures.map(cloneFeature).filter(Boolean);

        persistAppliedProposal(proposalData, proposalId);

        this._setDescendantProposalOnParcels(workingParentIds, proposalId);

        const step7Time = performance.now();
        this._linkProposalToAncestors(proposalId, workingParentIds);
        console.debug(`[_applyBuildingProposal] Step 7: Linked to ${workingParentIds.length} ancestors (${(performance.now() - step7Time).toFixed(2)}ms)`);

        refreshProposalUIAfterApply(`Applied building proposal ${proposalData.title || idLabel}`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyBuildingProposal] ✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    // §15a building formation (decision 2026-08-05): a FREEFORM building forms its own parcel —
    // one building, one parcel (the Croatian rule), realised against the live fabric:
    //   default    → FOOTPRINT parcel: mint the building's parcel from its footprint, cut each
    //                host parcel's remainder back to its owner (§14.2 — a formation owes the
    //                owner their remainders); the minimal taking.
    //   whole-take → buildingProposal.takeWholeParcels: adopt/merge the WHOLE host parcels as
    //                the building's parcel (the family-house-with-yard case).
    // Ownership goes to the PROPOSER (ownership-flow's declared destination for freeform).
    // Buildings on existing parcels (blocks/row/parcelBased) stay content and never reach here.
    async _formBuildingParcel(proposalId, proposalData, buildingProposal, footprintGeometry, declaredParentIds, idLabel) {
        // Idempotent on restore: an already-formed building keeps its record — unapply deletes
        // it, so only a fresh apply re-forms from the live fabric.
        if (buildingProposal.formation && Array.isArray(buildingProposal.formation.parcelIds) && buildingProposal.formation.parcelIds.length) {
            return { ok: true, parentIds: buildingProposal.formation.parcelIds.map(String) };
        }
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            console.error('[_formBuildingParcel] formation-edit/turf missing — the building cannot form its parcel');
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'building-formation-unavailable',
                    message: 'The formation engine is unavailable in this session; the building cannot form its parcel.'
                });
            } catch (_) { }
            return { ok: false };
        }
        const takeCtx = {
            area: f => { try { return turfRef.area(f) || 0; } catch (_) { return 0; } },
            intersectionArea: (a, b) => {
                try { const hit = turfRef.intersect(a, b); return hit ? turfRef.area(hit) : 0; } catch (_) { return 0; }
            }
        };
        const footprint = { type: 'Feature', properties: {}, geometry: footprintGeometry };

        // Candidates: the live parcels under the footprint — geometry decides (§15a).
        let candidateIds = declaredParentIds.slice();
        try {
            const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
            const resolution = (ancestry && typeof ancestry.resolveParentsByGeometry === 'function')
                ? ancestry.resolveParentsByGeometry(proposalData)
                : null;
            if (resolution && Array.isArray(resolution.ids) && resolution.ids.length) {
                candidateIds = resolution.ids.map(String);
            }
        } catch (_) { }
        const candidateFeatures = this._resolveParcelFeaturesByIds(candidateIds,
            { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true }) || [];
        const candidates = candidateFeatures
            .map(feature => ({ id: _getParcelIdFromFeature(feature), feature }))
            .filter(entry => entry.id !== undefined && entry.id !== null);

        const proposerName = proposalData.author || 'Proposer';
        const proposerOwnership = { owners: [{ name: proposerName, ownerLabel: proposerName, percentageShare: 100, actualShareText: '100%' }] };
        const proposerAgentId = (typeof getOrCreateAgentForRecipient === 'function') ? getOrCreateAgentForRecipient(proposerName) : null;

        const finishOwnership = (ownedIds, formationRecord) => {
            if (proposerAgentId && typeof transferParcelOwnership === 'function') {
                formationRecord.ownerAgentId = proposerAgentId;
                ownedIds.forEach(pid => {
                    try { transferParcelOwnership(String(pid), null, proposerAgentId, { skipAgentSync: true }); } catch (_) { }
                });
                if (typeof buildAgentOwnedParcelIndex === 'function' && typeof agentStorage !== 'undefined') {
                    try {
                        agentStorage.beginBatch();
                        const ownerIndex = buildAgentOwnedParcelIndex();
                        agentStorage.updateAgent(proposerAgentId, { ownedParcels: ownerIndex.get(proposerAgentId) || [] });
                    } finally {
                        agentStorage.endBatch();
                    }
                }
            }
        };

        if (buildingProposal.takeWholeParcels === true) {
            const plan = formationEdit.wholeParcelTakePlan(footprint, candidates, takeCtx);
            if (plan.mode === 'refuse') {
                const partialText = plan.partials
                    .map(partial => `${partial.id} (${Math.round(partial.coveredShare * 100)}%)`)
                    .join(', ');
                const message = plan.reason === 'partial-parcels'
                    ? `Taking whole parcels, but the building footprint covers only part of: ${partialText}. Cut the ground first, or place without the whole-parcel option.`
                    : (plan.reason === 'uncovered-ground'
                        ? `Part of the building footprint lies on no live parcel here (${Math.round(plan.uncoveredShare * 100)}% uncovered).`
                        : 'No parcels found under the building footprint.');
                if (typeof updateStatus === 'function') updateStatus(message);
                try { this._setLastApplyFailure(idLabel, { code: 'building-partial-parcels', message, partials: plan.partials }); } catch (_) { }
                return { ok: false };
            }
            const takenIds = plan.parcelIds.map(String);
            const takenFeatures = candidates.filter(entry => takenIds.includes(String(entry.id))).map(entry => entry.feature);
            if (plan.mode === 'adopt') {
                buildingProposal.formation = {
                    mode: 'adopt',
                    parcelIds: takenIds.slice(),
                    prior: takenFeatures.map(feature => ({
                        parcelId: String(_getParcelIdFromFeature(feature)),
                        ownershipDetails: feature.properties && feature.properties.ownershipDetails
                            ? JSON.parse(JSON.stringify(feature.properties.ownershipDetails)) : null,
                        ownershipType: (feature.properties && feature.properties.ownershipType) || null
                    }))
                };
                takenFeatures.forEach(feature => {
                    if (!feature.properties) feature.properties = {};
                    feature.properties.ownershipDetails = JSON.parse(JSON.stringify(proposerOwnership));
                    feature.properties.ownershipType = 'private';
                    try { this._persistParcelFeature(feature); } catch (_) { }
                });
                finishOwnership(takenIds, buildingProposal.formation);
            } else {
                // Merge whole hosts into ONE parcel — the union of their ground, not the
                // building outline.
                let unionFeature = null;
                try {
                    unionFeature = takenFeatures.reduce((acc, feature) => {
                        const asFeat = { type: 'Feature', properties: {}, geometry: feature.geometry };
                        return acc ? turfRef.union(acc, asFeat) : asFeat;
                    }, null);
                } catch (_) { unionFeature = null; }
                if (!unionFeature || !unionFeature.geometry) {
                    const message = 'Could not merge the host parcels into one parcel.';
                    try { this._setLastApplyFailure(idLabel, { code: 'building-merge-failed', message }); } catch (_) { }
                    return { ok: false };
                }
                const primary = takenFeatures[0];
                const childFeature = {
                    type: 'Feature',
                    geometry: JSON.parse(JSON.stringify(unionFeature.geometry)),
                    properties: {
                        proposalId,
                        parentParcelIds: takenIds.slice(),
                        parentParcelId: takenIds[0],
                        rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, takenIds[0]) || takenIds[0],
                        rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, takenIds[0]) || null,
                        baseParcelIds: formationEdit.baseIdsOfFeatures(takenFeatures),
                        calculatedArea: Math.round(_calculateGeoJsonArea(unionFeature.geometry)),
                        isProposed: true,
                        ownershipDetails: JSON.parse(JSON.stringify(proposerOwnership)),
                        ownershipType: 'private'
                    }
                };
                this._assignSyntheticChildIdentities(proposalId, [childFeature]);
                const childId = _getParcelIdFromFeature(childFeature);
                this._addFeaturesToMap([childFeature], true, proposalData);
                try { this._persistParcelFeature(childFeature); } catch (_) { }
                try { if (childId) this._addProposalAsAncestor(childId, proposalId); } catch (_) { }
                this._hideFeaturesFromMap(takenFeatures);
                buildingProposal.childParcelIds = childId ? [String(childId)] : [];
                proposalData.childParcelIds = buildingProposal.childParcelIds.slice();
                try { this._addChildParcels(proposalId, buildingProposal.childParcelIds, proposalData); } catch (_) { }
                buildingProposal.formation = { mode: 'merge', parcelIds: takenIds.slice(), childParcelIds: buildingProposal.childParcelIds.slice() };
                finishOwnership(buildingProposal.childParcelIds, buildingProposal.formation);
            }
            buildingProposal.parentParcelIds = takenIds.slice();
            proposalData.parentParcelIds = takenIds.slice();
            return { ok: true, parentIds: takenIds.slice() };
        }

        // Default: FOOTPRINT parcel. Hosts are every live parcel the footprint genuinely overlaps;
        // the footprint must stand on live fabric (uncovered ground refuses loudly).
        const footprintArea = takeCtx.area(footprint);
        if (!(footprintArea > 0)) {
            try { this._setLastApplyFailure(idLabel, { code: 'building-footprint-degenerate', message: 'The building footprint has no usable area.' }); } catch (_) { }
            return { ok: false };
        }
        const hosts = [];
        let coveredM2 = 0;
        candidates.forEach(entry => {
            const parcelFeature = { type: 'Feature', properties: {}, geometry: entry.feature.geometry };
            const overlap = takeCtx.intersectionArea(footprint, parcelFeature);
            if (overlap < formationEdit.DEFAULT_TOLERANCE_M2) return;
            coveredM2 += overlap;
            hosts.push(entry);
        });
        if (!hosts.length) {
            const message = 'No parcels found under the building footprint.';
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-no-parcels', message }); } catch (_) { }
            return { ok: false };
        }
        const uncoveredM2 = Math.max(0, footprintArea - coveredM2);
        if (uncoveredM2 > Math.max(formationEdit.DEFAULT_TOLERANCE_M2, footprintArea * formationEdit.DEFAULT_TOLERANCE_PCT / 100)) {
            const message = `Part of the building footprint lies on no live parcel here (${Math.round(uncoveredM2 / footprintArea * 100)}% uncovered).`;
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-uncovered-ground', message }); } catch (_) { }
            return { ok: false };
        }

        const hostIds = hosts.map(entry => String(entry.id));
        const hostFeatures = hosts.map(entry => entry.feature);
        const primary = hostFeatures[0];
        const parentEntries = hosts.map(entry => ({
            baseId: formationEdit.baseIdOf(
                (entry.feature.properties && entry.feature.properties.rootParcelId) || String(entry.id)),
            feature: entry.feature
        }));

        const buildingParcel = {
            type: 'Feature',
            geometry: JSON.parse(JSON.stringify(footprintGeometry)),
            properties: {
                proposalId,
                buildingParcel: true,
                parentParcelIds: hostIds.slice(),
                parentParcelId: hostIds[0],
                rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, hostIds[0]) || hostIds[0],
                rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, hostIds[0]) || null,
                baseParcelIds: formationEdit.overlappingBaseIds(footprint, parentEntries, takeCtx),
                calculatedArea: Math.round(_calculateGeoJsonArea(footprintGeometry)),
                isProposed: true,
                ownershipDetails: JSON.parse(JSON.stringify(proposerOwnership)),
                ownershipType: 'private'
            }
        };

        // Each host's remainder goes back to its owner (§14.2) — cloned from the host so the
        // owner, numbers and styling inherit; the identity funnel re-mints ids and explodes any
        // multi-part remainder into one parcel per piece.
        const remainders = [];
        hostFeatures.forEach(hostFeature => {
            let difference = null;
            try {
                difference = turfRef.difference(
                    { type: 'Feature', properties: {}, geometry: hostFeature.geometry },
                    footprint
                );
            } catch (_) { difference = null; }
            if (!difference || !difference.geometry) return; // host fully consumed by the footprint
            const hostId = _getParcelIdFromFeature(hostFeature);
            const remainder = JSON.parse(JSON.stringify(hostFeature));
            remainder.geometry = difference.geometry;
            remainder.properties = remainder.properties || {};
            remainder.properties.proposalId = proposalId;
            remainder.properties.parentParcelId = hostId !== undefined && hostId !== null ? String(hostId) : null;
            remainder.properties.parentParcelNumber = hostFeature.properties ? (hostFeature.properties.BROJ_CESTICE || null) : null;
            remainder.properties.calculatedArea = Math.round(_calculateGeoJsonArea(difference.geometry));
            remainders.push(remainder);
        });

        const children = [buildingParcel, ...remainders];
        this._assignSyntheticChildIdentities(proposalId, children);
        this._addFeaturesToMap(children, true, proposalData);
        const childIds = [];
        children.forEach(child => {
            const childId = _getParcelIdFromFeature(child);
            if (childId !== undefined && childId !== null) childIds.push(String(childId));
            try { this._persistParcelFeature(child); } catch (_) { }
            try { if (childId) this._addProposalAsAncestor(childId, proposalId); } catch (_) { }
        });
        this._hideFeaturesFromMap(hostFeatures);
        buildingProposal.childParcelIds = childIds.slice();
        proposalData.childParcelIds = childIds.slice();
        try { this._addChildParcels(proposalId, childIds, proposalData); } catch (_) { }

        const buildingParcelId = _getParcelIdFromFeature(buildingParcel);
        buildingProposal.formation = {
            mode: 'footprint',
            parcelIds: hostIds.slice(),
            childParcelIds: childIds.slice(),
            buildingParcelIds: buildingParcelId ? [String(buildingParcelId)] : []
        };
        finishOwnership(buildingProposal.formation.buildingParcelIds, buildingProposal.formation);

        buildingProposal.parentParcelIds = hostIds.slice();
        proposalData.parentParcelIds = hostIds.slice();
        return { ok: true, parentIds: hostIds.slice() };
    },
    };
});
