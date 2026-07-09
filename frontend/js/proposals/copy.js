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
        const definition = (source.roadProposal && source.roadProposal.definition) || source.definition || null;
        if (!definition) return false;
        const centerline = Array.isArray(definition.points) && definition.points.length
            ? definition.points
            : (Array.isArray(definition.segments) ? definition.segments : []);
        if (!centerline.length) return false;
        window.pendingRoadDrawingProposal = {
            centerline: copyDeepClone(centerline),
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

    // Validate everything BEFORE mutating the parcel selection or opening the dialog. A proposal
    // from another city won't resolve here, and a half-applied copy would leave the map dirty.
    // Require every parent parcel — copying a subset would silently drop land from the proposal.
    await hydrateParcelsForCopy(parcelIds);
    const resolvedCount = parcelIds.filter(id => !!resolveCopyParcelLayer(id)).length;
    if (!parcelIds.length || resolvedCount !== parcelIds.length) {
        console.warn(`[copyProposal] ${resolvedCount}/${parcelIds.length} parent parcels resolved; aborting copy.`);
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage(
                'copy_proposal_parcels_unavailable',
                "Could not load this proposal's parcels. Switch to the city it was created in, then try again."
            );
        }
        return;
    }

    // Leave the details panel: the copy opens the create dialog over the map.
    try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }

    reselectParcelsForCopy(parcelIds);
    const seededGeometry = seedPendingGeometryFromProposal(source, goalKey);

    const overrides = {
        goal: dialogGoalForCopy(goalKey),
        acquisitionMode: source.acquisitionMode || null,
        prefill: buildCopyPrefill(source),
        copySource: { proposalId: String(sourceKey), name: sourceName }
    };

    if (seededGeometry) {
        // V1: the copied geometry rides along verbatim and is not re-drawable in place. Say so
        // plainly rather than presenting an editor that would silently start from scratch.
        overrides.geometryPreset = {
            statusText: copyProposalI18n(
                'modal.createProposal.geometry.status.copied',
                'Geometry copied from "{name}"',
                { name: sourceName }
            ),
            submitted: true,
            selectedAction: 'upload',
            disableButtons: true
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
        currentProposalTool = goalKey;
        const typeInput = document.getElementById('proposalType');
        if (typeInput && !typeInput.value) typeInput.value = 'Residences';
        try { if (typeof updateCreateProposalSubmitState === 'function') updateCreateProposalSubmitState(); } catch (_) { }
    }
}

if (typeof window !== 'undefined') {
    window.copyProposalIntoNewProposal = copyProposalIntoNewProposal;
}
