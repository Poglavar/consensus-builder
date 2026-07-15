// Per-type apply/unapply implementations extracted from proposal-manager.js and mixed back in via
// Object.assign. `this` is ProposalManager at call time, so these keep using `this._x()` and the
// bare-name globals declared in proposal-manager.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalManagerApplyMethods = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

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
                    all.filter(p => p.proposalId !== proposalId && p.structureProposal && p.structureProposal.blockName === blockName)
                        .forEach(p => {
                            if (appliedOf(p, p.structureProposal)) {
                                const hasFamilyUnapply = typeof this.unapplyWholeFamily === 'function';
                                if (hasFamilyUnapply) {
                                    this.unapplyWholeFamily(p.proposalId, new Set(), { skipRestoreSource: true });
                                } else if (typeof this.unapplyProposal === 'function') {
                                    this.unapplyProposal(p.proposalId, { skipConfirm: true, skipRestoreSource: true });
                                }
                            }
                        });
                } catch (e) { }
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

            const step6Time = performance.now();
            // The structure is now on the map. Applying only moves the map-application axis; the
            // lifecycle (Active/Executed) is left as-is (executed structures stay executed).
            sp.applied = true;
            proposalData.structureProposal = sp;
            proposalData.applied = true;
            proposalData.proposalId = proposalData.proposalId || proposalId;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (proposalStorage.save) proposalStorage.save();
            console.debug(`[_applyStructureProposal] Step 6: Updated and saved proposal status (${(performance.now() - step6Time).toFixed(2)}ms)`);

            const step7Time = performance.now();
            try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
            try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
            try { if (typeof updateStatus === 'function') updateStatus(`Applied ${kind} proposal ${proposalData.title || idLabel}`); } catch (_) { }
            if (typeof refreshParcelStylesForAppliedProposals === 'function') {
                refreshParcelStylesForAppliedProposals();
            }
            console.debug(`[_applyStructureProposal] Step 7: Updated UI (${(performance.now() - step7Time).toFixed(2)}ms)`);

            const totalTime = performance.now() - startTime;
            console.debug(`[_applyStructureProposal] ✓ Structure proposal application completed in ${totalTime.toFixed(2)}ms`);
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            return false;
        }
    },

    async _applyDecideLaterProposal(proposalId, proposalData) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyDecideLaterProposal] Starting application for ${idLabel}...`);

        const decideLaterState = proposalData.decideLaterProposal || {};
        const parentIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.parentParcelIds) ? decideLaterState.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        let childIdsExisting = Array.from(new Set([
            ...(Array.isArray(decideLaterState.childParcelIds) ? decideLaterState.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        // Always try to recover child parcels from PersistentStorage, even if we have some IDs
        // This ensures we find child parcels even if the proposal data is missing childParcelIds
        if (typeof PersistentStorage !== 'undefined' && typeof PersistentStorage.key === 'function' && typeof PersistentStorage.length === 'number') {
            const recovered = [];
            const proposalIdStr = String(proposalId);
            // Also try normalized versions for matching
            const normalizedProposalId = _normalizeProposalId(proposalId) || proposalIdStr;
            const syntheticToken = _buildSyntheticToken(proposalId, 'proposal');
            const escapedToken = _escapeRegExp(syntheticToken);
            const tokenSuffixRegex = new RegExp(`#${escapedToken}-(\\d+)$`);
            const legacyTokenSuffixRegex = new RegExp(`${escapedToken}(?:/(\\d+)|_(\\d+))$`);
            console.debug(`[_applyDecideLaterProposal] Scanning PersistentStorage for child parcels with ancestorProposal=${proposalIdStr} (normalized=${normalizedProposalId})...`);

            // Debug: Log all parcels with ancestorProposal to see what we have
            const allParcelsWithAncestor = [];
            for (let i = 0; i < PersistentStorage.length; i++) {
                const key = PersistentStorage.key(i);
                if (!key || !key.startsWith('parcel_')) continue;
                if (key.includes('_owner') || key.includes('_road')) continue;
                try {
                    const raw = PersistentStorage.getItem(key);
                    const parsed = raw ? JSON.parse(raw) : null;
                    if (parsed && parsed.properties && parsed.properties.ancestorProposal) {
                        allParcelsWithAncestor.push({
                            key,
                            id: parsed.id || key.slice('parcel_'.length),
                            ancestorProposal: parsed.properties.ancestorProposal,
                            mergedFromDecideLater: parsed.properties.mergedFromDecideLater
                        });
                    }
                } catch (_) { }
            }
            if (allParcelsWithAncestor.length > 0) {
                console.debug(`[_applyDecideLaterProposal] Found ${allParcelsWithAncestor.length} parcels with ancestorProposal in storage:`, allParcelsWithAncestor);
            } else {
                console.debug(`[_applyDecideLaterProposal] No parcels with ancestorProposal found in storage`);
            }

            for (let i = 0; i < PersistentStorage.length; i++) {
                const key = PersistentStorage.key(i);
                if (!key || !key.startsWith('parcel_')) continue;
                if (key.includes('_owner') || key.includes('_road')) continue;

                let parsed = null;
                try {
                    const raw = PersistentStorage.getItem(key);
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (_) { /* ignore parse errors */ }

                if (!parsed || !parsed.properties) continue;

                // Check if this parcel was created by this proposal
                // Try multiple matching strategies in case of ID format differences
                const ancestorProposal = String(parsed.properties.ancestorProposal || '');
                const normalizedAncestor = _normalizeProposalId(ancestorProposal) || ancestorProposal;

                const candidateId = String(parsed.id || key.slice('parcel_'.length) || '');
                const candidateProposalId = String(parsed.properties.proposalId || parsed.properties.proposal_id || '');

                // Synthetic-id match: child parcels use `${rootId}#${token}-${index}` (or legacy token forms)
                // This is a strict id-based signal and avoids any similarity heuristics.
                const matchesToken = !!candidateId && (
                    tokenSuffixRegex.test(candidateId)
                    || legacyTokenSuffixRegex.test(candidateId)
                );

                // Match if exact match or normalized match
                const matchesProposal = ancestorProposal === proposalIdStr
                    || ancestorProposal === normalizedProposalId
                    || normalizedAncestor === proposalIdStr
                    || normalizedAncestor === normalizedProposalId
                    || (candidateProposalId && (candidateProposalId === proposalIdStr || candidateProposalId === normalizedProposalId))
                    || matchesToken;

                if (!matchesProposal) continue;

                // Also check mergedFromDecideLater flag as additional confirmation
                const isDecideLaterChild = parsed.properties.mergedFromDecideLater === true;

                if (candidateId) {
                    recovered.push(String(candidateId));
                    console.debug(`[_applyDecideLaterProposal] Found child parcel ${candidateId} in storage (ancestorProposal=${ancestorProposal}, normalized=${normalizedAncestor}, mergedFromDecideLater=${isDecideLaterChild})`);
                }
            }

            if (recovered.length) {
                const uniqueRecovered = Array.from(new Set(recovered.map(String).filter(Boolean)));
                const replacedCount = childIdsExisting.length;
                // Prefer recovered ids over stale `childParcelIds` in the proposal record.
                // Stale ids commonly happen when synthetic id formats change (legacy /token/idx vs new #token-idx).
                childIdsExisting = uniqueRecovered;
                console.debug(`[_applyDecideLaterProposal] Using ${childIdsExisting.length} recovered child parcel id(s) from storage for ${idLabel} (replaced ${replacedCount} stored id(s))`);
            } else {
                console.debug(`[_applyDecideLaterProposal] No child parcels found in PersistentStorage for ${idLabel} (searched for proposalId=${proposalIdStr}, normalized=${normalizedProposalId})`);
            }
        }

        const alreadyApplied = appliedOf(proposalData, decideLaterState) || lifecycleOf(proposalData) === 'Executed';

        const restoreFromExistingChildren = () => {
            if (!childIdsExisting.length) return null;
            // For decide later proposals, child parcels might only exist in PersistentStorage
            // Try to load them from storage if not found in map/cache
            const childFeatures = this._resolveParcelFeaturesByIds(childIdsExisting, {
                preferMap: true,
                allowStorage: true,
                allowMissing: true,  // Allow missing so we can fallback to direct storage load
                fallbackToMap: false
            }) || [];

            // If still not found, try loading directly from PersistentStorage
            // This is critical for decide later proposals where child parcels might only exist in storage
            if (childFeatures.length === 0 && typeof readPersistedParcelRecord === 'function') {
                console.debug(`[_applyDecideLaterProposal] Child parcels not found via _resolveParcelFeaturesByIds, trying direct PersistentStorage load for ${childIdsExisting.length} parcels`);
                for (const childId of childIdsExisting) {
                    try {
                        const record = readPersistedParcelRecord(childId);
                        if (record && record.properties) {
                            let geometry = null;

                            // Handle different geometry storage formats
                            if (record.geometry) {
                                if (record.geometry.type && record.geometry.coordinates) {
                                    // Already in GeoJSON format
                                    geometry = JSON.parse(JSON.stringify(record.geometry));
                                } else if (Array.isArray(record.geometry)) {
                                    // Stored as coordinates array directly - wrap in Polygon
                                    geometry = {
                                        type: 'Polygon',
                                        coordinates: [record.geometry]
                                    };
                                }
                            }

                            if (geometry && geometry.type && geometry.coordinates) {
                                const feature = {
                                    type: 'Feature',
                                    properties: { ...record.properties },
                                    geometry: geometry
                                };
                                // Ensure parcelId is set
                                if (!feature.properties.parcelId && childId) {
                                    feature.properties.parcelId = String(childId);
                                }
                                // Ensure ancestorProposal is set (critical for isParcelReplacedByChildren to work correctly)
                                if (!feature.properties.ancestorProposal) {
                                    feature.properties.ancestorProposal = proposalId;
                                }
                                childFeatures.push(feature);
                                console.debug(`[_applyDecideLaterProposal] Loaded child parcel ${childId} from PersistentStorage`, {
                                    hasGeometry: !!geometry,
                                    geometryType: geometry?.type,
                                    hasAncestorProposal: !!feature.properties.ancestorProposal
                                });
                            } else {
                                console.warn(`[_applyDecideLaterProposal] Child parcel ${childId} found in storage but missing valid geometry`, {
                                    hasRecord: !!record,
                                    hasGeometry: !!record?.geometry,
                                    geometryType: record?.geometry?.type,
                                    hasCoordinates: !!record?.geometry?.coordinates
                                });
                            }
                        }
                    } catch (err) {
                        console.warn(`[_applyDecideLaterProposal] Failed to load child parcel ${childId} from PersistentStorage:`, err);
                    }
                }
            }

            if (!childFeatures.length) {
                console.warn(`[_applyDecideLaterProposal] restoreFromExistingChildren: No child features found for ${idLabel}`, {
                    childIdsExisting,
                    childIdsExistingLength: childIdsExisting.length
                });
                return null;
            }
            console.debug(`[_applyDecideLaterProposal] restoreFromExistingChildren: Found ${childFeatures.length} child features for ${idLabel}`);

            // Only add layers that are not already on the map to avoid duplicates on repeated restores
            const missingFeatures = childFeatures.filter(feature => {
                const id = _getParcelIdFromFeature(feature);
                if (!id) {
                    console.warn(`[_applyDecideLaterProposal] Child feature missing parcelId:`, feature);
                    return false;
                }
                const alreadyOnMap = this._getParcelLayerById(id);
                if (alreadyOnMap) {
                    console.debug(`[_applyDecideLaterProposal] Child parcel ${id} already on map, skipping`);
                    return false;
                }
                return true;
            });
            if (missingFeatures.length) {
                console.debug(`[_applyDecideLaterProposal] Adding ${missingFeatures.length} child parcels to map for ${idLabel}`, {
                    featureIds: missingFeatures.map(f => _getParcelIdFromFeature(f)),
                    features: missingFeatures.map(f => ({
                        id: _getParcelIdFromFeature(f),
                        hasGeometry: !!f.geometry,
                        hasAncestorProposal: !!f.properties?.ancestorProposal,
                        ancestorProposal: f.properties?.ancestorProposal
                    }))
                });

                // Ensure all features have ancestorProposal set before adding
                missingFeatures.forEach(feature => {
                    if (!feature.properties) feature.properties = {};
                    if (!feature.properties.ancestorProposal) {
                        feature.properties.ancestorProposal = proposalId;
                        console.debug(`[_applyDecideLaterProposal] Set ancestorProposal=${proposalId} on feature ${_getParcelIdFromFeature(feature)}`);
                    }
                    if (!feature.properties.mergedFromDecideLater) {
                        feature.properties.mergedFromDecideLater = true;
                    }
                });

                this._addFeaturesToMap(missingFeatures, true, proposalData);

                // Verify they were added - wait a bit for async operations
                setTimeout(() => {
                    const addedIds = missingFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean);
                    const verifiedOnMap = addedIds.filter(id => this._getParcelLayerById(id));
                    if (verifiedOnMap.length !== addedIds.length) {
                        console.warn(`[_applyDecideLaterProposal] Only ${verifiedOnMap.length} of ${addedIds.length} child parcels verified on map after add`, {
                            missing: addedIds.filter(id => !verifiedOnMap.includes(id))
                        });
                    } else {
                        console.debug(`[_applyDecideLaterProposal] Successfully added ${verifiedOnMap.length} child parcels to map`);
                    }
                }, 100);
            } else if (childFeatures.length > 0) {
                console.debug(`[_applyDecideLaterProposal] All ${childFeatures.length} child parcels already on map`);
            }

            // Ensure child parcels are NOT flagged as removed and have their linkage set correctly
            childFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                feature.properties.ancestorProposal = proposalId;
                feature.properties.mergedFromDecideLater = true;
                this._persistParcelFeature(feature);
                this._addProposalAsAncestor(parcelId, proposalId);
                // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
            });
            this._addChildParcels(proposalId, childFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean), proposalData);
            return childFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean);
        };

        // Fast path: restoring an already applied proposal with stored children
        if (alreadyApplied) {
            const alreadyRestored = decideLaterState._restored === true;
            const childIdsOnMap = childIdsExisting.filter(id => this._getParcelLayerById(id));

            console.debug(`[_applyDecideLaterProposal] Restoring ${idLabel}:`, {
                childIdsExisting: childIdsExisting.length,
                childIdsOnMap: childIdsOnMap.length,
                alreadyRestored
            });

            // If everything is already in place, skip noisy work
            if (childIdsExisting.length && childIdsOnMap.length === childIdsExisting.length && alreadyRestored) {
                console.debug(`[_applyDecideLaterProposal] All ${childIdsOnMap.length} child parcels already on map and restored for ${idLabel}`);
                return true;
            }

            if (childIdsExisting.length && childIdsOnMap.length === childIdsExisting.length) {
                // Children already present; just ensure linkage/flags and exit
                // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js
                this._setDescendantProposalOnParcels(parentIds, proposalId);
                this._linkProposalToAncestors(proposalId, parentIds);
                this._markParcelsModifiedBatch([...parentIds, ...childIdsOnMap]);
                proposalData.decideLaterProposal = {
                    applied: true,
                    parentParcelIds: parentIds,
                    childParcelIds: childIdsExisting.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...childIdsExisting.map(String)]));
                proposalData.applied = true;
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposalData);
                if (proposalStorage.save) proposalStorage.save();
                console.debug(`[_applyDecideLaterProposal] Restored ${childIdsOnMap.length} child parcels already on map for ${idLabel}`);
                return true;
            }

            // Try to restore child parcels from storage
            console.debug(`[_applyDecideLaterProposal] Attempting to restore ${childIdsExisting.length} child parcels from storage for ${idLabel}`, {
                childIdsExisting,
                proposalId,
                proposalIdStr: String(proposalId)
            });
            const restoredChildIds = restoreFromExistingChildren();
            if (restoredChildIds && restoredChildIds.length) {
                console.debug(`[_applyDecideLaterProposal] Successfully restored ${restoredChildIds.length} child parcels for ${idLabel}:`, restoredChildIds);
                // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js
                this._setDescendantProposalOnParcels(parentIds, proposalId);
                this._linkProposalToAncestors(proposalId, parentIds);
                this._markParcelsModifiedBatch([...parentIds, ...restoredChildIds]);
                proposalData.decideLaterProposal = {
                    applied: true,
                    parentParcelIds: parentIds,
                    childParcelIds: restoredChildIds.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...restoredChildIds.map(String)]));
                proposalData.applied = true;
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposalData);
                if (proposalStorage.save) proposalStorage.save();
                console.debug(`[_applyDecideLaterProposal] Restored ${restoredChildIds.length} child parcels for ${idLabel}`);
                return true;
            } else {
                console.warn(`[_applyDecideLaterProposal] Failed to restore child parcels for ${idLabel} - restoreFromExistingChildren returned null or empty`, {
                    childIdsExisting,
                    childIdsExistingLength: childIdsExisting.length
                });
                // Don't return false here - the proposal might still be considered applied even if child parcels aren't found
                // This can happen if the child parcel was never created or was deleted
            }
        }

        if (!parentIds.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply decide later proposal: no ancestor parcels found.');
            }
            return false;
        }

        let parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
        let missingParents = this._getMissingParentParcels(parentFeatures);
        const missingIds = missingParents.map(info => info && info.id ? info.id.toString() : '').filter(Boolean);

        if (missingIds.length && typeof fetchParcelsForIds === 'function') {
            try {
                await fetchParcelsForIds(missingIds, { forceRefresh: true });
                parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
                missingParents = this._getMissingParentParcels(parentFeatures);
            } catch (err) {
                console.warn('[_applyDecideLaterProposal] Failed to fetch missing ancestor parcels', { missingIds, err });
            }
        }

        if (missingParents.length > 0) {
            const summary = missingParents.map(info => info && info.number ? `${info.number} [${info.id}]` : info && info.id ? info.id : '').filter(Boolean).join(', ');
            const message = summary
                ? `Cannot apply decide later proposal: missing parcels ${summary}`
                : 'Cannot apply decide later proposal: missing ancestor parcels.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        const mergedGeometry = _mergeParcelGeometries(parentFeatures);
        if (!mergedGeometry) {
            const message = 'Cannot apply decide later proposal: failed to merge parcel geometry.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryId = primaryFeature ? _getParcelIdFromFeature(primaryFeature) : parentIds[0];
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const parentNumbers = parentFeatures
            .map(f => f?.properties?.BROJ_CESTICE || f?.properties?.parcelNumber || f?.properties?.parcel_number)
            .filter(Boolean);
        const rootParcelId = _resolveRootParcelIdFromProperties(primaryFeature?.properties || null, primaryId) || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null, primaryId)
            || (primaryNumber ? _extractRootParcelNumber(primaryNumber) : null)
            || primaryNumber
            || 'parcel';

        const childFeature = {
            type: 'Feature',
            geometry: mergedGeometry,
            properties: {
                proposalId,
                ancestorProposal: proposalId,
                parentParcelIds: parentIds,
                parentParcelNumbers: parentNumbers,
                parentParcelId: primaryId || null,
                parentParcelNumber: primaryNumber || null,
                rootParcelId,
                rootParcelNumber,
                calculatedArea: Math.round(_calculateGeoJsonArea(mergedGeometry)),
                isProposed: true,
                mergedFromDecideLater: true
            }
        };

        this._assignSyntheticChildIdentities(proposalId, [childFeature]);

        _assignOwnershipDetails(childFeature, {
            defaultOwnerName: proposalData?.author || 'User',
            forceDefaultOwner: true,
            overwriteExisting: true
        });
        const childParcelId = _getParcelIdFromFeature(childFeature);
        if (!childParcelId) {
            const message = 'Cannot apply decide later proposal: failed to assign parcel id to merged parcel.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        // Authoritative ownership of the merged parcel: transfer to the chosen recipient
        // (to-me / to-city / third-party) when the proposal carries one; otherwise it stays
        // with the author label assigned above.
        if (typeof resolveProposalRecipientAgentId === 'function' && typeof transferParcelOwnership === 'function') {
            const recipientAgentId = resolveProposalRecipientAgentId(proposalData);
            if (recipientAgentId) transferParcelOwnership(childParcelId, null, recipientAgentId);
        }

        // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js

        if (typeof window !== 'undefined') {
            if (window.multiParcelSelection && window.multiParcelSelection.selectedParcels) {
                parentIds.forEach(parcelId => {
                    if (window.multiParcelSelection.selectedParcels.has(parcelId)) {
                        try {
                            const layer = window.multiParcelSelection.findParcelById ? window.multiParcelSelection.findParcelById(parcelId) : null;
                            if (layer && typeof window.multiParcelSelection.removeParcelHighlight === 'function') {
                                window.multiParcelSelection.removeParcelHighlight(layer);
                            }
                        } catch (_) { /* best-effort */ }
                        window.multiParcelSelection.selectedParcels.delete(parcelId);
                    }
                });
                if (typeof window.multiParcelSelection.updateUI === 'function') {
                    window.multiParcelSelection.updateUI();
                }
            }

            if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId && parentIds.includes(window.selectedParcelId.toString())) {
                window.selectedParcelId = null;
            }
        }

        const filteredChildFeatures = _filterChildFeaturesBlockedByDescendants([childFeature], proposalId);
        const shouldAddChild = filteredChildFeatures.length > 0;
        if (shouldAddChild) {
            const filteredChild = filteredChildFeatures[0];
            // Ensure ancestorProposal is set before persisting (critical for recovery on reload)
            if (!filteredChild.properties.ancestorProposal) {
                filteredChild.properties.ancestorProposal = proposalId;
            }
            // Ensure mergedFromDecideLater flag is set
            filteredChild.properties.mergedFromDecideLater = true;

            // CRITICAL: Ensure ancestorProposal is set before persisting and adding to map
            if (!filteredChild.properties.ancestorProposal) {
                filteredChild.properties.ancestorProposal = proposalId;
                console.debug(`[_applyDecideLaterProposal] Set ancestorProposal=${proposalId} on child parcel ${childParcelId} before persisting`);
            }
            if (!filteredChild.properties.mergedFromDecideLater) {
                filteredChild.properties.mergedFromDecideLater = true;
            }

            console.debug(`[_applyDecideLaterProposal] Persisting child parcel ${childParcelId} with ancestorProposal=${filteredChild.properties.ancestorProposal}`);
            this._persistParcelFeature(filteredChild);

            // Verify it was persisted correctly
            if (typeof readPersistedParcelRecord === 'function') {
                const persisted = readPersistedParcelRecord(childParcelId);
                if (persisted && persisted.properties) {
                    console.debug(`[_applyDecideLaterProposal] Verified child parcel ${childParcelId} persisted with ancestorProposal=${persisted.properties.ancestorProposal}`);
                } else {
                    console.warn(`[_applyDecideLaterProposal] Failed to verify child parcel ${childParcelId} was persisted`);
                }
            }

            this._addFeaturesToMap([filteredChild], true, proposalData);

            this._addProposalAsAncestor(childParcelId, proposalId);
            this._addChildParcels(proposalId, [childParcelId], proposalData);
        } else {
            console.debug(`[_applyDecideLaterProposal] Skipping child parcel ${childParcelId} because a descendant proposal is already applied`);
        }

        this._setDescendantProposalOnParcels(parentIds, proposalId);
        this._linkProposalToAncestors(proposalId, parentIds);
        this._markParcelsModifiedBatch([...parentIds, ...(shouldAddChild ? [childParcelId] : [])]);

        // Hide parents from visible layer but keep in parcelLayerById for descendant proposals
        this._hideFeaturesFromMap(parentFeatures);

        proposalData.decideLaterProposal = {
            applied: true,
            parentParcelIds: parentIds,
            childParcelIds: shouldAddChild ? [String(childParcelId)] : [],
            _restored: true
        };
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...(shouldAddChild ? [String(childParcelId)] : [])]));
        proposalData.applied = true;
        proposalData.updatedAt = new Date().toISOString();

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (proposalStorage.save) proposalStorage.save();

        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        if (typeof updateStatus === 'function') {
            updateStatus(`Applied decide later proposal ${proposalData.title || idLabel}`);
        }

        console.debug(`[_applyDecideLaterProposal] ✓ Completed application in ${(performance.now() - startTime).toFixed(2)}ms`);
        return true;
    },

    async _applyReparcellizationProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyReparcellizationProposal] Starting application for ${idLabel}...`);

        if (!proposalData || !proposalData.reparcellization) {
            console.warn(`[_applyReparcellizationProposal] Invalid proposal data or missing reparcellization`);
            return false;
        }
        const plan = proposalData.reparcellization;
        if (!Array.isArray(plan.polygons) || plan.polygons.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply reparcellization proposal: missing generated slices.');
            }
            console.warn(`[_applyReparcellizationProposal] Missing polygons: ${plan.polygons?.length || 0}`);
            return false;
        }

        // Skip overlay rendering: add child parcels directly with existing parcel styling
        console.debug(`[_applyReparcellizationProposal] Skipping overlay rendering for ${plan.polygons.length} slice(s); will add child parcels directly.`);

        const parentIds = Array.from(new Set((proposalData.parentParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        let parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];

        // Parent availability + conflict decision (this only runs on a fresh apply — already-applied
        // reparcellizations short-circuit in the dispatcher). Like road, this replaces parents with
        // child slices, so a parent occupied by another applied proposal is a real conflict.
        {
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: parentIds, parentFeatures, options });
            if (decision.defer) {
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            parentFeatures = decision.parentFeatures;
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryId = primaryFeature ? _getParcelIdFromFeature(primaryFeature) : (parentIds[0] || null);
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const parentNumbers = parentFeatures
            .map(f => f?.properties?.BROJ_CESTICE || f?.properties?.parcelNumber || f?.properties?.parcel_number)
            .filter(Boolean);
        const rootParcelId = _resolveRootParcelIdFromProperties(primaryFeature?.properties || null, primaryId) || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null, primaryId)
            || (primaryNumber ? _extractRootParcelNumber(primaryNumber) : null)
            || primaryNumber
            || 'parcel';

        const childFeatures = plan.polygons.map((slice, index) => {
            if (!slice || !slice.geometry) return null;
            const feature = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    proposalId,
                    parentParcelIds: parentIds,
                    parentParcelNumbers: parentNumbers,
                    parentParcelId: primaryId || null,
                    parentParcelNumber: primaryNumber || null,
                    rootParcelId,
                    rootParcelNumber,
                    calculatedArea: Math.round(_calculateGeoJsonArea(slice.geometry)),
                    isProposed: true,
                    color: slice.color || null,
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    percent: slice.percent !== undefined ? slice.percent : null
                }
            };

            const pct = Number(slice.percent);
            if (Number.isFinite(pct)) {
                const isSingleOwnerPlan = proposalData?.reparcellization?.isSingleOwner === true;
                const percentValue = isSingleOwnerPlan ? 100 : (pct > 1 ? pct : pct * 100);
                feature.properties.ownershipDetails = {
                    owners: [{
                        name: slice.displayName || proposalData?.author || 'Owner',
                        ownerLabel: slice.displayName || proposalData?.author || 'Owner',
                        percentageShare: percentValue,
                        actualShareText: `${percentValue}%`
                    }]
                };
            }

            return feature;
        }).filter(Boolean);

        if (!childFeatures.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply reparcellization proposal: failed to build parcel geometries.');
            }
            console.warn(`[_applyReparcellizationProposal] Failed to build child parcel features for ${idLabel}`);
            return false;
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures);
        this._addFeaturesToMap(childFeatures, true, proposalData);

        const childParcelIds = [];
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            feature.properties.ancestorProposal = proposalId;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            this._addProposalAsAncestor(parcelId, proposalId);
            if (parcelId !== undefined && parcelId !== null) {
                childParcelIds.push(String(parcelId));
                // Authoritative per-slice ownership from the readjustment plan: an ownerKey
                // that's a real agent id wins; otherwise find-or-create one for the slice label.
                if (typeof transferParcelOwnership === 'function') {
                    const ownerKey = feature.properties.ownerKey;
                    let agentId = null;
                    if (ownerKey && typeof agentStorage !== 'undefined' && agentStorage.getAgent(ownerKey)) {
                        agentId = ownerKey;
                    } else if (typeof getOrCreateAgentForRecipient === 'function' && feature.properties.displayName) {
                        agentId = getOrCreateAgentForRecipient(feature.properties.displayName);
                    }
                    if (agentId) transferParcelOwnership(String(parcelId), null, agentId);
                }
            }
        });

        this._setDescendantProposalOnParcels(parentIds, proposalId);
        this._linkProposalToAncestors(proposalId, parentIds);
        this._hideFeaturesFromMap(parentFeatures);
        if ((!parentFeatures || parentFeatures.length === 0) && Array.isArray(parentIds) && parentIds.length && typeof window.hideParcelLayerById === 'function') {
            parentIds.forEach(pid => window.hideParcelLayerById(pid));
        }
        this._markParcelsModifiedBatch([...parentIds, ...childParcelIds]);
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }

        const step2Time = performance.now();
        plan.applied = true;
        plan.appliedAt = new Date().toISOString();
        plan.parentParcelIds = parentIds;
        plan.childParcelIds = childParcelIds;
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = childParcelIds;
        proposalData.reparcellization = plan;

        proposalData.applied = true;
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
        console.debug(`[_applyReparcellizationProposal] Updated and saved proposal status (${(performance.now() - step2Time).toFixed(2)}ms)`);

        const step3Time = performance.now();
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        if (typeof updateStatus === 'function') {
            updateStatus(`Applied reparcellization proposal ${proposalData.title || idLabel}`);
        }
        console.debug(`[_applyReparcellizationProposal] Updated UI (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyReparcellizationProposal] ✓ Reparcellization proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    async _applyRoadProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const proposalIdForSynthetics = (proposalData && proposalData.proposalId) ? String(proposalData.proposalId) : proposalId;
        const idLabel = _normalizeProposalId(proposalIdForSynthetics || proposalId) || 'unknown-proposal';
        const suppressMissingParentAlerts = options && options.suppressMissingParentAlerts === true;
        console.debug(`[_applyRoadProposal] Starting application for ${idLabel}...`);

        const canonicalParentIds = Array.isArray(proposalData?.parentParcelIds) ? proposalData.parentParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const canonicalChildIds = Array.isArray(proposalData?.childParcelIds) ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const canonicalRoadPlan = proposalData?.geometry?.roadPlan || null;
        const canonicalRoadGeometry = proposalData?.geometry?.roadGeometry || null;

        // Keep a single shared reference so downstream mutations persist to storage
        const roadProposal = proposalData?.roadProposal
            ? { ...proposalData.roadProposal }
            : {
                parentParcelIds: canonicalParentIds.slice(),
                childParcelIds: canonicalChildIds.slice(),
                definition: canonicalRoadPlan,
                roadGeometry: canonicalRoadGeometry,
                applied: appliedOf(proposalData)
            };

        proposalData.roadProposal = roadProposal;
        delete roadProposal.parentFeatures;
        delete roadProposal.childFeatures;

        // Keep canonical fields authoritative
        proposalData.parentParcelIds = canonicalParentIds.length ? canonicalParentIds.slice() : (roadProposal.parentParcelIds || []);
        proposalData.childParcelIds = canonicalChildIds.length ? canonicalChildIds.slice() : (roadProposal.childParcelIds || []);
        proposalData.geometry = proposalData.geometry || {};
        if (canonicalRoadPlan && !proposalData.geometry.roadPlan) {
            proposalData.geometry.roadPlan = canonicalRoadPlan;
        }
        if (canonicalRoadGeometry && !proposalData.geometry.roadGeometry) {
            proposalData.geometry.roadGeometry = canonicalRoadGeometry;
        }

        if (!proposalData || (!proposalData.parentParcelIds && !roadProposal.parentParcelIds)) {
            console.warn(`[_applyRoadProposal] Invalid proposal data: missing parent parcel IDs`);
            return false;
        }

        // PERFORMANCE: Start write cache to batch localStorage operations
        if (typeof window._startParcelWriteCache === 'function') {
            window._startParcelWriteCache();
        }

        // Determine if we're restoring an already-applied proposal
        const isRestoring = appliedOf(proposalData, roadProposal);
        console.debug(`[_applyRoadProposal] Mode: ${isRestoring ? 'restoring' : 'new application'}`);

        const step1Time = performance.now();
        let assets;
        try {
            assets = this._loadRoadProposalAssets(proposalData, {
                includeParents: true,
                // Only attempt to load existing children when restoring an already-applied proposal.
                // For new applications we will regenerate children from the definition.
                includeChildren: isRestoring,
                includeKeepDetails: true,
                // Never throw on an unresolved parent here. Missing parents are handled downstream
                // by the single missing-parent decision point (conflict detection + apply-anyway),
                // which can proceed with the parents that ARE present.
                allowMissing: true
            });
        } catch (err) {
            console.error('[_applyRoadProposal] Failed to load proposal assets', err);
            try { this._setLastApplyFailure(idLabel, err); } catch (_) { }
            if (typeof updateStatus === 'function') {
                const msg = isRestoring
                    ? 'Cannot restore proposal: missing parcel geometries.'
                    : 'Cannot apply proposal: missing parcel geometries.';
                updateStatus(msg);
            }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        console.debug(`[_applyRoadProposal] Step 1: Loaded assets (${(performance.now() - step1Time).toFixed(2)}ms) - parents: ${assets.parentFeatures?.length || 0}, children: ${assets.childFeatures?.length || 0}`);

        let parentFeatures = Array.isArray(assets.parentFeatures) ? assets.parentFeatures : [];
        let childFeatures = Array.isArray(assets.childFeatures) ? assets.childFeatures : [];

        // Parent availability + conflict decision (new applications only). Runs BEFORE ownership
        // enrichment and child-building so the settled parent set feeds those steps. See
        // _resolveParentAvailabilityOrDefer for the full rationale.
        if (!isRestoring) {
            const declaredParentIds = Array.from(new Set(this._collectParentParcelIds(roadProposal, proposalData).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds, parentFeatures, options });
            if (decision.defer) {
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            parentFeatures = decision.parentFeatures;
        }

        // Enrich parent features with any locally-known ownership data BEFORE building children.
        // _buildChildFeaturesFromDefinition clones the parent feature (JSON deep-clone) when
        // minting each descendant, so whatever ownershipDetails / ownershipList / ownershipType
        // the parent carries gets inherited automatically. Without this step, descendants are
        // cloned from parents that were fetched from the cadastre server with no owner info,
        // so clicking a descendant later triggers a backend lookup that 404s (synthetic id).
        try {
            const parcelStore = (typeof window !== 'undefined' && window.ParcelsState && typeof window.ParcelsState.getParcelCache === 'function')
                ? window.ParcelsState.getParcelCache()
                : (typeof window !== 'undefined' ? window.parcelCache : null);
            if (parcelStore && parcelStore.byId instanceof Map) {
                parentFeatures.forEach(feature => {
                    if (!feature || !feature.properties) return;
                    const pid = _getParcelIdFromFeature(feature);
                    if (pid == null) return;
                    const stored = parcelStore.byId.get(pid.toString());
                    const storedProps = stored && stored.properties;
                    if (!storedProps) return;
                    if (!feature.properties.ownershipDetails && storedProps.ownershipDetails) {
                        feature.properties.ownershipDetails = storedProps.ownershipDetails;
                    }
                    if (!feature.properties.ownershipList && Array.isArray(storedProps.ownershipList)) {
                        feature.properties.ownershipList = storedProps.ownershipList.slice();
                    }
                    if (!feature.properties.ownershipType && storedProps.ownershipType) {
                        feature.properties.ownershipType = storedProps.ownershipType;
                    }
                });
            }
        } catch (e) {
            console.warn('[_applyRoadProposal] parent ownership enrichment failed', e);
        }

        const isGovernmentPlan = proposalData?.tags?.governmentPlan === true
            || proposalData?.roadProposal?.definition?.kind === 'government_plan'
            || proposalData?.geometry?.roadPlan?.kind === 'government_plan';
        const expectedCanonicalChildIds = Array.isArray(proposalData?.childParcelIds) && proposalData.childParcelIds.length
            ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : (Array.isArray(roadProposal?.childParcelIds) ? roadProposal.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : []);
        const providedChildFeatures = Array.isArray(proposalData?.childFeatures)
            ? proposalData.childFeatures
            : (Array.isArray(proposalData?.roadProposal?.childFeatures) ? proposalData.roadProposal.childFeatures : []);

        if (!isRestoring) {
            if (isGovernmentPlan) {
                childFeatures = this._cloneFeatures(providedChildFeatures);
            } else {
                childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures);
            }
        } else if (
            !isGovernmentPlan
            && (
                (options._restoreFromAlreadyAppliedState === true && !childFeatures.length)
                || (
                    expectedCanonicalChildIds.length > 0
                    && childFeatures.length > 0
                    && childFeatures.length !== expectedCanonicalChildIds.length
                )
            )
        ) {
            // The proposal was marked status=applied on arrival (e.g. server-fetched /proposals/:id
            // deep-link on a fresh client), so _resolveParcelFeaturesForRoadProposal returned no
            // children — there is nothing stored locally to restore. We still have parent features
            // and a road definition, so rebuild children deterministically from those, same as a
            // fresh apply. This is the primary path that keeps deep-linked applied proposals
            // visible without a separate regeneration scheduler.
            const priorChildCount = childFeatures.length;
            childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures);
            if (childFeatures.length > 0) {
                console.debug(`[_applyRoadProposal] Restoring ${idLabel}: rebuilt ${childFeatures.length} child features from definition`, {
                    priorChildCount,
                    expectedCanonicalChildCount: expectedCanonicalChildIds.length,
                    restoreFromAlreadyAppliedState: options._restoreFromAlreadyAppliedState === true
                });
            }
        }

        if (!isRestoring && isGovernmentPlan && !childFeatures.length) {
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        // Ensure track proposals carry track flags and points on all child features
        const trackFromDefinition = corridorIsTrack(proposalData?.roadProposal?.definition)
            || (proposalData?.roadProposal?.definition?.metadata?.type === 'track')
            || (proposalData?.roadProposal?.definition?.type === 'track');

        const flattenTrackPoints = (points) => {
            if (!Array.isArray(points)) return null;
            const result = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(p => {
                    if (Array.isArray(p)) {
                        walk(p);
                    } else if (p !== undefined && p !== null) {
                        result.push(p);
                    }
                });
            };
            walk(points);
            return result;
        };

        const trackPointsFromDefinitionRaw = proposalData?.roadProposal?.definition?.points;
        const trackPointsFromDefinition = flattenTrackPoints(trackPointsFromDefinitionRaw);
        const trackMetaLog = {
            trackFromDefinition,
            trackDefinitionType: proposalData?.roadProposal?.definition?.type,
            trackMetadataType: proposalData?.roadProposal?.definition?.metadata?.type,
            trackMetadataFlag: proposalData?.roadProposal?.definition?.metadata?.isTrack,
            trackPointCount: Array.isArray(trackPointsFromDefinition) ? trackPointsFromDefinition.length : 0,
            trackPointRawShape: Array.isArray(trackPointsFromDefinitionRaw) ? trackPointsFromDefinitionRaw.length : 0,
            childFeatureCount: Array.isArray(childFeatures) ? childFeatures.length : 0
        };
        if (trackFromDefinition && Array.isArray(childFeatures)) {
            childFeatures.forEach(f => {
                if (!f || typeof f !== 'object') return;
                if (!f.properties) f.properties = {};
                // The corridor parcel is identified by isCorridor or isTrack flag
                const isCorridor = f.properties.isCorridor === true
                    || f.properties.isTrack === true;
                if (isCorridor) {
                    f.properties.isCorridor = true;
                    f.properties.isTrack = true;
                    f.properties.isRoad = false; // tracks are NOT roads
                    if (!f.properties.trackPoints && trackPointsFromDefinition) {
                        f.properties.trackPoints = trackPointsFromDefinition;
                    } else if (Array.isArray(f.properties.trackPoints)) {
                        f.properties.trackPoints = flattenTrackPoints(f.properties.trackPoints) || f.properties.trackPoints;
                    }
                } else {
                    // Ensure non-corridor children don't inherit track styling
                    if (f.properties.isCorridor) delete f.properties.isCorridor;
                    if (f.properties.isTrack) delete f.properties.isTrack;
                    if (f.properties.trackPoints) delete f.properties.trackPoints;
                }
            });
            try {
                const sample = childFeatures.slice(0, 5).map(f => ({
                    pid: _getParcelIdFromFeature(f),
                    isTrack: f?.properties?.isTrack === true,
                    isRoad: f?.properties?.isRoad === true,
                    hasTrackPoints: Array.isArray(f?.properties?.trackPoints),
                    trackPointCount: Array.isArray(f?.properties?.trackPoints) ? f.properties.trackPoints.length : 0
                }));
                console.debug('[_applyRoadProposal] track tagging applied', { ...trackMetaLog, sample });
            } catch (logErr) {
                console.warn('[_applyRoadProposal] track tagging log failed', logErr);
            }
        } else {
            console.debug('[_applyRoadProposal] track tagging skipped', trackMetaLog);
        }

        // Children carry the ids the id subsystem just minted for THIS apply; we never try to
        // reproduce a stored canonical list. A stored count (from a prior apply synced via
        // server/shared link) may differ from what we regenerated — children are derived data
        // (parents + road/track definition), so evolved geometry drifts the count by a few slivers.
        // That is cosmetic: the consensus layer (acceptance, sale, ownership transfer) is entirely
        // parent-keyed. We log the drift for visibility and apply the regenerated children as-is.
        if (!isGovernmentPlan && expectedCanonicalChildIds.length > 0 && childFeatures.length !== expectedCanonicalChildIds.length) {
            console.debug(`[_applyRoadProposal] Child count drifted for ${idLabel}: stored ${expectedCanonicalChildIds.length}, generated ${childFeatures.length}. Applying regenerated children with freshly minted ids.`);
        }

        // When restoring an already-applied proposal, parent parcels are expected to be removed
        // So we only require parent features for new applications, not for restorations
        if (!isRestoring && !parentFeatures.length) {
            console.warn('Cannot apply road proposal: parent parcel geometries are missing.', { proposalId });
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply proposal: missing parent parcel geometries.');
            }
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'dependency-missing',
                    message: 'Cannot apply proposal: missing parent parcel geometries.'
                });
            } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        // For restoration, we need child features to restore OR child parcels must already be in parcelLayerById
        if (isRestoring && !childFeatures.length) {
            // Check if child parcels are in parcelLayerById (may be hidden but still indexed)
            const childParcelIds = Array.isArray(proposalData.childParcelIds)
                ? proposalData.childParcelIds.map(id => String(id))
                : [];
            const mapById = (typeof window.getParcelLayerIdMap === 'function')
                ? window.getParcelLayerIdMap()
                : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (childParcelIds.length > 0 && mapById) {
                const childrenInIndex = new Set();
                childParcelIds.forEach(id => {
                    if (mapById.has(id)) {
                        childrenInIndex.add(id);
                    }
                });
                // If all child parcels are in the index, we can proceed with restoration
                if (childrenInIndex.size === childParcelIds.length) {
                    console.debug(`[_applyRoadProposal] Restoring ${proposalId}: All ${childParcelIds.length} child parcels in parcelLayerById, skipping feature loading`);
                    // Still need to hide parent parcels if they exist
                    // The early return check below will handle this
                } else {
                    console.warn('Cannot restore road proposal: child parcel geometries are missing and not all children are in index.', {
                        proposalId,
                        expected: childParcelIds.length,
                        found: childrenInIndex.size,
                        missing: childParcelIds.filter(id => !childrenInIndex.has(id))
                    });
                    if (typeof updateStatus === 'function') {
                        updateStatus('Cannot restore proposal: missing child parcel geometries.');
                    }
                    if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                    return false;
                }
            } else {
                console.warn('Cannot restore road proposal: child parcel geometries are missing.', { proposalId });
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot restore proposal: missing child parcel geometries.');
                }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
        }

        console.debug(`Applying proposal ${proposalId}:`, {
            parentFeatures: parentFeatures.length,
            childFeatures: childFeatures.length,
            parentIds: parentFeatures.map(f => _getParcelIdFromFeature(f)),
            childIds: childFeatures.map(f => _getParcelIdFromFeature(f))
        });

        const parentParcelIds = [];
        if (Array.isArray(roadProposal.parentParcelIds)) {
            roadProposal.parentParcelIds.forEach(id => {
                if (id === undefined || id === null) return;
                parentParcelIds.push(id && id.toString ? id.toString() : String(id));
            });
        }
        parentFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId) {
                parentParcelIds.push(parcelId.toString());
            }
        });
        const uniqueParentParcelIds = Array.from(new Set(parentParcelIds.length ? parentParcelIds : parentIdsForFetch));
        roadProposal.parentParcelIds = uniqueParentParcelIds.slice();
        proposalData.parentParcelIds = uniqueParentParcelIds.slice();

        let parentsToRemoveCandidates;
        if (Array.isArray(roadProposal.parentsToRemove)) {
            parentsToRemoveCandidates = roadProposal.parentsToRemove;
        } else if (roadProposal.parentsToRemove === undefined || roadProposal.parentsToRemove === null) {
            // Use uniqueParentParcelIds (which includes all parent parcel IDs) instead of parentParcelIds
            // This ensures we include all parent parcels, even if some features weren't loaded
            parentsToRemoveCandidates = uniqueParentParcelIds;
        } else {
            parentsToRemoveCandidates = [roadProposal.parentsToRemove];
        }

        const parentsToRemoveSet = new Set();
        const addParentIdCandidate = (candidate) => {
            if (candidate === undefined || candidate === null) {
                return;
            }
            const normalized = candidate && candidate.toString ? candidate.toString() : String(candidate);
            if (!normalized) {
                return;
            }
            // Keep the full id (descendants need exact matches) and also the legacy base id used by older synthetic ids with "_" suffixes.
            parentsToRemoveSet.add(normalized);
            const legacyBase = normalized.includes('_') ? normalized.split('_')[0] : null;
            if (legacyBase && legacyBase !== normalized) {
                parentsToRemoveSet.add(legacyBase);
            }
        };

        (parentsToRemoveCandidates || []).forEach(addParentIdCandidate);

        const parentFeaturesToRemove = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return parcelId && parentsToRemoveSet.has(parcelId.toString());
        });

        const parentFeaturesKept = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return !parcelId || !parentsToRemoveSet.has(parcelId.toString());
        });

        // Debug logging to understand why parentFeaturesToRemove might be incomplete
        console.debug(`[_applyRoadProposal] Parent parcel removal analysis:`, {
            proposalId,
            parentFeaturesCount: parentFeatures.length,
            parentFeaturesIds: parentFeatures.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            uniqueParentParcelIds: uniqueParentParcelIds,
            parentsToRemoveSet: Array.from(parentsToRemoveSet),
            parentsToRemoveCandidates: parentsToRemoveCandidates,
            roadProposalHasParentsToRemove: roadProposal.parentsToRemove !== undefined && roadProposal.parentsToRemove !== null,
            parentFeaturesToRemoveCount: parentFeaturesToRemove.length,
            parentFeaturesToRemoveIds: parentFeaturesToRemove.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            parentFeaturesKeptCount: parentFeaturesKept.length,
            parentFeaturesKeptIds: parentFeaturesKept.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            missingFromParentFeatures: uniqueParentParcelIds.filter(id => !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === id)),
            inParentsToRemoveSetButNotInParentFeatures: Array.from(parentsToRemoveSet).filter(id => !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === id))
        });

        // When restoring, parent parcels are already removed, so this check doesn't apply
        if (isRestoring && !childFeatures.length) {
            const childParcelIds = Array.isArray(roadProposal.childParcelIds)
                ? roadProposal.childParcelIds.map(id => String(id))
                : [];
            const mapById = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (!mapById) {
                console.error('Cannot restore road proposal: parcelLayerById map is unavailable.');
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            const missing = childParcelIds.filter(id => !mapById.has(id));
            if (missing.length === 0) {
                console.debug(`[_applyRoadProposal] Restoring ${proposalId}: All ${childParcelIds.length} child parcels already on map, skipping feature loading`);
            } else {
                console.warn('Cannot restore road proposal: child parcel geometries are missing and not all children are on map.', {
                    proposalId,
                    expected: childParcelIds.length,
                    missing
                });
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot restore proposal: missing child parcel geometries.');
                }
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Cannot restore proposal: missing child parcel geometries.', 5000, 'error');
                }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
        }
        const parentParcelIdsToRemove = Array.from(parentsToRemoveSet || []).reduce((acc, rawId) => {
            const id = (rawId === undefined || rawId === null) ? '' : String(rawId);
            if (!id) return acc;
            acc.push(id);
            const legacyBase = id.includes('_') ? id.split('_')[0] : null;
            if (legacyBase && legacyBase !== id) {
                acc.push(legacyBase);
            }
            return acc;
        }, []);
        const uniqueParentParcelIdsToRemove = Array.from(new Set(parentParcelIdsToRemove));

        // No longer need to set removedByProposal flag - visibility is calculated from parent/child relationships
        // Parent parcels will be hidden automatically by isParcelReplacedByChildren() based on applied proposals

        // Determine which parents are currently on the map.
        const parentParcelsOnMap = [];
        const parentIdSet = new Set(uniqueParentParcelIdsToRemove);
        const mapByIdRemove = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
        if (!mapByIdRemove) {
            console.error('[_applyRoadProposal] parcelLayerById map is unavailable; aborting parent removal detection.');
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        parentIdSet.forEach(id => {
            if (mapByIdRemove.has(id)) {
                parentParcelsOnMap.push(id);
            }
        });

        // Restoration optimization: only skip if children are present AND no parents are present.
        // NOTE: bypass this fast path when we have rebuilt children from definition
        // (_restoreFromAlreadyAppliedState) — the rebuilt features need to be ingested into the
        // map, even though the stored childParcelIds list may be empty or stale.
        if (isRestoring && options._restoreFromAlreadyAppliedState !== true) {
            const childParcelIds = Array.isArray(roadProposal.childParcelIds)
                ? roadProposal.childParcelIds.map(id => String(id))
                : [];
            const remaining = new Set(childParcelIds);
            const mapByIdRestore = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (!mapByIdRestore) {
                console.error('[_applyRoadProposal] parcelLayerById map is unavailable during restoration check.');
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            remaining.forEach(id => {
                if (mapByIdRestore.has(id)) {
                    remaining.delete(id);
                }
            });
            const allChildrenOnMap = remaining.size === 0;
            if (allChildrenOnMap && parentParcelsOnMap.length === 0) {
                return true;
            }
        }

        const removeParentParcels = () => {
            if (parentParcelsOnMap.length === 0) return;
            const step5Time = performance.now();
            // Remove from multi-selection if any are selected
            if (typeof window.multiParcelSelection !== 'undefined' && window.multiParcelSelection) {
                parentParcelsOnMap.forEach(parcelId => {
                    if (window.multiParcelSelection.selectedParcels && window.multiParcelSelection.selectedParcels.has(parcelId)) {
                        const parcel = window.multiParcelSelection.findParcelById && window.multiParcelSelection.findParcelById(parcelId);
                        if (parcel && typeof window.multiParcelSelection.removeParcelHighlight === 'function') {
                            window.multiParcelSelection.removeParcelHighlight(parcel);
                        }
                        window.multiParcelSelection.selectedParcels.delete(parcelId);
                    }
                });
                if (typeof window.multiParcelSelection.updateUI === 'function') {
                    window.multiParcelSelection.updateUI();
                }
            }

            // Clear single selection if it's one of the removed parcels
            if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
                const selectedId = window.selectedParcelId.toString();
                if (parentParcelsOnMap.includes(selectedId)) {
                    window.selectedParcelId = null;
                }
            }

            console.debug(`[_applyRoadProposal] ${isRestoring ? 'Restoring: ' : ''}Hiding ${parentParcelsOnMap.length} parent parcels from map (keeping in index):`, parentParcelsOnMap);
            parentParcelsOnMap.forEach(parcelId => {
                // Use hideParcelLayerById to keep entry in parcelLayerById so descendant proposals can still find parents
                if (typeof window.hideParcelLayerById === 'function') {
                    window.hideParcelLayerById(parcelId);
                } else if (typeof window.removeParcelLayerById === 'function') {
                    window.removeParcelLayerById(parcelId);
                }
            });
            console.debug(`[_applyRoadProposal] Step 5: Hidden ${parentParcelsOnMap.length} parent parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);
        };

        const filteredChildFeatures = _filterChildFeaturesBlockedByDescendants(childFeatures, proposalId);
        const skippedChildren = childFeatures.length - filteredChildFeatures.length;
        if (skippedChildren > 0) {
            console.debug(`[_applyRoadProposal] Skipping ${skippedChildren} child parcel(s) hidden by applied descendant proposals`);
        }

        let allChildrenAdded = true;
        try {
            const step3Time = performance.now();
            // Add new features using normal map styling (no special proposal coloring)
            // Pass proposal data so track information can be retrieved if needed
            this._addFeaturesToMap(filteredChildFeatures, true, proposalData);
            console.debug(`[_applyRoadProposal] Step 3: Added ${filteredChildFeatures.length} child parcels to map (${(performance.now() - step3Time).toFixed(2)}ms)`);
        } catch (err) {
            allChildrenAdded = false;
            console.error('Failed to add one or more child parcels during road proposal application:', err);
        }

        if (!allChildrenAdded) {
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        const step4Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentParcelIds);
        // PERFORMANCE: Use batched version instead of per-parcel calls
        this._markParcelsModifiedBatch(uniqueParentParcelIds);
        this._setDescendantProposalOnParcels(uniqueParentParcelIds, proposalId);
        console.debug(`[_applyRoadProposal] Step 4: Linked to ${uniqueParentParcelIds.length} ancestors (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // Remove parents only after ancestor linkage/property updates so map lookups succeed.
        removeParentParcels();

        const step6Time = performance.now();
        const childParcelIds = [];
        const childParcelIdsForMark = [];
        filteredChildFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // Save coordinates in WGS84 format (same as display format)
            feature.properties.ancestorProposal = proposalId;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            const parentIdsForRoadCheck = []
                .concat(feature.properties.parentParcelIds || [])
                .concat(feature.properties.parentParcelId ? [feature.properties.parentParcelId] : [])
                .concat(feature.properties.rootParcelId ? [feature.properties.rootParcelId] : []);
            const parentIsRoadParcel = typeof window.isRoadParcel === 'function'
                && parentIdsForRoadCheck.some(id => id && window.isRoadParcel(String(id)));
            if (feature.properties.isRoad || parentIsRoadParcel) {
                feature.properties.isRoad = true;
                feature.properties.roadName = feature.properties.roadName || 'Unnamed Road';
                feature.properties.roadId = feature.properties.roadId || '';
                if (typeof window.addRoadParcel === 'function') window.addRoadParcel(parcelId);
            }
            this._addProposalAsAncestor(parcelId, proposalId);
            if (parcelId !== undefined && parcelId !== null) {
                childParcelIds.push(String(parcelId));
                childParcelIdsForMark.push(parcelId);
            }
        });
        // PERFORMANCE: Batch the mark operation instead of per-parcel calls
        this._markParcelsModifiedBatch(childParcelIdsForMark);
        // Always register child IDs so getProposalsForParcel() can find descendants via childParcelIds.
        // _addChildParcels merges with existing (Set-based), so calling it in the restore path is safe
        // and essential for fresh deep-link proposals that arrive with no prior childParcelIds.
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }
        console.debug(`[_applyRoadProposal] Step 6: Saved ${filteredChildFeatures.length} child parcels to storage (${(performance.now() - step6Time).toFixed(2)}ms)`);

        if (parentFeaturesKept.length > 0) {
            const keptIds = parentFeaturesKept
                .map(feature => _getParcelIdFromFeature(feature)?.toString())
                .filter(Boolean);
            console.warn('[GovernmentPlan] Kept existing parent parcel(s); replacement geometry was unavailable or incomplete.', {
                keptCount: parentFeaturesKept.length,
                keptIds
            });
        }
        const uniqueChildIds = Array.from(new Set(childParcelIds.map(id => id.toString())));
        roadProposal.childParcelIds = uniqueChildIds;
        proposalData.childParcelIds = uniqueChildIds;

        // Do not persist child geometries on the proposal object; IDs and persisted storage are the source of truth
        delete roadProposal.childFeatures;
        delete roadProposal.parentFeatures;
        if (proposalData.roadProposal) {
            delete proposalData.roadProposal.childFeatures;
            delete proposalData.roadProposal.parentFeatures;
        }

        const step7Time = performance.now();
        proposalData.geometry = proposalData.geometry || {};
        if (roadProposal.definition) {
            proposalData.geometry.roadPlan = roadProposal.definition;
        }
        if (roadProposal.roadGeometry) {
            proposalData.geometry.roadGeometry = roadProposal.roadGeometry;
        }
        roadProposal.applied = true;
        proposalData.applied = true;
        proposalStorage.save();
        console.debug(`[_applyRoadProposal] Step 7: Saved proposal status (${(performance.now() - step7Time).toFixed(2)}ms)`);

        // Keep proposals indicator in sync
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof showAllProposalsModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                showAllProposalsModal();
            }
        }

        // Update proposals indicator and list button
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
            const affectedParcelIds = parentFeatures
                .map(f => _getParcelIdFromFeature(f))
                .filter(Boolean)
                .map(id => id.toString());
            if (affectedParcelIds.includes(window.selectedParcelId.toString())) {
                if (typeof showParcelInfoPanel === 'function') {
                    const parcelLayer = window.parcelLayer.getLayers().find(l =>
                        _getParcelIdFromFeature(l.feature)?.toString() === window.selectedParcelId.toString()
                    );
                    if (parcelLayer) {
                        showParcelInfoPanel(parcelLayer.feature);
                    }
                }
            }
        }

        const step8Time = performance.now();
        // Keep proposals indicator in sync
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        try { if (typeof updateProposalLayer === 'function') updateProposalLayer(); } catch (_) { }
        console.debug(`[_applyRoadProposal] Step 8: Updated UI indicators (${(performance.now() - step8Time).toFixed(2)}ms)`);

        const step9Time = performance.now();
        // Refresh parcel styles to ensure borders and fills are properly displayed
        // This is critical after applying road/track proposals as parcels may have been removed/added
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        console.debug(`[_applyRoadProposal] Step 9: Refreshed parcel styles (${(performance.now() - step9Time).toFixed(2)}ms)`);

        // Step 10: If this proposal is currently highlighted, re-highlight using the normal flow
        // This updates the button from "Apply to map" to "Remove from map" and clears any hover overlays
        try {
            const isHighlighted = window.currentlyHighlightedProposalId &&
                proposalData.proposalId &&
                String(window.currentlyHighlightedProposalId) === String(proposalData.proposalId);

            if (isHighlighted && typeof selectAndHighlightProposal === 'function') {
                selectAndHighlightProposal(proposalData.proposalId, window.selectedParcelInProposal, false, true);
            }
        } catch (_) { }

        // PERFORMANCE: Flush cached writes to localStorage in one batch
        if (typeof window._flushParcelWriteCache === 'function') {
            window._flushParcelWriteCache();
        }

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyRoadProposal] ✓ Road proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

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
            allProposals
                .filter(p => p.proposalId !== proposalId && this._isBuildingProposal(p))
                .forEach(p => {
                    const otherKey = this._getBuildingAncestorKey(p);
                    if (otherKey === ancestorKey && appliedOf(p, p.buildingProposal)) {
                        const hasFamilyUnapply = typeof this.unapplyWholeFamily === 'function';
                        if (hasFamilyUnapply) {
                            this.unapplyWholeFamily(p.proposalId, new Set(), { skipRestoreSource: true });
                        } else if (typeof this.unapplyProposal === 'function') {
                            this.unapplyProposal(p.proposalId, { skipConfirm: true, skipRestoreSource: true });
                        }
                    }
                });
        } catch (err) {
            console.warn('Failed to enforce unique building proposal constraint', err);
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

        proposalData.applied = true;
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        proposalStorage.save();

        this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);

        const step7Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentIds);
        console.debug(`[_applyBuildingProposal] Step 7: Linked to ${uniqueParentIds.length} ancestors (${(performance.now() - step7Time).toFixed(2)}ms)`);

        const step8Time = performance.now();
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Applied building proposal ${proposalData.title || idLabel}`);
        }

        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        console.debug(`[_applyBuildingProposal] Step 8: Updated UI (${(performance.now() - step8Time).toFixed(2)}ms)`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyBuildingProposal] ✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    // Internal: perform unapply after confirmation. `visitedProposals` breaks CYCLES in the
    // child-proposal links (old imports carry mutual A<->B references; a proposal's status only
    // flips at the END of its own frame, so without this the recursion never terminates —
    // "Maximum call stack size exceeded" on bulldoze/unapply).
    async _unapplyProposalConfirmed(proposalId, visitedProposals = null) {
        const visited = visitedProposals || new Set();
        const selfKey = String(proposalId);
        if (visited.has(selfKey)) return;
        visited.add(selfKey);
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.roadProposal) return;
        const roadProposal = proposalData.roadProposal;

        const descendantProposalIds = this._getAllDescendantProposals(proposalId);
        for (const childId of descendantProposalIds) {
            if (visited.has(String(childId))) continue;
            const childProposal = _getProposalRecord(childId);
            if (!childProposal || !childProposal.roadProposal) continue;
            if (appliedOf(childProposal, childProposal.roadProposal)) {
                await this._unapplyProposalConfirmed(childId, visited);
            }
        }

        const assets = this._loadRoadProposalAssets(proposalData, {
            includeParents: true,
            includeChildren: true,
            includeKeepDetails: true,
            allowMissing: true
        });

        let parentFeatures = Array.isArray(assets.parentFeatures) ? assets.parentFeatures : [];
        let childFeatures = Array.isArray(assets.childFeatures) ? assets.childFeatures : [];

        // Fallback: rebuild parents from ids if still missing (e.g., not cached but stored ids)
        const parentIds = this._collectParentParcelIds(roadProposal, proposalData);
        if (!parentFeatures.length && parentIds.length) {
            parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
        }

        // Fetch missing ancestors if any are still unresolved, then retry resolution once
        if (parentIds.length) {
            const resolvedIds = new Set(parentFeatures.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean));
            const missingIds = parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(id => id && !resolvedIds.has(id));
            if (missingIds.length > 0 && typeof fetchParcelsForIds === 'function') {
                try {
                    await fetchParcelsForIds(missingIds, { forceRefresh: true });
                    const reloaded = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                    if (Array.isArray(reloaded) && reloaded.length > parentFeatures.length) {
                        parentFeatures = reloaded;
                    }
                } catch (err) {
                    console.warn('[_unapplyProposalConfirmed] Failed to fetch missing ancestor parcels', { missingIds, err });
                }
            }
            const remainingMissing = parentIds.filter(id => {
                const normalized = id && id.toString ? id.toString() : String(id || '');
                return normalized && !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === normalized);
            });
            // Synthetic ancestors (slices of other proposals) cannot be fetched from the server by
            // definition; on imported proposals their ids drift and may simply not exist here.
            // Blocking the whole unapply on them locked such roads forever — restore what exists
            // and only refuse when a REAL cadastre parcel cannot be recovered.
            const missingBase = remainingMissing.filter(id => !String(id).includes('#p-'));
            if (missingBase.length > 0) {
                const message = `Missing ancestor parcels: ${missingBase.join(', ')}`;
                console.error(message);
                throw new Error(message);
            }
            if (remainingMissing.length > 0) {
                console.warn('[_unapplyProposalConfirmed] Skipping unrecoverable synthetic ancestors', remainingMissing);
            }
        }

        // Build a definitive list of descendant parcel ids from multiple sources (no cache dependency)
        const childFeatureById = new Map();
        const childIdsFromFeatures = childFeatures
            .map(f => _getParcelIdFromFeature(f))
            .filter(Boolean)
            .map(id => id.toString());
        childFeatures.forEach(feature => {
            const pid = _getParcelIdFromFeature(feature);
            if (pid !== undefined && pid !== null) {
                childFeatureById.set(pid.toString(), feature);
            }
        });
        const childIdsFromProposal = Array.isArray(proposalData.childParcelIds)
            ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const childIdsFromRoadProposal = Array.isArray(roadProposal?.childParcelIds)
            ? roadProposal.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const childIdsFromHelper = Array.isArray(this._getProposalChildParcels(proposalId))
            ? this._getProposalChildParcels(proposalId).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const allChildIds = Array.from(new Set([
            ...childIdsFromFeatures,
            ...childIdsFromProposal,
            ...childIdsFromRoadProposal,
            ...childIdsFromHelper
        ]));

        // If we still have no child ids, nothing to remove; treat as already unapplied
        if (allChildIds.length === 0) {
            roadProposal.applied = false;
            proposalData.applied = false;
            this._restoreSupersededRoadSources(proposalId, proposalData);
            proposalStorage.save();
            console.warn('[_unapplyProposalConfirmed] No child parcel ids resolved; skipping removal', { proposalId, proposalHasChildIds: Array.isArray(proposalData.childParcelIds) && proposalData.childParcelIds.length });
            return;
        }

        // Remove new features from map when we have them
        if (childFeatures && childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }

        // Always remove by id to cover cases with no cached features. A corridor's rails live on the
        // applied-corridor overlay, not on the parcel layer, so there is nothing extra to detach here.
        allChildIds.forEach(id => {
            if (typeof window.removeParcelLayerById === 'function') {
                window.removeParcelLayerById(id);
            }
        });

        // Remove new features from PersistentStorage
        allChildIds.forEach(parcelId => {
            const feature = childFeatureById.get(parcelId);
            if (feature && feature.properties) {
                _ensureParcelIdOnProperties(feature.properties, parcelId);
            }
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            if (typeof window.removeRoadParcel === 'function') window.removeRoadParcel(parcelId);

            // Remove this proposal as ancestor of the parcel
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // Fetch parent features by ID (don't rely on stored parentFeatures)
        const parentParcelIds = this._collectParentParcelIds(roadProposal, proposalData);
        const parentFeaturesResolved = this._resolveParcelFeaturesByIds(parentParcelIds, { preferMap: true, allowStorage: true });

        // Show hidden parents first (they're in parcelLayerById but not visible)
        this._showFeaturesOnMap(parentFeaturesResolved);
        // If some parents weren't in parcelLayerById, add them via full add
        // IMPORTANT: pass proposalData so the descendant filter can exclude this proposal while it is being unapplied.
        this._addFeaturesToMap(parentFeaturesResolved, true, proposalData); // Pass true to use normal style

        // Restore original features to PersistentStorage
        const parentIdsForUnmark = [];
        parentFeaturesResolved.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            delete feature.properties.descendantProposal;
            if (typeof writePersistedParcelRecord === 'function') {
                writePersistedParcelRecord(parcelId, record => {
                    record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                    record.properties = { ...feature.properties };
                    // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
                });
            }

            // If the original was a road, restore that too
            const parentIdsForRoadCheck = []
                .concat(feature.properties.parentParcelIds || [])
                .concat(feature.properties.parentParcelId ? [feature.properties.parentParcelId] : [])
                .concat(feature.properties.rootParcelId ? [feature.properties.rootParcelId] : []);
            const parentIsRoadParcel = typeof window.isRoadParcel === 'function'
                && parentIdsForRoadCheck.some(id => id && window.isRoadParcel(String(id)));
            if (feature.properties.isRoad || parentIsRoadParcel) {
                feature.properties.isRoad = true;
                feature.properties.roadName = feature.properties.roadName || 'Unnamed Road';
                feature.properties.roadId = feature.properties.roadId || '';
                if (typeof window.addRoadParcel === 'function') window.addRoadParcel(parcelId);
            }
            parentIdsForUnmark.push(parcelId);
        });

        this._clearDescendantProposalOnParcels(parentIdsForUnmark, proposalId);
        Array.from(new Set(parentIdsForUnmark.map(id => id?.toString()))).forEach(id => this._unmarkParcelModified(id));

        // Clean up dependency tracking
        this._removeChildParcels(proposalId, allChildIds);
        roadProposal.childParcelIds = Array.from(new Set(allChildIds));

        roadProposal.applied = false;
        proposalData.applied = false; // leaves the map
        this._restoreSupersededRoadSources(proposalId, proposalData);
        proposalStorage.save();

        const removedParcels = allChildIds.length;
        const restoredParcels = parentFeaturesResolved.length;
        console.info('[ProposalManager] Unapplied road proposal', {
            proposalId,
            removedParcels,
            restoredParcels,
            type: 'road'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates
    },

    _unapplyDecideLaterProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const decideLaterState = proposalData.decideLaterProposal || {};
        const parentIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.parentParcelIds) ? decideLaterState.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        const childIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.childParcelIds) ? decideLaterState.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        const childFeatures = childIds.length
            ? this._resolveParcelFeaturesByIds(childIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }

        childIds.forEach(parcelId => {
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships

        const parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (parentFeatures.length) {
            // IMPORTANT: pass proposalData so the descendant filter can exclude this proposal while it is being unapplied.
            this._addFeaturesToMap(parentFeatures, true, proposalData);
            parentFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                if (typeof writePersistedParcelRecord === 'function') {
                    writePersistedParcelRecord(parcelId, record => {
                        record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                        record.properties = { ...feature.properties };
                        record.removedByProposal = false;
                    });
                }
            });
        }

        this._clearDescendantProposalOnParcels(parentIds, proposalId);
        parentIds.forEach(id => this._unmarkParcelModified(id));
        this._removeChildParcels(proposalId, childIds, proposalData);

        proposalData.decideLaterProposal = {
            applied: false,
            parentParcelIds: parentIds,
            childParcelIds: []
        };
        proposalData.childParcelIds = Array.isArray(proposalData.childParcelIds)
            ? proposalData.childParcelIds.filter(id => !childIds.includes(id && id.toString ? id.toString() : String(id)))
            : [];
        proposalData.applied = false;
        proposalData.updatedAt = new Date().toISOString();

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        }
        if (proposalStorage.save) {
            proposalStorage.save();
        }

        const removedParcels = childIds.length;
        const restoredParcels = parentFeatures.length;
        console.info('[ProposalManager] Unapplied decide-later proposal', {
            proposalId,
            removedParcels,
            restoredParcels,
            type: 'decide-later'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },

    _unapplyBuildingProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const parentIdsSource = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parentParcelIds;
        const parentIds = Array.from(new Set((Array.isArray(parentIdsSource) ? parentIdsSource : []).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        this._clearDescendantProposalOnParcels(parentIds, proposalId);

        if (typeof removeProposedBuildingFeature === 'function') {
            removeProposedBuildingFeature(proposalId, { updateLayer: true, save: true });
        } else if (typeof proposedBuildings !== 'undefined') {
            if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
            const initialLength = proposedBuildings.length;
            for (let i = proposedBuildings.length - 1; i >= 0; i--) {
                const feature = proposedBuildings[i];
                if (feature && feature.properties && feature.properties.proposalId === proposalId) {
                    proposedBuildings.splice(i, 1);
                }
            }
            if (proposedBuildings.length !== initialLength) {
                if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
                if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();
            }
        }

        if (typeof markProposedBuildingState === 'function') {
            markProposedBuildingState(proposalId, 'unapplied', { updateLayer: false, save: true });
            if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
        }

        buildingProposal.applied = false;
        buildingProposal.appliedAt = null;
        proposalData.buildingProposal = buildingProposal;

        if (proposalData.executedAt) {
            delete proposalData.executedAt;
        }
        proposalData.applied = false;
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        proposalStorage.save();

        console.info('[ProposalManager] Unapplied building proposal', {
            proposalId,
            removedParcels: 0,
            restoredParcels: 0,
            type: 'building'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },

    _unapplyStructureProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.structureProposal) return false;
        const sp = proposalData.structureProposal;
        const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';
        const blockName = sp.blockName || null;
        const normalizedProposalId = proposalId && proposalId.toString ? proposalId.toString() : (proposalId === 0 ? '0' : String(proposalId || ''));

        try {
            let removedParcels = 0;
            if (kind === 'park') {
                if (Array.isArray(window.parks)) {
                    const before = window.parks.length;
                    window.parks = window.parks.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.parks.length);
                    if (before !== window.parks.length) {
                        try { PersistentStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
                        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
                    }
                }
            } else if (kind === 'lake') {
                if (Array.isArray(window.lakes)) {
                    const before = window.lakes.length;
                    window.lakes = window.lakes.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.lakes.length);
                    if (before !== window.lakes.length) {
                        try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
                        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
                    }
                }
            } else {
                if (Array.isArray(window.squares)) {
                    const before = window.squares.length;
                    window.squares = window.squares.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.squares.length);
                    if (before !== window.squares.length) {
                        try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
                        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                    }
                }
            }

            // Unmark modified and unlink ancestor parcels (no parcel restoration needed)
            const parentIds = Array.from(new Set([
                ...(Array.isArray(sp.parentParcelIds) ? sp.parentParcelIds : []),
                ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : []),
            ].map(id => id && id.toString ? id.toString() : (id !== undefined && id !== null ? String(id) : null)).filter(Boolean)));
            const uniqueParents = Array.from(new Set(parentIds));

            this._clearDescendantProposalOnParcels(uniqueParents, proposalId);
            uniqueParents.forEach(id => this._unmarkParcelModified(id));

            // The structure leaves the map (application axis only).
            sp.applied = false;
            proposalData.structureProposal = sp;
            proposalData.applied = false;
            proposalData.proposalId = proposalData.proposalId || proposalId;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (proposalStorage.save) proposalStorage.save();

            console.info('[ProposalManager] Unapplied structure proposal', {
                proposalId,
                removedParcels,
                restoredParcels: 0,
                type: kind
            });

            // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
            // to allow batch operations without intermediate UI updates

            return true;
        } catch (e) {
            console.warn('Failed to unapply structure proposal', e);
            return false;
        }
    },

    _unapplyReparcellizationProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.reparcellization) {
            return false;
        }
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        const plan = proposalData.reparcellization;
        const parentIds = Array.from(new Set([
            ...(Array.isArray(plan.parentParcelIds) ? plan.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        const childIds = Array.from(new Set([
            ...(Array.isArray(plan.childParcelIds) ? plan.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        this._clearDescendantProposalOnParcels(parentIds, proposalId);

        // Remove new parcels from map and storage
        const childFeatures = childIds.length
            ? this._resolveParcelFeaturesByIds(childIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }
        childIds.forEach(parcelId => {
            if (typeof window.removeParcelLayerById === 'function') {
                window.removeParcelLayerById(parcelId);
            }
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // Restore ancestors
        let parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if ((!parentFeatures || !parentFeatures.length) && parentIds.length && typeof fetchParcelsForIds === 'function') {
            try {
                fetchParcelsForIds(parentIds, { forceRefresh: true });
                parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
            } catch (err) {
                console.warn('[_unapplyReparcellizationProposalConfirmed] Failed to fetch parent parcels', err);
            }
        }
        if (parentFeatures.length) {
            this._showFeaturesOnMap(parentFeatures);
            this._addFeaturesToMap(parentFeatures, true, proposalData);
            parentFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                delete feature.properties.descendantProposal;
                if (typeof writePersistedParcelRecord === 'function') {
                    writePersistedParcelRecord(parcelId, record => {
                        record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                        record.properties = { ...feature.properties };
                    });
                }
                this._unmarkParcelModified(parcelId);
            });
        }

        this._removeReparcellizationLayer(proposalId);
        this._removeChildParcels(proposalId, childIds, proposalData);

        plan.applied = false;
        if (plan.appliedAt) {
            delete plan.appliedAt;
        }
        plan.childParcelIds = [];
        proposalData.childParcelIds = [];

        proposalData.applied = false;
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Removed reparcellization proposal ${proposalData.title || idLabel} from the map.`);
        }

        console.info('[ProposalManager] Unapplied reparcellization proposal', {
            proposalId,
            removedParcels: childIds.length,
            restoredParcels: parentFeatures.length,
            type: 'reparcellization'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },
    };
});
