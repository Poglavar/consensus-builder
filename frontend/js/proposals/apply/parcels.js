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
