// _applyRoadProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyRoad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    return {
    // The applied PROPOSED fabric standing on the ground this corridor would take. Geometry is the
    // authority here, not declared ids — the whole point is to catch what the corridor covers but
    // never declared. Returns [] when the pure module or turf is unavailable: a missing helper must
    // not silently block every road apply.
    _detectContentOccupations(proposalData, exemptKeys) {
        const occupation = window.__contentOccupation;
        const planOrder = window.__planOrder;
        const turf = window.turf;
        if (!occupation || !planOrder || !turf || typeof turf.intersect !== 'function') return [];

        let footprint = null;
        try {
            const definition = (proposalData && proposalData.roadProposal && proposalData.roadProposal.definition)
                || (proposalData && proposalData.definition) || null;
            // The SURFACE footprint is what parcel cutting consumes — the same ground the occupation
            // question is about.
            footprint = (definition && typeof corridorSurfaceFootprintForDefinition === 'function')
                ? corridorSurfaceFootprintForDefinition(definition)
                : null;
            if (!footprint) footprint = planOrder.footprintOf(proposalData);
        } catch (_) { return []; }
        if (!footprint) return [];

        const selfKey = String((typeof getProposalKey === 'function' ? getProposalKey(proposalData) : null)
            || (proposalData && proposalData.proposalId) || '');

        const candidates = [];
        try {
            proposalStorage.getAllProposals().forEach(other => {
                if (!other || typeof isProposalApplied !== 'function' || !isProposalApplied(other)) return;
                const key = String((typeof getProposalKey === 'function' ? getProposalKey(other) : null)
                    || other.proposalId || '');
                if (!key || key === selfKey) return;
                let otherFootprint = null;
                try { otherFootprint = planOrder.footprintOf(other); } catch (_) { otherFootprint = null; }
                if (otherFootprint) candidates.push({ key, proposal: other, footprint: otherFootprint });
            });
        } catch (_) { return []; }

        return occupation.occupationsOf(footprint, candidates, {
            area: f => turf.area(f),
            intersectionArea: (a, b) => {
                try { const hit = turf.intersect(a, b); return hit ? turf.area(hit) : 0; } catch (_) { return 0; }
            }
        }, { selfKey, exemptKeys: Array.isArray(exemptKeys) ? exemptKeys : [] });
    },

    async _applyRoadProposal(proposalId, proposalData, options = {}) {
        if (
            options._parcelWriteBatchActive !== true
            && typeof window !== 'undefined'
            && typeof window.withParcelWriteBatch === 'function'
        ) {
            return window.withParcelWriteBatch(() => this._applyRoadProposal(proposalId, proposalData, {
                ...options,
                _parcelWriteBatchActive: true
            }));
        }

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
                roadGeometry: canonicalRoadGeometry
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
            // Every refusal RECORDS its reason: "Proposal did not apply" with no stored failure
            // info is a debugging dead end (a shared-plan summary can only echo what is stored).
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The proposal declares no parent parcels at all.' }); } catch (_) { }
            return false;
        }

        // PERFORMANCE: Start write cache to batch localStorage operations
        if (options._parcelWriteBatchActive !== true && typeof window._startParcelWriteCache === 'function') {
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

        // A corridor never cuts PROPOSED fabric (rethink §15 decision 3): half a building is not
        // something its author proposed. Anything applied standing on the ground this corridor
        // takes has to be un-applied first — by the shared-plan conflict tour (which reads the
        // conflict ids off this failure) or by the local occupation prompt. Restores are exempt:
        // the occupier question was answered when the road was first applied. Surveyed buildings
        // are untouched by this — they are facts on the ground and keep cut/tunnel/demolish.
        if (!isRestoring && options.allowOccupation !== true) {
            const occupations = this._detectContentOccupations(proposalData, options.occupationExemptKeys);
            if (occupations && occupations.length) {
                const describe = window.__contentOccupation?.describeOccupations;
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'content-occupied',
                        message: typeof describe === 'function'
                            ? describe(occupations)
                            : `This takes ground held by ${occupations.length} applied proposal(s).`,
                        conflictTitles: occupations.map(o => o.title).filter(Boolean),
                        conflictProposalIds: occupations.map(o => o.key).filter(Boolean)
                    });
                } catch (_) { }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
        }

        // Parent availability + conflict decision (new applications only). Runs BEFORE ownership
        // enrichment and child-building so the settled parent set feeds those steps. See
        // _resolveParentAvailabilityOrDefer for the full rationale.
        if (!isRestoring) {
            let declaredParentIds = Array.from(new Set(this._collectParentParcelIds(roadProposal, proposalData).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
            // A7, receiving side (rethink-proposals.md §15a): the stored declaration is the flat
            // consent anchor (base ids); the ground actually CONSUMED is derived from the
            // footprint against the LIVE fabric — geometry is authoritative, in both directions:
            //   coverage ≥ 95% → the working set IS the live fabric under the footprint;
            //   coverage < 95% → REFUSE. A formation consumes the ground under its footprint or
            //   does not apply; proceeding on the declaration when the live fabric cannot be seen
            //   is how a formation minted itself ON TOP of un-consumed pieces (double fabric).
            {
                const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
                const resolution = (ancestry && typeof ancestry.resolveParentsByGeometry === 'function')
                    ? ancestry.resolveParentsByGeometry(proposalData)
                    : null;
                if (resolution) {
                    if (Array.isArray(resolution.ids) && resolution.ids.length && resolution.coverage >= 0.95) {
                        // Attempt-local: the record's parents are written downstream from the
                        // parents actually consumed on success, so a failed attempt never
                        // poisons the declaration.
                        declaredParentIds = resolution.ids.map(String);
                        // The features must FOLLOW the ids: the availability gate reads declared
                        // ids against resolved features, and step 1 resolved the record's
                        // declaration — without this re-resolve a sibling road's minutes-old
                        // slice counts as "absent" and fails as a phantom prerequisite.
                        parentFeatures = this._resolveParcelFeaturesByIds(declaredParentIds,
                            { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                    } else {
                        const coveragePct = Math.round((resolution.coverage || 0) * 100);
                        const message = `The live fabric covers only ${coveragePct}% of this road's footprint here — the ground is not loaded or not present, so nothing was cut.`;
                        if (typeof updateStatus === 'function') updateStatus(message);
                        try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-unresolved', message }); } catch (_) { }
                        if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                        return false;
                    }
                }
            }
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds, parentFeatures, options });
            if (decision.defer) {
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            parentFeatures = decision.parentFeatures;

            // The gate may have PARKED occupying conflicts (autoParkConflicts), which changes
            // the live fabric under the corridor — re-derive so the working set is the
            // post-park ground, not a stale set naming a parked proposal's dead parcel (that id
            // would ride the success write-back into the record as a consumed parent).
            {
                const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
                const resolution = (ancestry && typeof ancestry.resolveParentsByGeometry === 'function')
                    ? ancestry.resolveParentsByGeometry(proposalData)
                    : null;
                if (resolution && Array.isArray(resolution.ids) && resolution.ids.length && resolution.coverage >= 0.95) {
                    declaredParentIds = resolution.ids.map(String);
                    parentFeatures = this._resolveParcelFeaturesByIds(declaredParentIds,
                        { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                }
            }
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
                // priorChildren: a formation edit (road-drawing) passes the previous partition's
                // pieces so surviving ground keeps its parcel identity across the recut.
                // uncutParentIds comes back filled with parents the corridor did not actually
                // cut — they stay live, unhidden and unmarked below.
                const buildOptions = Array.isArray(options.priorChildren) && options.priorChildren.length
                    ? { priorChildren: options.priorChildren }
                    : {};
                buildOptions.uncutParentIds = [];
                childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures, buildOptions);
                options._uncutParentIds = buildOptions.uncutParentIds;
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
            try { this._setLastApplyFailure(idLabel, { code: 'no-children-derived', message: 'The corridor produced no child parcels on this fabric.' }); } catch (_) { }
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
                    const missingChildIds = childParcelIds.filter(id => !childrenInIndex.has(id));
                    console.warn('Cannot restore road proposal: child parcel geometries are missing and not all children are in index.', {
                        proposalId,
                        expected: childParcelIds.length,
                        found: childrenInIndex.size,
                        missing: missingChildIds
                    });
                    if (typeof updateStatus === 'function') {
                        updateStatus('Cannot restore proposal: missing child parcel geometries.');
                    }
                    try { this._setLastApplyFailure(idLabel, { code: 'restore-missing-children', message: 'Cannot restore: child parcel geometries are missing.', missingIds: missingChildIds }); } catch (_) { }
                    if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                    return false;
                }
            } else {
                console.warn('Cannot restore road proposal: child parcel geometries are missing.', { proposalId });
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot restore proposal: missing child parcel geometries.');
                }
                try { this._setLastApplyFailure(idLabel, { code: 'restore-missing-children', message: 'Cannot restore: child parcel geometries are missing.', missingIds: (childParcelIds || []).slice() }); } catch (_) { }
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
        // Identity carry-over can hand a NEW child the id of the prior piece it replaces (a recut
        // keeps the corridor strip's name — the §15a partition-edit contract). Such an id was not
        // CONSUMED, it continued: recording it as a parent makes the record self-inconsistent
        // (parents ∩ children ≠ ∅), and the boot restore then hides the road's own live corridor
        // as a "consumed parent". The record keeps only genuinely replaced ground as parents;
        // the same set also guards the hide/mark passes below.
        const newChildIds = new Set(childFeatures
            .map(f => { try { return String(_getParcelIdFromFeature(f)); } catch (_) { return null; } })
            .filter(Boolean));
        const recordParentIds = uniqueParentParcelIds.filter(id => !newChildIds.has(String(id)));
        roadProposal.parentParcelIds = recordParentIds.slice();
        proposalData.parentParcelIds = recordParentIds.slice();

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

        // A parent the corridor never cut keeps its ground: it is not consumed, so it must not
        // be hidden (that orphans its uncut area) nor consumption-marked (that makes it a
        // hoverable parcel whose click falls into the consumed-parcel branch).
        const uncutParents = new Set((Array.isArray(options._uncutParentIds) ? options._uncutParentIds : []).map(String));
        uncutParents.forEach(id => parentsToRemoveSet.delete(id));

        // Conservation guard (§2.1): whatever branch dropped the child — the uncut-skip, the
        // sliver filters, a degenerate difference — a parent that produced NO remainder child may
        // only be hidden when the corridor truly swallowed it (≥98% covered). Anything else stays
        // live, or its uncut ground becomes a hole (the 6804/5 case: a 1 m² corner clip hid a
        // 38 m² parcel with nothing minted in its place).
        try {
            const corridorPolygon = roadProposal?.definition?.polygon || proposalData?.geometry?.roadGeometry?.polygon || null;
            const turfGuard = (typeof turf !== 'undefined') ? turf : null;
            if (corridorPolygon && turfGuard && typeof turfGuard.intersect === 'function') {
                const corridorFeature = { type: 'Feature', properties: {}, geometry: corridorPolygon };
                const remainderParents = new Set();
                childFeatures.forEach(feature => {
                    const props = feature && feature.properties;
                    if (!props || props.isCorridor === true || props.isTrack === true) return;
                    if (props.parentParcelId) remainderParents.add(String(props.parentParcelId));
                });
                Array.from(parentsToRemoveSet).forEach(pid => {
                    if (remainderParents.has(pid)) return; // it left a remainder — a real cut
                    let parentFeature = parentFeatures.find(f => {
                        const id = _getParcelIdFromFeature(f);
                        return id && String(id) === pid;
                    });
                    if (!parentFeature || !parentFeature.geometry) {
                        // Not among the resolved working features — pull it from the registry.
                        try {
                            const resolved = this._resolveParcelFeaturesByIds([pid],
                                { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true }) || [];
                            parentFeature = resolved[0] || null;
                        } catch (_) { parentFeature = null; }
                    }
                    // Conservative by construction: with no geometry to prove full consumption,
                    // the parent is NOT hidden. Hiding on unknown evidence is how ground orphans.
                    let share = 0;
                    if (parentFeature && parentFeature.geometry) {
                        try {
                            const pf = { type: 'Feature', properties: {}, geometry: parentFeature.geometry };
                            const total = turfGuard.area(pf) || 0;
                            const hit = turfGuard.intersect(pf, corridorFeature);
                            share = total > 0 ? ((hit ? turfGuard.area(hit) : 0) / total) : 0;
                        } catch (_) { share = 0; }
                    }
                    if (share < 0.98) {
                        console.warn(`[_applyRoadProposal] Sparing parent ${pid} — no remainder child and ${Math.round(share * 100)}% under the corridor; hiding it would orphan its ground.`);
                        parentsToRemoveSet.delete(pid);
                        uncutParents.add(pid);
                    }
                });
            }
        } catch (guardError) {
            console.warn('[_applyRoadProposal] conservation guard failed', guardError);
        }

        const parentFeaturesToRemove = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return parcelId && parentsToRemoveSet.has(parcelId.toString());
        });

        const parentFeaturesKept = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return !parcelId || !parentsToRemoveSet.has(parcelId.toString());
        });

        // Final record parents = ground truly CONSUMED (parentsToRemoveSet after the uncut and
        // conservation guards; unloaded declared parents stay — they are candidates too). A
        // spared parent recorded as consumed gets hidden by the next boot's restore, which is
        // how the park's parcel vanished after a road edit that merely grazed it.
        {
            const consumedRecordIds = recordParentIds.filter(id => parentsToRemoveSet.has(String(id)));
            roadProposal.parentParcelIds = consumedRecordIds.slice();
            proposalData.parentParcelIds = consumedRecordIds.slice();
        }

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
                try { this._setLastApplyFailure(idLabel, { code: 'map-unavailable', message: 'The parcel index is unavailable — the map has not finished booting.' }); } catch (_) { }
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
                try { this._setLastApplyFailure(idLabel, { code: 'restore-missing-children', message: 'Cannot restore: child parcel geometries are missing.', missingIds: missing.slice() }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'map-unavailable', message: 'The parcel index is unavailable — the map has not finished booting.' }); } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        // newChildIds (defined at the record write-back): an id carried over onto a NEW child is
        // the live child now — hiding it as a consumed parent would hide the just-added layer
        // (the corridor strip vanished from the map this way while the record said applied).
        parentIdSet.forEach(id => {
            if (newChildIds.has(id)) return;
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
                try { this._setLastApplyFailure(idLabel, { code: 'map-unavailable', message: 'The parcel index is unavailable — the map has not finished booting.' }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'children-not-added', message: 'One or more child parcels could not be added to the map.' }); } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        const step4Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentParcelIds);
        // PERFORMANCE: Use batched version instead of per-parcel calls
        this._markParcelsModifiedBatch(uniqueParentParcelIds);
        // Spared (uncut) parents keep their ground and stay unmarked: the consumed flag is what
        // routes their click into the consumed-parcel branch (the hover-fine-click-dead parcel).
        // An id carried over onto a NEW child (recut identity continuity) is the live child now,
        // not a consumed parent — marking it would dead-click the road's own corridor strip.
        this._setDescendantProposalOnParcels(
            uniqueParentParcelIds.filter(id => !uncutParents.has(String(id)) && !newChildIds.has(String(id))),
            proposalId);
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
        setProposalApplied(proposalData, true);
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
    };
});
