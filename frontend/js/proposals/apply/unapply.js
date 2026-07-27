// _unapplyProposalConfirmed, _unapplyDecideLaterProposalConfirmed, _unapplyBuildingProposalConfirmed, _unapplyStructureProposalConfirmed, _unapplyReparcellizationProposalConfirmed, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyUnapply = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    return {
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
            setProposalApplied(proposalData, false);
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
            // DIRECT parent only. Checking the full parentParcelIds genealogy (or the root)
            // over-triggers badly on deep parcel trees: a reparcellization slice carries ALL the
            // readjustment's ancestor ids, so one road-detected ancestor anywhere in that list
            // turned every zone slice's remainder into an "Unnamed Road" (dark asphalt fill) the
            // moment a road edit re-carved it - and re-registered it, ratcheting the corruption.
            // A child inherits road-ness from the parcel it was actually cut from, nothing else.
            const parentIdsForRoadCheck = feature.properties.parentParcelId
                ? [feature.properties.parentParcelId]
                : [];
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

        setProposalApplied(proposalData, false); // leaves the map
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
            parentParcelIds: parentIds,
            childParcelIds: []
        };
        proposalData.childParcelIds = Array.isArray(proposalData.childParcelIds)
            ? proposalData.childParcelIds.filter(id => !childIds.includes(id && id.toString ? id.toString() : String(id)))
            : [];
        setProposalApplied(proposalData, false);
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

        proposalData.buildingProposal = buildingProposal;
        setProposalApplied(proposalData, false);
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
        const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
        const blockName = sp.blockName || null;
        const normalizedProposalId = proposalId && proposalId.toString ? proposalId.toString() : (proposalId === 0 ? '0' : String(proposalId || ''));

        try {
            let removedParcels = 0;
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
                    }
                }
            } else if (kind === 'station') {
                if (Array.isArray(window.transitStations)) {
                    const before = window.transitStations.length;
                    window.transitStations = window.transitStations.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.transitStations.length);
                    if (before !== window.transitStations.length) {
                        try { PersistentStorage.setItem('cb_transit_stations', JSON.stringify(window.transitStations)); } catch (_) { }
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
            proposalData.structureProposal = sp;
            setProposalApplied(proposalData, false);
            proposalData.proposalId = proposalData.proposalId || proposalId;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (proposalStorage.save) proposalStorage.save();

            // The view must observe the proposal already unapplied; otherwise its demolition
            // records remain active for one refresh and the old building meshes stay stale.
            try { refreshStructureLayer(); } catch (error) {
                console.error(`[_unapplyStructureProposalConfirmed] Failed to refresh ${kind} presentation`, error);
            }

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

        plan.childParcelIds = [];
        proposalData.childParcelIds = [];

        setProposalApplied(proposalData, false);
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
