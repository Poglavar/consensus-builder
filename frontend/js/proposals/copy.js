// "Copy into new proposal" — forks an existing proposal into a fresh, editable draft.
//
// Proposals are immutable by design (they get minted on-chain), so this never mutates the
// source. Instead it re-seeds the create flow from the source's stored state and lets the user
// tweak before saving a brand-new proposal that records a `copiedFromProposalId` pointer back.
//
// createProposal() reads geometry out of a handful of "pending" globals that the interactive
// geometry tools write into, then clears them. Forking is therefore the inverse of that read:
// take the geometry fields off the stored proposal and put them back into those globals, mark
// the geometry as already-submitted, and open the dialog prefilled.

// Goals whose geometry lives in a pending global (the rest derive geometry from the parcel
// selection, so simply re-selecting the source's parcels reproduces it).
const COPY_BUILDING_GOALS = ['buildings', 'row', 'parcelBased', 'single'];
// Goals whose editor can reopen on an existing design, so a copy stays fully editable.
// road-track has its own path (it reopens the drawing tool directly, see copyCorridorIntoNewProposal).
const COPY_EDITABLE_GOALS = [...COPY_BUILDING_GOALS, 'reparcellization'];

function copyDeepClone(value) {
    if (value === null || value === undefined) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

// createProposal() parses the expiry/decay inputs with parseExpiryTime(); this is its inverse,
// so a copied proposal's stored durations round-trip back into those text fields.
function formatCopyDuration(ms) {
    const total = Number(ms);
    if (!Number.isFinite(total) || total <= 0) return null;
    const totalSeconds = Math.round(total / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hours)}h:${pad(minutes)}m:${pad(seconds)}s`;
}

function resolveCopyParcelLayer(id) {
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection
            && typeof multiParcelSelection.findParcelById === 'function') {
            const layer = multiParcelSelection.findParcelById(id);
            if (layer) return layer;
        }
        if (typeof resolveParcelLayerById === 'function') {
            const layer = resolveParcelLayerById(id);
            if (layer) return layer;
        }
    } catch (_) { /* not loaded */ }
    return null;
}

// The source's parcels may not be loaded (different viewport, or the app was reloaded straight
// into another city). Pull them in before we decide whether the copy can proceed. Synthetic
// descendant ids aren't fetchable from the parcel server, so they're skipped.
async function hydrateParcelsForCopy(parcelIds) {
    if (!parcelIds.length || typeof ensureParentParcelsLoaded !== 'function') return;
    const isSynthetic = (typeof ProposalManager !== 'undefined' && typeof ProposalManager.isSyntheticParcelId === 'function')
        ? ProposalManager.isSyntheticParcelId.bind(ProposalManager)
        : () => false;
    const real = [...new Set(parcelIds.filter(id => !isSynthetic(id)))];
    if (!real.length) return;
    try {
        await ensureParentParcelsLoaded(real);
    } catch (error) {
        console.warn('[copyProposal] parcel hydration failed', error);
    }
}

// Re-select the source proposal's parent parcels, using the same clear→add→highlight→updateUI
// pattern the geometry tools use. The create dialog reads this selection back out via
// getCurrentParcelSelectionContext().
function reselectParcelsForCopy(parcelIds) {
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection) return 0;
    if (!parcelIds.length) return 0;

    multiParcelSelection.isActive = true;
    if (multiParcelSelection.selectedParcels && typeof multiParcelSelection.selectedParcels.clear === 'function') {
        multiParcelSelection.selectedParcels.clear();
    }

    let resolved = 0;
    parcelIds.forEach((id) => {
        multiParcelSelection.selectedParcels.add(id);
        const layer = resolveCopyParcelLayer(id);
        if (layer) {
            resolved += 1;
            try {
                if (typeof multiParcelSelection.addParcelHighlight === 'function') multiParcelSelection.addParcelHighlight(layer);
            } catch (_) { }
        }
    });
    multiParcelSelection.lastSelectedParcelId = parcelIds[parcelIds.length - 1];
    try { if (typeof multiParcelSelection.updateUI === 'function') multiParcelSelection.updateUI(); } catch (_) { }
    return resolved;
}

function roadDefinitionOf(source) {
    return (source && ((source.roadProposal && source.roadProposal.definition) || source.definition)) || null;
}

// A road centerline is stored either as one flat list of points (older roads) or as a list of
// segments; both live under `points`, with `segments` as an alias.
function roadCenterlineOf(definition) {
    if (!definition) return [];
    if (Array.isArray(definition.points) && definition.points.length) return definition.points;
    return Array.isArray(definition.segments) ? definition.segments : [];
}

function isTrackProposal(source) {
    const definition = roadDefinitionOf(source);
    if (definition && definition.metadata && definition.metadata.isTrack === true) return true;
    return source && source.primaryType === 'Track';
}

// Copying a corridor reopens its drawing tool on the existing centerline rather than the create dialog:
// the whole point of copying a road or a track is to keep drawing it — extend it from either end, or
// (for roads) branch off it. The dialog comes later, when the user presses C, prefilled by
// finishRoadDrawing()/finishTrackDrawing() from the copy source we stash here.
async function copyCorridorIntoNewProposal(source, sourceKey, sourceName, options = {}) {
    const definition = roadDefinitionOf(source);
    const centerline = roadCenterlineOf(definition);
    if (!centerline.length) return false;

    const isTrack = isTrackProposal(source);
    const metadata = definition.metadata || {};
    const seed = isTrack
        ? { centerline: copyDeepClone(centerline), width: definition.width, tunnels: copyDeepClone(definition.tunnels || []) }
        : buildCorridorDrawingSeed(definition, options.profile);
    if (!seed) return false;
    if (isTrack) {
        seed.trackSpeed = metadata.trackSpeed;
        seed.trackMinRadius = metadata.trackMinRadius;
    }

    const copySource = {
        proposalId: String(sourceKey),
        name: sourceName,
        prefill: buildCopyPrefill(source)
    };
    return typeof startSeededCorridorDrawing === 'function'
        ? startSeededCorridorDrawing(isTrack ? 'track' : 'road', seed, copySource)
        : false;
}

// Put the source proposal's geometry back into the pending globals that createProposal() reads.
// Returns true when geometry was seeded (i.e. the dialog should show it as already submitted).
function seedPendingGeometryFromProposal(source, goalKey) {
    if (!source) return false;
    const parentIds = (Array.isArray(source.parentParcelIds) ? source.parentParcelIds : []).map(String);

    if (COPY_BUILDING_GOALS.includes(goalKey)) {
        const bp = source.buildingProposal || {};
        const buildings = (Array.isArray(bp.buildings) && bp.buildings.length)
            ? bp.buildings
            : ((source.geometry && Array.isArray(source.geometry.buildings)) ? source.geometry.buildings : []);
        const primary = bp.buildingFeature
            || (buildings.length ? buildings[0] : null)
            || (source.buildingGeometry ? { type: 'Feature', geometry: source.buildingGeometry, properties: source.buildingProperties || {} } : null);
        if (!primary && !buildings.length) return false;

        const context = {
            parcelIds: (Array.isArray(bp.parentParcelIds) && bp.parentParcelIds.length ? bp.parentParcelIds : parentIds).map(String),
            parentDetails: Array.isArray(bp.parentParcelNumbers) ? copyDeepClone(bp.parentParcelNumbers) : null,
            blockName: bp.blockName || null,
            parameters: copyDeepClone(bp.parameters) || {},
            buildingFeature: copyDeepClone(primary),
            buildings: copyDeepClone(buildings.length ? buildings : [primary])
        };
        window.pendingBuildingProposalContext = context;
        if (typeof setPendingBuildingProposalContext === 'function') setPendingBuildingProposalContext(context);
        return true;
    }

    if (goalKey === 'road-track') {
        const definition = roadDefinitionOf(source);
        if (!definition) return false;
        const centerline = roadCenterlineOf(definition);
        if (!centerline.length) return false;
        window.pendingRoadDrawingProposal = {
            centerline: copyDeepClone(centerline),
            segmentIds: Array.isArray(definition.segmentIds) ? definition.segmentIds.slice() : [],
            profile: copyDeepClone(definition.profile) || null,
            width: definition.width,
            sidewalkWidth: definition.sidewalkWidth,
            polygon: copyDeepClone(definition.polygon),
            metadata: copyDeepClone(definition.metadata) || {},
            parentParcelIds: parentIds.slice()
        };
        return true;
    }

    if (goalKey === 'reparcellization') {
        const plan = source.reparcellization;
        if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) return false;
        window.pendingReparcellizationPlan = copyDeepClone(plan);
        return true;
    }

    // park / square / lake / as-is / decide-later / ownership-transfer: geometry is derived
    // from the parcel selection at create time, so re-selecting the parcels is enough.
    return false;
}

// Collect every parameter the create dialog can restore from the source proposal.
function buildCopyPrefill(source) {
    const prefill = {
        name: source.title || source.name || source.proposalName || '',
        description: source.description || '',
        offerCurrency: source.offerCurrency || null
    };
    const offer = Number(source.offer);
    if (Number.isFinite(offer) && offer > 0) prefill.offer = offer;

    if (typeof source.isConditional === 'boolean') prefill.isConditional = source.isConditional;

    // Expiry is stored as an absolute timestamp; re-express it as the remaining duration so the
    // copy gets the same window rather than an already-elapsed deadline.
    if (source.expiresAt && source.createdAt) {
        const span = new Date(source.expiresAt).getTime() - new Date(source.createdAt).getTime();
        const formatted = formatCopyDuration(span);
        if (formatted) prefill.expiryTime = formatted;
    }

    if (source.decayEnabled) {
        prefill.decayEnabled = true;
        if (Number.isFinite(Number(source.decayPercent))) prefill.decayPercent = Number(source.decayPercent);
        const decayTime = formatCopyDuration(source.decayDurationMs);
        if (decayTime) prefill.decayTime = decayTime;
    }
    if (source.depositEnabled) {
        prefill.depositEnabled = true;
        if (Number.isFinite(Number(source.depositPercent))) prefill.depositPercent = Number(source.depositPercent);
    }
    return prefill;
}

// The land-use radio has no "buildings" option — block/row/parcelBased all live under the
// "urban-rule" land use plus a typology button, so map the stored goal back onto that pair.
function dialogGoalForCopy(goalKey) {
    if (goalKey === 'buildings' || goalKey === 'row' || goalKey === 'parcelBased') return 'urban-rule';
    return goalKey;
}

function typologyForCopy(source, goalKey) {
    if (goalKey === 'row') return 'row';
    if (goalKey === 'parcelBased') return 'parcelBased';
    if (goalKey === 'buildings') {
        const stored = source.typologyType ? String(source.typologyType) : '';
        return ['block', 'row', 'parcelBased'].includes(stored) ? stored : 'block';
    }
    return null;
}

// The seed a building editor should open with, or null to start blank. Read straight off the
// pending context, which is the single place a building design lives before it becomes a proposal.
// That covers two cases with one mechanism:
//   - a freshly copied proposal (copyProposalIntoNewProposal seeds the pending context), and
//   - reopening the editor mid-draft, which used to reset to defaults and lose your design.
// Guarded on the parcel set so a stale context from a different selection can never leak in.
function getPendingBuildingSeedFor(parcelIds) {
    const context = (typeof window !== 'undefined') ? window.pendingBuildingProposalContext : null;
    if (!context || !Array.isArray(context.parcelIds) || !context.parcelIds.length) return null;
    const key = (ids) => (ids || []).map(String).slice().sort().join('|');
    if (key(context.parcelIds) !== key(parcelIds)) return null;
    return context;
}

// Building features held by a pending context (single-building keeps position in the geometry).
function pendingBuildingSeedFeatures(context) {
    if (!context) return null;
    if (Array.isArray(context.buildings) && context.buildings.length) return context.buildings;
    if (context.buildingFeature) return [context.buildingFeature];
    return null;
}

// Outer ring of a building footprint, open (no closing duplicate) — the shape blockify's manual
// mode edits. Handles both Polygon and MultiPolygon.
function outerRingOfFeature(feature) {
    const geometry = feature && feature.geometry;
    if (!geometry) return null;
    let ring = null;
    if (geometry.type === 'Polygon') ring = geometry.coordinates && geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates && geometry.coordinates[0] && geometry.coordinates[0][0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const open = ring.map(c => [c[0], c[1]]);
    const first = open[0], last = open[open.length - 1];
    if (first && last && first[0] === last[0] && first[1] === last[1]) open.pop();
    return open.length >= 3 ? open : null;
}

// The blockify seed: the saved parameters, plus a manual outline recovered from the geometry when
// needed. A hand-dragged outline is not slider-derived, so regenerating from width/setback/chamfer
// would silently reshape it. Proposals saved before the editor persisted `mode`/`manualOuterRing`
// can still be detected via the feature's own `properties.manual` flag.
function buildBlockifySeed(context) {
    if (!context || !context.parameters) return null;
    const seed = { ...context.parameters };
    const feature = context.buildingFeature || (Array.isArray(context.buildings) ? context.buildings[0] : null);
    const looksManual = seed.mode === 'manual' || !!(feature && feature.properties && feature.properties.manual);
    if (looksManual) {
        const ring = (Array.isArray(seed.manualOuterRing) && seed.manualOuterRing.length >= 3)
            ? seed.manualOuterRing
            : outerRingOfFeature(feature);
        if (ring) {
            seed.mode = 'manual';
            seed.manualOuterRing = ring;
        }
    }
    return seed;
}

// Same idea as getPendingBuildingSeedFor, for the reparcellization plan: the pending global is the
// one place a plan lives before it becomes a proposal, so reading it back covers both a copied
// proposal and reopening the editor mid-draft. Guarded on the parcel set.
function getPendingReparcellizationSeedFor(parcelIds) {
    const plan = (typeof window !== 'undefined') ? window.pendingReparcellizationPlan : null;
    if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) return null;
    if (!Array.isArray(plan.parcelIds) || !plan.parcelIds.length) return null;
    const key = (ids) => (ids || []).map(String).slice().sort().join('|');
    if (key(plan.parcelIds) !== key(parcelIds)) return null;
    return plan;
}

// An applied proposal has already rewritten the map: its parents are gone, its children are there.
function isProposalAppliedToMap(proposal) {
    const statuses = [
        proposal.status,
        proposal.roadProposal && proposal.roadProposal.status,
        proposal.buildingProposal && proposal.buildingProposal.status,
        proposal.structureProposal && proposal.structureProposal.status,
        proposal.reparcellization && proposal.reparcellization.status,
        proposal.decideLaterProposal && proposal.decideLaterProposal.status
    ];
    return statuses.some(status => {
        const value = String(status || '').toLowerCase();
        return value === 'applied' || value === 'executed';
    });
}

function copyProposalI18n(key, fallback, params) {
    try {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const translated = window.i18n.t(key, params || {});
            if (translated && translated !== key) return translated;
        }
    } catch (_) { }
    let text = fallback;
    if (params) {
        Object.keys(params).forEach((k) => {
            text = text.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}|\\{${k}\\}`, 'g'), params[k]);
        });
    }
    return text;
}

// Entry point, wired to the "Copy into new proposal" button in the details panel.
async function copyProposalIntoNewProposal(proposalIdOrHash) {
    // Backwards-compatible entry point for shared links or cached UI that still invokes the old
    // action name. The editor dialog is retired: proposing from an object goes straight to the
    // prefilled create dialog.
    if (typeof proposeExistingProposal === 'function') {
        return proposeExistingProposal(proposalIdOrHash);
    }
    if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) return;

    const source = (typeof getProposalByIdOrHash === 'function')
        ? getProposalByIdOrHash(proposalIdOrHash)
        : null;
    if (!source) {
        console.warn('[copyProposal] source proposal not found:', proposalIdOrHash);
        return;
    }

    const goalKey = (typeof resolveProposalGoalKey === 'function')
        ? resolveProposalGoalKey(source)
        : (source.goal || '');
    if (!goalKey) {
        console.warn('[copyProposal] proposal has no resolvable goal; cannot copy:', proposalIdOrHash);
        return;
    }

    const sourceKey = (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId;
    const sourceName = source.title || source.name || source.proposalName || sourceKey;
    const parcelIds = (Array.isArray(source.parentParcelIds) ? source.parentParcelIds : [])
        .map(id => (id === null || id === undefined) ? null : String(id))
        .filter(Boolean);

    // Validate everything BEFORE mutating the parcel selection or opening the dialog: a half-applied
    // copy would leave the map dirty.
    //
    // "Its parcels aren't on the map" used to mean all three of these at once, and answered every one of
    // them with "switch to the city it was created in":
    //
    //   - the proposal belongs to another city    → true, and the proposal itself records which one
    //   - the proposal consumed its own parents   → it is applied; unapplying restores them
    //   - the parcels genuinely could not load    → the only case the old message described
    //
    // A corridor needs no parcels at all: its copy reopens the drawing tool from the stored centerline.
    if (!parcelIds.length) {
        console.warn('[copyProposal] proposal has no parent parcels; aborting copy.');
        return;
    }

    const sourceCity = source.city ? String(source.city) : null;
    const currentCity = (typeof getProposalCityId === 'function') ? getProposalCityId() : null;
    if (sourceCity && currentCity && sourceCity !== currentCity) {
        console.warn(`[copyProposal] proposal is from ${sourceCity}, current city is ${currentCity}; aborting copy.`);
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage(
                'copy_proposal_wrong_city',
                copyProposalI18n(
                    'proposals.copy.wrongCity',
                    'This proposal was created in another city. Switch to that city, then try again.'
                )
            );
        }
        return;
    }

    const needsParcelsOnMap = goalKey !== 'road-track';
    if (needsParcelsOnMap) {
        await hydrateParcelsForCopy(parcelIds);
        const resolvedCount = parcelIds.filter(id => !!resolveCopyParcelLayer(id)).length;
        if (resolvedCount !== parcelIds.length) {
            // An applied proposal has replaced its parents with its own children. Re-fetching them would
            // draw the pre-proposal cadastre over the proposal; unapplying is what puts them back.
            const applied = isProposalAppliedToMap(source);
            console.warn(`[copyProposal] ${resolvedCount}/${parcelIds.length} parent parcels resolved (applied: ${applied}); aborting copy.`);
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage(
                    applied ? 'copy_proposal_applied' : 'copy_proposal_parcels_unavailable',
                    applied
                        ? copyProposalI18n('proposals.copy.appliedFirst', 'Remove this proposal from the map first, then copy it.')
                        : copyProposalI18n('proposals.copy.parcelsUnavailable', "Could not load this proposal's parcels. Try again once they are on the map.")
                );
            }
            return;
        }
    }

    // Leave the details panel: the copy opens the create dialog over the map.
    try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }

    reselectParcelsForCopy(parcelIds);

    // Roads and tracks reopen in their drawing tool instead of the dialog, so the copy can be continued.
    if (goalKey === 'road-track' && await copyCorridorIntoNewProposal(source, sourceKey, sourceName)) {
        return;
    }

    const seededGeometry = seedPendingGeometryFromProposal(source, goalKey);

    const overrides = {
        goal: dialogGoalForCopy(goalKey),
        acquisitionMode: source.acquisitionMode || null,
        prefill: buildCopyPrefill(source),
        copySource: { proposalId: String(sourceKey), name: sourceName }
    };

    if (seededGeometry) {
        // The building and reparcellization editors reopen on the copied design (they read the
        // pending state we just seeded), so leave their buttons live — "Edit" reopens the original,
        // fully editable. Road drawing has no seed-from-existing path yet: its geometry rides along
        // verbatim and the buttons stay locked rather than silently starting from a blank canvas.
        const editable = COPY_EDITABLE_GOALS.includes(goalKey);
        overrides.geometryPreset = {
            statusText: copyProposalI18n(
                editable ? 'modal.createProposal.geometry.status.copiedEditable' : 'modal.createProposal.geometry.status.copied',
                editable ? 'Geometry copied from "{name}" — press Edit to adjust it' : 'Geometry copied from "{name}"',
                { name: sourceName }
            ),
            submitted: true,
            selectedAction: 'edit',
            disableButtons: !editable
        };
    }

    showProposalDialog(overrides);

    // Building goals need the typology button + tool restored after the dialog exists. The
    // land-use radio only got us as far as "urban-rule"; the typology picks the concrete tool.
    const typology = typologyForCopy(source, goalKey);
    if (typology && typeof handleUrbanRuleTypologyClick === 'function') {
        handleUrbanRuleTypologyClick(typology, { skipLaunch: true });
        // skipLaunch returns before setting the tool (it normally launches an editor), so set it
        // here; otherwise createProposal()'s goal gate sees "urban-rule" and demands geometry.
        // Every typology is stored under goal 'buildings', so derive the tool from the typology.
        currentProposalTool = (typology === 'row') ? 'row'
            : (typology === 'parcelBased') ? 'parcelBased'
                : 'buildings';
        const typeInput = document.getElementById('proposalType');
        if (typeInput && !typeInput.value) typeInput.value = 'Residences';
        try { if (typeof updateCreateProposalSubmitState === 'function') updateCreateProposalSubmitState(); } catch (_) { }
    }
}

if (typeof window !== 'undefined') {
    window.copyProposalIntoNewProposal = copyProposalIntoNewProposal;
    window.copyCorridorIntoNewProposal = copyCorridorIntoNewProposal;
    window.getPendingBuildingSeedFor = getPendingBuildingSeedFor;
    window.pendingBuildingSeedFeatures = pendingBuildingSeedFeatures;
    window.buildBlockifySeed = buildBlockifySeed;
    window.getPendingReparcellizationSeedFor = getPendingReparcellizationSeedFor;
}
