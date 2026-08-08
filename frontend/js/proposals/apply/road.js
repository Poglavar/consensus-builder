// _applyRoadProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyRoad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Below this, two polygons are not meaningfully related — the same measured-noise floor
    // plan-order.js uses for ancestry. It is NOT a tolerance for cut debris: the fabric is read at
    // full precision now (see cadastre-ancestry.js), so ground a road actually cut leaves exactly
    // zero overlap and mere adjacency measures exactly zero. Used below to tell a real take of
    // corridor ground from an abutting one, which must never be trimmed.
    const MIN_REAL_OVERLAP_M2 = 0.25;

    return {
    // §15b (decision 2026-08-06): one partition, latest wins — the taker AMENDS the taken.
    // After a formation successfully takes ground, every OTHER applied formation whose plan
    // still claims that ground is amended immediately: its authored plots are clipped by the
    // taken footprint, loudly. V1 amends reparcellization victims (their polygons ARE their
    // plan); corridor trimming of a road victim is the recorded follow-up. Amendment is
    // idempotent — re-clipping an already-clipped plan reports no change — and permanent:
    // un-applying the taker later frees the ground to base remainders, never back to the plan.
    // The ground a formation TAKES, per type — and it must be the SAME geometry the CUT
    // consumes, or the amend pass misses takings the fabric already performed. For roads that
    // is the FULL corridor polygon: the resolver and the parcel cut consume via
    // footprintOf → definition.polygon, tunnels included (Cibona's tunnelled roads consumed
    // the plots above them while the surface footprint overlapped those plots by 0 m², so
    // Subdivide 2042 was never amended and re-applied once per reload). The full corridor is
    // authoritative taking/cut geometry; a tunnel changes presentation only.
    _takingFootprintOf(proposalData) {
        try {
            if (!proposalData) return null;
            const definition = proposalData.roadProposal && proposalData.roadProposal.definition;
            if (definition) {
                if (definition.polygon) return definition.polygon;
                return (typeof corridorSurfaceFootprintForDefinition === 'function')
                    ? corridorSurfaceFootprintForDefinition(definition)
                    : null;
            }
            if (proposalData.reparcellization && Array.isArray(proposalData.reparcellization.polygons)) {
                const claimed = proposalData.reparcellization.polygons
                    .map(slice => slice && slice.geometry)
                    .filter(g => g && /Polygon/.test(g.type));
                if (!claimed.length) return null;
                return claimed.length === 1 ? claimed[0] : {
                    type: 'MultiPolygon',
                    coordinates: claimed.flatMap(g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
                };
            }
        } catch (_) { }
        return null;
    },

    // A road, once placed, IS a parcel, and nothing else may be built on it. Not "may not cut it
    // in two" — may not stand on it at all: a square laid across a street, a building overhanging
    // the carriageway, a park swallowing a junction are all the same mistake, and the fabric has no
    // way to represent two proposals owning the same ground.
    //
    // This replaces a narrower rule that refused only takes which DISCONNECTED a road, measured by
    // trimming the road's CENTERLINE. That leaked the centerline into a decision the parcel owns:
    // a road whose parcel no longer follows its centerline — one shaped by an edit, a migration or
    // drawn by hand — was judged on a line that is not its ground. The test is now the parcel
    // itself, so a derived corridor and a hand-drawn polygon behave identically.
    //
    // Roads still take from everything else; this is the one direction that is closed. Returns
    // { proposal, overlapM2 } for the first applied road the taking would stand on, else null.
    _appliedRoadOverlappedByTaking(takenGeometry, excludeProposalId) {
        try {
            const turfRef = (typeof turf !== 'undefined') ? turf : null;
            if (!turfRef || !takenGeometry) return null;
            const taken = takenGeometry.type === 'Feature'
                ? takenGeometry
                : { type: 'Feature', properties: {}, geometry: takenGeometry };
            if (!taken.geometry) return null;
            const excludeKey = excludeProposalId === undefined || excludeProposalId === null
                ? '' : String(excludeProposalId);
            const all = (typeof proposalStorage !== 'undefined' && proposalStorage
                && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals() : [];
            for (const p of all) {
                if (!p) continue;
                if (excludeKey && String(p.proposalId) === excludeKey) continue;
                if (!(p.roadProposal && p.roadProposal.definition)) continue;
                if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(p)) continue;
                // The road's PARCEL: its stored polygon when it has one, the corridor it would cut
                // otherwise. Same geometry the cut consumes, so the guard cannot disagree with it.
                const claim = this._takingFootprintOf(p);
                if (!claim) continue;
                let overlapM2 = 0;
                try {
                    const hit = turfRef.intersect(taken, { type: 'Feature', properties: {}, geometry: claim });
                    overlapM2 = hit ? (turfRef.area(hit) || 0) : 0;
                } catch (_) { overlapM2 = 0; }
                // Abutting a street is normal composition and measures exactly zero now that the
                // fabric is read at full precision; anything above the noise floor is a real take.
                if (overlapM2 >= MIN_REAL_OVERLAP_M2) return { proposal: p, overlapM2 };
            }
        } catch (error) {
            console.warn('[_appliedRoadOverlappedByTaking] road-overlap pre-check failed', error);
        }
        return null;
    },

    // Parcel ids held by OTHER currently-applied road formations — the ground the crossroads
    // rule keeps out of a road's taking. Records are the source (childParcelIds is written
    // back on every apply), so during an ordered rebuild an earlier road's fresh children are
    // seen by every later one.
    _appliedRoadHeldParcelIds(excludeProposalId) {
        const held = new Set();
        try {
            const all = (typeof proposalStorage !== 'undefined' && proposalStorage
                && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals() : [];
            const excludeKey = excludeProposalId === undefined || excludeProposalId === null
                ? '' : String(excludeProposalId);
            all.forEach(p => {
                if (!p) return;
                if (excludeKey && String(p.proposalId) === excludeKey) return;
                if (!(p.roadProposal && p.roadProposal.definition)) return;
                if (typeof isProposalCurrentlyApplied === 'function' && !isProposalCurrentlyApplied(p)) return;
                (Array.isArray(p.childParcelIds) ? p.childParcelIds : []).forEach(id => {
                    const key = id === undefined || id === null ? '' : String(id);
                    if (key) held.add(key);
                });
            });
        } catch (_) { }
        return held;
    },
    // §15b's amend pass lived here: when a formation took ground, every other applied formation
    // whose plan still claimed it had its authored plots clipped. It is gone, and deliberately.
    //
    // The live fabric is a DERIVATION (§15c) — cadastre, then the applied formations in order, each
    // cutting what stands — replayed from the authored records. A derivation must not rewrite its
    // own inputs, and that is exactly what amending a victim's stored plan did: every rebuild
    // re-ran every taker, so a readjustment's plan shrank on each pass. Measured on UPU Borovje:
    // 103,145 m² of authored plots down to 81,271, until it resolved 79 fragmented parents instead
    // of 29 whole parcels and could not apply at all — invisible, while its record still read
    // "applied" from the first pass.
    //
    // Nothing is lost by removing it, because amendment never resolved the conflict anyway. A
    // readjustment is refused on derived ground, so it can never be LATER than a taker on the same
    // ground; when it is earlier it mints first and the taker consumes what it needs — the vertical
    // stack, not a competing claim. Order decides. And since nothing may take road ground, a
    // readjustment was the only victim the pass had left.


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
        console.debug(`[_applyRoadProposal] Starting application for ${idLabel}...`);

        const canonicalParentIds = Array.isArray(proposalData?.parentParcelIds) ? proposalData.parentParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const canonicalChildIds = Array.isArray(proposalData?.childParcelIds) ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const isGovernmentPlan = proposalData?.tags?.governmentPlan === true
            || proposalData?.roadProposal?.definition?.kind === 'government_plan';

        // One authored road record: all cutting and presentation derive from this definition.
        const roadProposal = proposalData?.roadProposal && typeof proposalData.roadProposal === 'object'
            ? { ...proposalData.roadProposal }
            : null;
        if (!roadProposal?.definition) {
            const message = `Cannot apply ${idLabel}: the stored road record has no authored definition. Run migrate-tessellation.js first.`;
            try { this._setLastApplyFailure(idLabel, { code: 'road-definition-missing', message }); } catch (_) { }
            return false;
        }

        proposalData.roadProposal = roadProposal;
        delete roadProposal.parentFeatures;
        if (!isGovernmentPlan) delete roadProposal.childFeatures;

        // Keep canonical fields authoritative
        proposalData.parentParcelIds = canonicalParentIds.slice();
        proposalData.childParcelIds = canonicalChildIds.length ? canonicalChildIds.slice() : (roadProposal.childParcelIds || []);

        // PERFORMANCE: Start write cache to batch localStorage operations
        if (options._parcelWriteBatchActive !== true && typeof window._startParcelWriteCache === 'function') {
            window._startParcelWriteCache();
        }

        let childFeatures = [];

        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'road');
        if (!liveParents.ok) {
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        let parentFeatures = liveParents.features;

        // Crossroads (ruling 2026-08-07): a road never takes ROAD SURFACE from another applied
        // road — where corridors cross they form a junction, and the crossing box stays with
        // whichever road already holds it. Only the holder's CORRIDOR pieces leave the parent
        // set; a road's §14.2 remainders are the owner's ordinary ground and a later road cuts
        // them like any parcel (identity carried) — excluding them by mere record membership
        // left an owner's parcel spanning whole underneath the new road. When the holder is
        // later unapplied, the rebuild replays this road against holderless ground and it
        // mints the box itself — junction ownership is a derivation, not a stored fact.
        const roadHeldIds = this._appliedRoadHeldParcelIds(idLabel);
        const roadHeldFeatures = [];
        if (roadHeldIds.size) {
            const excluded = [];
            const kept = [];
            parentFeatures.forEach(feature => {
                const pid = _getParcelIdFromFeature(feature);
                const key = pid === undefined || pid === null ? '' : String(pid);
                const corridorPiece = !!(feature && feature.properties
                    && (feature.properties.isCorridor === true || feature.properties.isTrack === true));
                if (key && corridorPiece && roadHeldIds.has(key)) {
                    excluded.push(key);
                    roadHeldFeatures.push(feature);
                } else kept.push(feature);
            });
            if (excluded.length) {
                console.info(`[_applyRoadProposal] ${idLabel}: junction with applied road ground — `
                    + `${excluded.length} road parcel(s) left with their holder`, excluded);
                parentFeatures = kept;
            }
            if (!parentFeatures.length) {
                const message = `Cannot apply ${idLabel}: the corridor lies entirely over already-applied road ground.`;
                try { this._setLastApplyFailure(idLabel, { code: 'road-over-road', message }); } catch (_) { }
                try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
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

        const providedChildFeatures = Array.isArray(proposalData?.childFeatures)
            ? proposalData.childFeatures
            : (Array.isArray(proposalData?.roadProposal?.childFeatures) ? proposalData.roadProposal.childFeatures : []);

        if (isGovernmentPlan) {
            childFeatures = this._cloneFeatures(providedChildFeatures);
        } else {
            const buildOptions = {};
            buildOptions.uncutParentIds = [];
            buildOptions.cutFailures = [];
            // Crossroads: the cut geometry itself must exclude road-held ground — a corridor
            // RUN spans the authored corridor between junctions, so dropping the box parcel
            // from the parents alone still minted runs whose geometry covered the box.
            buildOptions.cutExclusionFeatures = roadHeldFeatures;
            childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures, buildOptions);
            options._uncutParentIds = buildOptions.uncutParentIds;
            options._cutFailures = buildOptions.cutFailures;
        }

        if (isGovernmentPlan && !childFeatures.length) {
            try { this._setLastApplyFailure(idLabel, { code: 'no-children-derived', message: 'The corridor produced no child parcels on this fabric.' }); } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        if (!isGovernmentPlan && (!childFeatures.length || (options._cutFailures && options._cutFailures.length))) {
            const failures = Array.isArray(options._cutFailures) ? options._cutFailures : [];
            const message = failures.length
                ? `The road cut could not conserve ${failures.length} parcel(s): ${failures.map(f => f.parcelId).filter(Boolean).join(', ')}.`
                : 'The road footprint produced no tessellation.';
            try { this._setLastApplyFailure(idLabel, { code: 'road-cut-failed', message, failures }); } catch (_) { }
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        const roadDefinition = roadProposal.definition;
        if (roadDefinition && typeof roadDefinition === 'object') {
            roadDefinition.demolishedBuildings = [];
            delete roadDefinition.demolitionScanned;
            try {
                const footprint = this._takingFootprintOf(proposalData);
                if (footprint && typeof this._deriveDemolishedBuildings === 'function') {
                    roadDefinition.demolishedBuildings = await this._deriveDemolishedBuildings(footprint, {
                        ...options,
                        proposalId: idLabel
                    });
                }
            } catch (error) {
                console.error('[_applyRoadProposal] demolition scan failed', idLabel, error);
            }
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

        if (!parentFeatures.length) {
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

        console.debug(`Applying proposal ${proposalId}:`, {
            parentFeatures: parentFeatures.length,
            childFeatures: childFeatures.length,
            parentIds: parentFeatures.map(f => _getParcelIdFromFeature(f)),
            childIds: childFeatures.map(f => _getParcelIdFromFeature(f))
        });

        // The geometry resolver selected the exact live pieces this stamp cuts. Never mix the
        // record's declared cadastral hints back into that set: doing so made a replay hide stale
        // generations and made road edits depend on which tiles happened to be loaded first.
        const liveParentParcelIds = Array.from(new Set(parentFeatures
            .map(feature => _getParcelIdFromFeature(feature))
            .filter(id => id !== undefined && id !== null)
            .map(String)));
        // Identity carry-over can hand a new remainder the id of the live piece it replaces. Do
        // not hide that freshly re-minted layer after adding it.
        const newChildIds = new Set(childFeatures
            .map(f => { try { return String(_getParcelIdFromFeature(f)); } catch (_) { return null; } })
            .filter(Boolean));
        // The exact live parents resolved geometrically are the only layers this stamp consumes.
        const parentsToRemoveSet = new Set(liveParentParcelIds);

        // A parent the corridor never cut keeps its ground: it is not consumed, so it must not
        // be hidden (that orphans its uncut area) nor consumption-marked (that makes it a
        // hoverable parcel whose click falls into the consumed-parcel branch).
        const uncutParents = new Set((Array.isArray(options._uncutParentIds) ? options._uncutParentIds : []).map(String));
        uncutParents.forEach(id => parentsToRemoveSet.delete(id));

        const parentFeaturesKept = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return !parcelId || !parentsToRemoveSet.has(parcelId.toString());
        });

        // Records stay flat. Live/derived ids are only an input to this cut and never survive it.
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const flatParentIds = formationEdit && typeof formationEdit.baseIdOf === 'function'
            ? Array.from(new Set(Array.from(parentsToRemoveSet).map(formationEdit.baseIdOf).filter(Boolean)))
            : [];
        if (!flatParentIds.length) {
            const message = 'Cannot apply road: the consumed ground has no cadastral anchors.';
            try { this._setLastApplyFailure(idLabel, { code: 'road-cadastre-unresolved', message }); } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        proposalData.cadastreParcelIds = flatParentIds.slice();
        roadProposal.parentParcelIds = flatParentIds.slice();
        proposalData.parentParcelIds = flatParentIds.slice();

        // Determine which parents are currently on the map.
        const parentParcelsOnMap = [];
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
        parentsToRemoveSet.forEach(id => {
            if (newChildIds.has(id)) return;
            if (mapByIdRemove.has(id)) {
                parentParcelsOnMap.push(id);
            }
        });

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

            console.debug(`[_applyRoadProposal] Hiding ${parentParcelsOnMap.length} parent parcels from map (keeping in index):`, parentParcelsOnMap);
            parentParcelsOnMap.forEach(parcelId => {
                // Hide from the live partition while retaining the registry entry for this replay.
                if (typeof window.hideParcelLayerById === 'function') {
                    window.hideParcelLayerById(parcelId);
                } else if (typeof window.removeParcelLayerById === 'function') {
                    window.removeParcelLayerById(parcelId);
                }
            });
            console.debug(`[_applyRoadProposal] Step 5: Hidden ${parentParcelsOnMap.length} parent parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);
        };

        let allChildrenAdded = true;
        try {
            const step3Time = performance.now();
            // Add new features using normal map styling (no special proposal coloring)
            // Pass proposal data so track information can be retrieved if needed
            this._addFeaturesToMap(childFeatures, true, proposalData);
            console.debug(`[_applyRoadProposal] Step 3: Added ${childFeatures.length} child parcels to map (${(performance.now() - step3Time).toFixed(2)}ms)`);
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
        // PERFORMANCE: Use batched version instead of per-parcel calls
        // Spared (uncut) parents keep their ground and stay unmarked: the consumed flag is what
        // routes their click into the consumed-parcel branch (the hover-fine-click-dead parcel).
        // An id carried over onto a NEW child (recut identity continuity) is the live child now,
        // not a consumed parent — marking it would dead-click the road's own corridor strip.
        console.debug(`[_applyRoadProposal] Step 4: Cut ${liveParentParcelIds.length} live parcel(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // Remove parents only after ancestor linkage/property updates so map lookups succeed.
        removeParentParcels();

        const step6Time = performance.now();
        const childParcelIds = [];
        const ownIdForChildren = String(proposalIdForSynthetics || proposalId);
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // §15b: a carried piece of a FOREIGN plot is the victim's child, not this road's —
            // it keeps the victim's proposalId (the builder left the clone untouched), goes
            // into the victim's record, and never into this road's child list or ancestry.
            const pieceProposalId = feature.properties && feature.properties.proposalId
                ? String(feature.properties.proposalId) : ownIdForChildren;
            if (pieceProposalId !== ownIdForChildren && pieceProposalId !== String(proposalId)) {
                this._persistParcelFeature(feature);
                this._addProposalAsAncestor(parcelId, pieceProposalId);
                if (parcelId !== undefined && parcelId !== null) {
                }
                return;
            }
            // Save coordinates in WGS84 format (same as display format)
            feature.properties.ancestorProposal = proposalId;
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
            }
        });
        // PERFORMANCE: Batch the mark operation instead of per-parcel calls
        // Register this freshly derived child set for selection and proposal lookup.
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }
        console.debug(`[_applyRoadProposal] Step 6: Saved ${childFeatures.length} child parcels to storage (${(performance.now() - step6Time).toFixed(2)}ms)`);

        if (parentFeaturesKept.length > 0) {
            const keptIds = parentFeaturesKept
                .map(feature => _getParcelIdFromFeature(feature)?.toString())
                .filter(Boolean);
            console.debug('[_applyRoadProposal] Kept uncut parent parcel(s).', {
                keptCount: parentFeaturesKept.length,
                keptIds
            });
        }
        const uniqueChildIds = Array.from(new Set(childParcelIds.map(id => id.toString())));
        roadProposal.childParcelIds = uniqueChildIds;
        proposalData.childParcelIds = uniqueChildIds;

        // Ordinary children are derived. Government-plan road children are the authored plan.
        if (!isGovernmentPlan) delete roadProposal.childFeatures;
        else roadProposal.childFeatures = this._cloneFeatures(providedChildFeatures);
        delete roadProposal.parentFeatures;
        if (proposalData.roadProposal) {
            if (!isGovernmentPlan) delete proposalData.roadProposal.childFeatures;
            delete proposalData.roadProposal.parentFeatures;
        }

        persistAppliedProposal(proposalData, proposalId);
        refreshProposalUIAfterApply(`Applied road proposal ${proposalData.title || idLabel}`);

        // PERFORMANCE: Flush cached writes to localStorage in one batch
        if (typeof window._flushParcelWriteCache === 'function') {
            window._flushParcelWriteCache();
        }

        // §15b: the taking is done — amend every earlier standing plan that still claims it.
        try {
            const takenFootprint = this._takingFootprintOf(proposalData);
        } catch (amendError) {
            console.warn('[_applyRoadProposal] §15b amend pass failed', amendError);
        }

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyRoadProposal] ✓ Road proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },
    };
});
