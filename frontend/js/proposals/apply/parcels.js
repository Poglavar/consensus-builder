// _applyReparcellizationProposal, _applyDecideLaterProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyParcels = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    return {
    async _applyReparcellizationProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyReparcellizationProposal] Starting application for ${idLabel}...`);

        if (!proposalData || !proposalData.reparcellization) {
            console.warn(`[_applyReparcellizationProposal] Invalid proposal data or missing reparcellization`);
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The proposal record carries no reparcellization plan.' }); } catch (_) { }
            return false;
        }
        const plan = proposalData.reparcellization;
        if (!Array.isArray(plan.polygons) || plan.polygons.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply reparcellization proposal: missing generated slices.');
            }
            console.warn(`[_applyReparcellizationProposal] Missing polygons: ${plan.polygons?.length || 0}`);
            try { this._setLastApplyFailure(idLabel, { code: 'no-slices', message: 'The reparcellization plan holds no generated slices to cut the parcels into.' }); } catch (_) { }
            return false;
        }

        // Skip overlay rendering: add child parcels directly with existing parcel styling
        console.debug(`[_applyReparcellizationProposal] Skipping overlay rendering for ${plan.polygons.length} slice(s); will add child parcels directly.`);

        let parentIds = Array.from(new Set((proposalData.parentParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        // A7, receiving side (rethink-proposals.md §15a): the pool actually consumed is derived
        // from the plan's footprint against the LIVE fabric — geometry is authoritative, in both
        // directions: coverage ≥ 95% → the pool IS the live fabric under the plan's polygons;
        // coverage < 95% → REFUSE. Minting plots without consuming the pieces underneath is how
        // a readjustment stacked double fabric on the ground (found by the Cibona square).
        {
            const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
            const resolution = (ancestry && typeof ancestry.resolveParentsByGeometry === 'function')
                ? ancestry.resolveParentsByGeometry(proposalData)
                : null;
            if (resolution) {
                if (Array.isArray(resolution.ids) && resolution.ids.length && resolution.coverage >= 0.95) {
                    // Attempt-local; the record's parents are written on SUCCESS at the tail.
                    parentIds = resolution.ids.map(String);
                } else {
                    const coveragePct = Math.round((resolution.coverage || 0) * 100);
                    const message = `The live fabric covers only ${coveragePct}% of this readjustment's plots here — the ground is not loaded or not present, so nothing was re-formed.`;
                    if (typeof updateStatus === 'function') updateStatus(message);
                    try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-unresolved', message }); } catch (_) { }
                    return false;
                }
            }
        }
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
            try { this._setLastApplyFailure(idLabel, { code: 'no-children-derived', message: `None of the ${plan.polygons.length} plan slice(s) carried a usable geometry, so no child parcels were built.` }); } catch (_) { }
            return false;
        }

        // Flat anchors + identity carry-over (formation-edit.js; rethink-proposals.md §15a). Every
        // plot records the base cadastral parcels actually under it — a comasation plot spanning
        // thirty parents is one formation with thirty base anchors, never a chain — and the
        // proposal's flat declaration is written where the cut is computed. On an EDIT, the caller
        // passes the previous partition's plots (options.priorChildren): plots that survive keep
        // their parcel identity, fresh plots continue the numbering past every prior index.
        let identityOptions = {};
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (formationEdit && turfRef && typeof turfRef.intersect === 'function') {
            try {
                const anchorCtx = {
                    area: f => { try { return turfRef.area(f) || 0; } catch (_) { return 0; } },
                    intersectionArea: (a, b) => {
                        try { const hit = turfRef.intersect(a, b); return hit ? turfRef.area(hit) : 0; } catch (_) { return 0; }
                    }
                };
                const parentEntries = parentFeatures.map(feature => ({
                    baseId: formationEdit.baseIdOf(
                        _resolveRootParcelIdFromProperties(feature?.properties || null, _getParcelIdFromFeature(feature))
                        || _getParcelIdFromFeature(feature) || ''),
                    feature
                })).filter(entry => entry.baseId && entry.baseId !== 'parcel');
                childFeatures.forEach(feature => {
                    const ids = formationEdit.overlappingBaseIds(feature, parentEntries, anchorCtx);
                    if (ids.length) feature.properties.baseParcelIds = ids;
                });
                const cadastreIds = Array.from(new Set(parentEntries.map(entry => entry.baseId)));
                if (cadastreIds.length) proposalData.cadastreParcelIds = cadastreIds;

                const priorChildren = Array.isArray(options.priorChildren) ? options.priorChildren : null;
                if (priorChildren && priorChildren.length) {
                    const beforeEntries = priorChildren.map(prior => ({
                        id: prior.parcelId !== undefined && prior.parcelId !== null ? String(prior.parcelId) : null,
                        number: prior.parcelNumber !== undefined && prior.parcelNumber !== null ? String(prior.parcelNumber) : null,
                        baseId: formationEdit.baseIdOf(prior.rootParcelId || prior.parcelId || ''),
                        isCorridor: false,
                        feature: prior.feature || null
                    }));
                    const afterEntries = childFeatures.map(feature => ({
                        baseId: formationEdit.baseIdOf(feature?.properties?.rootParcelId || ''),
                        isCorridor: false,
                        feature
                    }));
                    const match = formationEdit.matchPieces(beforeEntries, afterEntries, anchorCtx);
                    match.assignments.forEach((beforeIndex, afterIndex) => {
                        if (beforeIndex === null || !beforeEntries[beforeIndex].id) return;
                        childFeatures[afterIndex].properties.__carryIdentity = {
                            parcelId: beforeEntries[beforeIndex].id,
                            parcelNumber: beforeEntries[beforeIndex].number
                        };
                    });
                    const grow = (typeof window !== 'undefined' && window.__corridorGrow) ? window.__corridorGrow : null;
                    if (grow && typeof grow.nextSyntheticIndexByRoot === 'function') {
                        identityOptions = {
                            startIndexByRootId: grow.nextSyntheticIndexByRoot(
                                priorChildren.map(prior => prior.parcelId),
                                _buildSyntheticToken(proposalId, 'proposal')
                            )
                        };
                    }
                }
            } catch (error) {
                console.warn('[_applyReparcellizationProposal] flat anchors / identity carry-over skipped', error);
            }
        }

        // §14.2: a formation owes the owner their remainders. The pool consumed above is the
        // LIVE ground under the plan's footprint, and the authored plots may tile less than that
        // (plots drawn against another generation's fabric) — every scrap of pool the plots do
        // not cover is minted back as a remainder parcel, cloned from its parent so the owner
        // keeps it. Without this the leftover strip is ORPHANED: consumed, unminted, a hole in
        // the fabric that hover can only resolve to the hidden ancestor (the Cibona sliver).
        try {
            const turfRemainder = (typeof turf !== 'undefined') ? turf : null;
            if (turfRemainder && typeof turfRemainder.difference === 'function' && parentFeatures.length) {
                let plotsUnion = null;
                childFeatures.forEach(feature => {
                    const f = { type: 'Feature', properties: {}, geometry: feature.geometry };
                    try { plotsUnion = plotsUnion ? turfRemainder.union(plotsUnion, f) : f; } catch (_) { }
                });
                if (plotsUnion) {
                    parentFeatures.forEach(parentFeature => {
                        if (!parentFeature || !parentFeature.geometry) return;
                        let leftover = null;
                        try {
                            leftover = turfRemainder.difference(
                                { type: 'Feature', properties: {}, geometry: parentFeature.geometry }, plotsUnion);
                        } catch (_) { leftover = null; }
                        if (!leftover || !leftover.geometry) return;
                        let leftoverArea = 0;
                        try { leftoverArea = turfRemainder.area(leftover) || 0; } catch (_) { leftoverArea = 0; }
                        if (leftoverArea < 0.5) return; // rounding, not land
                        const parentId = _getParcelIdFromFeature(parentFeature);
                        const remainder = JSON.parse(JSON.stringify(parentFeature));
                        remainder.geometry = leftover.geometry;
                        remainder.properties = remainder.properties || {};
                        remainder.properties.proposalId = proposalId;
                        remainder.properties.parentParcelId = parentId !== undefined && parentId !== null ? String(parentId) : null;
                        remainder.properties.parentParcelNumber = parentFeature.properties ? (parentFeature.properties.BROJ_CESTICE || null) : null;
                        remainder.properties.calculatedArea = Math.round(leftoverArea);
                        remainder.properties.isProposed = true;
                        delete remainder.properties.color;
                        delete remainder.properties.ownerKey;
                        delete remainder.properties.displayName;
                        delete remainder.properties.percent;
                        childFeatures.push(remainder);
                    });
                }
            }
        } catch (remainderError) {
            console.warn('[_applyReparcellizationProposal] remainder minting failed', remainderError);
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures, identityOptions);
        this._addFeaturesToMap(childFeatures, true, proposalData);

        const childParcelIds = [];
        const touchedAgentIds = new Set();
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            feature.properties.ancestorProposal = proposalId;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            this._addProposalAsAncestor(parcelId, proposalId);
            if (parcelId !== undefined && parcelId !== null) {
                childParcelIds.push(String(parcelId));
                // Per-slice ownership from the readjustment plan. The modal now REQUIRES a real owner
                // for every plot (or "All public"), so there is NO silent fallback to an "Unassigned"
                // placeholder agent: public land commits to the City, a real assigned agent wins, a
                // named recipient gets a find-or-create agent, and an unresolved slice is simply left
                // untransferred (no phantom owner). skipAgentSync defers the per-agent owned-parcels
                // rebuild to one pass after the loop — per-child it re-scanned the whole keyspace
                // (O(children²), the ~1s-per-parcel freeze).
                if (typeof transferParcelOwnership === 'function') {
                    const ownerKey = feature.properties.ownerKey;
                    const displayName = feature.properties.displayName;
                    let agentId = null;
                    if (ownerKey === 'public-land') {
                        agentId = (typeof getOrCreateCityAgent === 'function') ? getOrCreateCityAgent() : null;
                    } else if (ownerKey && typeof agentStorage !== 'undefined' && agentStorage.getAgent(ownerKey)) {
                        agentId = ownerKey;
                    } else if (ownerKey && displayName && displayName !== 'Unassigned' && typeof getOrCreateAgentForRecipient === 'function') {
                        agentId = getOrCreateAgentForRecipient(displayName);
                    }
                    if (agentId) {
                        transferParcelOwnership(String(parcelId), null, agentId, { skipAgentSync: true });
                        touchedAgentIds.add(agentId);
                    }
                }
            }
        });

        // Rebuild the touched agents' owned-parcel lists in ONE keyspace pass (buildAgentOwnedParcelIndex),
        // batching the agent save to once — instead of a full scan + full re-serialize per child above.
        if (touchedAgentIds.size && typeof buildAgentOwnedParcelIndex === 'function' && typeof agentStorage !== 'undefined') {
            try {
                agentStorage.beginBatch();
                const ownerIndex = buildAgentOwnedParcelIndex();
                touchedAgentIds.forEach(id => agentStorage.updateAgent(id, { ownedParcels: ownerIndex.get(id) || [] }));
            } finally {
                agentStorage.endBatch();
            }
        }

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

        plan.parentParcelIds = parentIds;
        plan.childParcelIds = childParcelIds;
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = childParcelIds;
        proposalData.reparcellization = plan;

        persistAppliedProposal(proposalData, proposalId);
        refreshProposalUIAfterApply(`Applied reparcellization proposal ${proposalData.title || idLabel}`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyReparcellizationProposal] ✓ Reparcellization proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
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

        // Children are addressed by their DECLARED ids only. The old PersistentStorage scan that
        // guessed children back by token heuristics was legacy healing — records are flat and
        // authoritative now (rethink-proposals.md §15a); a record whose children are genuinely
        // gone fails loudly below instead of being reconstructed from lookalikes.

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
                    parentParcelIds: parentIds,
                    childParcelIds: childIdsExisting.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...childIdsExisting.map(String)]));
                setProposalApplied(proposalData, true);
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
                    parentParcelIds: parentIds,
                    childParcelIds: restoredChildIds.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...restoredChildIds.map(String)]));
                setProposalApplied(proposalData, true);
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
            try { this._setLastApplyFailure(idLabel, { code: 'no-parent-parcels', message: 'The decide-later proposal names no ancestor parcels to merge.' }); } catch (_) { }
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
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'dependency-missing',
                    message: `${missingParents.length} of the ${parentIds.length} ancestor parcel(s) could not be found, even after refetching.`,
                    missingIds: missingParents.map(info => (info && info.id) ? info.id : null).filter(Boolean)
                });
            } catch (_) { }
            return false;
        }

        const mergedGeometry = _mergeParcelGeometries(parentFeatures);
        if (!mergedGeometry) {
            const message = 'Cannot apply decide later proposal: failed to merge parcel geometry.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            try { this._setLastApplyFailure(idLabel, { code: 'merge-failed', message: `The ${parentIds.length} ancestor parcel geometries could not be merged into a single parcel.` }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'child-id-assignment-failed', message: 'The merged parcel came back without a synthetic parcel id, so it cannot be placed on the map.' }); } catch (_) { }
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
            parentParcelIds: parentIds,
            childParcelIds: shouldAddChild ? [String(childParcelId)] : [],
            _restored: true
        };
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...(shouldAddChild ? [String(childParcelId)] : [])]));
        persistAppliedProposal(proposalData, proposalId);
        refreshProposalUIAfterApply(`Applied decide later proposal ${proposalData.title || idLabel}`);

        console.debug(`[_applyDecideLaterProposal] ✓ Completed application in ${(performance.now() - startTime).toFixed(2)}ms`);
        return true;
    },
    };
});
