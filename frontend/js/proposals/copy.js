// "Copy into new proposal" — forks an existing proposal into a fresh, editable draft.
//
// Proposals are immutable by design (they get minted on-chain), so this never mutates the
// source. Instead it re-seeds the create flow from the source's stored state and lets the user
// tweak before saving a brand-new proposal that records a typed `proposalOrigin` relationship back.
//
// createProposal() reads geometry out of a handful of "pending" globals that the interactive
// geometry tools write into, then clears them. Forking is therefore the inverse of that read:
// take the geometry fields off the stored proposal and put them back into those globals, mark
// the geometry as already-submitted, and open the dialog prefilled.

// Goals whose geometry lives in a pending global (the rest derive geometry from the parcel
// selection, so simply re-selecting the source's parcels reproduces it).
const COPY_BUILDING_GOALS = ['buildings', 'row', 'parcelBased', 'single'];
// Goals whose editor can reopen on an existing design, so a copy stays fully editable.
// road-track is not listed: a road's node and cross-section editors save it directly.
const COPY_EDITABLE_GOALS = [...COPY_BUILDING_GOALS];

function copyDeepClone(value) {
    if (value === null || value === undefined) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function resolveCopyParcelLayers(ids) {
    const presenter = window.ParcelPresenter;
    if (!presenter || typeof presenter.resolveLiveLayers !== 'function') return [];
    return presenter.resolveLiveLayers(ids, { includeCorridors: false });
}

// The source's cadastral ground may not be loaded (different viewport, or the app was reloaded
// straight into another city). Durable proposals declare those ids explicitly.
async function hydrateParcelsForCopy(cadastreParcelIds) {
    const ids = [...new Set((cadastreParcelIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    try {
        const ground = (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository)
            ? CadastralParcelRepository
            : ((typeof window !== 'undefined') ? window.CadastralParcelRepository : null);
        if (!ground || typeof ground.ensureIds !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }
        await ground.ensureIds(ids);
    } catch (error) {
        console.warn('[copyProposal] parcel hydration failed', error);
    }
}

// Re-select the current live pieces over the source proposal's cadastral ground, using the same clear→add→highlight→updateUI
// pattern the geometry tools use. The create dialog reads this selection back out via
// getCurrentParcelSelectionContext().
function reselectParcelsForCopy(parcelIds) {
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection) return 0;
    if (!parcelIds.length) return 0;

    multiParcelSelection.isActive = true;
    if (multiParcelSelection.selectedParcels && typeof multiParcelSelection.selectedParcels.clear === 'function') {
        multiParcelSelection.selectedParcels.clear();
    }

    const layers = resolveCopyParcelLayers(parcelIds);
    layers.forEach(layer => {
        const id = window.ParcelPresenter?.getIdForLayer?.(layer);
        if (!id || multiParcelSelection.selectedParcels.has(id)) return;
        multiParcelSelection.selectedParcels.add(id);
        try {
            if (typeof multiParcelSelection.addParcelHighlight === 'function') multiParcelSelection.addParcelHighlight(layer);
        } catch (_) { }
    });
    multiParcelSelection.lastSelectedParcelId = multiParcelSelection.selectedParcels.size
        ? Array.from(multiParcelSelection.selectedParcels).slice(-1)[0]
        : null;
    try { if (typeof multiParcelSelection.updateUI === 'function') multiParcelSelection.updateUI(); } catch (_) { }
    return layers.length;
}

function roadDefinitionOf(source) {
    return source?.roadProposal?.definition || null;
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
    if (corridorIsTrack(definition)) return true;
    return source && source.primaryType === 'Track';
}

// Put the source proposal's geometry back into the pending globals that createProposal() reads.
// Returns true when geometry was seeded (i.e. the dialog should show it as already submitted).
function seedPendingGeometryFromProposal(source, goalKey, selectedLiveParcelIds = []) {
    if (!source) return false;
    const selectionIds = Array.from(new Set((selectedLiveParcelIds || []).map(String).filter(Boolean)));

    if (COPY_BUILDING_GOALS.includes(goalKey)) {
        const bp = source.buildingProposal || {};
        const buildings = (source.geometry && Array.isArray(source.geometry.buildings))
            ? source.geometry.buildings
            : [];
        const primary = buildings.length ? buildings[0] : null;
        if (!primary && !buildings.length) return false;

        const context = {
            parcelIds: selectionIds,
            blockName: bp.blockName || null,
            parameters: copyDeepClone(bp.parameters) || {},
            buildingFeature: copyDeepClone(primary),
            buildings: copyDeepClone(buildings.length ? buildings : [primary]),
            // A building proposal's paved/green surroundings copy with its buildings.
            groundSurface: copyDeepClone(source.geometry && source.geometry.groundSurface) || null
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
            parcelIds: selectionIds.slice()
        };
        return true;
    }

    // park / square / lake / as-is / ownership-transfer: geometry is derived
    // from the parcel selection at create time, so re-selecting the parcels is enough.
    return false;
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
        // A design read back from the index carries its typology in the payload only (design/v1 keeps
        // one payload, design-record.js), as every other typology reader already allows for.
        const typology = source.typologyType || (source.buildingProposal && source.buildingProposal.typologyType);
        const stored = typology ? String(typology) : '';
        return ['block', 'row', 'parcelBased'].includes(stored) ? stored : 'block';
    }
    return null;
}

// The seed a building editor should open with, or null to start blank. Read straight off the
// pending context, which is the single place a building design lives before it becomes a proposal.
// That covers two cases with one mechanism:
//   - a freshly forked proposal (its publish step seeds the pending context), and
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
    // The authored block-wide outline; a block's buildings are its per-parcel pieces.
    const feature = context.blockMassing || context.buildingFeature || (Array.isArray(context.buildings) ? context.buildings[0] : null);
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

// An applied proposal has already rewritten the map: its parents are gone, its children are there.
function isProposalAppliedToMap(proposal) {
    if (!proposal) return false;
    if (isApplied(proposal)) return true;
    return ['roadProposal', 'buildingProposal', 'structureProposal', 'parcelLayout']
        .some(key => proposal[key] && isApplied(proposal, proposal[key]));
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

if (typeof window !== 'undefined') {
    window.getPendingBuildingSeedFor = getPendingBuildingSeedFor;
    window.pendingBuildingSeedFeatures = pendingBuildingSeedFeatures;
    window.buildBlockifySeed = buildBlockifySeed;
}
