// _applyStructureProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyStructures = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function structureNeedsGroundFormation(kind) {
        return kind !== 'station';
    }

    return {
    structureNeedsGroundFormation,
    async _applyStructureProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        // Same gate as the building path: `window.DEBUG_APPLY = true` to trace one apply.
        const traceApply = (typeof window !== 'undefined' && window.DEBUG_APPLY)
            ? (message) => console.debug(`[_applyStructureProposal] ${message}`)
            : () => { };
        traceApply(`Starting application for ${idLabel}...`);
        try {
            const step1Time = performance.now();
            const sp = proposalData.structureProposal || {};
            const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
            const canonicalGeometry = typeof this._getCanonicalStructureGeometry === 'function'
                ? this._getCanonicalStructureGeometry(proposalData, kind)
                : null;
            let geometry = sp.geometry;
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                geometry = canonicalGeometry;
            }
            if (geometry && geometry.type && Array.isArray(geometry.coordinates)) {
                try { sp.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { sp.geometry = geometry; }
            }
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
            // Demolition is derived from the authored body on every apply. A cached scan once
            // turned a transient empty footprint fetch into permanent surviving buildings.
            sp.demolishedBuildings = [];
            delete sp.demolitionScanned;
            try {
                if (geometry
                    && typeof this._deriveDemolishedBuildings === 'function') {
                    sp.demolishedBuildings = await this._deriveDemolishedBuildings(geometry, {
                        ...options,
                        proposalId: idLabel
                    });
                }
            } catch (error) {
                console.error('[_applyStructureProposal] demolition scan failed', idLabel, error);
            }
            traceApply(`Step 1: Initialized structure proposal (${(performance.now() - step1Time).toFixed(2)}ms) - kind: ${kind}`);

            const collection = kind === 'park'
                ? window.parks
                : (kind === 'lake'
                    ? window.lakes
                    : (kind === 'station' ? window.transitStations : window.squares));
            const alreadyInLayer = Array.isArray(collection)
                ? collection.some(feature => feature && feature.properties && feature.properties.proposalId === proposalId)
                : false;
            const alreadyAppliedStatus = appliedOf(proposalData);
            const rebuilding = !!(this && this._rebuildInProgress === true);
            if (alreadyAppliedStatus && alreadyInLayer && !rebuilding) {
                return true;
            }
            const step2Time = performance.now();
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

            // Persist canonical geometry/parents onto the structureProposal for downstream consumers
            if (geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { sp.geometry = geometry; }
            }
            let parentIds = [];
            let flatParentIds = [];
            let liveParentFeatures = [];
            const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, kind);
            if (!liveParents.ok) return false;
            parentIds = liveParents.ids;
            flatParentIds = liveParents.cadastreIds.slice();
            liveParentFeatures = liveParents.features;
            traceApply(`Step 2: Resolved ${parentIds.length} parent parcel reference(s) (${(performance.now() - step2Time).toFixed(2)}ms)`);

            // §15a structure formation (decision 2026-08-05): a park/square/lake TAKES its
            // ground — adopt the one parcel matching the footprint, or merge whole parcels into
            // one minted parcel — with ownership → City at apply. Partial coverage of any parcel
            // refuses with the offenders named. A station stays content on its corridor and
            // forms nothing.
            if (structureNeedsGroundFormation(kind, sp)) {
                const formation = await this._formStructureParcel(
                    proposalId, proposalData, sp, geometry, parentIds, idLabel, liveParentFeatures);
                if (!formation.ok) return false;
                parentIds = formation.parentIds;
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
                    stationGraphics: kind === 'station' ? geometry : null,
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
                if (kind === 'station' && !proposalData.geometry.stationGraphics) {
                    proposalData.geometry.stationGraphics = geometry;
                }
            }

            const feature = {
                type: 'Feature',
                properties: {
                    structureType: kind,
                    blockName: blockName,
                    proposalId,
                    lakeGraphics: sp.lakeGraphics || null,
                    decorations: sp.decorations ? JSON.parse(JSON.stringify(sp.decorations)) : undefined,
                    stationType: sp.stationType || undefined,
                    center: Array.isArray(sp.center) ? sp.center.slice() : undefined,
                    bearing: Number.isFinite(Number(sp.bearing)) ? Number(sp.bearing) : undefined,
                    platformHeightM: Number.isFinite(Number(sp.platformHeightM)) ? Number(sp.platformHeightM) : undefined,
                    attachment: sp.attachment ? JSON.parse(JSON.stringify(sp.attachment)) : undefined,
                    modelVersion: sp.modelVersion || undefined,
                    name: proposalData.title || proposalData.name || undefined,
                    parentParcelIds: parentIds.slice()
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
                try {
                    if (typeof ensureParkDecorations === 'function') {
                        ensureParkDecorations(feature);
                    }
                } catch (_) { }
                // Auto-layout is generated on the rendered feature. Keep the same canonical copy
                // on the proposal so every generated item is present when Design is reopened.
                if (feature.properties?.decorations) {
                    sp.decorations = JSON.parse(JSON.stringify(feature.properties.decorations));
                }
                window.parks.push(feature);
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
                try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
            } else if (kind === 'station') {
                if (!Array.isArray(window.transitStations)) window.transitStations = [];
                window.transitStations = window.transitStations.filter(f => {
                    if (!f || !f.properties) return true;
                    return String(f.properties.proposalId || '') !== String(proposalId);
                });
                window.transitStations.push(feature);
                try { PersistentStorage.setItem('cb_transit_stations', JSON.stringify(window.transitStations)); } catch (_) { }
            } else {
                if (!Array.isArray(window.squares)) window.squares = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.squares = window.squares.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try {
                    if (typeof ensureSquareDecorations === 'function') {
                        ensureSquareDecorations(feature);
                    }
                } catch (_) { }
                if (feature.properties?.decorations) {
                    sp.decorations = JSON.parse(JSON.stringify(feature.properties.decorations));
                }
                window.squares.push(feature);
                try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
            }
            traceApply(`Step 4: Prepared ${kind} layer data and storage (${(performance.now() - step4Time).toFixed(2)}ms)`);

            const step5Time = performance.now();
            // Link the exact live pieces consumed in this derivation for local selection only.
            const uniqueParentIds = Array.from(new Set((parentIds || []).filter(Boolean)));

            traceApply(`Step 5: Formed from ${uniqueParentIds.length} live parcel(s) (${(performance.now() - step5Time).toFixed(2)}ms)`);

            // The structure is now on the map. persistAppliedProposal moves only the root-local
            // application axis; the lifecycle (Active/Executed) is left as-is. Persist the model
            // BEFORE refreshing its views: both 2D and 3D building filters read the canonical
            // application flag when the structure-layer update event fires.
            sp.parentParcelIds = flatParentIds.slice();
            proposalData.parentParcelIds = flatParentIds.slice();
            proposalData.structureProposal = sp;
            persistAppliedProposal(proposalData, proposalId);
            try { refreshStructureLayer(); } catch (error) {
                console.error(`[_applyStructureProposal] Failed to refresh ${kind} presentation`, error);
            }
            // The status line is written once, for every type, by _runProposalApplyWithSummary.
            refreshProposalUIAfterApply();

            const totalTime = performance.now() - startTime;
            traceApply(`✓ Structure proposal application completed in ${totalTime.toFixed(2)}ms`);
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-apply-threw',
                    message: `Applying the structure threw: ${e && e.message ? e.message : e}`
                });
            } catch (_) { }
            return false;
        }
    },

    // §15a structure formation (decision 2026-08-05). A park/square/lake takes WHOLE parcels
    // only: adopt the one parcel matching its footprint (formation is adoptive, §15.1 — ownership
    // moves, nothing is cut or minted), or merge-take a union of whole parcels into ONE minted
    // parcel anchored flat to every base underneath. Partial coverage of any parcel REFUSES with
    // the offenders named — if only part of a parcel is wanted, a road or a land readjustment
    // cuts it first. Ownership goes to the City agent at apply, the reparcellization pattern.
    async _formStructureParcel(proposalId, proposalData, sp, geometry, declaredParentIds, idLabel, resolvedParentFeatures = null) {
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            console.error('[_formStructureParcel] formation-edit/turf missing — the structure cannot take its parcel');
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-formation-unavailable',
                    message: 'The formation engine is unavailable in this session; the structure cannot take its parcel.'
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
        const footprint = { type: 'Feature', properties: {}, geometry };

        const candidateIds = declaredParentIds.slice();
        const candidateFeatures = Array.isArray(resolvedParentFeatures)
            ? resolvedParentFeatures
            : (this._resolveParcelFeaturesByIds(candidateIds,
                { preferMap: true, allowStorage: false, fallbackToMap: false, allowMissing: true }) || []);
        const candidates = candidateFeatures
            .map(feature => ({ id: _getParcelIdFromFeature(feature), feature }))
            .filter(entry => entry.id !== undefined && entry.id !== null);

        let plan = formationEdit.wholeParcelTakePlan(footprint, candidates, takeCtx);
        // §15c REBUILD: this structure's claim already stands (latest wins) — the replay just
        // re-derived the fabric beneath it (a road edit reshapes the remainders), so its
        // authored footprint may no longer align to whole parcels. "Whole parcels" is the
        // AUTHORING gate; a rebuild CUTS the partials at the body's edge instead: the inside
        // is consumed with the take, and each outside piece is re-minted so identity flows
        // with the ground — a derived parent's pieces stay ITS proposal's children (the same
        // carry the road cut uses), a base parent's leftovers become this structure's §14.2
        // remainders (the formation owes the owner their remainders).
        const rebuildingTake = !!(this && this._rebuildInProgress === true);
        let partialCuts = null;
        if (rebuildingTake && plan.mode === 'refuse' && plan.reason === 'partial-parcels'
            && typeof turfRef.difference === 'function') {
            const footprintArea = takeCtx.area(footprint);
            const uncoveredM2 = Math.max(0, Number(plan.uncoveredShare) || 0) * footprintArea;
            const uncoveredTolerance = Math.max(
                Number(formationEdit.DEFAULT_TOLERANCE_M2) || 1,
                footprintArea * (Number(formationEdit.DEFAULT_TOLERANCE_PCT) || 1) / 100
            );
            const takenIdSet = new Set(plan.parcelIds.map(String));
            partialCuts = [];
            let cutsOk = uncoveredM2 <= uncoveredTolerance;
            plan.partials.forEach(partial => {
                const entry = candidates.find(c => String(c.id) === String(partial.id));
                if (!entry || !entry.feature || !entry.feature.geometry) { cutsOk = false; return; }
                // A PARTIAL parcel by definition has ground outside the body, so a null
                // difference here is a failed computation, never "fully consumed" — swallowing
                // it used to take the parcel whole with no outside piece minted (dead ground).
                // A retry on coordinates truncated to 7 decimals (~1.1 cm) used to sit here; it is
                // gone, because quantizing coordinates is what manufactures the degenerate rings
                // it was meant to survive, and a cut computed at centimetre precision is a silently
                // wrong answer. A failure here fails loudly via the authoring refusal below.
                let outside = null;
                try {
                    outside = turfRef.difference(
                        { type: 'Feature', properties: {}, geometry: entry.feature.geometry }, footprint);
                } catch (error) {
                    console.error('[_formStructureParcel] partial-cut difference failed for', String(partial.id), error);
                    outside = null;
                }
                if (!outside || !outside.geometry) { cutsOk = false; return; }
                const parts = [];
                if (outside && outside.geometry) {
                    const polys = outside.geometry.type === 'MultiPolygon'
                        ? outside.geometry.coordinates.map(coords => ({ type: 'Polygon', coordinates: coords }))
                        : [outside.geometry];
                    polys.forEach(geometry => {
                        let area = 0;
                        try { area = turfRef.area({ type: 'Feature', properties: {}, geometry }) || 0; } catch (_) { }
                        if (area >= 0.5) parts.push({ geometry, area });
                    });
                }
                parts.sort((x, y) => y.area - x.area);
                partialCuts.push({ entry, parts });
                takenIdSet.add(String(partial.id));
            });
            if (cutsOk) {
                plan = { mode: 'merge', reason: null, parcelIds: Array.from(takenIdSet), partials: [], uncoveredShare: plan.uncoveredShare };
                console.info('[§15c] rebuild take cut', partialCuts.length, 'partial parcel(s) at the', sp.kind, 'edge');
            } else {
                partialCuts = null;
            }
        }
        if (plan.mode === 'refuse') {
            const partialText = plan.partials
                .map(partial => `${partial.id} (${Math.round(partial.coveredShare * 100)}%)`)
                .join(', ');
            const message = plan.reason === 'partial-parcels'
                ? `A ${sp.kind} must take whole parcels, but this footprint covers only part of: ${partialText}. Cut the ground first with a road or a land readjustment.`
                : (plan.reason === 'uncovered-ground'
                    ? `Part of the ${sp.kind} footprint lies on no live parcel here (${Math.round(plan.uncoveredShare * 100)}% uncovered).`
                    : `No parcels found under the ${sp.kind} footprint.`);
            if (typeof updateStatus === 'function') updateStatus(message);
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'structure-partial-parcels',
                    message,
                    partials: plan.partials
                });
            } catch (_) { }
            return { ok: false };
        }

        const takenIds = plan.parcelIds.map(String);
        const takenFeatures = candidates
            .filter(entry => takenIds.includes(String(entry.id)))
            .map(entry => entry.feature);
        // Ruling 2026-08-07: no take may DISCONNECT an applied road — no structure-editing
        // gesture legitimately severs one, so a footprint that would is an authoring error and
        // the apply refuses BEFORE any mutation. Tested against the actual taken ground (whole
        // parcels can reach far past the drawn body); an end-take that leaves the road one
        // connected piece is a legal trim, amended by the pass below.
        try {
            const severTestPolys = takenFeatures
                .map(feature => feature && feature.geometry)
                .filter(g => g && /Polygon/.test(String(g.type || '')));
            const severTestGround = rebuildingTake ? geometry
                : (severTestPolys.length === 0 ? geometry
                    : (severTestPolys.length === 1 ? severTestPolys[0] : {
                        type: 'MultiPolygon',
                        coordinates: severTestPolys.flatMap(g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
                    }));
            const roadHit = (typeof this._appliedRoadOverlappedByTaking === 'function')
                ? this._appliedRoadOverlappedByTaking(severTestGround, idLabel) : null;
            if (roadHit) {
                const road = roadHit.proposal;
                const roadName = road.title || road.name || road.proposalId;
                const message = `Cannot apply the ${sp.kind}: it would stand on ${Math.round(roadHit.overlapM2)} m² of the applied road "${roadName}". Nothing is built over a street — move it clear, or unapply that road first.`;
                if (typeof updateStatus === 'function') updateStatus(message);
                try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'structure-over-road',
                        message,
                        roadProposalId: String(road.proposalId || ''),
                        overlapM2: roadHit.overlapM2
                    });
                } catch (_) { }
                return { ok: false };
            }
        } catch (severError) {
            console.warn('[_formStructureParcel] road-overlap pre-check failed', severError);
        }
        const cityAgentId = (typeof getOrCreateCityAgent === 'function') ? getOrCreateCityAgent() : null;
        const cityOwnership = { owners: [{ name: 'City', ownerLabel: 'City', percentageShare: 100, actualShareText: '100%' }] };

        // An adopt is still a stamp: mint the structure parcel and hide the matching live parcel.
        // Mutating the cadastral feature in place made the square a visual overlay with the old
        // parcel still underneath and required ownership snapshots on unapply.
        const primary = takenFeatures[0];
            const childFeature = {
                type: 'Feature',
                geometry: JSON.parse(JSON.stringify(geometry)),
                properties: {
                    proposalId,
                    structureType: sp.kind,
                    parentParcelIds: takenIds.slice(),
                    parentParcelId: takenIds[0],
                    rootParcelId: _resolveRootParcelIdFromProperties(primary ? primary.properties : null, takenIds[0]) || takenIds[0],
                    rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null, takenIds[0]) || null,
                    baseParcelIds: formationEdit.baseIdsOfFeatures(takenFeatures),
                    calculatedArea: Math.round(_calculateGeoJsonArea(geometry)),
                    isProposed: true,
                    ownershipDetails: JSON.parse(JSON.stringify(cityOwnership)),
                    ownershipType: 'city'
                }
            };
            // Keep the ARRAY passed to identity assignment: a multipart body is exploded there
            // into one parcel per connected piece. Passing a throwaway `[childFeature]` and then
            // adding the original object lost those assigned identities entirely.
            const bodyFeatures = [childFeature];
            this._assignSyntheticChildIdentities(proposalId, bodyFeatures);
            const bodyParcelIds = bodyFeatures
                .map(feature => _getParcelIdFromFeature(feature))
                .filter(id => id !== undefined && id !== null)
                .map(String);
            await this._addFeaturesToMap(bodyFeatures, true, proposalData);
            bodyFeatures.forEach(feature => {
                const bodyId = _getParcelIdFromFeature(feature);
                try { this._persistParcelFeature(feature); } catch (_) { }
                try { if (bodyId) this._addProposalAsAncestor(bodyId, proposalId); } catch (_) { }
            });
            this._hideFeaturesFromMap(takenFeatures);
            // §15c rebuild partial cuts: mint each outside piece. Derived parents keep their
            // identity (largest piece carries the parcel's own id; splits continue the OWNER's
            // numbering); base parents' leftovers mint as this structure's remainder children.
            const structureRemainderIds = [];
            if (partialCuts && partialCuts.length) {
                const feCarry = (typeof window !== 'undefined') ? window.__formationEdit : null;
                const allocForeign = (typeof _createForeignIndexAllocator === 'function') ? _createForeignIndexAllocator() : null;
                const structureRemainders = [];
                const foreignPieces = [];
                partialCuts.forEach(({ entry, parts }) => {
                    const parentId = String(entry.id);
                    const parentProps = entry.feature.properties || {};
                    const idParts = feCarry && typeof feCarry.derivedIdParts === 'function' ? feCarry.derivedIdParts(parentId) : null;
                    parts.forEach((part, partIndex) => {
                        const clone = JSON.parse(JSON.stringify(entry.feature));
                        clone.geometry = part.geometry;
                        clone.properties = clone.properties || {};
                        clone.properties.calculatedArea = Math.round(part.area);
                        if (idParts && idParts.token && allocForeign) {
                            const carriedId = partIndex === 0
                                ? parentId
                                : `${idParts.base}#${idParts.token}-${allocForeign(idParts.base, idParts.token)}`;
                            clone.properties.parcelId = carriedId;
                            clone.properties.id = carriedId;
                            _ensureParcelIdOnProperties(clone.properties, carriedId);
                            foreignPieces.push({ feature: clone, proposalId: String(parentProps.proposalId || '') });
                        } else {
                            // Base parent: the leftover is a §14.2 remainder of this structure.
                            clone.properties.proposalId = proposalId;
                            clone.properties.parentParcelId = parentId;
                            clone.properties.isProposed = true;
                            delete clone.properties.color;
                            structureRemainders.push(clone);
                        }
                    });
                });
                if (structureRemainders.length) {
                    // Body and base remainders share this formation's token. Continue each root's
                    // allocator after body ids; restarting at 1 here let a remainder overwrite the
                    // square body under the same `…#proposal-1` id.
                    const startIndexByRootId = {};
                    bodyParcelIds.forEach(id => {
                        const parts = feCarry && typeof feCarry.derivedIdParts === 'function'
                            ? feCarry.derivedIdParts(id) : null;
                        if (!parts || !parts.base || !Number.isFinite(parts.index)) return;
                        startIndexByRootId[parts.base] = Math.max(
                            Number(startIndexByRootId[parts.base]) || 1,
                            parts.index + 1
                        );
                    });
                    this._assignSyntheticChildIdentities(proposalId, structureRemainders, { startIndexByRootId });
                }
                const minted = [...foreignPieces.map(fp => fp.feature), ...structureRemainders];
                if (minted.length) {
                    await this._addFeaturesToMap(minted, true, proposalData);
                    minted.forEach(feature => { try { this._persistParcelFeature(feature); } catch (_) { } });
                }
                foreignPieces.forEach(({ feature, proposalId: ownerProposalId }) => {
                    const pid = _getParcelIdFromFeature(feature);
                    try { if (pid && ownerProposalId) this._addProposalAsAncestor(pid, ownerProposalId); } catch (_) { }
                });
                structureRemainders.forEach(feature => {
                    const pid = _getParcelIdFromFeature(feature);
                    try {
                        if (pid) {
                            structureRemainderIds.push(String(pid));
                            this._addProposalAsAncestor(pid, proposalId);
                        }
                    } catch (_) { }
                });
            }
            sp.childParcelIds = Array.from(new Set([...bodyParcelIds, ...structureRemainderIds]));
            proposalData.childParcelIds = sp.childParcelIds.slice();
            try { this._addChildParcels(proposalId, sp.childParcelIds, proposalData); } catch (_) { }
            sp.formation = {
                mode: plan.mode,
                parcelIds: takenIds.slice(),
                childParcelIds: sp.childParcelIds.slice(),
                bodyParcelIds,
                remainderParcelIds: structureRemainderIds.slice()
            };
            // §15b: the structure CONSUMED its source parcel(s), so amend every earlier applied
            // plan that still claims this ground. The taking is the WHOLE PARCELS taken, not the drawn footprint — a structure grabs
            // entire pieces its footprint merely touches (a 1 m² graze took a whole remainder,
            // and clipping only the graze left the victim's pool still claiming the rest).
            try {
                const takenPolys = takenFeatures
                    .map(feature => feature && feature.geometry)
                    .filter(g => g && /Polygon/.test(String(g.type || '')));
                // Initial authoring merge-takes whole parcels. A REBUILD of a standing body is
                // different by rule 12: partial parents are cut at the BODY EDGE, so its taking
                // and amendment geometry is exactly the authored body. Passing the whole partial
                // parent here destroyed the legitimate outside sliver we had just re-minted.
                const takenGround = rebuildingTake ? geometry
                    : (takenPolys.length === 0 ? geometry
                        : (takenPolys.length === 1 ? takenPolys[0] : {
                            type: 'MultiPolygon',
                            coordinates: takenPolys.flatMap(g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
                        }));
            } catch (amendError) {
                console.warn('[_formStructureParcel] §15b amend pass failed', amendError);
            }
            // Corridor ground among what this structure took means the no-build-over-a-street
            // guard did not fire — nothing may stand on a road, so this is a bug, not a note.
            try {
                takenFeatures.forEach(feature => {
                    if (feature && feature.properties && feature.properties.isCorridor === true) {
                        console.error('[road] structure consumed corridor ground —',
                            String(_getParcelIdFromFeature(feature)),
                            '— nothing may be built over a street; the pre-check was bypassed');
                    }
                });
            } catch (_) { }
        if (cityAgentId && typeof transferParcelOwnership === 'function') {
            sp.formation.ownerAgentId = cityAgentId;
            const ownedNow = Array.isArray(sp.formation.bodyParcelIds)
                ? sp.formation.bodyParcelIds
                : sp.formation.childParcelIds;
            ownedNow.forEach(pid => {
                try { transferParcelOwnership(String(pid), null, cityAgentId, { skipAgentSync: true }); } catch (_) { }
            });
            if (typeof buildAgentOwnedParcelIndex === 'function' && typeof agentStorage !== 'undefined') {
                try {
                    agentStorage.beginBatch();
                    const ownerIndex = buildAgentOwnedParcelIndex();
                    agentStorage.updateAgent(cityAgentId, { ownedParcels: ownerIndex.get(cityAgentId) || [] });
                } finally {
                    agentStorage.endBatch();
                }
            }
        }

        return { ok: true, parentIds: takenIds.slice() };
    },
    };
});
