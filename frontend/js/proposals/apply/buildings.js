// _applyBuildingProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyBuildings = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('../parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    // The demolition ground rule lives with the replay prefetch, which must compute the same region.
    function demolitionGroundApi() {
        if (typeof window !== 'undefined' && window.__demolitionPrefetch) return window.__demolitionPrefetch;
        return typeof require === 'function' ? require('../demolition-prefetch.js') : null;
    }

    function openGroundApi() {
        if (typeof window !== 'undefined' && window.__openGround) return window.__openGround;
        return typeof require === 'function' ? require('../open-ground.js') : null;
    }

    // What counts as ground and whether a shape reaches into a parcel (geometry-tolerances.js).
    function groundApi() {
        return (typeof window !== 'undefined' && window.GeometryTolerances)
            || (typeof require === 'function' ? require('../../geometry-tolerances.js') : null);
    }

    function shouldFormOwnBuildingParcel(_proposalData, goalKey, featureCount) {
        return goalKey === 'single' && featureCount === 1;
    }

    return {
    shouldFormOwnBuildingParcel,
    async _applyBuildingProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        // Step-by-step tracing, off by default. Six lines per proposal is a fine way to watch ONE
        // apply and a terrible way to read a replay of three hundred — the useful line is the
        // single summary _runProposalApplyWithSummary already prints. `window.DEBUG_APPLY = true`
        // in the console brings the steps back for the next apply.
        const traceApply = (typeof window !== 'undefined' && window.DEBUG_APPLY)
            ? (message) => console.debug(`[_applyBuildingProposal] ${message}`)
            : () => { };
        traceApply(`Starting application for ${idLabel}...`);

        if (!proposalData) {
            console.warn(`[_applyBuildingProposal] Invalid proposal data`);
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The proposal record is empty — there is no building data to apply.' }); } catch (_) { }
            return false;
        }

        const step1Time = performance.now();
        // The record's OWN sub-object, never a copy: Step 4 writes the demolition scan onto it and
        // persistAppliedProposal stores proposalData itself, so a copy silently dropped every
        // building demolition (2026-10-22) and the Surviving views had nothing to hide. Structures
        // write to proposalData.structureProposal the same way.
        if (!proposalData.buildingProposal || typeof proposalData.buildingProposal !== 'object') proposalData.buildingProposal = {};
        const buildingProposal = proposalData.buildingProposal;
        if (buildingProposal.takeWholeParcels === true && !proposalData.geometry?.landTake) {
            this._setLastApplyFailure?.(idLabel, { code: 'building-land-take-review-required',
                message: 'This design uses the retired whole-parcel setting. Open Freeform and review its land take before applying it.' });
            return false;
        }
        // Every building proves its live host ground, including any overlap inherited from
        // distinct cadastral source outlines.
        const liveParents = this._resolveLiveFormationParents(proposalData, idLabel, 'building', options);
        if (!liveParents.ok) return false;
        const uniqueParentIds = liveParents.ids;
        const flatParentIds = liveParents.cadastreIds.slice();
        traceApply(`Step 1: Resolved ${uniqueParentIds.length} live parcel(s) from geometry (${(performance.now() - step1Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        const cloneFeature = (raw) => {
            if (!raw || typeof raw !== 'object') return null;
            try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
        };

        // Legacy buildingFeatures ignored; do not mutate

        const savedFeatures = Array.isArray(proposalData?.geometry?.buildings)
            ? proposalData.geometry.buildings
                .map(raw => {
                    const cloned = cloneFeature(raw);
                    return cloned && cloned.geometry ? cloned : null;
                })
                .filter(Boolean)
            : [];
        // A Block or Row drawn on parcels that are no longer under it (a parcel layout came off the
        // map and it was left standing) is cut again by the live parcels it stands on now.
        const variation = typeof window !== 'undefined' ? window.UrbanRuleVariation : null;
        const candidateFeatures = variation && savedFeatures.length && proposalData.geometry?.ruleMassing
            ? variation.piecesOnGround(savedFeatures, cloneFeature(proposalData.geometry.ruleMassing),
                liveParents.features.map((feature, index) => ({ feature, parcelId: liveParents.ids[index] })),
                { turf: typeof turf !== 'undefined' ? turf : null })
            : savedFeatures;

        if (!candidateFeatures.length) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalId });
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'missing-building-geometry', message: 'The proposal stores no building footprints (geometry.buildings is empty).' }); } catch (_) { }
            return false;
        }

        const proposalState = lifecycleOf(proposalData) === 'Executed' ? 'executed' : 'applied';

        const preparedFeatures = candidateFeatures
            .map((raw, index) => {
                if (!raw || !raw.geometry) return null;
                const cloned = cloneFeature(raw);
                if (!cloned || !cloned.geometry) return null;
                const properties = {
                    ...(cloned.properties || {}),
                    proposalId,
                    proposalState,
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
        // The land this proposal takes (demolition-prefetch.js buildingDemolitionGeometry): the live
        // parcels it stands on plus its authored footprints, or the footprints alone for a building
        // that forms its own parcel or a rule that models the existing buildings. The existing
        // buildings it clears are derived from that land (demolition-index.js); applied proposed
        // buildings under it are parked here, inside this mutation.
        {
            const ground = demolitionGroundApi();
            if (!ground || typeof ground.buildingDemolitionGeometry !== 'function') throw new Error('demolition-prefetch.js (demolition ground) is not loaded');
            const goalHelpers = (typeof window !== 'undefined' && window.__applyRoute && typeof window.__applyRoute.normalizeGoalKey === 'function')
                ? { normalizeGoalKey: window.__applyRoute.normalizeGoalKey } : {};
            const demolitionRegion = ground.buildingDemolitionGeometry(proposalData, liveParents.features, goalHelpers);
            (typeof window !== 'undefined' ? window : globalThis).DemolitionIndex?.registerRegion(idLabel, demolitionRegion);
            if (demolitionRegion) await this._parkProposedBuildingsUnder(demolitionRegion, { ...options, proposalId: idLabel });
        }
        traceApply(`Step 4: Prepared ${preparedFeatures.length} building feature(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // §15a building formation: a FREEFORM building (goal 'single', one footprint) forms its
        // own parcel from its exact authored land take (the footprint by default).
        // Refusals abort before anything renders.
        // Blocks/row/parcel-based buildings stay content on existing parcels (§9 table).
        let workingParentIds = uniqueParentIds;
        {
            const goalKey = (typeof window !== 'undefined' && window.__applyRoute && typeof window.__applyRoute.normalizeGoalKey === 'function')
                ? window.__applyRoute.normalizeGoalKey(proposalData.goal)
                : String(proposalData.goal || '');
            if (shouldFormOwnBuildingParcel(proposalData, goalKey, preparedFeatures.length)) {
                const formation = await this._formBuildingParcel(
                    proposalId, proposalData, buildingProposal, preparedFeatures[0].geometry,
                    uniqueParentIds, idLabel, liveParents.features, options);
                if (!formation.ok) return false;
                workingParentIds = formation.parentIds;
            }
        }

        const proposedCollection = options?._parcelMutation?.collections?.proposedBuildings;
        if (!Array.isArray(proposedCollection)) {
            throw new Error('Building application requires a proposal-collection mutation draft.');
        }
        preparedFeatures.forEach(feature => {
            const existingIndex = proposedCollection.findIndex(b => b?.properties
                && String(b.properties.proposalId || '') === String(proposalId)
                && b.properties.buildingIndex === feature.properties.buildingIndex);
            if (existingIndex > -1) proposedCollection[existingIndex] = feature;
            else proposedCollection.push(feature);
        });

        // THIS proposal's buildings, not every proposal's. The full rebuild is for removals and
        // boot; an apply has one proposal to draw and should cost one proposal.
        if (options.deferPresentation !== true) options._parcelMutation.afterCommit(() => {
            if (typeof drawProposedBuildingsForProposal === 'function') {
                drawProposedBuildingsForProposal(proposalId);
            } else if (typeof updateProposedBuildingsLayer === 'function') {
                updateProposedBuildingsLayer();
            }
            const showBuildingsCheckbox = typeof document !== 'undefined'
                ? document.getElementById('showProposedBuildings')
                : null;
            if (showBuildingsCheckbox && !showBuildingsCheckbox.checked) showBuildingsCheckbox.checked = true;
        });

        // `preparedFeatures` belong to the live rendering registry.  The authored record remains
        // untouched: its GeoJSON does not acquire proposal ids, live parcel ids, or replay state.
        persistAppliedProposal(proposalData, proposalId, options);

        traceApply(`Formed from ${workingParentIds.length} live parcel(s)`);

        // The status line is written once, for every type, by _runProposalApplyWithSummary.
        if (options.deferPresentation !== true) refreshProposalUIAfterApply(null, options);

        const totalTime = performance.now() - startTime;
        traceApply(`✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    // A Freeform building forms one parcel from its exact reviewed land take. The
    // material footprint stays independent; every untaken remainder keeps its owner.
    async _formBuildingParcel(proposalId, proposalData, buildingProposal, footprintGeometry, declaredParentIds, idLabel, resolvedParentFeatures = null, options = {}) {
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
        const arrangement = clipFailureApi();
        const clip = (operation, left, right, context) => arrangement.clip(operation, left, right,
            { proposalId: idLabel, ...context });
        const takeCtx = {
            turf: turfRef,
            area: f => { try { return turfRef.area(f) || 0; } catch (_) { return 0; } }
        };
        // The exact reviewed take is authored land, never the union of today's whole hosts.
        // Replay may partition that land again, but cannot silently expand it.
        const takeGeometry = proposalData.geometry?.landTake?.geometry || proposalData.geometry?.landTake || footprintGeometry;
        const takeFeature = arrangement.onClipGrid({ type: 'Feature', properties: {}, geometry: takeGeometry });
        const material = { type: 'Feature', properties: {}, geometry: footprintGeometry };
        // Every "is this ground / does it reach this parcel" below is the shared rule, widened only
        // by the design's own toleranceM, as binding widened it.
        const ground = groundApi();
        const toleranceM = ground.designToleranceM(proposalData);
        const outside = proposalData.geometry?.landTake
            ? clip('difference', material, takeFeature, { site: 'apply-buildings.materialOutsideTake' }) : null;
        if (ground.isGround(turfRef, outside, toleranceM)) {
            this._setLastApplyFailure(idLabel, { code: 'building-outside-land-take', message: 'The building extends outside its reviewed land take.' });
            return { ok: false };
        }
        const footprint = takeFeature;
        const reaches = (parcelFeature, parcelId) => ground.reachesInto(turfRef, footprint, parcelFeature, toleranceM,
            { site: 'apply-buildings.host', proposalId: idLabel, parcelId });

        const candidateIds = declaredParentIds.slice();
        const candidateFeatures = Array.isArray(resolvedParentFeatures)
            ? resolvedParentFeatures
            : (this._resolveParcelFeaturesByIds(candidateIds, {
                allowMissing: true,
                _parcelMutation: options._parcelMutation
            }) || []);
        const openGround = openGroundApi();
        const allCandidates = candidateFeatures
            .map(feature => ({ id: _getParcelIdFromFeature(feature), feature }))
            .filter(entry => entry.id !== undefined && entry.id !== null);
        const hostEntries = allCandidates.filter(entry => openGround && openGround.isOpenGroundHost(entry.feature));
        const candidates = allCandidates.filter(entry => !hostEntries.includes(entry));
        const asPlain = geometry => ({ type: 'Feature', properties: {}, geometry });
        const takenHosts = hostEntries.filter(entry => reaches(asPlain(entry.feature.geometry), entry.id));
        // Ground provenance of what the building parcel takes: the open-ground host and any formed
        // pieces on open ground among its parents.
        const groundIdsWith = features => Array.from(new Set([
            ...takenHosts.flatMap(entry => openGround.groundIdsOf(entry.feature)),
            ...features.flatMap(feature => openGround.groundIdsOf(feature))
        ]));

        const proposerName = proposalData.author || 'Proposer';
        const proposerOwnership = { owners: [{ name: proposerName, ownerLabel: proposerName, percentageShare: 100, actualShareText: '100%' }] };
        const ownershipContext = {
            storage: options?._parcelMutation?.storage,
            agentStore: options?._parcelMutation?.agents
        };
        const proposerAgentId = (typeof getOrCreateAgentForRecipient === 'function')
            ? getOrCreateAgentForRecipient(proposerName, ownershipContext)
            : null;

        const finishOwnership = (ownedIds) => {
            if (proposerAgentId && typeof transferParcelOwnership === 'function') {
                ownedIds.forEach(pid => {
                    transferParcelOwnership(String(pid), null, proposerAgentId, {
                        ...ownershipContext,
                        skipAgentSync: true
                    });
                });
                if (typeof buildAgentOwnedParcelIndex === 'function' && ownershipContext.agentStore) {
                    const ownerIndex = buildAgentOwnedParcelIndex({ storage: ownershipContext.storage });
                    ownershipContext.agentStore.updateAgent(proposerAgentId, {
                        ownedParcels: ownerIndex.get(proposerAgentId) || []
                    });
                }
            }
        };

        // Hosts are every live parcel the reviewed take genuinely overlaps;
        // the footprint must stand on live fabric (uncovered ground refuses loudly).
        const footprintArea = takeCtx.area(footprint);
        if (!(footprintArea > 0)) {
            try { this._setLastApplyFailure(idLabel, { code: 'building-footprint-degenerate', message: 'The building footprint has no usable area.' }); } catch (_) { }
            return { ok: false };
        }
        const hosts = candidates.filter(entry => reaches(asPlain(entry.feature.geometry), entry.id));
        if (!hosts.length && !takenHosts.length) {
            const message = 'No parcels found under the building footprint.';
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-no-parcels', message }); } catch (_) { }
            return { ok: false };
        }
        const uncovered = ground.uncoveredBy(turfRef, footprint, [...takenHosts, ...hosts].map(entry => asPlain(entry.feature.geometry)),
            { site: 'apply-buildings.uncovered', proposalId: idLabel });
        if (ground.isGround(turfRef, uncovered, toleranceM)) {
            const message = `Part of the building footprint lies on no live parcel here (${Math.max(1, Math.round(takeCtx.area(uncovered) / footprintArea * 100))}% uncovered).`;
            if (typeof updateStatus === 'function') updateStatus(message);
            try { this._setLastApplyFailure(idLabel, { code: 'building-uncovered-ground', message }); } catch (_) { }
            return { ok: false };
        }

        const hostIds = hosts.map(entry => String(entry.id));
        const hostFeatures = hosts.map(entry => entry.feature);
        const primary = hostFeatures[0];
        // The building parcel is the take cut to the ground it consumes (geometry-tolerances.js
        // cutTo): what is cut off is the debris the gate above let pass, so no vertex of the parcel
        // lies outside its own hosts, and it overlaps no piece it does not consume.
        const piece = ground.cutTo(turfRef, footprint, [...takenHosts, ...hosts].map(entry => asPlain(entry.feature.geometry)),
            { site: 'apply-buildings.piece', proposalId: idLabel });
        const parentEntries = hosts.flatMap(entry => formationEdit.cadastreIdsOfFeature(entry.feature)
            .map(baseId => ({ baseId, feature: entry.feature })));
        const buildingCadastreIds = formationEdit.overlappingBaseIds(piece, parentEntries, takeCtx, { toleranceM });
        const groundIds = groundIdsWith(hostFeatures);
        if (!buildingCadastreIds.length && !groundIds.length) {
            throw new Error('Building formation has no explicit cadastral anchors under its footprint.');
        }

        const buildingParcel = {
            type: 'Feature',
            geometry: JSON.parse(JSON.stringify(piece.geometry)),
            properties: {
                producedByProposalId: proposalId,
                buildingParcel: true,
                rootParcelId: buildingCadastreIds[0] || null,
                rootParcelNumber: _resolveRootParcelNumberFromProperties(primary ? primary.properties : null) || null,
                cadastreParcelIds: buildingCadastreIds,
                ...(groundIds.length ? { groundIds } : {}),
                calculatedArea: Math.round(_calculateGeoJsonArea(piece.geometry)),
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
            ? this._createForeignIndexAllocator(options)
            : null;
        // `threw` distinguishes a real "fully consumed" (null difference) from a failed
        // computation, so the caller can refuse instead of hiding ground it never re-minted.
        //
        // The cut runs through the shared clip (parcel-arrangement.js clipWith): the same 9-decimal
        // grid as every other stage, retried deterministically on coarser grids. A throw from it
        // is a real failure and is reported as one.
        const safeDifference = (aGeometry, bFeature, hostId) => {
            const a = { type: 'Feature', properties: {}, geometry: aGeometry };
            try {
                return { result: clip('difference', a, bFeature,
                    { site: 'apply-buildings.hostRemainder', parcelId: hostId }), threw: false, failure: null };
            } catch (error) {
                const failure = clipFailureApi().clipFailure('difference', error, { site: 'apply-buildings.hostRemainder', proposalId: idLabel, parcelId: hostId }, [a, bFeature]);
                console.error(`[${new Date().toISOString()}] [_formBuildingParcel] ${failure.message}`);
                return { result: null, threw: true, failure };
            }
        };
        let cutFailedHostId = null;
        let cutFailure = null;
        hostFeatures.forEach(hostFeature => {
            if (cutFailedHostId) return;
            const { result: difference, threw, failure } = safeDifference(hostFeature.geometry, footprint,
                _getParcelIdFromFeature(hostFeature));
            if (!difference || !difference.geometry) {
                // "Fully consumed" must be TRUE, not an exception artifact: a sweep-line throw
                // here used to hide the host with no remainder minted — a whole parcel of DEAD
                // ground around the building (unclickable, unhoverable). Whether the remainder is
                // ground is decided on the remainder itself (geometry-tolerances.js isGround); the
                // shared clip is deterministic, so a failed cut cannot be measured another way.
                // Refuse the apply rather than swallow ground that cannot be re-minted.
                if (threw) {
                    cutFailedHostId = String(_getParcelIdFromFeature(hostFeature) || 'unknown');
                    cutFailure = failure;
                }
                return; // host fully consumed by the footprint
            }
            const hostId = String(_getParcelIdFromFeature(hostFeature) || '');
            const hostIdentity = formationEdit.formationIdentityOf(hostFeature);
            const hostProducer = hostFeature.properties
                && hostFeature.properties.producedByProposalId;
            const isForeign = !!(hostIdentity && hostProducer
                && String(hostProducer) !== String(proposalId));
            const geometries = difference.geometry.type === 'MultiPolygon'
                ? difference.geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
                : [difference.geometry];
            const parts = geometries.map(geometry => ({
                geometry,
                area: _calculateGeoJsonArea(geometry)
            })).filter(part => ground.isGround(turfRef, asPlain(part.geometry))).sort((a, b) => b.area - a.area);

            if (isForeign && allocateForeignIndex) allocateForeignIndex.reserve(hostIdentity.anchor, hostIdentity.token, hostIdentity.index);

            parts.forEach((part, index) => {
                const remainder = JSON.parse(JSON.stringify(hostFeature));
                remainder.geometry = part.geometry;
                remainder.properties = remainder.properties || {};
                remainder.properties.calculatedArea = Math.round(part.area);
                if (isForeign && allocateForeignIndex) {
                    const syntheticIndex = index === 0
                        ? hostIdentity.index
                        : allocateForeignIndex(hostIdentity.anchor, hostIdentity.token);
                    remainder.properties.__carryIdentity = {
                        parcelId: index === 0
                            ? hostId
                            : _composeSyntheticParcelId(hostIdentity.root, hostIdentity.token, syntheticIndex),
                        parcelNumber: index === 0
                            ? (hostFeature.properties.BROJ_CESTICE || null)
                            : _composeSyntheticParcelNumber(
                                hostFeature.properties.rootParcelNumber || null,
                                hostIdentity.token,
                                syntheticIndex),
                        syntheticToken: hostIdentity.token,
                        syntheticIndex
                    };
                    foreignRemainders.push(remainder);
                    return;
                }
                remainder.properties.producedByProposalId = proposalId;
                ownRemainders.push(remainder);
            });
        });

        if (cutFailedHostId) {
            const message = `Cannot apply the building: the remainder of parcel ${cutFailedHostId} could not be computed — applying would leave its ground dead on the map.`
                + (cutFailure ? ` (${cutFailure.originalMessage})` : '');
            if (typeof updateStatus === 'function') updateStatus(message);
            try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
            try { this._setLastApplyFailure(idLabel, { code: 'building-cut-failed', message, parcelId: cutFailedHostId }); } catch (_) { }
            return { ok: false };
        }
        // Nothing is built over a street — refuse before any mutation (everything above is pure
        // computation on clones).
        {
            const roadHit = (typeof this._appliedRoadOverlappedByTaking === 'function')
                ? this._appliedRoadOverlappedByTaking(takeGeometry, idLabel, { ...options, toleranceM }) : null;
            if (roadHit) {
                const road = roadHit.proposal;
                const roadName = road.title || road.name || road.proposalId;
                const message = `Cannot apply the building: its footprint would stand on ${Math.round(roadHit.overlapM2)} m² of the applied road "${roadName}". Nothing is built over a street — move it clear, or unapply that road first.`;
                if (typeof updateStatus === 'function') updateStatus(message);
                try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error'); } catch (_) { }
                try { this._setLastApplyFailure(idLabel, { code: 'building-over-road', message, roadProposalId: String(road.proposalId || ''), overlapM2: roadHit.overlapM2 }); } catch (_) { }
                return { ok: false };
            }
        }
        const children = [buildingParcel, ...ownRemainders, ...foreignRemainders];
        this._assignSyntheticChildIdentities(proposalId, children);
        // A DERIVED host's largest remainder carries the host's own id (§15b: identity flows
        // with the ground), so _addFeaturesToMap below REPLACES that registry entry with the
        // remainder piece. Hiding such a host by feature would hide the remainder we just
        // minted — a whole parcel of dead, unclickable ground. Hide only hosts whose id no
        // child re-uses.
        const reusedHostIds = new Set(children
            .map(child => String(_getParcelIdFromFeature(child) || ''))
            .filter(Boolean));
        const consumedHosts = hostFeatures.filter(hostFeature => {
            const hostId = String(_getParcelIdFromFeature(hostFeature) || '');
            return !(hostId && reusedHostIds.has(hostId));
        });
        // The pieces must tile the ground they replace, as a private read checks them.
        if (!await this._checkFormedPartition(idLabel, proposalData, hostFeatures, children, options)) return { ok: false };
        await this._addFeaturesToMap(children, true, proposalData, options);
        const childIds = [];
        const buildingParcelIds = [];
        children.forEach(child => {
            const childId = _getParcelIdFromFeature(child);
            const ownsChild = child.properties
                && String(child.properties.producedByProposalId || proposalId) === String(proposalId);
            if (ownsChild && childId !== undefined && childId !== null) childIds.push(String(childId));
            if (ownsChild && child.properties && child.properties.buildingParcel === true
                && childId !== undefined && childId !== null) buildingParcelIds.push(String(childId));
            try {
                if (childId) this._markParcelProducedByProposal(
                    childId,
                    ownsChild ? proposalId : String(child.properties.producedByProposalId),
                    options
                );
            } catch (_) { }
        });
        this._consumeFeaturesFromLiveFabric(consumedHosts, options);
        finishOwnership(buildingParcelIds);

        return { ok: true, parentIds: hostIds.concat(takenHosts.map(entry => String(entry.id))) };
    },
    };
});
