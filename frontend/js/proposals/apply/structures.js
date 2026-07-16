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
            const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';

            // Structures clear their ground by default. A structure with NO demolition list
            // (created before the feature, or while no building footprints were loaded)
            // computes it now, at apply time, after making sure footprints are available.
            if (!Array.isArray(sp.demolishedBuildings) || (!sp.demolishedBuildings.length && sp.demolitionScanned !== true)) {
                try {
                    if (typeof window.ensureCorridorBuildingFootprintsLoaded === 'function') {
                        await window.ensureCorridorBuildingFootprintsLoaded();
                    }
                    if (sp.geometry && typeof window.demolishBuildingsUnderFootprint === 'function') {
                        sp.demolishedBuildings = await window.demolishBuildingsUnderFootprint(sp.geometry);
                        sp.demolitionScanned = true;
                        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') proposalStorage.save();
                    }
                } catch (error) {
                    console.error('[_applyStructureProposal] demolition scan failed', idLabel, error);
                }
            }
            console.debug(`[_applyStructureProposal] Step 1: Initialized structure proposal (${(performance.now() - step1Time).toFixed(2)}ms) - kind: ${kind}`);

            const collection = (kind === 'park') ? window.parks : (kind === 'lake' ? window.lakes : window.squares);
            const alreadyInLayer = Array.isArray(collection)
                ? collection.some(feature => feature && feature.properties && feature.properties.proposalId === proposalId)
                : false;
            const alreadyAppliedStatus = appliedOf(proposalData, sp) || lifecycleOf(proposalData) === 'Executed';
            if (alreadyAppliedStatus && alreadyInLayer) {
                return true;
            }
            const step2Time = performance.now();
            const canonicalGeometry = this._getCanonicalStructureGeometry(proposalData, kind);
            let geometry = sp.geometry;
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                geometry = canonicalGeometry;
            }
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
            const parentIds = Array.from(new Set([
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
                        return false;
                    }
                } catch (e) {
                    console.warn('Failed to enforce unique structure proposal constraint', e);
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
            }

            const feature = {
                type: 'Feature',
                properties: {
                    structureType: kind,
                    blockName: blockName,
                    proposalId,
                    lakeGraphics: sp.lakeGraphics || null,
                    decorations: sp.decorations ? JSON.parse(JSON.stringify(sp.decorations)) : undefined
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
                window.parks.push(feature);
                try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
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
                try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
                try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
            } else {
                if (!Array.isArray(window.squares)) window.squares = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.squares = window.squares.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureSquareDecorations === 'function') ensureSquareDecorations(feature); } catch (_) { }
                window.squares.push(feature);
                try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
            }
            console.debug(`[_applyStructureProposal] Step 4: Added ${kind} to map and storage (${(performance.now() - step4Time).toFixed(2)}ms)`);

            const step5Time = performance.now();
            // Link to ancestors without hiding parent parcels; keep parcels clickable beneath the square overlay
            const uniqueParentIds = Array.from(new Set((parentIds || []).filter(Boolean)));

            this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);
            this._linkProposalToAncestors(proposalId, uniqueParentIds);
            uniqueParentIds.forEach(id => this._unmarkParcelModified(id));
            console.debug(`[_applyStructureProposal] Step 5: Linked ${uniqueParentIds.length} ancestors without removing parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);

            // The structure is now on the map. persistAppliedProposal moves only the root-local
            // application axis; the lifecycle (Active/Executed) is left as-is.
            proposalData.structureProposal = sp;
            persistAppliedProposal(proposalData, proposalId);
            refreshProposalUIAfterApply(`Applied ${kind} proposal ${proposalData.title || idLabel}`);

            const totalTime = performance.now() - startTime;
            console.debug(`[_applyStructureProposal] ✓ Structure proposal application completed in ${totalTime.toFixed(2)}ms`);
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            return false;
        }
    },
    };
});
