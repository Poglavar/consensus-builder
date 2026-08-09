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

        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'readjustment');
        if (!liveParents.ok) return false;
        let parentIds = liveParents.ids;
        let parentFeatures = liveParents.features;
        proposalData.cadastreParcelIds = liveParents.cadastreIds.slice();

        // Ruling 2026-08-07: a land readjustment stands on the CADASTRE, never on another
        // proposal's fabric, and its inputs are WHOLE cadastral parcels only. The interactive
        // apply path asks to unapply the coverers before this transaction (applyProposal
        // pre-ask); by the time this gate runs, refusal is the only honest move.
        {
            const derivedParents = parentIds.map(String).filter(id => id.includes('#'));
            if (derivedParents.length) {
                const coverers = new Map();
                derivedParents.forEach(id => {
                    const layerFeature = parentFeatures.find(f => String(_getParcelIdFromFeature(f)) === id);
                    const ownerId = layerFeature && layerFeature.properties && layerFeature.properties.proposalId
                        ? String(layerFeature.properties.proposalId) : '';
                    if (!ownerId) return;
                    const record = (typeof _getProposalRecord === 'function') ? _getProposalRecord(ownerId) : null;
                    coverers.set(ownerId, (record && (record.title || record.name)) || ownerId);
                });
                const names = Array.from(coverers.values());
                const message = names.length
                    ? `A land readjustment must stand on cadastral parcels, but this ground is held by ${names.map(n => `"${n}"`).join(', ')}. Unapply ${names.length === 1 ? 'that proposal' : 'those proposals'} first.`
                    : 'A land readjustment must stand on cadastral parcels, but part of this ground is held by another proposal. Unapply it first.';
                if (typeof updateStatus === 'function') updateStatus(message);
                console.warn(`[_applyReparcellizationProposal] ${idLabel}: derived ground —`, derivedParents);
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'readjustment-derived-ground',
                        message,
                        coveringProposalIds: Array.from(coverers.keys())
                    });
                } catch (_) { }
                return false;
            }
            // Amended records are exempt from the whole-parcel check: a taker clipped their
            // slices, so under-covering the parents is the one-partition model working, and the
            // §14.2 remainders minted below are exactly the ground the taker consumes on replay.
            const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
            const wholeTurf = (typeof turf !== 'undefined') ? turf : null;
            const claim = (proposalData.amendedByTaking !== true
                && planOrderApi && typeof planOrderApi.footprintOf === 'function')
                ? planOrderApi.footprintOf(proposalData) : null;
            if (claim && wholeTurf && typeof wholeTurf.intersect === 'function' && typeof wholeTurf.area === 'function') {
                const claimFeature = claim.type === 'Feature' ? claim : { type: 'Feature', properties: {}, geometry: claim };
                const partials = [];
                parentFeatures.forEach(feature => {
                    try {
                        const parcelFeature = { type: 'Feature', properties: {}, geometry: feature.geometry };
                        const area = wholeTurf.area(parcelFeature) || 0;
                        if (!(area > 0)) return;
                        const hit = wholeTurf.intersect(parcelFeature, claimFeature);
                        const covered = hit ? (wholeTurf.area(hit) || 0) : 0;
                        const uncovered = Math.max(0, area - covered);
                        // Strict (ruling 2026-08-07): the plan must tessellate every input
                        // parcel. Calibration: turf/4326 vs the cadastre's native 3765 measure
                        // the same parcel-aligned claim ~1% apart (Cibona's conforming 2042
                        // read 99% on HR-339270-824), so noise absorbs up to 3% AND 5 m²;
                        // every real offender seen so far sits at ≤95% with tens of m² missing.
                        if (covered < area * 0.97 && uncovered > 5) {
                            partials.push({
                                id: String(_getParcelIdFromFeature(feature)),
                                coveredShare: area > 0 ? covered / area : 0
                            });
                        }
                    } catch (_) { /* an unmeasurable parent cannot pass a whole-parcel gate either way */ }
                });
                if (partials.length) {
                    const partialText = partials
                        .map(partial => `${partial.id} (${Math.round(partial.coveredShare * 100)}%)`)
                        .join(', ');
                    const message = `A land readjustment takes whole cadastral parcels, but its outline covers only part of: ${partialText}. Align the outline to parcel boundaries.`;
                    if (typeof updateStatus === 'function') updateStatus(message);
                    try {
                        this._setLastApplyFailure(idLabel, {
                            code: 'readjustment-partial-parcels',
                            message,
                            partials
                        });
                    } catch (_) { }
                    return false;
                }
            }
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

        // Flat anchors (formation-edit.js; rethink-proposals.md §15a). Every
        // plot records the base cadastral parcels actually under it — a comasation plot spanning
        // thirty parents is one formation with thirty base anchors, never a chain — and the
        // proposal's flat declaration is written where the cut is computed. Edits are new records;
        // an unchanged record therefore derives the same ids from the same ordered geometry.
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

            } catch (error) {
                console.warn('[_applyReparcellizationProposal] flat anchors skipped', error);
            }
        }

        let allocForeignIndex = null;
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
                        // §15b identity flows with the ground: the leftover of ANOTHER
                        // proposal's formed plot stays the VICTIM's child — the largest part
                        // keeps the plot's id (same parcel, smaller), splits continue the
                        // victim's numbering, and the clone keeps the victim's proposalId and
                        // ownership untouched. Only ground under this plan's plots changes hands.
                        const feCarry = (typeof window !== 'undefined') ? window.__formationEdit : null;
                        const carryParts = (feCarry && typeof feCarry.derivedIdParts === 'function')
                            ? feCarry.derivedIdParts(String(parentId || '')) : null;
                        const ownTokenCarry = (typeof _buildSyntheticToken === 'function')
                            ? _buildSyntheticToken(proposalId, 'proposal') : null;
                        if (carryParts && carryParts.token && ownTokenCarry && carryParts.token !== ownTokenCarry
                            && typeof _extractPolygonsWithHolesFromGeometry === 'function'
                            && typeof _ensurePolygonIsClosed === 'function') {
                            if (!allocForeignIndex) allocForeignIndex = _createForeignIndexAllocator();
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
                                const carriedId = partIndex === 0
                                    ? String(parentId)
                                    : `${carryParts.base}#${carryParts.token}-${allocForeignIndex(carryParts.base, carryParts.token)}`;
                                const carriedNumber = partIndex === 0
                                    ? ((parentFeature.properties && parentFeature.properties.BROJ_CESTICE) || null)
                                    : (typeof _composeSyntheticParcelNumber === 'function'
                                        ? _composeSyntheticParcelNumber(
                                            (carried.properties.rootParcelNumber || null),
                                            carryParts.token,
                                            Number(carriedId.slice(carriedId.lastIndexOf('-') + 1)))
                                        : null);
                                carried.properties.__carryIdentity = { parcelId: carriedId, parcelNumber: carriedNumber };
                                _ensureParcelIdOnProperties(carried.properties, carriedId);
                                childFeatures.push(carried);
                            });
                            return;
                        }
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

        // §15b: the record's geometry IS its current claim — the resolved pool, the union of
        // the ground actually consumed. Stored so §14.2 remainder ground is part of the
        // amendable plan: when a later formation takes a remainder, the amend pass clips THIS
        // geometry, footprintOf shrinks with it, and the next re-derivation avoids the taken
        // ground instead of re-minting under the taker.
        try {
            const turfPool = (typeof turf !== 'undefined') ? turf : null;
            if (turfPool && typeof turfPool.union === 'function' && parentFeatures.length) {
                let pool = null;
                parentFeatures.forEach(parentFeature => {
                    if (!parentFeature || !parentFeature.geometry) return;
                    const f = { type: 'Feature', properties: {}, geometry: parentFeature.geometry };
                    try { pool = pool ? turfPool.union(pool, f) : f; } catch (_) { }
                });
                if (pool && pool.geometry) proposalData.geometry = JSON.parse(JSON.stringify(pool.geometry));
            }
        } catch (poolError) {
            console.warn('[_applyReparcellizationProposal] pool claim persistence failed', poolError);
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures);

        this._addFeaturesToMap(childFeatures, true, proposalData);

        const childParcelIds = [];
        const touchedAgentIds = new Set();
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // §15b: a carried piece of a FOREIGN plot is the victim's child, not this
            // readjustment's — see the road apply's twin branch.
            const pieceProposalId = feature.properties && feature.properties.proposalId
                ? String(feature.properties.proposalId) : String(proposalId);
            if (pieceProposalId !== String(proposalId)) {
                this._persistParcelFeature(feature);
                this._addProposalAsAncestor(parcelId, pieceProposalId);
                return;
            }
            feature.properties.ancestorProposal = proposalId;
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

        // The record keeps only ground ACTUALLY consumed: ids whose parcels were LIVE on the
        // map at this moment (the hide below is what consumes them). Feature resolution alone
        // is not the test — the registry keeps dead layers forever, so a conflict the gate just
        // PARKED still resolves a feature; recording its id as a parent made it a standing
        // claim that blocked the parked structure's own re-mint and was resurrected by every
        // later unapply.
        // §15b: an id carried onto a minted piece is the LIVE piece now — hiding it or
        // recording it as a consumed parent would consume the victim's surviving plot. The
        // ground it lost is anchored to the BASE parcel instead, so this readjustment's unapply
        // frees it as a BASE remainder (latest wins — never the plot at stale geometry).
        const mintedIdSet = new Set(childFeatures
            .map(f => { try { return String(_getParcelIdFromFeature(f)); } catch (_) { return null; } })
            .filter(Boolean));
        const feParcelAnchor = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const carriedBaseAnchors = new Set();
        const consumedParentIds = Array.from(new Set(parentFeatures
            .map(f => { const id = _getParcelIdFromFeature(f); return id ? String(id) : null; })
            .filter(Boolean)))
            .filter(id => {
                if (mintedIdSet.has(String(id))) {
                    try {
                        const baseId = (feParcelAnchor && typeof feParcelAnchor.baseIdOf === 'function')
                            ? feParcelAnchor.baseIdOf(String(id)) : null;
                        if (baseId && baseId !== String(id)) carriedBaseAnchors.add(baseId);
                    } catch (_) { }
                    return false;
                }
                try {
                    const layer = window.parcelLayerById.get(String(id));
                    return !!(layer && window.parcelLayer && window.parcelLayer.hasLayer(layer));
                } catch (_) { return true; }
            });
        carriedBaseAnchors.forEach(baseId => {
            if (!consumedParentIds.includes(baseId)) consumedParentIds.push(baseId);
        });
        this._hideFeaturesFromMap(parentFeatures.filter(f => {
            try { return !mintedIdSet.has(String(_getParcelIdFromFeature(f))); } catch (_) { return true; }
        }));
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }
        const flatParentIds = Array.isArray(proposalData.cadastreParcelIds) && proposalData.cadastreParcelIds.length
            ? Array.from(new Set(proposalData.cadastreParcelIds.map(String)))
            : consumedParentIds.map(id => {
                const fe = (typeof window !== 'undefined') ? window.__formationEdit : null;
                return fe && typeof fe.baseIdOf === 'function' ? fe.baseIdOf(String(id)) : String(id);
            });
        plan.parentParcelIds = Array.from(new Set(flatParentIds));
        plan.childParcelIds = childParcelIds;
        proposalData.parentParcelIds = plan.parentParcelIds.slice();
        proposalData.childParcelIds = childParcelIds;
        proposalData.reparcellization = plan;

        persistAppliedProposal(proposalData, proposalId);
        refreshProposalUIAfterApply(`Applied reparcellization proposal ${proposalData.title || idLabel}`);

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

    async _applyDecideLaterProposal(proposalId, proposalData) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyDecideLaterProposal] Starting application for ${idLabel}...`);

        const decideLaterState = proposalData.decideLaterProposal || {};
        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'decide-later formation');
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

        this._persistParcelFeature(childFeature);
        this._addFeaturesToMap([childFeature], true, proposalData);
        this._addProposalAsAncestor(childParcelId, proposalId);
        this._addChildParcels(proposalId, [childParcelId], proposalData);


        // Hide parents from visible layer but keep in parcelLayerById for descendant proposals
        this._hideFeaturesFromMap(parentFeatures);

        proposalData.decideLaterProposal = {
            parentParcelIds: flatParentIds,
            childParcelIds: [String(childParcelId)]
        };
        proposalData.parentParcelIds = flatParentIds;
        proposalData.childParcelIds = [String(childParcelId)];
        persistAppliedProposal(proposalData, proposalId);
        refreshProposalUIAfterApply(`Applied decide later proposal ${proposalData.title || idLabel}`);

        console.debug(`[_applyDecideLaterProposal] ✓ Completed application in ${(performance.now() - startTime).toFixed(2)}ms`);
        return true;
    },
    };
});
