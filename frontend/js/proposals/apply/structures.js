// _applyStructureProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyStructures = api;
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
    async _applyStructureProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyStructureProposal] Starting application for ${idLabel}...`);
        try {
            const step1Time = performance.now();
            const sp = proposalData.structureProposal || {};
            const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
            const canonicalGeometry = typeof this._getCanonicalStructureGeometry === 'function'
                ? this._getCanonicalStructureGeometry(proposalData, kind)
                : null;
            let geometry = sp.geometry;
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                geometry = canonicalGeometry;
            }
            if ((!geometry || !geometry.type || !Array.isArray(geometry.coordinates))
                && typeof this._rebuildStructureGeometry === 'function') {
                geometry = this._rebuildStructureGeometry(sp, proposalData);
            }
            if (geometry && geometry.type && Array.isArray(geometry.coordinates)) {
                try { sp.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { sp.geometry = geometry; }
            }
            const refreshStructureLayer = () => {
                if (kind === 'park') {
                    if (typeof updateParksLayer === 'function') updateParksLayer();
                } else if (kind === 'lake') {
                    if (typeof updateLakesLayer === 'function') updateLakesLayer();
                } else if (kind === 'station') {
                    if (typeof updateTransitStationsLayer === 'function') updateTransitStationsLayer();
                } else if (typeof updateSquaresLayer === 'function') {
                    updateSquaresLayer();
                }
            };
            let repairedEmptyDemolitionScan = false;

            // Structures clear their ground by default. A structure with NO demolition list
            // (created before the feature, or after an earlier footprint fetch failed) computes
            // it now, after making sure footprints are available. An EMPTY scan is deliberately
            // retried on reapply/load: `demolitionScanned=true` used to make a transient empty
            // pool permanent, so covered buildings survived forever after one failed request.
            if (!Array.isArray(sp.demolishedBuildings) || !sp.demolishedBuildings.length) {
                try {
                    if (typeof window.ensureCorridorBuildingFootprintsLoaded === 'function') {
                        await window.ensureCorridorBuildingFootprintsLoaded();
                    }
                    if (geometry && typeof window.demolishBuildingsUnderFootprint === 'function') {
                        const previousCount = Array.isArray(sp.demolishedBuildings) ? sp.demolishedBuildings.length : 0;
                        sp.demolishedBuildings = await window.demolishBuildingsUnderFootprint(geometry);
                        sp.demolitionScanned = true;
                        repairedEmptyDemolitionScan = previousCount === 0 && sp.demolishedBuildings.length > 0;
                        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') proposalStorage.save();
                    }
                } catch (error) {
                    console.error('[_applyStructureProposal] demolition scan failed', idLabel, error);
                }
            }
            console.debug(`[_applyStructureProposal] Step 1: Initialized structure proposal (${(performance.now() - step1Time).toFixed(2)}ms) - kind: ${kind}`);

            const collection = kind === 'park'
                ? window.parks
                : (kind === 'lake'
                    ? window.lakes
                    : (kind === 'station' ? window.transitStations : window.squares));
            const alreadyInLayer = Array.isArray(collection)
                ? collection.some(feature => feature && feature.properties && feature.properties.proposalId === proposalId)
                : false;
            const alreadyAppliedStatus = appliedOf(proposalData, sp) || lifecycleOf(proposalData) === 'Executed';
            if (alreadyAppliedStatus && alreadyInLayer) {
                if (repairedEmptyDemolitionScan) {
                    try { refreshStructureLayer(); } catch (error) {
                        console.error(`[_applyStructureProposal] Failed to refresh repaired ${kind} presentation`, error);
                    }
                }
                return true;
            }
            const step2Time = performance.now();
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                if (typeof updateStatus === 'function') updateStatus('Cannot apply structure proposal: missing geometry.');
                console.warn('[_applyStructureProposal] Missing geometry for structure proposal; refusing to apply', {
                    proposalId: idLabel,
                    kind,
                    hasStructureGeometry: !!sp.geometry,
                    hasCanonicalGeometry: !!canonicalGeometry
                });
                try { this._setLastApplyFailure(idLabel, 'Cannot apply structure proposal: missing geometry.'); } catch (_) { }
                return false;
            }
            const blockName = sp.blockName || null;
            let parentIds = Array.from(new Set([
                ...(Array.isArray(sp.parentParcelIds) ? sp.parentParcelIds : []),
                ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
            ].map(x => x && x.toString ? x.toString() : (x !== undefined && x !== null ? String(x) : null)).filter(Boolean)));

            // Persist canonical geometry/parents onto the structureProposal for downstream consumers
            if (geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { sp.geometry = geometry; }
            }
            sp.parentParcelIds = parentIds;

            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                // Fallback: attempt to resolve parent parcel features directly and rebuild geometry
                let resolvedGeometry = null;
                try {
                    const parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                    if (Array.isArray(parentFeatures) && parentFeatures.length > 0) {
                        const pseudoLayers = parentFeatures.map(feature => ({ feature }));
                        resolvedGeometry = buildGeometryFromParcels(pseudoLayers);
                    }
                } catch (fallbackErr) {
                    console.warn('[_applyStructureProposal] Fallback geometry rebuild failed', fallbackErr);
                }

                if (resolvedGeometry && resolvedGeometry.type && Array.isArray(resolvedGeometry.coordinates)) {
                    geometry = resolvedGeometry;
                } else {
                    if (typeof updateStatus === 'function') updateStatus('Cannot apply structure proposal: missing geometry.');
                    try {
                        const cityId = typeof window !== 'undefined' && window.cityConfigManager && typeof window.cityConfigManager.getCurrentCityId === 'function'
                            ? window.cityConfigManager.getCurrentCityId()
                            : null;
                        console.warn('[_applyStructureProposal] Missing geometry after rebuild', {
                            cityId,
                            parentIdsCount: parentIds.length,
                            kind,
                            hasStoredGeometry: !!sp.geometry,
                            parentIdsSample: parentIds.slice(0, 5)
                        });
                    } catch (_) { /* ignore logging errors */ }
                    try {
                        this._setLastApplyFailure(idLabel, {
                            code: 'structure-geometry-unresolvable',
                            message: `The ${kind} has no stored geometry and none could be rebuilt from its ${parentIds.length} parent parcel(s).`
                        });
                    } catch (_) { }
                    return false;
                }
            }
            console.debug(`[_applyStructureProposal] Step 2: Prepared geometry and parent IDs (${(performance.now() - step2Time).toFixed(2)}ms) - ${parentIds.length} parents`);

            const step3Time = performance.now();
            // Enforce only one structure per block: unapply other applied structure proposals on same block
            if (blockName) {
                try {
                    const all = proposalStorage.getAllProposals();
                    const conflicts = all.filter(p => (
                        p.proposalId !== proposalId
                        && p.structureProposal
                        && p.structureProposal.blockName === blockName
                        && appliedOf(p, p.structureProposal)
                    ));
                    const conflictsCleared = await unapplyConflictsSequentially(this, conflicts, {
                        skipRestoreSource: true,
                        _mutationTransaction: options._mutationTransaction
                    });
                    if (!conflictsCleared) {
                        console.warn('Could not unapply a conflicting structure proposal', { proposalId, blockName });
                        try {
                            this._setLastApplyFailure(idLabel, {
                                code: 'conflict-unapply-failed',
                                message: `Another structure already occupies block ${blockName} and could not be unapplied.`,
                                conflictTitles: conflicts.map(p => p && p.title).filter(Boolean),
                                conflictProposalIds: conflicts.map(p => p && p.proposalId).filter(Boolean)
                            });
                        } catch (_) { }
                        return false;
                    }
                } catch (e) {
                    console.warn('Failed to enforce unique structure proposal constraint', e);
                    try {
                        this._setLastApplyFailure(idLabel, {
                            code: 'conflict-check-failed',
                            message: `Checking for a conflicting structure on block ${blockName} threw: ${e && e.message ? e.message : e}`
                        });
                    } catch (_) { }
                    return false;
                }
            }
            console.debug(`[_applyStructureProposal] Step 3: Unapplied conflicting structures (${(performance.now() - step3Time).toFixed(2)}ms)`);

            // Cross-type conflict / availability check. A structure OVERLAYS its parents (never hides
            // them), so "apply anyway" just renders it. Same-block structures were already
            // auto-unapplied above; this catches parcels occupied by OTHER proposal types
            // (road/building/reparcellization) and offers unapply-or-apply-anyway.
            {
                const parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: parentIds, parentFeatures, options });
                if (decision.defer) {
                    return false;
                }
                // Flat anchor (rethink-proposals.md §15a): content is positioned against the base
                // cadastral parcels, whatever generation the parcels it overlays belong to.
                try {
                    const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
                    const cadastreIds = formationEdit ? formationEdit.baseIdsOfFeatures(decision.parentFeatures || parentFeatures) : [];
                    if (cadastreIds.length) proposalData.cadastreParcelIds = cadastreIds;
                } catch (_) { }
            }

            // §15a structure formation (decision 2026-08-05): a park/square/lake TAKES its
            // ground — adopt the one parcel matching the footprint, or merge whole parcels into
            // one minted parcel — with ownership → City at apply. Partial coverage of any parcel
            // refuses with the offenders named. A station stays content on its corridor and
            // forms nothing.
            if (kind !== 'station') {
                const formation = await this._formStructureParcel(proposalId, proposalData, sp, geometry, parentIds, idLabel);
                if (!formation.ok) return false;
                parentIds = formation.parentIds;
            }

            const step4Time = performance.now();
            // Add to appropriate collection and layer
            // Ensure canonical geometry container is populated for downstream consumers
            if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
                proposalData.geometry = {
                    superParcel: null,
                    lakeGraphics: kind === 'lake' ? (sp.lakeGraphics || null) : null,
                    parkGraphics: kind === 'park' ? geometry : null,
                    squareGraphics: kind === 'square' ? geometry : null,
                    stationGraphics: kind === 'station' ? geometry : null,
                    roadGeometry: null,
                    roadPlan: null,
                    buildings: null,
                    reparcellizationPolygons: null
                };
            } else {
                if (kind === 'lake' && sp.lakeGraphics && !proposalData.geometry.lakeGraphics) {
                    proposalData.geometry.lakeGraphics = sp.lakeGraphics;
                }
                if (kind === 'park' && !proposalData.geometry.parkGraphics) {
                    proposalData.geometry.parkGraphics = geometry;
                }
                if (kind === 'square' && !proposalData.geometry.squareGraphics) {
                    proposalData.geometry.squareGraphics = geometry;
                }
                if (kind === 'station' && !proposalData.geometry.stationGraphics) {
                    proposalData.geometry.stationGraphics = geometry;
                }
            }

            const feature = {
                type: 'Feature',
                properties: {
                    structureType: kind,
                    blockName: blockName,
                    proposalId,
                    lakeGraphics: sp.lakeGraphics || null,
                    decorations: sp.decorations ? JSON.parse(JSON.stringify(sp.decorations)) : undefined,
                    stationType: sp.stationType || undefined,
                    center: Array.isArray(sp.center) ? sp.center.slice() : undefined,
                    bearing: Number.isFinite(Number(sp.bearing)) ? Number(sp.bearing) : undefined,
                    platformHeightM: Number.isFinite(Number(sp.platformHeightM)) ? Number(sp.platformHeightM) : undefined,
                    attachment: sp.attachment ? JSON.parse(JSON.stringify(sp.attachment)) : undefined,
                    modelVersion: sp.modelVersion || undefined,
                    name: proposalData.title || proposalData.name || undefined,
                    parentParcelIds: parentIds.slice()
                },
                geometry: JSON.parse(JSON.stringify(geometry))
            };
            if (kind === 'park') {
                if (!Array.isArray(window.parks)) window.parks = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.parks = window.parks.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureParkDecorations === 'function') ensureParkDecorations(feature); } catch (_) { }
                // Auto-layout is generated on the rendered feature. Keep the same canonical copy
                // on the proposal so every generated item is present when Design is reopened.
                if (feature.properties?.decorations) {
                    sp.decorations = JSON.parse(JSON.stringify(feature.properties.decorations));
                }
                window.parks.push(feature);
                try { PersistentStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
            } else if (kind === 'lake') {
                if (!Array.isArray(window.lakes)) window.lakes = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.lakes = window.lakes.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureLakeGraphics === 'function') ensureLakeGraphics(feature); } catch (_) { }
                window.lakes.push(feature);
                try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
            } else if (kind === 'station') {
                if (!Array.isArray(window.transitStations)) window.transitStations = [];
                window.transitStations = window.transitStations.filter(f => {
                    if (!f || !f.properties) return true;
                    return String(f.properties.proposalId || '') !== String(proposalId);
                });
                window.transitStations.push(feature);
                try { PersistentStorage.setItem('cb_transit_stations', JSON.stringify(window.transitStations)); } catch (_) { }
            } else {
                if (!Array.isArray(window.squares)) window.squares = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.squares = window.squares.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureSquareDecorations === 'function') ensureSquareDecorations(feature); } catch (_) { }
                if (feature.properties?.decorations) {
                    sp.decorations = JSON.parse(JSON.stringify(feature.properties.decorations));
                }
                window.squares.push(feature);
                try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
            }
            console.debug(`[_applyStructureProposal] Step 4: Prepared ${kind} layer data and storage (${(performance.now() - step4Time).toFixed(2)}ms)`);

            const step5Time = performance.now();
            // Link to ancestors. An ADOPTED parcel stays on the map (owner changed, ground identical);
            // a merge-take has already hidden its consumed parents and minted the structure's parcel.
            const uniqueParentIds = Array.from(new Set((parentIds || []).filter(Boolean)));

            this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);
            this._linkProposalToAncestors(proposalId, uniqueParentIds);
            uniqueParentIds.forEach(id => this._unmarkParcelModified(id));
            console.debug(`[_applyStructureProposal] Step 5: Linked ${uniqueParentIds.length} ancestors without removing parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);

            // The structure is now on the map. persistAppliedProposal moves only the root-local
            // application axis; the lifecycle (Active/Executed) is left as-is. Persist the model
            // BEFORE refreshing its views: both 2D and 3D building filters read the canonical
            // application flag when the structure-layer update event fires.
            proposalData.structureProposal = sp;
            persistAppliedProposal(proposalData, proposalId);
            try { refreshStructureLayer(); } catch (error) {
                console.error(`[_applyStructureProposal] Failed to refresh ${kind} presentation`, error);
            }
            refreshProposalUIAfterApply(`Applied ${kind} proposal ${proposalData.title || idLabel}`);

            const totalTime = performance.now() - startTime;
            console.debug(`[_applyStructureProposal] ✓ Structure proposal application completed in ${totalTime.toFixed(2)}ms`);
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-apply-threw',
                    message: `Applying the structure threw: ${e && e.message ? e.message : e}`
                });
            } catch (_) { }
            return false;
        }
    },

    // §15a structure formation (decision 2026-08-05). A park/square/lake takes WHOLE parcels
    // only: adopt the one parcel matching its footprint (formation is adoptive, §15.1 — ownership
    // moves, nothing is cut or minted), or merge-take a union of whole parcels into ONE minted
    // parcel anchored flat to every base underneath. Partial coverage of any parcel REFUSES with
    // the offenders named — if only part of a parcel is wanted, a road or a land readjustment
    // cuts it first. Ownership goes to the City agent at apply, the reparcellization pattern.
    async _formStructureParcel(proposalId, proposalData, sp, geometry, declaredParentIds, idLabel) {
        // Idempotent on restore: an already-formed structure keeps its record — unapply deletes
        // it, so only a fresh apply re-takes from the live fabric.
        if (sp.formation && Array.isArray(sp.formation.parcelIds) && sp.formation.parcelIds.length) {
            return { ok: true, parentIds: sp.formation.parcelIds.map(String) };
        }
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            console.error('[_formStructureParcel] formation-edit/turf missing — the structure cannot take its parcel');
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-formation-unavailable',
                    message: 'The formation engine is unavailable in this session; the structure cannot take its parcel.'
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
        const footprint = { type: 'Feature', properties: {}, geometry };

        // Candidates: the live parcels under the footprint — geometry decides (§15a); the
        // declared parents are only the fallback when the resolver cannot see the fabric.
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

        const plan = formationEdit.wholeParcelTakePlan(footprint, candidates, takeCtx);
        if (plan.mode === 'refuse') {
            const partialText = plan.partials
                .map(partial => `${partial.id} (${Math.round(partial.coveredShare * 100)}%)`)
                .join(', ');
            const message = plan.reason === 'partial-parcels'
                ? `A ${sp.kind} must take whole parcels, but this footprint covers only part of: ${partialText}. Cut the ground first with a road or a land readjustment.`
                : (plan.reason === 'uncovered-ground'
                    ? `Part of the ${sp.kind} footprint lies on no live parcel here (${Math.round(plan.uncoveredShare * 100)}% uncovered).`
                    : `No parcels found under the ${sp.kind} footprint.`);
            if (typeof updateStatus === 'function') updateStatus(message);
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-partial-parcels',
                    message,
                    partials: plan.partials
                });
            } catch (_) { }
            return { ok: false };
        }

        const takenIds = plan.parcelIds.map(String);
        const takenFeatures = candidates
            .filter(entry => takenIds.includes(String(entry.id)))
            .map(entry => entry.feature);
        const cityAgentId = (typeof getOrCreateCityAgent === 'function') ? getOrCreateCityAgent() : null;
        const cityOwnership = { owners: [{ name: 'City', ownerLabel: 'City', percentageShare: 100, actualShareText: '100%' }] };

        if (plan.mode === 'adopt') {
            sp.formation = {
                mode: 'adopt',
                parcelIds: takenIds.slice(),
                // The snapshot unapply restores — recorded BEFORE ownership moves.
                prior: takenFeatures.map(feature => ({
                    parcelId: String(_getParcelIdFromFeature(feature)),
                    ownershipDetails: feature.properties && feature.properties.ownershipDetails
                        ? JSON.parse(JSON.stringify(feature.properties.ownershipDetails)) : null,
                    ownershipType: (feature.properties && feature.properties.ownershipType) || null
                }))
            };
            takenFeatures.forEach(feature => {
                if (!feature.properties) feature.properties = {};
                feature.properties.ownershipDetails = JSON.parse(JSON.stringify(cityOwnership));
                feature.properties.ownershipType = 'city';
                try { this._persistParcelFeature(feature); } catch (_) { }
            });
        } else {
            const primary = takenFeatures[0];
            const childFeature = {
                type: 'Feature',
                geometry: JSON.parse(JSON.stringify(geometry)),
                properties: {
                    proposalId,
                    structureType: sp.kind,
                    parentParcelIds: takenIds.slice(),
                    parentParcelId: takenIds[0],
                    rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, takenIds[0]) || takenIds[0],
                    rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, takenIds[0]) || null,
                    baseParcelIds: formationEdit.baseIdsOfFeatures(takenFeatures),
                    calculatedArea: Math.round(_calculateGeoJsonArea(geometry)),
                    isProposed: true,
                    ownershipDetails: JSON.parse(JSON.stringify(cityOwnership)),
                    ownershipType: 'city'
                }
            };
            this._assignSyntheticChildIdentities(proposalId, [childFeature]);
            const childId = _getParcelIdFromFeature(childFeature);
            this._addFeaturesToMap([childFeature], true, proposalData);
            try { this._persistParcelFeature(childFeature); } catch (_) { }
            try { if (childId) this._addProposalAsAncestor(childId, proposalId); } catch (_) { }
            this._hideFeaturesFromMap(takenFeatures);
            sp.childParcelIds = childId ? [String(childId)] : [];
            proposalData.childParcelIds = sp.childParcelIds.slice();
            try { this._addChildParcels(proposalId, sp.childParcelIds, proposalData); } catch (_) { }
            sp.formation = { mode: 'merge', parcelIds: takenIds.slice(), childParcelIds: sp.childParcelIds.slice() };
        }

        if (cityAgentId && typeof transferParcelOwnership === 'function') {
            sp.formation.ownerAgentId = cityAgentId;
            const ownedNow = plan.mode === 'adopt' ? takenIds : sp.formation.childParcelIds;
            ownedNow.forEach(pid => {
                try { transferParcelOwnership(String(pid), null, cityAgentId, { skipAgentSync: true }); } catch (_) { }
            });
            if (typeof buildAgentOwnedParcelIndex === 'function' && typeof agentStorage !== 'undefined') {
                try {
                    agentStorage.beginBatch();
                    const ownerIndex = buildAgentOwnedParcelIndex();
                    agentStorage.updateAgent(cityAgentId, { ownedParcels: ownerIndex.get(cityAgentId) || [] });
                } finally {
                    agentStorage.endBatch();
                }
            }
        }

        sp.parentParcelIds = takenIds.slice();
        proposalData.parentParcelIds = takenIds.slice();
        return { ok: true, parentIds: takenIds.slice() };
    },
    };
});
