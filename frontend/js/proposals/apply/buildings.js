// _applyBuildingProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyBuildings = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    return {
    async _applyBuildingProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyBuildingProposal] Starting application for ${idLabel}...`);

        if (!proposalData) {
            console.warn(`[_applyBuildingProposal] Invalid proposal data`);
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The proposal record is empty — there is no building data to apply.' }); } catch (_) { }
            return false;
        }

        const step1Time = performance.now();
        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'building');
        if (!liveParents.ok) return false;
        const uniqueParentIds = liveParents.ids;
        const flatParentIds = liveParents.cadastreIds.slice();
        console.debug(`[_applyBuildingProposal] Step 1: Resolved ${uniqueParentIds.length} live parcel(s) from geometry (${(performance.now() - step1Time).toFixed(2)}ms)`);

        const ancestorKey = flatParentIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

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
            try { this._setLastApplyFailure(idLabel, { code: 'missing-building-geometry', message: 'The proposal stores no building footprints (geometry.buildings is empty).' }); } catch (_) { }
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
            try { this._setLastApplyFailure(idLabel, { code: 'building-geometry-unusable', message: `All ${candidateFeatures.length} stored building footprint(s) were dropped while preparing geometry.` }); } catch (_) { }
            return false;
        }
        // The authored building footprints are the scan region. Never reuse a record produced by
        // authoring or a previous browser's fabric.
        buildingProposal.demolishedBuildings = [];
        delete buildingProposal.demolitionScanned;
        try {
            const polygons = preparedFeatures.flatMap(feature => {
                const geometry = feature && feature.geometry;
                if (!geometry) return [];
                if (geometry.type === 'Polygon') return [geometry.coordinates];
                if (geometry.type === 'MultiPolygon') return geometry.coordinates;
                return [];
            });
            const demolitionRegion = polygons.length === 1
                ? { type: 'Polygon', coordinates: polygons[0] }
                : (polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null);
            if (demolitionRegion && typeof this._deriveDemolishedBuildings === 'function') {
                buildingProposal.demolishedBuildings = await this._deriveDemolishedBuildings(demolitionRegion, {
                    ...options,
                    proposalId: idLabel
                });
            }
        } catch (error) {
            console.error('[_applyBuildingProposal] demolition scan failed', idLabel, error);
        }
        console.debug(`[_applyBuildingProposal] Step 4: Prepared ${preparedFeatures.length} building feature(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // §15a building formation: a FREEFORM building (goal 'single', one footprint) forms its
        // own parcel — footprint parcel by default, whole host parcels when
        // buildingProposal.takeWholeParcels is set. Refusals abort before anything renders.
        // Blocks/row/parcel-based buildings stay content on existing parcels (§9 table).
        let workingParentIds = uniqueParentIds;
        {
            const goalKey = (typeof window !== 'undefined' && window.__applyRoute && typeof window.__applyRoute.normalizeGoalKey === 'function')
                ? window.__applyRoute.normalizeGoalKey(proposalData.goal)
                : String(proposalData.goal || '');
            if (goalKey === 'single' && preparedFeatures.length === 1) {
                const formation = await this._formBuildingParcel(
                    proposalId, proposalData, buildingProposal, preparedFeatures[0].geometry,
                    uniqueParentIds, idLabel, liveParents.features);
                if (!formation.ok) return false;
                workingParentIds = formation.parentIds;
                preparedFeatures[0].properties.parentParcelIds = workingParentIds.slice();
            }
        }

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

        buildingProposal.parentParcelIds = flatParentIds.slice();
        buildingProposal.ancestorKey = ancestorKey;
        proposalData.buildingProposal = buildingProposal;
        proposalData.parentParcelIds = flatParentIds.slice();

        if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
            proposalData.geometry = {};
        }
        proposalData.geometry.buildings = preparedFeatures.map(feature => {
            const stored = cloneFeature(feature);
            if (stored && stored.properties) stored.properties.parentParcelIds = flatParentIds.slice();
            return stored;
        }).filter(Boolean);

        persistAppliedProposal(proposalData, proposalId);

        console.debug(`[_applyBuildingProposal] Formed from ${workingParentIds.length} live parcel(s)`);

        refreshProposalUIAfterApply(`Applied building proposal ${proposalData.title || idLabel}`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyBuildingProposal] ✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    // §15a building formation (decision 2026-08-05): a FREEFORM building forms its own parcel —
    // one building, one parcel (the Croatian rule), realised against the live fabric:
    //   default    → FOOTPRINT parcel: mint the building's parcel from its footprint, cut each
    //                host parcel's remainder back to its owner (§14.2 — a formation owes the
    //                owner their remainders); the minimal taking.
    //   whole-take → buildingProposal.takeWholeParcels: adopt/merge the WHOLE host parcels as
    //                the building's parcel (the family-house-with-yard case).
    // Ownership goes to the PROPOSER (ownership-flow's declared destination for freeform).
    // Buildings on existing parcels (blocks/row/parcelBased) stay content and never reach here.
    async _formBuildingParcel(proposalId, proposalData, buildingProposal, footprintGeometry, declaredParentIds, idLabel, resolvedParentFeatures = null) {
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            console.error('[_formBuildingParcel] formation-edit/turf missing — the building cannot form its parcel');
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'building-formation-unavailable',
                    message: 'The formation engine is unavailable in this session; the building cannot form its parcel.'
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
        const footprint = { type: 'Feature', properties: {}, geometry: footprintGeometry };

        const candidateIds = declaredParentIds.slice();
        const candidateFeatures = Array.isArray(resolvedParentFeatures)
            ? resolvedParentFeatures
            : (this._resolveParcelFeaturesByIds(candidateIds,
                { preferMap: true, allowStorage: false, fallbackToMap: false, allowMissing: true }) || []);
        const candidates = candidateFeatures
            .map(feature => ({ id: _getParcelIdFromFeature(feature), feature }))
            .filter(entry => entry.id !== undefined && entry.id !== null);

        const proposerName = proposalData.author || 'Proposer';
        const proposerOwnership = { owners: [{ name: proposerName, ownerLabel: proposerName, percentageShare: 100, actualShareText: '100%' }] };
        const proposerAgentId = (typeof getOrCreateAgentForRecipient === 'function') ? getOrCreateAgentForRecipient(proposerName) : null;

        const finishOwnership = (ownedIds, formationRecord) => {
            if (proposerAgentId && typeof transferParcelOwnership === 'function') {
                formationRecord.ownerAgentId = proposerAgentId;
                ownedIds.forEach(pid => {
                    try { transferParcelOwnership(String(pid), null, proposerAgentId, { skipAgentSync: true }); } catch (_) { }
                });
                if (typeof buildAgentOwnedParcelIndex === 'function' && typeof agentStorage !== 'undefined') {
                    try {
                        agentStorage.beginBatch();
                        const ownerIndex = buildAgentOwnedParcelIndex();
                        agentStorage.updateAgent(proposerAgentId, { ownedParcels: ownerIndex.get(proposerAgentId) || [] });
                    } finally {
                        agentStorage.endBatch();
                    }
                }
            }
        };

        if (buildingProposal.takeWholeParcels === true) {
            const plan = formationEdit.wholeParcelTakePlan(footprint, candidates, takeCtx);
            if (plan.mode === 'refuse') {
                const partialText = plan.partials
                    .map(partial => `${partial.id} (${Math.round(partial.coveredShare * 100)}%)`)
                    .join(', ');
                const message = plan.reason === 'partial-parcels'
                    ? `Taking whole parcels, but the building footprint covers only part of: ${partialText}. Cut the ground first, or place without the whole-parcel option.`
                    : (plan.reason === 'uncovered-ground'
                        ? `Part of the building footprint lies on no live parcel here (${Math.round(plan.uncoveredShare * 100)}% uncovered).`
                        : 'No parcels found under the building footprint.');
                if (typeof updateStatus === 'function') updateStatus(message);
                try { this._setLastApplyFailure(idLabel, { code: 'building-partial-parcels', message, partials: plan.partials }); } catch (_) { }
                return { ok: false };
            }
            const takenIds = plan.parcelIds.map(String);
            const takenFeatures = candidates.filter(entry => takenIds.includes(String(entry.id))).map(entry => entry.feature);
            // A whole-parcel adopt is still a fresh formation stamp. Always mint its parcel and
            // hide the source instead of mutating a cadastral feature in place.
            let unionFeature = null;
            try {
                unionFeature = takenFeatures.reduce((acc, feature) => {
                    const asFeat = { type: 'Feature', properties: {}, geometry: feature.geometry };
                    return acc ? turfRef.union(acc, asFeat) : asFeat;
                }, null);
            } catch (_) { unionFeature = null; }
            if (!unionFeature || !unionFeature.geometry) {
                const message = 'Could not merge the host parcels into one parcel.';
                try { this._setLastApplyFailure(idLabel, { code: 'building-merge-failed', message }); } catch (_) { }
                return { ok: false };
            }
            // Ruling 2026-08-07: no take may DISCONNECT an applied road — refuse before any
            // mutation. Whole taken parcels can reach far past the drawn footprint.
            {
                const severedRoad = (typeof this._appliedRoadSeveredByTaking === 'function')
                ? this._appliedRoadSeveredByTaking(unionFeature.geometry, idLabel) : null;
                if (severedRoad) {
                    const roadName = severedRoad.title || severedRoad.name || severedRoad.proposalId;
                    const message = `Cannot apply the building: its parcel take would cut the applied road "${roadName}" apart. Unapply or edit that road first.`;
                    if (typeof updateStatus === 'function') updateStatus(message);
                    try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
                    try { this._setLastApplyFailure(idLabel, { code: 'building-severs-road', message, roadProposalId: String(severedRoad.proposalId || '') }); } catch (_) { }
                    return { ok: false };
                }
            }
            const primary = takenFeatures[0];
            const childFeature = {
                type: 'Feature',
                geometry: JSON.parse(JSON.stringify(unionFeature.geometry)),
                properties: {
                    proposalId,
                    parentParcelIds: takenIds.slice(),
                    parentParcelId: takenIds[0],
                    rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, takenIds[0]) || takenIds[0],
                    rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, takenIds[0]) || null,
                    baseParcelIds: formationEdit.baseIdsOfFeatures(takenFeatures),
                    calculatedArea: Math.round(_calculateGeoJsonArea(unionFeature.geometry)),
                    isProposed: true,
                    ownershipDetails: JSON.parse(JSON.stringify(proposerOwnership)),
                    ownershipType: 'private'
                }
            };
            const bodyFeatures = [childFeature];
            this._assignSyntheticChildIdentities(proposalId, bodyFeatures);
            const childIds = bodyFeatures
                .map(feature => _getParcelIdFromFeature(feature))
                .filter(id => id !== undefined && id !== null)
                .map(String);
            this._addFeaturesToMap(bodyFeatures, true, proposalData);
            bodyFeatures.forEach(feature => {
                const childId = _getParcelIdFromFeature(feature);
                try { this._persistParcelFeature(feature); } catch (_) { }
                try { if (childId) this._addProposalAsAncestor(childId, proposalId); } catch (_) { }
            });
            this._hideFeaturesFromMap(takenFeatures);
            buildingProposal.childParcelIds = childIds;
            proposalData.childParcelIds = buildingProposal.childParcelIds.slice();
            try { this._addChildParcels(proposalId, buildingProposal.childParcelIds, proposalData); } catch (_) { }
            buildingProposal.formation = { mode: plan.mode, parcelIds: takenIds.slice(), childParcelIds: buildingProposal.childParcelIds.slice() };
            finishOwnership(buildingProposal.childParcelIds, buildingProposal.formation);
            try { this._amendAppliedPlansByTaking(proposalData, unionFeature.geometry); } catch (amendError) {
                console.warn('[_formBuildingParcel] whole-parcel amend pass failed', amendError);
            }
            return { ok: true, parentIds: takenIds.slice() };
        }

        // Default: FOOTPRINT parcel. Hosts are every live parcel the footprint genuinely overlaps;
        // the footprint must stand on live fabric (uncovered ground refuses loudly).
        const footprintArea = takeCtx.area(footprint);
        if (!(footprintArea > 0)) {
            try { this._setLastApplyFailure(idLabel, { code: 'building-footprint-degenerate', message: 'The building footprint has no usable area.' }); } catch (_) { }
            return { ok: false };
        }
        const hosts = [];
        let coveredM2 = 0;
        candidates.forEach(entry => {
            const parcelFeature = { type: 'Feature', properties: {}, geometry: entry.feature.geometry };
            const overlap = takeCtx.intersectionArea(footprint, parcelFeature);
            if (overlap < formationEdit.DEFAULT_TOLERANCE_M2) return;
            coveredM2 += overlap;
            hosts.push(entry);
        });
        if (!hosts.length) {
            const message = 'No parcels found under the building footprint.';
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-no-parcels', message }); } catch (_) { }
            return { ok: false };
        }
        const uncoveredM2 = Math.max(0, footprintArea - coveredM2);
        if (uncoveredM2 > Math.max(formationEdit.DEFAULT_TOLERANCE_M2, footprintArea * formationEdit.DEFAULT_TOLERANCE_PCT / 100)) {
            const message = `Part of the building footprint lies on no live parcel here (${Math.round(uncoveredM2 / footprintArea * 100)}% uncovered).`;
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-uncovered-ground', message }); } catch (_) { }
            return { ok: false };
        }

        const hostIds = hosts.map(entry => String(entry.id));
        const hostFeatures = hosts.map(entry => entry.feature);
        const primary = hostFeatures[0];
        const parentEntries = hosts.map(entry => ({
            baseId: formationEdit.baseIdOf(
                (entry.feature.properties && entry.feature.properties.rootParcelId) || String(entry.id)),
            feature: entry.feature
        }));

        const buildingParcel = {
            type: 'Feature',
            geometry: JSON.parse(JSON.stringify(footprintGeometry)),
            properties: {
                proposalId,
                buildingParcel: true,
                parentParcelIds: hostIds.slice(),
                parentParcelId: hostIds[0],
                rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, hostIds[0]) || hostIds[0],
                rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, hostIds[0]) || null,
                baseParcelIds: formationEdit.overlappingBaseIds(footprint, parentEntries, takeCtx),
                calculatedArea: Math.round(_calculateGeoJsonArea(footprintGeometry)),
                isProposed: true,
                ownershipDetails: JSON.parse(JSON.stringify(proposerOwnership)),
                ownershipType: 'private'
            }
        };

        // Each host's remainder goes back to its owner (§14.2). A remainder of another
        // formation keeps that formation's identity; only cadastral remainders become this
        // building formation's children.
        const ownRemainders = [];
        const foreignRemainders = [];
        const allocateForeignIndex = typeof this._createForeignIndexAllocator === 'function'
            ? this._createForeignIndexAllocator()
            : null;
        // A degenerate ring makes turf's sweep-line throw; retrying on truncated coordinates
        // usually heals it. `threw` distinguishes a real "fully consumed" (null difference)
        // from a failed computation.
        const safeDifference = (aGeometry, bFeature) => {
            const a = { type: 'Feature', properties: {}, geometry: aGeometry };
            try { return { result: turfRef.difference(a, bFeature), threw: false }; } catch (_) { }
            try {
                if (typeof turfRef.truncate === 'function') {
                    const at = turfRef.truncate(JSON.parse(JSON.stringify(a)), { precision: 7, mutate: true });
                    const bt = turfRef.truncate(JSON.parse(JSON.stringify(bFeature)), { precision: 7, mutate: true });
                    return { result: turfRef.difference(at, bt), threw: false };
                }
            } catch (_) { }
            return { result: null, threw: true };
        };
        let cutFailedHostId = null;
        hostFeatures.forEach(hostFeature => {
            if (cutFailedHostId) return;
            const { result: difference, threw } = safeDifference(hostFeature.geometry, footprint);
            if (!difference || !difference.geometry) {
                // "Fully consumed" must be TRUE, not an exception artifact: a sweep-line throw
                // here used to hide the host with no remainder minted — a whole parcel of DEAD
                // ground around the building (unclickable, unhoverable). If the computation
                // failed AND the host is not genuinely inside the footprint, refuse the apply
                // rather than swallow ground that cannot be re-minted.
                if (threw) {
                    const hostArea = takeCtx.area({ type: 'Feature', properties: {}, geometry: hostFeature.geometry });
                    const covered = takeCtx.intersectionArea(
                        { type: 'Feature', properties: {}, geometry: hostFeature.geometry }, footprint);
                    if (!(hostArea > 0) || (hostArea - covered) > Math.max(1, hostArea * 0.01)) {
                        cutFailedHostId = String(_getParcelIdFromFeature(hostFeature) || 'unknown');
                    }
                }
                return; // host fully consumed by the footprint
            }
            const hostId = String(_getParcelIdFromFeature(hostFeature) || '');
            const idParts = typeof formationEdit.derivedIdParts === 'function'
                ? formationEdit.derivedIdParts(hostId)
                : null;
            const isForeign = !!(idParts && idParts.token
                && hostFeature.properties && hostFeature.properties.proposalId
                && String(hostFeature.properties.proposalId) !== String(proposalId));
            const geometries = difference.geometry.type === 'MultiPolygon'
                ? difference.geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
                : [difference.geometry];
            const parts = geometries.map(geometry => ({
                geometry,
                area: _calculateGeoJsonArea(geometry)
            })).filter(part => part.area >= 0.5).sort((a, b) => b.area - a.area);

            parts.forEach((part, index) => {
                const remainder = JSON.parse(JSON.stringify(hostFeature));
                remainder.geometry = part.geometry;
                remainder.properties = remainder.properties || {};
                remainder.properties.calculatedArea = Math.round(part.area);
                if (isForeign && allocateForeignIndex) {
                    remainder.properties.__carryIdentity = {
                        parcelId: index === 0
                            ? hostId
                            : `${idParts.base}#${idParts.token}-${allocateForeignIndex(idParts.base, idParts.token)}`,
                        parcelNumber: index === 0 ? (hostFeature.properties.BROJ_CESTICE || null) : null
                    };
                    foreignRemainders.push(remainder);
                    return;
                }
                remainder.properties.proposalId = proposalId;
                remainder.properties.parentParcelId = hostId || null;
                remainder.properties.parentParcelNumber = hostFeature.properties
                    ? (hostFeature.properties.BROJ_CESTICE || null)
                    : null;
                ownRemainders.push(remainder);
            });
        });

        if (cutFailedHostId) {
            const message = `Cannot apply the building: the remainder of parcel ${cutFailedHostId} could not be computed — applying would leave its ground dead on the map.`;
            if (typeof updateStatus === 'function') updateStatus(message);
            try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
            try { this._setLastApplyFailure(idLabel, { code: 'building-cut-failed', message, parcelId: cutFailedHostId }); } catch (_) { }
            return { ok: false };
        }
        // Ruling 2026-08-07: no take may DISCONNECT an applied road — refuse before any
        // mutation (everything above is pure computation on clones).
        {
            const severedRoad = (typeof this._appliedRoadSeveredByTaking === 'function')
                ? this._appliedRoadSeveredByTaking(footprintGeometry, idLabel) : null;
            if (severedRoad) {
                const roadName = severedRoad.title || severedRoad.name || severedRoad.proposalId;
                const message = `Cannot apply the building: its footprint would cut the applied road "${roadName}" apart. Unapply or edit that road first.`;
                if (typeof updateStatus === 'function') updateStatus(message);
                try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
                try { this._setLastApplyFailure(idLabel, { code: 'building-severs-road', message, roadProposalId: String(severedRoad.proposalId || '') }); } catch (_) { }
                return { ok: false };
            }
        }
        const children = [buildingParcel, ...ownRemainders, ...foreignRemainders];
        this._assignSyntheticChildIdentities(proposalId, children);
        this._addFeaturesToMap(children, true, proposalData);
        const childIds = [];
        const buildingParcelIds = [];
        children.forEach(child => {
            const childId = _getParcelIdFromFeature(child);
            const ownsChild = child.properties
                && String(child.properties.proposalId || proposalId) === String(proposalId);
            if (ownsChild && childId !== undefined && childId !== null) childIds.push(String(childId));
            if (ownsChild && child.properties && child.properties.buildingParcel === true
                && childId !== undefined && childId !== null) buildingParcelIds.push(String(childId));
            try { this._persistParcelFeature(child); } catch (_) { }
            try {
                if (childId) this._addProposalAsAncestor(
                    childId,
                    ownsChild ? proposalId : String(child.properties.proposalId)
                );
            } catch (_) { }
        });
        // A DERIVED host's largest remainder carries the host's own id (§15b: identity flows
        // with the ground), so _addFeaturesToMap above REPLACED that registry entry with the
        // remainder piece. Hiding such a host by feature would hide the remainder we just
        // minted — a whole parcel of dead, unclickable ground. Hide only hosts whose id no
        // child re-uses.
        const reusedHostIds = new Set(children
            .map(child => String(_getParcelIdFromFeature(child) || ''))
            .filter(Boolean));
        this._hideFeaturesFromMap(hostFeatures.filter(hostFeature => {
            const hostId = String(_getParcelIdFromFeature(hostFeature) || '');
            return !(hostId && reusedHostIds.has(hostId));
        }));
        buildingProposal.childParcelIds = childIds.slice();
        proposalData.childParcelIds = childIds.slice();
        try { this._addChildParcels(proposalId, childIds, proposalData); } catch (_) { }

        buildingProposal.formation = {
            mode: 'footprint',
            parcelIds: hostIds.slice(),
            childParcelIds: childIds.slice(),
            buildingParcelIds
        };
        finishOwnership(buildingProposal.formation.buildingParcelIds, buildingProposal.formation);
        try { this._amendAppliedPlansByTaking(proposalData, footprintGeometry); } catch (amendError) {
            console.warn('[_formBuildingParcel] footprint amend pass failed', amendError);
        }

        return { ok: true, parentIds: hostIds.slice() };
    },
    };
});
