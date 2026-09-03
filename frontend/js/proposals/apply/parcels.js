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
        // Apply works from a private copy. Runtime contribution summaries and materialized parcel
        // ids must never be written back into the authored plan.
        const plan = JSON.parse(JSON.stringify(proposalData.reparcellization));
        const coordinatedPlanId = proposalData.coordinatedPlanId === undefined
            || proposalData.coordinatedPlanId === null
            ? ''
            : String(proposalData.coordinatedPlanId).trim();
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

        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'readjustment', options);
        if (!liveParents.ok) return false;
        let parentIds = liveParents.ids;
        let parentFeatures = liveParents.features;

        // A readjustment may stand on any ground NOT already taken — including the remainders a
        // road left behind. That is the whole point of drawing roads to form a block and then
        // redividing it: a block bounded by roads is made of remainders by construction, so
        // requiring whole cadastral parcels meant a readjustment could never touch anything the
        // roads had created (ruling 2026-08-10, replacing the whole-parcel rule of 2026-08-07).
        //
        // What it may still not do is take ground another formation has already taken — a corridor.
        // That is the same rule roads live under: you may take what is free, never what is spoken
        // for. A record is defined by its cadastral anchors plus the geometry of its take, exactly
        // as a road is; the pieces it stands on are derived and carry no authority of their own.
        {
            const takenParents = parentIds.map(String).filter(id => {
                const layerFeature = parentFeatures.find(f => String(_getParcelIdFromFeature(f)) === id);
                const props = (layerFeature && layerFeature.properties) || {};
                const takers = Array.isArray(props.formedByProposalIds) ? props.formedByProposalIds : [];
                return props.isCorridor === true || props.isTrack === true || takers.length > 0;
            });
            if (takenParents.length) {
                const coverers = new Map();
                takenParents.forEach(id => {
                    const layerFeature = parentFeatures.find(f => String(_getParcelIdFromFeature(f)) === id);
                    const props = (layerFeature && layerFeature.properties) || {};
                    const takers = Array.isArray(props.formedByProposalIds) && props.formedByProposalIds.length
                        ? props.formedByProposalIds.map(String)
                        : (props.producedByProposalId ? [String(props.producedByProposalId)] : []);
                    takers.forEach(ownerId => {
                        if (!ownerId) return;
                        const record = options?._parcelMutation?.proposals?.getProposal?.(ownerId) || null;
                        coverers.set(ownerId, (record && (record.title || record.name)) || ownerId);
                    });
                });
                const names = Array.from(coverers.values());
                const message = names.length
                    ? `A land readjustment cannot take ground another proposal already holds: ${names.map(n => `"${n}"`).join(', ')}. Move the outline off it, or unapply ${names.length === 1 ? 'that proposal' : 'those proposals'} first.`
                    : 'A land readjustment cannot take ground another proposal already holds. Move the outline off it, or unapply that proposal first.';
                if (typeof updateStatus === 'function') updateStatus(message);
                console.warn(`[_applyReparcellizationProposal] ${idLabel}: ground already taken —`, takenParents);
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'readjustment-taken-ground',
                        message,
                        coveringProposalIds: Array.from(coverers.keys())
                    });
                } catch (_) { }
                return false;
            }
            // The whole-parcel tessellation gate that used to sit here is gone. It required the
            // plan to cover every input parcel to 97%, which made a readjustment impossible on any
            // ground a road had touched — and forming blocks with roads and then redividing them is
            // the reason to draw roads first. A readjustment now takes what its outline covers; the
            // part of a parent it does NOT cover is minted back to the owner as a remainder (§14.2
            // below), exactly as it is for a road.
        }

        // Two plots may not cover the same ground. The take IS the union of the plots, so a gap or
        // an excess against it cannot happen — but an overlap can, and it is the one failure that
        // corrupts the result silently: the pool measures the union correctly while the plots hand
        // the same square metre to two people.
        //
        // The draft editor already refuses this, and that is not enough. A plan can arrive from a
        // shared link, an import or any other route that never passed through the editor, and this
        // is the last point before ground changes hands.
        {
            const contributionsApi = (typeof window !== 'undefined') ? window.__readjustmentContributions : null;
            if (contributionsApi && typeof contributionsApi.overlappingPlots === 'function') {
                const overlaps = contributionsApi.overlappingPlots(plan.polygons);
                if (overlaps.length) {
                    const worst = overlaps.slice().sort((x, y) => y.areaM2 - x.areaM2)[0];
                    const pairs = overlaps.map(o => `${o.a + 1}&${o.b + 1}`).join(', ');
                    const message = `A land readjustment cannot give the same ground to two plots: ${overlaps.length} overlapping pair(s) (${pairs}), the largest ${Math.round(worst.areaM2)} m². Redraw the plots so they meet without covering each other.`;
                    if (typeof updateStatus === 'function') updateStatus(message);
                    console.warn(`[_applyReparcellizationProposal] ${idLabel}: overlapping plots —`, overlaps);
                    try {
                        this._setLastApplyFailure(idLabel, {
                            code: 'readjustment-overlapping-plots',
                            message,
                            overlaps
                        });
                    } catch (_) { }
                    return false;
                }
            }
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const rootParcelId = liveParents.cadastreIds[0] || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null)
            || primaryNumber || 'parcel';

        const childFeatures = plan.polygons.map(slice => {
            if (!slice || !slice.geometry) return null;
            const feature = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    producedByProposalId: proposalId,
                    cadastreParcelIds: liveParents.cadastreIds.slice(),
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

        // Flat anchors (formation-edit.js; rethink-proposals.md §15a). Every
        // plot records the base cadastral parcels actually under it — a comasation plot spanning
        // thirty parents is one formation with thirty base anchors, never a chain — and the
        // proposal's flat declaration is written where the cut is computed. Edits are new records;
        // an unchanged record therefore derives the same ids from the same ordered geometry.
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            throw new Error('Readjustment formation requires the cadastral provenance geometry service.');
        }
        const anchorCtx = {
            area: f => { try { return turfRef.area(f) || 0; } catch (_) { return 0; } },
            intersectionArea: (a, b) => {
                try { const hit = turfRef.intersect(a, b); return hit ? turfRef.area(hit) : 0; } catch (_) { return 0; }
            }
        };
        const parentEntries = parentFeatures.flatMap(feature => formationEdit.cadastreIdsOfFeature(feature)
            .map(baseId => ({ baseId, feature })));
        if (!parentEntries.length) {
            throw new Error('Readjustment parents carry no explicit cadastral provenance.');
        }
        childFeatures.forEach(feature => {
            const ids = formationEdit.overlappingBaseIds(feature, parentEntries, anchorCtx);
            if (!ids.length) throw new Error('A readjustment plot lies on no declared cadastral parcel.');
            feature.properties.cadastreParcelIds = ids;
        });

        let allocForeignIndex = null;
        // §14.2: a formation owes the owner their remainders. The pool consumed above is the
        // LIVE ground under the plan's footprint, and the authored plots may tile less than that
        // (plots drawn against another generation's fabric) — every scrap of pool the plots do
        // not cover is minted back as a remainder parcel, cloned from its parent so the owner
        // keeps it. Without this the leftover strip is ORPHANED: consumed, unminted, a hole in
        // the fabric that hover can only resolve to the hidden ancestor (the Cibona sliver).
        try {
            const turfRemainder = (typeof turf !== 'undefined') ? turf : null;
            // A coordinated package's missing ground is not an accidental remainder: sibling road
            // records own those bands. Leave the gap until their immediately following phase
            // materialises it. Ordinary standalone readjustments still conserve every scrap here.
            if (!coordinatedPlanId && turfRemainder && typeof turfRemainder.difference === 'function' && parentFeatures.length) {
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
                        // §15b identity flows with the ground: the leftover of ANOTHER
                        // proposal's formed plot stays the VICTIM's child — the largest part
                        // keeps the plot's id (same parcel, smaller), splits continue the
                        // victim's numbering, and the clone keeps the victim's proposalId and
                        // ownership untouched. Only ground under this plan's plots changes hands.
                        const carryIdentity = formationEdit.formationIdentityOf(parentFeature);
                        const parentProducer = parentFeature.properties
                            && parentFeature.properties.producedByProposalId;
                        if (carryIdentity && parentProducer && String(parentProducer) !== String(proposalId)
                            && typeof _extractPolygonsWithHolesFromGeometry === 'function'
                            && typeof _ensurePolygonIsClosed === 'function') {
                            if (!allocForeignIndex) allocForeignIndex = this._createForeignIndexAllocator(options);
                            const parts = _extractPolygonsWithHolesFromGeometry(leftover.geometry)
                                .map(({ outer, holes }) => {
                                    const coords = [_ensurePolygonIsClosed(outer || []), ...(Array.isArray(holes) ? holes.map(ring => _ensurePolygonIsClosed(ring || [])) : [])];
                                    let area = 0;
                                    try { area = turfRemainder.area(turfRemainder.polygon(coords)) || 0; } catch (_) { area = 0; }
                                    return { coords, area };
                                })
                                .filter(part => part.area >= 0.5)
                                .sort((x, y) => y.area - x.area);
                            parts.forEach((part, partIndex) => {
                                const carried = JSON.parse(JSON.stringify(parentFeature));
                                carried.geometry = { type: 'Polygon', coordinates: part.coords };
                                carried.properties = carried.properties || {};
                                carried.properties.calculatedArea = Math.round(part.area);
                                const syntheticIndex = partIndex === 0
                                    ? carryIdentity.index
                                    : allocForeignIndex(carryIdentity.cadastreParcelIds[0], carryIdentity.token);
                                const carriedId = partIndex === 0
                                    ? String(parentId)
                                    : _composeSyntheticParcelId(
                                        carryIdentity.cadastreParcelIds[0],
                                        carryIdentity.token,
                                        syntheticIndex);
                                const carriedNumber = partIndex === 0
                                    ? ((parentFeature.properties && parentFeature.properties.BROJ_CESTICE) || null)
                                    : _composeSyntheticParcelNumber(
                                        carried.properties.rootParcelNumber || null,
                                        carryIdentity.token,
                                        syntheticIndex);
                                carried.properties.__carryIdentity = {
                                    parcelId: carriedId,
                                    parcelNumber: carriedNumber,
                                    syntheticToken: carryIdentity.token,
                                    syntheticIndex
                                };
                                _ensureParcelIdOnProperties(carried.properties, carriedId);
                                childFeatures.push(carried);
                            });
                            return;
                        }
                        const remainder = JSON.parse(JSON.stringify(parentFeature));
                        remainder.geometry = leftover.geometry;
                        remainder.properties = remainder.properties || {};
                        remainder.properties.producedByProposalId = proposalId;
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
            throw new Error(`Readjustment remainder formation failed: ${remainderError.message || remainderError}`);
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures);

        await this._addFeaturesToMap(childFeatures, true, proposalData, options);

        const childParcelIds = [];
        const touchedAgentIds = new Set();
        const ownershipContext = {
            storage: options?._parcelMutation?.storage,
            agentStore: options?._parcelMutation?.agents
        };
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // §15b: a carried piece of a FOREIGN plot is the victim's child, not this
            // readjustment's — see the road apply's twin branch.
            const pieceProposalId = feature.properties && feature.properties.producedByProposalId
                ? String(feature.properties.producedByProposalId) : String(proposalId);
            if (pieceProposalId !== String(proposalId)) {
                this._markParcelProducedByProposal(parcelId, pieceProposalId, options);
                return;
            }
            feature.properties.producedByProposalId = proposalId;
            this._markParcelProducedByProposal(parcelId, proposalId, options);
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
                        agentId = (typeof getOrCreateCityAgent === 'function')
                            ? getOrCreateCityAgent(ownershipContext)
                            : null;
                    } else if (ownerKey && ownershipContext.agentStore?.getAgent?.(ownerKey)) {
                        agentId = ownerKey;
                    } else if (ownerKey && displayName && displayName !== 'Unassigned' && typeof getOrCreateAgentForRecipient === 'function') {
                        agentId = getOrCreateAgentForRecipient(displayName, ownershipContext);
                    }
                    if (agentId) {
                        transferParcelOwnership(String(parcelId), null, agentId, {
                            ...ownershipContext,
                            skipAgentSync: true
                        });
                        touchedAgentIds.add(agentId);
                    }
                }
            }
        });

        // Rebuild the touched agents' owned-parcel lists in ONE keyspace pass (buildAgentOwnedParcelIndex),
        // batching the agent save to once — instead of a full scan + full re-serialize per child above.
        if (touchedAgentIds.size && typeof buildAgentOwnedParcelIndex === 'function' && ownershipContext.agentStore) {
            const ownerIndex = buildAgentOwnedParcelIndex({ storage: ownershipContext.storage });
            touchedAgentIds.forEach(id => ownershipContext.agentStore.updateAgent(id, {
                ownedParcels: ownerIndex.get(id) || []
            }));
        }

        // The record keeps only flat cadastral ground actually consumed. Live generated ids are
        // local cut inputs; after replacement they are deleted rather than retained as lineage.
        // §15b: an id carried onto a minted piece is the LIVE piece now — hiding it or
        // recording it as a consumed parent would consume the victim's surviving plot. The
        // ground it lost is anchored to the BASE parcel instead, so this readjustment's unapply
        // frees it as a BASE remainder (latest wins — never the plot at stale geometry).
        const mintedIdSet = new Set(childFeatures
            .map(f => { try { return String(_getParcelIdFromFeature(f)); } catch (_) { return null; } })
            .filter(Boolean));
        const carriedBaseAnchors = new Set();
        const consumedParentIds = Array.from(new Set(parentFeatures
            .map(f => { const id = _getParcelIdFromFeature(f); return id ? String(id) : null; })
            .filter(Boolean)))
            .filter(id => {
                if (mintedIdSet.has(String(id))) {
                    const retained = parentFeatures.find(feature => (
                        String(_getParcelIdFromFeature(feature) || '') === String(id)
                    ));
                    const cadastreIds = Array.isArray(retained?.properties?.cadastreParcelIds)
                        ? retained.properties.cadastreParcelIds.map(String)
                        : [];
                    cadastreIds.forEach(baseId => carriedBaseAnchors.add(String(baseId)));
                    return false;
                }
                // parentFeatures were resolved from the transaction's live-fabric draft. Their
                // presence there is the domain proof that they are consumable; a Leaflet layer is
                // only a projection and can never veto or resurrect a parcel mutation.
                return true;
            });
        carriedBaseAnchors.forEach(baseId => {
            if (!consumedParentIds.includes(baseId)) consumedParentIds.push(baseId);
        });
        this._consumeFeaturesFromLiveFabric(parentFeatures.filter(f => {
            try { return !mintedIdSet.has(String(_getParcelIdFromFeature(f))); } catch (_) { return true; }
        }), options);
        const flatParentIds = Array.from(new Set(
            Array.isArray(proposalData.cadastreParcelIds)
                ? proposalData.cadastreParcelIds.map(String).filter(Boolean)
                : []
        ));
        if (!flatParentIds.length) {
            const error = new Error('Cannot apply reparcellization without explicit cadastral provenance.');
            error.code = 'reparcellization-cadastre-provenance-missing';
            throw error;
        }
        persistAppliedProposal(proposalData, proposalId, options);
        // The status line is written once, for every type, by _runProposalApplyWithSummary.
        if (options.deferPresentation !== true) refreshProposalUIAfterApply(null, options);

        // §15b: this plan's authored polygons are the ground it took — amend every other
        // applied plan that still claims any of it (one partition, latest wins).
        try {
            const claimed = plan.polygons
                .map(slice => slice && slice.geometry)
                .filter(g => g && /Polygon/.test(g.type));
            if (claimed.length) {
                const takenGeometry = claimed.length === 1
                    ? claimed[0]
                    : {
                        type: 'MultiPolygon',
                        coordinates: claimed.flatMap(g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
                    };
            }
        } catch (amendError) {
            console.warn('[_applyReparcellizationProposal] §15b amend pass failed', amendError);
        }

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyReparcellizationProposal] ✓ Reparcellization proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    async _applyDecideLaterProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyDecideLaterProposal] Starting application for ${idLabel}...`);

        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'decide-later formation', options);
        if (!liveParents.ok) return false;
        const parentIds = liveParents.ids;
        const parentFeatures = liveParents.features;
        const flatParentIds = liveParents.cadastreIds.slice();

        const mergedGeometry = _mergeParcelGeometries(parentFeatures);
        if (!mergedGeometry) {
            const message = 'Cannot apply decide later proposal: failed to merge parcel geometry.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            try { this._setLastApplyFailure(idLabel, { code: 'merge-failed', message: `The ${parentIds.length} ancestor parcel geometries could not be merged into a single parcel.` }); } catch (_) { }
            return false;
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const rootParcelId = flatParentIds[0] || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null)
            || primaryNumber || 'parcel';

        const childFeature = {
            type: 'Feature',
            geometry: mergedGeometry,
            properties: {
                producedByProposalId: proposalId,
                cadastreParcelIds: flatParentIds.slice(),
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
            const ownershipContext = {
                storage: options?._parcelMutation?.storage,
                agentStore: options?._parcelMutation?.agents
            };
            const recipientAgentId = resolveProposalRecipientAgentId(proposalData, ownershipContext);
            if (recipientAgentId) {
                transferParcelOwnership(childParcelId, null, recipientAgentId, ownershipContext);
            }
        }

        // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js

        options._parcelMutation.afterCommit(() => {
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
        });

        await this._addFeaturesToMap([childFeature], true, proposalData, options);
        this._markParcelProducedByProposal(childParcelId, proposalId, options);


        this._consumeFeaturesFromLiveFabric(parentFeatures, options);

        persistAppliedProposal(proposalData, proposalId, options);
        if (options.deferPresentation !== true) refreshProposalUIAfterApply(null, options);

        console.debug(`[_applyDecideLaterProposal] ✓ Completed application in ${(performance.now() - startTime).toFixed(2)}ms`);
        return true;
    },
    };
});
