/**
 * Building blocks (blocks of buildings) functionality.
 * 
 * This file contains the functionality for building blocks (blocks of buildings).
 * NOTE: this is not the same things as parcel blocks (blocks of parcels).
 * 
 * It includes the logic for creating blocks of buildings on top of parcels,
 * updating the blockify button, and showing the blockify modal.
 * 
 */

// Building blocks functionality
window.selectedBlockName = null;
let selectedBlockName = window.selectedBlockName;

function blockifyParcelId(parcel) {
    if (parcel === undefined || parcel === null) return null;
    if (typeof parcel === 'string' || typeof parcel === 'number') return String(parcel);
    if (parcel.type === 'Feature') {
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(parcel)
            : (parcel.properties?.parcelId ?? parcel.properties?.parcel_id ?? parcel.properties?.id);
        return id === undefined || id === null ? null : String(id);
    }
    const id = parcel.id ?? parcel.parcelId;
    return id === undefined || id === null ? null : String(id);
}

function blockifyFeatureForParcel(parcel) {
    if (parcel?.feature?.type === 'Feature' && parcel.feature.geometry) return parcel.feature;
    if (parcel?.type === 'Feature' && parcel.geometry) return parcel;
    const id = blockifyParcelId(parcel);
    if (!id) return null;
    // A site on bare ground designs on synthetic parcels (js/site-drawing.js).
    if (typeof window.resolveDesignParcelFeature === 'function') return window.resolveDesignParcelFeature(id) || null;
    return window.LiveParcelFabric?.get?.(id) || null;
}

function blockifyFeaturesForBlock(block) {
    const inputs = Array.isArray(block?.parcelIds) && block.parcelIds.length
        ? block.parcelIds
        : (Array.isArray(block?.parcels) ? block.parcels : []);
    const features = inputs.map(blockifyFeatureForParcel).filter(Boolean);
    return features.length === inputs.length ? features : [];
}
// Add blockify modal variables
let blockifyMap = null;
let blockifyModal = null;
let blockifyParcelLayer = null;
let blockifyBoundaryLayer = null;
let blockifyAuthoredSite = null;
let blockifyGenerationSite = null; // The generator frame: the authored site, else the parcels' union.
let blockifyBuildingLayer = null;
let blockifyPieceLayers = [];      // one per constituent parcel
let blockifyExcludedLayers = [];   // parcels the rule leaves out, drawn hatched
let generatedBuildingFeature = null;
let blockifyBlockNameOverride = null;
// Default parameter values
const DEFAULT_SETBACK = 2; // meters
const DEFAULT_BUILDING_WIDTH = 15; // meters
const DEFAULT_BUILDING_HEIGHT = 17.5; // meters (5 floors x 3.5 m)
const DEFAULT_CHAMFER_M = 0; // meters (corner cut distance along each adjacent edge)
const DEFAULT_SIMPLIFY_M = 0; // meters (0 = follow parcels exactly; higher smooths jagged outlines)
// Chamfer every convex corner up to this internal angle. High enough to catch obtuse corners on
// irregular blocks, low enough to skip near-straight arc segments (~174° from the negative buffer).
const CHAMFER_MAX_INTERNAL_ANGLE_DEG = 165;
// A block's massing is one ring, but the buildings under it belong to individual owners. The ring
// is cut into one building per constituent parcel, in distinct shades, so a block reads as a street
// — and so the gain lands on the parcel that earned it. See urban-rule-massing.md.
//
// The default is "exactly this height": the block editor has always drawn one specific form that
// everyone builds, and that is a real kind of rule (C). Choosing "at most" or "between" turns the
// same envelope into a ceiling and lets the buildings under it vary.
const DEFAULT_BLOCK_RULE_KIND = 'exact';
const DEFAULT_BLOCK_MIN_PLOT_AREA_M2 = 50;
let blockRuleKind = DEFAULT_BLOCK_RULE_KIND;
let blockMinHeightM = 0;
let blockMinDepthM = 0;          // obvezni građevni pravac: compelled depth from the street
let blockMinPlotAreaM2 = DEFAULT_BLOCK_MIN_PLOT_AREA_M2;
let blockVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
let blockMassingPieces = [];      // per-parcel economic pieces; the proposal also saves the full authored massing
let blockBuildOut = [];           // one example built under it — presentation only
let blockExcludedParcels = [];

let currentSetback = DEFAULT_SETBACK;
let currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
let currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
let currentChamferM = DEFAULT_CHAMFER_M;
let currentSimplifyM = DEFAULT_SIMPLIFY_M;
// Gap/wing placement: each is a fraction (0..1) along the outer ring. The count sliders manage how
// many there are (adding new ones in the largest free span, removing the last); dragging a handle on
// the modal map fine-tunes an individual position. This keeps the block fully parametric/shareable.
let gapPositions = [];
let wingPositions = [];
let lastOuterRing = null;        // last generated outer ring ([lng,lat], closed) for handle projection
let lastSuperparcel = null;      // the exact parcel outline, to clip the building so nothing pokes out
let blockifyHandleLayer = null;  // Leaflet layer group holding the draggable gap/wing handles
let blockifyPolygonEditor = null; // shared manual-outline editor (also used by freeform buildings)
let blockifyPendingVertexActionIndex = null; // survives the synchronous rebuild after drag release
let blockifyHistory = null;
let blockifyUndoButton = null;
let blockifyHistoryKeydown = null;
let blockifyDragState = null;
let blockifyShapeHistoryRecorded = false;
// Manual (freeform) footprint mode: a one-way branch from the parametric sliders. In manual mode the
// outer ring's vertices are draggable, the shape-producing sliders are inert, and the courtyard is
// re-inset by no footprint controls in manual mode; only height stays live. "Back to sliders" regenerates
// parametrically and discards manual edits. See the roadmap in URBAN-RULE-BLOCKS-ROADMAP.md.
let blockifyMode = 'parametric';  // 'parametric' | 'manual' | 'existing'
let manualOuterRing = [];         // editable outer-ring vertices ([lng,lat], open — no closing dup)
let manualBuildSucceeded = false; // has any manual build produced a shape? gates the trapped-state recovery
// Design to restore when the modal next opens, instead of starting from the defaults. Set by
// openUrbanRuleForParcels({ initialState }) — used by "Copy into new proposal" so a fork reopens
// the editor showing the original design, with every control live. Consumed once, then cleared.
let blockifySeedState = null;
let blockifySurroundings = null;
let blockifyInitialGroundTreatment = null;
let blockifyInitialDecorationDesign = null;
// "Based on existing buildings" mode: the proposal is derived from the existing building
// footprints on the selected parcels instead of a freeform slider shape. Two independent rules,
// picked by radio (moving a slider also activates its rule): "proposed height" extrudes EVERY
// footprint to exactly that height; "additional floors" adds floors on top of each building's
// current height (uncapped, so it needs known heights). Footprints (+ per-building heights where
// the city's data knows them) come from POST /buildings/footprints — an optional per-city backend
// capability, so cities without a footprint source simply report unsupported and the toggle reverts.
const DEFAULT_FLOOR_HEIGHT_M = 3.5;     // one storey, matches DEFAULT_BUILDING_HEIGHT (5 floors x 3.5 m)
const DEFAULT_PROPOSED_HEIGHT_FLOORS = 6;
const DEFAULT_ADDITIONAL_FLOORS = 1;
let existingRule = 'exact';             // 'exact' (proposed height) | 'additional' (added floors)
let currentProposedHeightFloors = DEFAULT_PROPOSED_HEIGHT_FLOORS;
let currentAdditionalFloors = DEFAULT_ADDITIONAL_FLOORS;
let currentFloorHeightM = DEFAULT_FLOOR_HEIGHT_M;
let existingFootprints = null;          // [{ id, geometry, height_m, floors }] for the current block
let existingFootprintsPromise = null;   // in-flight/settled fetch; one per modal open
let generatedBuildingFeatures = null;   // existing-mode result: one Feature per raised building
let blockifyFootprintLayer = null;      // Leaflet layer outlining the fetched footprints
let livePreviewEnabled = false;
let blockifyBlock = null;
let pendingBuildingProposalContext = null;

function formatBuildingText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
        const value = params[key];
        // An i18n reference ({ key, count }) without i18n loaded: its count is the best fallback.
        return value && typeof value === 'object' && 'count' in value ? value.count : value;
    });
}

// "1 parcel left out" / "3 parcels left out" as an i18n reference for a summary line's params.
function blockParcelsLeftOutPhrase(count) {
    return { key: 'blockify.modal.messages.parcelsLeftOut', count };
}

function translateBuildingText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        { const translated = api.t(key, params); if (translated !== key) return translated; }
    }
    return formatBuildingText(fallback, params);
}

function refreshBlockifyDensityStats(buildings = null) {
    const api = (typeof window !== 'undefined') ? window.BuildingDensityStats : null;
    const container = document.getElementById('blockify-density-stats');
    if (!api || !container || typeof turf === 'undefined') return;

    const candidates = Array.isArray(buildings)
        ? buildings
        : (blockMassingPieces.length ? blockMassingPieces : (generatedBuildingFeature ? [generatedBuildingFeature] : []));
    const floorHeightM = blockifyMode === 'existing' ? currentFloorHeightM : DEFAULT_FLOOR_HEIGHT_M;
    let stats = null;
    try {
        stats = api.summarizeDensity({
            parcelFeature: blockifyDesignBoundary(),
            buildings: candidates,
            turf,
            floorHeightM,
            preferHeight: true
        });
    } catch (_) { }

    const setValue = (suffix, value) => {
        const element = document.getElementById(`blockify-density-${suffix}`);
        if (element) element.textContent = value;
    };
    const area = value => stats && Number.isFinite(value) ? CbFormat.formatArea(value) : '\u2014';
    setValue('parcel', stats?.parcelAreaM2 > 0 ? area(stats.parcelAreaM2) : '\u2014');
    setValue('footprint', stats ? area(stats.footprintAreaM2) : '\u2014');
    setValue('coverage', stats?.parcelAreaM2 > 0 ? CbFormat.formatPercent(stats.siteCoveragePercent, { ofHundred: true, maxFractionDigits: 1, missing: '\u2014' }) : '\u2014');
    setValue('gbp', stats ? area(stats.aboveGroundGbpM2) : '\u2014');
    setValue('kin', stats?.parcelAreaM2 > 0 ? CbFormat.formatNumber(stats.kin, { maxFractionDigits: 3, missing: '\u2014' }) : '\u2014');

    const hint = document.getElementById('blockify-density-hint');
    if (hint) {
        const height = CbFormat.formatNumber(floorHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
        hint.textContent = translateBuildingText(
            'densityStats.floorHeightHint',
            'Calculated from the drawn footprints and height \u00f7 {{height}} m per storey.',
            { height }
        );
    }
}

function showBuildingAlert(key, fallback, params = {}) {
    const message = key
        ? translateBuildingText(`alerts.messages.${key}`, fallback, params)
        : translateBuildingText('', fallback, params);
    window.CbDialog.alert(message);
    return message;
}

function setPendingBuildingProposalContext(ctx, options = {}) {
    pendingBuildingProposalContext = ctx || null;
    if (typeof window !== 'undefined') {
        window.pendingBuildingProposalContext = pendingBuildingProposalContext;
        if (pendingBuildingProposalContext && options.fromDraft !== true
            && typeof window.syncActiveProposalDraftFromEditor === 'function') {
            window.syncActiveProposalDraftFromEditor('building', pendingBuildingProposalContext, {
                coalesceKey: options.coalesceKey || 'building-design'
            });
        }
    }
}

if (typeof window !== 'undefined') {
    window.setPendingBuildingProposalContext = setPendingBuildingProposalContext;
}

if (typeof window !== 'undefined' && typeof window.pendingBuildingProposalContext !== 'undefined') {
    pendingBuildingProposalContext = window.pendingBuildingProposalContext;
}

function getBlockifyDisplayName() {
    if (blockifyBlockNameOverride) return blockifyBlockNameOverride;
    const hasSelected = typeof selectedBlockName !== 'undefined' && selectedBlockName;
    return hasSelected ? selectedBlockName : translateBuildingText('blockify.modal.messages.selectedParcels', 'Selected Parcels');
}

function getActiveBlockifyBlock() {
    if (blockifyBlock && Array.isArray(blockifyBlock.parcels) && blockifyBlock.parcels.length > 0) {
        return blockifyBlock;
    }
    if (typeof selectedBlockName !== 'undefined' && selectedBlockName && blockStorage.blocks.has(selectedBlockName)) {
        const stored = blockStorage.blocks.get(selectedBlockName);
        const parcelIds = Array.from(new Set((stored?.parcelIds || []).map(String).filter(Boolean)));
        const features = parcelIds.map(id => window.LiveParcelFabric?.get?.(id)).filter(Boolean);
        if (!parcelIds.length || features.length !== parcelIds.length) return null;
        return { ...stored, parcels: parcelIds, parcelIds, polygon: null };
    }
    return null;
}

function normalizeBlockifySite(site) {
    if (!site || typeof site !== 'object') return null;
    const feature = site.type === 'Feature'
        ? deepCloneBuildingFeature(site)
        : (['Polygon', 'MultiPolygon'].includes(site.type)
            ? { type: 'Feature', properties: {}, geometry: deepCloneBuildingFeature(site) }
            : null);
    return feature && ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) ? feature : null;
}

function blockifyDesignBoundary() {
    return blockifyGenerationSite?.geometry ? blockifyGenerationSite
        : (blockifyAuthoredSite?.geometry ? blockifyAuthoredSite : lastSuperparcel);
}

function blockifyClone(value) {
    try { return value == null ? value : JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

function blockifyGeometrySnapshot() {
    return {
        mode: blockifyMode,
        feature: blockifyClone(generatedBuildingFeature),
        features: blockifyClone(generatedBuildingFeatures),
            manualOuterRing: blockifyMode === 'manual'
                ? (blockifyOuterRing(generatedBuildingFeature) || blockifyClone(manualOuterRing))
                : blockifyClone(manualOuterRing),
        params: {
            setback: currentSetback, width: currentBuildingWidth, height: currentBuildingHeight,
            chamfer: currentChamferM, simplify: currentSimplifyM,
            gaps: blockifyClone(gapPositions), wings: blockifyClone(wingPositions),
            ruleKind: blockRuleKind, minHeight: blockMinHeightM, minDepth: blockMinDepthM,
            minPlotArea: blockMinPlotAreaM2, seed: blockVariationSeed
        }
    };
}

function restoreBlockifyGeometrySnapshot(snapshot) {
    if (!snapshot) return;
    blockifyMode = snapshot.mode || 'parametric';
    generatedBuildingFeature = blockifyClone(snapshot.feature);
    generatedBuildingFeatures = blockifyClone(snapshot.features);
    manualOuterRing = blockifyClone(snapshot.manualOuterRing) || [];
    const params = snapshot.params || {};
    currentSetback = params.setback ?? currentSetback;
    currentBuildingWidth = params.width ?? currentBuildingWidth;
    currentBuildingHeight = params.height ?? currentBuildingHeight;
    currentChamferM = params.chamfer ?? currentChamferM;
    currentSimplifyM = params.simplify ?? currentSimplifyM;
    gapPositions = blockifyClone(params.gaps) || [];
    wingPositions = blockifyClone(params.wings) || [];
    blockRuleKind = params.ruleKind || DEFAULT_BLOCK_RULE_KIND;
    blockMinHeightM = params.minHeight ?? 0;
    blockMinDepthM = params.minDepth ?? 0;
    blockMinPlotAreaM2 = params.minPlotArea ?? DEFAULT_BLOCK_MIN_PLOT_AREA_M2;
    blockVariationSeed = params.seed ?? blockVariationSeed;
    syncBlockifyControlsFromState();
    setFootprintSlidersEnabled(blockifyMode !== 'manual');
    updateManualToggleLabel();
    if (generatedBuildingFeature?.geometry) {
        displayBuildingInModal(generatedBuildingFeature);
        if (blockifyMode === 'manual') renderManualPolygonEditor();
    } else if (Array.isArray(generatedBuildingFeatures)) displayBuildingsInModal(generatedBuildingFeatures);
}

function ensureBlockifyHistory() {
    if (blockifyHistory || !window.GeometryEditHistory?.create || !blockifyMap) return blockifyHistory;
    blockifyHistory = window.GeometryEditHistory.create({
        capture: blockifyGeometrySnapshot,
        restore: restoreBlockifyGeometrySnapshot
    });
    blockifyHistoryKeydown = blockifyHistory.bindKeyboard(document, { enabled: () => blockifyModal?.active === true });
    try {
        blockifyUndoButton = document.createElement('button');
        blockifyUndoButton.type = 'button';
        blockifyUndoButton.className = 'map-shell-button geom-undo-button';
        blockifyUndoButton.title = translateBuildingText('onMapEditor.undo', 'Undo (Cmd/Ctrl+Z)');
        blockifyUndoButton.setAttribute('aria-label', blockifyUndoButton.title);
        blockifyUndoButton.textContent = '↶';
        blockifyUndoButton.disabled = true;
        L.DomEvent?.disableClickPropagation?.(blockifyUndoButton);
        L.DomEvent?.disableScrollPropagation?.(blockifyUndoButton);
        blockifyMap.getContainer()?.appendChild(blockifyUndoButton);
        blockifyHistory.bindButton(blockifyUndoButton);
    } catch (_) { blockifyUndoButton = null; }
    return blockifyHistory;
}

function blockifyOuterRing(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return null;
    const polygon = geometry.type === 'Polygon' ? geometry : geometry.type === 'MultiPolygon' ? geometry.coordinates?.[0] : null;
    const ring = Array.isArray(polygon) ? polygon : polygon?.coordinates;
    if (!Array.isArray(ring?.[0])) return null;
    const open = ring[0].map(coordinate => [coordinate[0], coordinate[1]]);
    if (open.length > 1 && open[0][0] === open.at(-1)[0] && open[0][1] === open.at(-1)[1]) open.pop();
    return open.length >= 3 ? open : null;
}

function blockifyPointerEvent(event) {
    const nativeEvent = event?.originalEvent || event;
    const touch = nativeEvent?.changedTouches?.[0] || nativeEvent?.touches?.[0];
    if (!touch) return event;
    nativeEvent.preventDefault?.();
    return { clientX: touch.clientX, clientY: touch.clientY, target: nativeEvent.target, originalEvent: nativeEvent, preventDefault: () => nativeEvent.preventDefault?.() };
}

// A Block is built by its rule on its own parcels, so it does not move: dragging the massing
// previews it at the drop, and the drop asks what should happen there (proposal-editor-shell.js
// chooseRuleDrop): convert to one Freeform building kept here, run the same rule on the parcels
// here, or cancel, which puts it back.
function startBlockifyMassMove(event) {
    const originalTarget = event?.originalEvent?.target;
    if (!event?.latlng || (originalTarget?.closest?.('.polygon-geometry-editor__vertex, .polygon-geometry-editor__delete-marker, .map-shell-button, button, input, label'))) return;
    if (!generatedBuildingFeature?.geometry || blockifyDragState || blockifyMode === 'existing') return;
    L.DomEvent?.stopPropagation?.(event);
    if (event?.originalEvent && typeof event.originalEvent.preventDefault === 'function') event.originalEvent.preventDefault();
    blockifyDragState = {
        start: event.latlng,
        point: event.latlng,
        feature: blockifyClone(generatedBuildingFeature),
        last: blockifyClone(generatedBuildingFeature),
        wasMapDraggingEnabled: blockifyMap?.dragging?.enabled?.() !== false
    };
    clearGapWingHandles();
    if (blockifyPolygonEditor) {
        blockifyPolygonEditor.destroy();
        blockifyPolygonEditor = null;
    }
    blockifyMap.dragging.disable();
    document.addEventListener('mousemove', moveBlockifyMass);
    document.addEventListener('mouseup', finishBlockifyMassMove);
    document.addEventListener('touchmove', moveBlockifyMass, { passive: false });
    document.addEventListener('touchend', finishBlockifyMassMove);
    document.addEventListener('touchcancel', finishBlockifyMassMove);
}

function moveBlockifyMass(event) {
    if (!blockifyDragState || !blockifyMap) return;
    const pointer = blockifyPointerEvent(event);
    const point = blockifyMap.containerPointToLatLng(blockifyMap.mouseEventToContainerPoint(pointer));
    const moved = window.SingleBuildingGeometry?.moveGeometry?.(blockifyDragState.feature.geometry, blockifyDragState.start, point);
    if (!moved) return;
    const candidate = blockifyClone(blockifyDragState.feature);
    candidate.geometry = moved;
    blockifyDragState.last = candidate;
    blockifyDragState.point = point;
    displayBuildingInModal(candidate);
}

function blockifyStopMassMoveListeners(drag) {
    if (drag.wasMapDraggingEnabled) blockifyMap?.dragging?.enable?.();
    document.removeEventListener('mousemove', moveBlockifyMass);
    document.removeEventListener('mouseup', finishBlockifyMassMove);
    document.removeEventListener('touchmove', moveBlockifyMass);
    document.removeEventListener('touchend', finishBlockifyMassMove);
    document.removeEventListener('touchcancel', finishBlockifyMassMove);
}

// The parcels a dropped Block stands on: those mostly inside its moved site outline
// (proposals/freeform-conversion.js parcelsMostlyInside), roads excluded.
function blockifyParcelsUnderOutline(outline) {
    const fabric = window.LiveParcelFabric;
    const conversion = window.__freeformConversion;
    const order = window.__planOrder;
    if (!outline?.geometry || !fabric?.queryBounds || !conversion || !order?.intersectionArea) return [];
    const candidates = fabric.queryBounds(turf.bbox(outline), { includeCorridors: false })
        .filter(feature => !(typeof window.isRoadParcel === 'function' && window.isRoadParcel(fabric.featureId(feature))))
        .map(feature => ({ id: fabric.featureId(feature), feature }));
    return conversion.parcelsMostlyInside(outline, candidates, {
        intersectionArea: order.intersectionArea,
        area: feature => turf.area(feature)
    });
}

// Run the Block rule, with every current parameter, on the parcels under the dropped outline. A
// rule that cannot build there is refused with the reason, and the editor stays where it was.
function blockifyRuleAtOutline(outline) {
    const ids = blockifyParcelsUnderOutline(outline);
    if (!ids.length) {
        return { ok: false, reason: translateBuildingText('proposalDrafts.freeform.noParcelsHere', 'No parcel lies mostly inside the dropped outline.') };
    }
    const resolve = typeof window.resolveDesignParcelFeature === 'function'
        ? window.resolveDesignParcelFeature
        : id => window.LiveParcelFabric?.get?.(id);
    const features = ids.map(id => resolve(id)).filter(Boolean);
    let superparcel = features.length === ids.length ? robustUnion(features) : null;
    superparcel = superparcel ? (toSingleLargestPolygon(sanitizePolygonFeature(superparcel) || superparcel) || superparcel) : null;
    const ring = superparcel?.geometry
        ? blockRingOutline(superparcel, superparcel, { setback: currentSetback, width: currentBuildingWidth, simplifyM: currentSimplifyM })
        : null;
    if (!ring) {
        return { ok: false, reason: translateBuildingText('proposalDrafts.freeform.ruleFailedHere', 'The {{rule}} rule cannot build a building on the parcels here.', { rule: window.ruleDropLabel?.('block') || 'Block' }) };
    }
    blockifyHistory?.record?.();
    blockifyBlock = { parcels: ids, parcelIds: ids, syntheticSite: false, site: null, valid: true, polygon: null };
    blockifyAuthoredSite = null;
    blockifyGenerationSite = robustUnion(features);
    blockifyBlockNameOverride = describeParcelSelection(ids);
    // The design's land moves with the rule (proposal-editor-shell.js moveActiveDesignToParcels).
    window.moveActiveDesignToParcels?.(ids);
    if (blockifyMode === 'manual') exitToParametricMode();
    displayBlockOnMap(blockifyBlock);
    generateBuildingInModal();
    return { ok: true };
}

// "Convert to Freeform building" in the Block editor: the block as the rule produces it now becomes
// one Freeform building where it stands, and the editor closes as Done does, which saves it.
async function convertBlockifyToFreeform() {
    if (!generatedBuildingFeature?.geometry && !generatedBuildingFeatures?.length) return;
    const features = blockifyMode === 'existing'
        ? blockifyClone(generatedBuildingFeatures || [])
        : [window.UrbanRuleVariation.massingWithRule(generatedBuildingFeature, currentBlockRule(), blockVariationSeed, { turf })];
    const boundary = blockifyDesignBoundary();
    const result = await window.convertActiveDesignToFreeform?.({
        features,
        typology: 'block',
        site: window.__siteDraft?.siteFromFeatures?.([boundary?.geometry ? boundary : features[0]])
    });
    if (result?.ok) {
        closeBlockifyModal({ preservePending: true });
        return;
    }
    if (result?.cancelled) return;
    setBlockifyInfo(null, result?.reason || translateBuildingText('proposalDrafts.freeform.noBuildings', 'This design has no buildings to keep.'));
}

async function finishBlockifyMassMove() {
    if (!blockifyDragState) return;
    const drag = blockifyDragState;
    blockifyDragState = null;
    blockifyStopMassMoveListeners(drag);
    const putBack = () => {
        generatedBuildingFeature = drag.feature;
        displayBuildingInModal(drag.feature);
        if (blockifyMode === 'manual') renderManualPolygonEditor();
        renderGapWingHandles();
    };
    if (!drag.last?.geometry || JSON.stringify(drag.last.geometry) === JSON.stringify(drag.feature.geometry)) {
        putBack();
        return;
    }
    const boundary = blockifyDesignBoundary();
    const movedOutline = boundary?.geometry
        ? { type: 'Feature', properties: {}, geometry: window.SingleBuildingGeometry.moveGeometry(boundary.geometry, drag.start, drag.point) }
        : null;
    const answer = typeof window.chooseRuleDrop === 'function'
        ? await window.chooseRuleDrop({
            typology: 'block',
            tryConvert: async () => {
                const result = await window.convertActiveDesignToFreeform({
                    features: [window.UrbanRuleVariation.massingWithRule(drag.last, currentBlockRule(), blockVariationSeed, { turf })],
                    site: window.__siteDraft?.siteFromFeatures?.([movedOutline || drag.last]),
                    typology: 'block',
                    confirm: false
                });
                if (result?.ok) closeBlockifyModal({ preservePending: true });
                return result;
            },
            tryRule: async () => blockifyRuleAtOutline(movedOutline)
        })
        : 'cancel';
    if (answer === 'cancel' && blockifyModal) putBack();
}

function describeParcelSelection(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return translateBuildingText('blockify.modal.messages.selectedParcels', 'Selected Parcels');
    if (ids.length === 1) return translateBuildingText('blockify.modal.messages.singleParcelLabel', 'Parcel {{id}}', { id: ids[0] });
    // The shared plural key: Croatian and Serbian need a different form for 2–4 parcels.
    return translateBuildingText('proposals.autoName.parcels', '{{count}} parcels', { count: ids.length });
}

const BLOCKIFY_ALGORITHMS = {
    'semi-open': {
        key: 'semi_open',
        nameFallback: '80s European, semi-open blocks',
        descriptionFallback: 'Perimeter blocks following the parcel shapes, opened by gaps between the buildings, courtyards in the middle, like European urban blocks of the 1980s.'
    },
    'fully-closed': {
        key: 'fully_closed', // do we need separate types for park inside vs garage inside?
        nameFallback: 'Central European fully closed',
        descriptionFallback: 'Fully enclosed blocks, closely following parcel shapes, no gaps, courtyards in the middle, like in Central European cities.'
    },
    'one-side-open': {
        key: 'one_side_open',
        nameFallback: 'One side open',
        descriptionFallback: 'Blocks enclosed from three sides, one side is open.'
    },
    'circular': {
        key: 'circular',
        nameFallback: 'Circular',
        descriptionFallback: 'Rounded blocks that do not follow parcel shapes closely.'
    },
    'buenos-aires-protruding': {
        key: 'buenos_aires_protruding',
        nameFallback: 'Buenos Aires protruding',
        descriptionFallback: 'Blocks that do not have uniform sides, but allow building towards the center of the courtyard with protruding shapes, when distances from other sides are enough. Inspired by Buenos Aires.'
    }
};

function getBlockifyAlgorithmTranslation(value, type) {
    const entry = BLOCKIFY_ALGORITHMS[value];
    if (!entry) return '';
    const translationKey = `blockify.modal.algorithms.${entry.key}.${type}`;
    const fallback = entry[`${type}Fallback`] || '';
    return translateBuildingText(translationKey, fallback);
}

function getBlockifyAlgorithmName(value) {
    const name = getBlockifyAlgorithmTranslation(value, 'name');
    return name || value;
}

function getBlockifyAlgorithmDescription(value) {
    return getBlockifyAlgorithmTranslation(value, 'description');
}

function setBlockifyInfo(key, fallback, params = {}) {
    const infoElement = document.getElementById('blockify-info');
    if (!infoElement) return;
    if (key) {
        infoElement.setAttribute('data-i18n-key', key);
        infoElement.setAttribute('data-i18n-attr', 'text');
    } else {
        infoElement.removeAttribute('data-i18n-key');
    }
    if (params && Object.keys(params).length > 0) {
        try {
            infoElement.setAttribute('data-i18n-params', JSON.stringify(params));
        } catch (_) {
            infoElement.removeAttribute('data-i18n-params');
        }
    } else {
        infoElement.removeAttribute('data-i18n-params');
    }
    infoElement.textContent = translateBuildingText(key, fallback, params);
}

function setBlockifyFitWarning(visible) {
    const warning = document.getElementById('blockify-fit-warning');
    if (warning) warning.hidden = !visible;
}

// --- Geometry utilities to improve robustness ---
// Robust footprint geometry (sanitizePolygonFeature, robustNegativeBuffer, robustUnion,
// toSingleLargestPolygon, the selective chamfer + incrementalInsetPolygon, and the GEOM_* consts)
// moved to frontend/js/footprint-geometry.js (loaded first) and is now unit-tested. Callers here
// and in row-house/single-building/parcel-based/proposals-geometry use the globals unchanged.

function updateBlockifyButton() {
    // Use the updateBlockButtonStates function in index.html to handle all button states
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    } else {
        // Fallback if the function doesn't exist yet (to prevent errors during page load)
        const blockifyButton = document.getElementById('blockifyButton');
        if (!blockifyButton) return;
        const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
        const showBlocks = parcelBlocksCheckbox ? parcelBlocksCheckbox.checked : false;
        blockifyButton.style.display = showBlocks && selectedBlockName ? 'inline-block' : 'none';
    }
}

// A generation error over the open editor: the app's alert (js/ui/dialogs.js), whose confirm rung
// sits above the editor dialog, so it is seen while the editor is still open.
function showErrorPopup(message) {
    window.CbDialog.alert(message);
}

// Update the highlightBlock function to handle blockify button
const originalHighlightBlock = highlightBlock;
highlightBlock = function (blockName) {
    selectedBlockName = blockName;
    window.selectedBlockName = selectedBlockName;
    updateBlockifyButton();
    originalHighlightBlock(blockName);
};

// Update the toggleLayer function to handle blockify button
// Wait for toggleLayer to be available on window
(function () {
    // Wait for map-controls.js to load and define toggleLayer
    function wrapToggleLayer() {
        if (typeof window.toggleLayer === 'function') {
            const originalToggleLayer = window.toggleLayer;
            window.toggleLayer = function (layerType) {
                originalToggleLayer(layerType);
                if (layerType === 'blocks') {
                    // updateBlockifyButton(); // This is now called by updateBlockButtonStates, which is called by toggleAccordion
                }
            };
        } else {
            // If not available yet, try again after a short delay
            setTimeout(wrapToggleLayer, 10);
        }
    }
    wrapToggleLayer();
})();

// Add these variables at the top with other layer variables
let proposedBuildingLayer = null;
let proposedBuildings = [];
// Expose globally so other modules (e.g., 3D mode) can consume proposed buildings
if (typeof window !== 'undefined') {
    try { window.proposedBuildings = proposedBuildings; } catch (_) { }
}

function ensureProposedBuildingsState() {
    // Other proposal modules clear/rebuild this derived collection through the shared window
    // binding. Adopt that replacement instead of immediately publishing the stale lexical array
    // back onto window; doing the latter resurrected the just-cleared building during boot replay.
    if (typeof window !== 'undefined'
        && Array.isArray(window.proposedBuildings)
        && window.proposedBuildings !== proposedBuildings) {
        proposedBuildings = window.proposedBuildings;
    }
    if (!Array.isArray(proposedBuildings)) {
        proposedBuildings = [];
    }
    if (typeof window !== 'undefined') {
        try { window.proposedBuildings = proposedBuildings; } catch (_) { }
    }
    return proposedBuildings;
}

function getProposedBuildingIndexById(proposalId, buildingIndex = null) {
    if (!proposalId) return -1;
    const list = ensureProposedBuildingsState();
    const normalizedId = String(proposalId);
    const normalizedIndex = buildingIndex === null || buildingIndex === undefined ? null : Number(buildingIndex);

    for (let i = 0; i < list.length; i++) {
        const candidate = list[i];
        if (!candidate || !candidate.properties) continue;
        const sameId = String(candidate.properties.proposalId) === normalizedId;
        if (!sameId) continue;
        if (normalizedIndex === null) {
            return i;
        }
        const candidateIndex = candidate.properties.buildingIndex;
        if (candidateIndex !== undefined && candidateIndex !== null && Number(candidateIndex) === normalizedIndex) {
            return i;
        }
    }

    return -1;
}

// No `save`: the proposed-building list is DERIVED from the applied proposals and rebuilt by
// the replay, so there has never been anything here to persist. The option used to be passed
// through to saveExecutedBuildingsToStorage(), a function that does not exist in this codebase
// and never has — both call sites were typeof-guarded, so a `save: true` read as persistence
// happening and was a no-op.
function upsertProposedBuildingFeature(feature, { updateLayer = true } = {}) {
    if (!feature || typeof feature !== 'object' || !feature.properties || !feature.properties.proposalId) {
        return false;
    }
    if (!feature.properties.proposalState) {
        feature.properties.proposalState = 'applied';
    }
    const list = ensureProposedBuildingsState();
    const normalizedId = String(feature.properties.proposalId);

    // Prefer geometry-based matching when possible (avoids collisions when buildingIndex is duplicated or missing).
    let geomKey = null;
    try { geomKey = feature.geometry ? JSON.stringify(feature.geometry) : null; } catch (_) { geomKey = null; }
    if (geomKey) {
        for (let i = 0; i < list.length; i++) {
            const candidate = list[i];
            if (!candidate || !candidate.properties) continue;
            if (String(candidate.properties.proposalId) !== normalizedId) continue;
            try {
                const candidateKey = candidate.geometry ? JSON.stringify(candidate.geometry) : null;
                if (candidateKey && candidateKey === geomKey) {
                    // Preserve a stable index if present on the existing record.
                    const existingIdx = candidate.properties.buildingIndex;
                    if (existingIdx !== undefined && existingIdx !== null && isFinite(Number(existingIdx))) {
                        feature.properties.buildingIndex = Number(existingIdx);
                    }
                    list[i] = feature;
                    if (typeof window !== 'undefined') {
                        try { window.proposedBuildings = list; } catch (_) { }
                        try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
                    }
                    if (updateLayer && typeof updateProposedBuildingsLayer === 'function') {
                        updateProposedBuildingsLayer();
                    }
                    return true;
                }
            } catch (_) { /* ignore */ }
        }
    }

    // Legacy/compat: if buildingIndex is missing, assign a stable one so multiple
    // geometries for the same proposal don't overwrite each other and don't duplicate on reload.
    const rawBuildingIndex = feature.properties.buildingIndex;
    const hasValidIndex = rawBuildingIndex !== undefined
        && rawBuildingIndex !== null
        && isFinite(Number(rawBuildingIndex));
    if (!hasValidIndex) {
        let resolvedIndex = null;
        try {
            const matchKey = geomKey;
            if (matchKey) {
                const match = list.find(candidate => {
                    if (!candidate || !candidate.properties) return false;
                    if (String(candidate.properties.proposalId) !== normalizedId) return false;
                    const idx = candidate.properties.buildingIndex;
                    if (idx === undefined || idx === null || !isFinite(Number(idx))) return false;
                    try {
                        return candidate.geometry && JSON.stringify(candidate.geometry) === matchKey;
                    } catch (_) {
                        return false;
                    }
                });
                if (match && match.properties && isFinite(Number(match.properties.buildingIndex))) {
                    resolvedIndex = Number(match.properties.buildingIndex);
                }
            }
        } catch (_) { /* best-effort */ }

        if (resolvedIndex === null) {
            const used = new Set();
            list.forEach(candidate => {
                if (!candidate || !candidate.properties) return;
                if (String(candidate.properties.proposalId) !== normalizedId) return;
                const idx = candidate.properties.buildingIndex;
                if (idx !== undefined && idx !== null && isFinite(Number(idx))) {
                    used.add(Number(idx));
                }
            });
            let next = 0;
            while (used.has(next)) next += 1;
            resolvedIndex = next;
        }

        feature.properties.buildingIndex = resolvedIndex;
    } else if (typeof feature.properties.buildingIndex !== 'number') {
        feature.properties.buildingIndex = Number(feature.properties.buildingIndex);
    }

    let index = getProposedBuildingIndexById(normalizedId, feature.properties.buildingIndex);
    if (index > -1 && geomKey) {
        // Guard: if buildingIndex collides but geometry differs, assign a new index instead of overwriting.
        try {
            const existing = list[index];
            const existingKey = existing && existing.geometry ? JSON.stringify(existing.geometry) : null;
            if (existingKey && existingKey !== geomKey) {
                const used = new Set();
                list.forEach(candidate => {
                    if (!candidate || !candidate.properties) return;
                    if (String(candidate.properties.proposalId) !== normalizedId) return;
                    const idx = candidate.properties.buildingIndex;
                    if (idx !== undefined && idx !== null && isFinite(Number(idx))) {
                        used.add(Number(idx));
                    }
                });
                let next = 0;
                while (used.has(next)) next += 1;
                feature.properties.buildingIndex = next;
                index = -1;
            }
        } catch (_) { /* best-effort */ }
    }

    if (index > -1) {
        list[index] = feature;
    } else {
        list.push(feature);
    }

    if (typeof window !== 'undefined') {
        try { window.proposedBuildings = list; } catch (_) { }
        try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
    }

    if (updateLayer && typeof updateProposedBuildingsLayer === 'function') {
        updateProposedBuildingsLayer();
    }
    return true;
}

function removeProposedBuildingFeature(proposalId, { updateLayer = true } = {}) {
    if (!proposalId) return false;
    const normalizedId = String(proposalId);
    const list = ensureProposedBuildingsState();
    const initialLength = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
        const candidate = list[i];
        if (candidate && candidate.properties && String(candidate.properties.proposalId) === normalizedId) {
            list.splice(i, 1);
        }
    }

    if (list.length !== initialLength) {
        if (typeof window !== 'undefined') {
            try { window.proposedBuildings = list; } catch (_) { }
            try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
        }
        if (updateLayer && typeof updateProposedBuildingsLayer === 'function') {
            updateProposedBuildingsLayer();
        }
        return true;
    }
    return false;
}

function getProposedBuildingFeature(proposalId) {
    const index = getProposedBuildingIndexById(proposalId);
    if (index > -1) {
        return ensureProposedBuildingsState()[index];
    }
    return null;
}

function markProposedBuildingState(proposalId, state, { updateLayer = true } = {}) {
    if (!proposalId) return false;
    const list = ensureProposedBuildingsState();
    const normalizedId = String(proposalId);
    let changed = false;
    for (let i = 0; i < list.length; i++) {
        const feature = list[i];
        if (!feature || !feature.properties) continue;
        if (String(feature.properties.proposalId) !== normalizedId) continue;
        feature.properties = {
            ...feature.properties,
            proposalState: state || feature.properties.proposalState || 'applied'
        };
        if (state === 'executed') {
            feature.properties.type = 'executed_proposal';
        } else if (state === 'unapplied') {
            if (feature.properties.type === 'executed_proposal') {
                delete feature.properties.type;
            }
        }
        changed = true;
    }

    if (!changed) return false;

    if (typeof window !== 'undefined') {
        try { window.proposedBuildings = list; } catch (_) { }
        try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
    }

    if (updateLayer && typeof updateProposedBuildingsLayer === 'function') {
        updateProposedBuildingsLayer();
    }
    return true;
}

if (typeof window !== 'undefined') {
    window.upsertProposedBuildingFeature = upsertProposedBuildingFeature;
    window.removeProposedBuildingFeature = removeProposedBuildingFeature;
    window.getProposedBuildingFeature = getProposedBuildingFeature;
    window.markProposedBuildingState = markProposedBuildingState;
}
let blockifyDebugLayer = null;

function deepCloneBuildingFeature(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(raw));
    } catch (_) {
        return null;
    }
}

function hydrateProposedBuildingsFromProposals() {
    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return { added: 0 };

    const proposals = proposalStorage.getAllProposals();
    let added = 0;

    // Active-city scope: applied proposals are stored globally, so without this a Zagreb
    // building proposal would hydrate (and poison the nearby-3D-buildings query) in an NYC session.
    const cityId = (typeof window !== 'undefined' && window.CityConfigManager
            && typeof window.CityConfigManager.getCurrentCityId === 'function')
        ? window.CityConfigManager.getCurrentCityId() : null;
    const isInCityFn = (typeof isInCity === 'function') ? isInCity
        : ((typeof window !== 'undefined' && typeof window.isInCity === 'function') ? window.isInCity : null);

    proposals.forEach(p => {
        if (!p || !p.buildingProposal) return;

        if (!isApplied(p, p.buildingProposal)) return;

        if (cityId && isInCityFn) {
            const cityIds = Array.isArray(p.cadastreParcelIds) ? p.cadastreParcelIds : [];
            if (cityIds.length && !cityIds.some(id => isInCityFn(id, cityId))) return;
        }

        const proposalId = p.proposalId || p.id;
        if (!proposalId) return;

        const bp = p.buildingProposal;
        const features = Array.isArray(p.geometry && p.geometry.buildings) ? p.geometry.buildings : [];

        if (!features.length) return;

        // Same lifecycle rule as the apply path (proposals/apply/buildings.js). This used to read a
        // bare `status`, which in a browser silently resolves to window.status (the legacy
        // status-bar string, '') — so an EXECUTED proposal's buildings came back stamped '' and were
        // relabelled 'applied' downstream, and outside a browser it was a hard ReferenceError.
        const status = (typeof getLifecycleStatus === 'function' && getLifecycleStatus(p) === 'Executed')
            ? 'executed'
            : 'applied';

        // Base props should act as defaults only. Per-building properties (parcelId, buildingIndex, etc.)
        // must NOT be overridden by proposal-level buildingProperties; otherwise we can collapse multiple
        // buildings into one on reload (e.g. 5 buildings -> 4).
        const baseProps = {
            cadastreParcelIds: Array.isArray(p.cadastreParcelIds) ? p.cadastreParcelIds.slice() : [],
            title: p.title || null,
            author: p.author || null
        };
        // Remove known per-building identifiers from proposal-level defaults.
        delete baseProps.buildingIndex;
        delete baseProps.parcelId;
        delete baseProps.parcel_id;

        features.forEach((raw, idx) => {
            const clone = deepCloneBuildingFeature(raw);
            if (!clone || !clone.geometry) return;
            // Merge base first, then per-building properties override.
            const props = { ...baseProps, ...(clone.properties || {}) };

            // Always stamp proposal identity/state on the hydrated feature (don't trust stored props).
            props.proposalId = proposalId;
            props.proposalState = status;

            // Ensure buildingIndex is a valid number; fallback to loop index.
            if (props.buildingIndex === undefined || props.buildingIndex === null || !isFinite(Number(props.buildingIndex))) {
                props.buildingIndex = idx;
            } else if (typeof props.buildingIndex !== 'number') {
                props.buildingIndex = Number(props.buildingIndex);
            }
            const hydrated = {
                type: 'Feature',
                geometry: clone.geometry,
                properties: props
            };
            if (upsertProposedBuildingFeature(hydrated, { updateLayer: false })) {
                added += 1;
            }
        });
    });

    return { added };
}

// Hydrate executed/apply-time buildings from proposal storage
function loadExecutedBuildingsFromStorage() {
    try {
        const list = ensureProposedBuildingsState();

        // Ensure applied/executed proposals rehydrate their buildings (guards against cache misses)
        const { added } = hydrateProposedBuildingsFromProposals();
        if (added > 0) {
            console.log(`Hydrated ${added} building feature(s) from applied proposals`);
        }

        // Prune stale/duplicate legacy entries:
        // - Keep only buildings for proposals that are currently applied/executed
        // - If we know how many buildings a proposal has, drop out-of-range indices
        // - Drop exact geometry duplicates per proposal (prevents "darker" overlap on reload)
        try {
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
                const proposals = proposalStorage.getAllProposals();
                const activeBuildingCounts = new Map(); // proposalId -> count (0 means unknown)
                proposals.forEach(p => {
                    if (!p || !p.buildingProposal) return;
                    if (!isApplied(p, p.buildingProposal)) return;
                    const pid = p.proposalId || p.id;
                    if (!pid) return;
                    const count = Array.isArray(p.geometry && p.geometry.buildings) ? p.geometry.buildings.length : 0;
                    activeBuildingCounts.set(String(pid), count);
                });

                if (activeBuildingCounts.size > 0 && Array.isArray(list) && list.length > 0) {
                    const seenGeom = new Map(); // proposalId -> Set(geomKey)
                    const filtered = [];
                    list.forEach(feature => {
                        if (!feature || !feature.properties || !feature.properties.proposalId) return;
                        const pid = String(feature.properties.proposalId);
                        if (!activeBuildingCounts.has(pid)) return;

                        // NOTE: Do NOT drop buildings based on buildingIndex ranges.
                        // Some generators use 1-based indexes, and older stored features can carry
                        // gaps/out-of-range indexes. Dropping here causes "missing 1 building after reload".
                        // We only drop exact geometry duplicates (see below) and buildings for inactive proposals.

                        let geomKey = null;
                        try { geomKey = feature.geometry ? JSON.stringify(feature.geometry) : null; } catch (_) { geomKey = null; }
                        if (geomKey) {
                            const set = seenGeom.get(pid) || new Set();
                            if (set.has(geomKey)) return;
                            set.add(geomKey);
                            seenGeom.set(pid, set);
                        }

                        filtered.push(feature);
                    });

                    if (filtered.length !== list.length) {
                        list.length = 0;
                        filtered.forEach(f => list.push(f));
                        if (typeof window !== 'undefined') {
                            try { window.proposedBuildings = list; } catch (_) { }
                            try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
                        }
                    }
                }
            }
        } catch (_) { /* best-effort prune only */ }

        if (typeof window !== 'undefined') { window.proposedBuildings = list; }

        // The paved/green surround of a freeform proposal belongs to the proposal, not to the
        // buildings layer, so it is painted on load regardless of the buildings checkbox below.
        if (typeof window !== 'undefined') {
            try { window.updateBuildingGroundLayer?.(); } catch (error) { console.error('[buildings] ground surface hydration failed', error); }
        }

        // Applied buildings are part of the map, so a reload must show them — exactly as applying
        // one does (every creation path ticks this box). #showProposedBuildings is a session toggle
        // with no persisted OFF state: it starts unchecked on every load, so gating the first render
        // on it meant an applied building proposal silently vanished on refresh while roads, which
        // have no such gate, came back. The proposal itself was in storage all along.
        if (list.length > 0) {
            const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
            if (showProposedBuildingsCheckbox) showProposedBuildingsCheckbox.checked = true;
            // Use setTimeout to ensure map is ready
            setTimeout(() => {
                updateProposedBuildingsLayer();
            }, 100);
        }

    } catch (error) {
        console.error('Error hydrating executed buildings:', error);
    }
}

function removeExecutedBuildingByProposalId(proposalId) {
    const removed = removeProposedBuildingFeature(proposalId, { updateLayer: true });
    if (removed) {
        console.log(`Removed stored building for proposal ${proposalId}`);
    }
    return removed;
}

// Hydrate executed buildings on page load
if (typeof PersistentStorage !== 'undefined' && typeof PersistentStorage.ensureReady === 'function') {
    try {
        PersistentStorage.ensureReady(loadExecutedBuildingsFromStorage);
    } catch (_) {
        loadExecutedBuildingsFromStorage();
    }
} else {
    loadExecutedBuildingsFromStorage();
}

// Add this function to update the proposed buildings layer
// The explicitly recorded parts of an APPLIED urban rule that it left out, as plain features.
// One collector is read by both the 2D layer and the 3D view, so they cannot disagree. Ground
// identity remains flat: the proposal records the excluded plot's authored geometry, so this
// presentation adapter never has to retain or resolve the disposable live parcel that happened to
// be present while the rule was authored.
function appliedIneligibleBlockParts(onlyProposalId) {
    const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
    if (!store || typeof store.getAllProposals !== 'function') return [];
    const collector = (typeof window !== 'undefined' && window.IneligibleBlockParts)
        ? window.IneligibleBlockParts.collectAppliedIneligibleBlockParts
        : null;
    if (typeof collector !== 'function') return [];
    const standing = record => (typeof window.isProposalApplied === 'function')
        ? window.isProposalApplied(record)
        : !!(record && record.applied === true);
    return collector({
        records: store.getAllProposals(),
        isApplied: standing,
        onlyProposalId
    });
}
if (typeof window !== 'undefined') window.appliedIneligibleBlockParts = appliedIneligibleBlockParts;
// NOT `window.withProposedBuildingsRefreshHeld = run => withProposedBuildingsRefreshHeld(run)`.
// This is a classic script, so the top-level `function withProposedBuildingsRefreshHeld` IS
// window.withProposedBuildingsRefreshHeld already. Assigning a wrapper that calls the bare name
// makes the name resolve to the wrapper — the function becomes a call to itself, and the first
// replay dies with "Maximum call stack size exceeded" before it applies anything. Nothing to
// publish here: the declaration published it.

// Rebuilding the proposed-buildings layer means throwing the whole layer away and drawing every
// building of every applied proposal again. That happens once per apply, which over a replay is
// quadratic: applying the 180th proposal redraws the 179 before it, and the burst is synchronous
// Leaflet/SVG work, so the map cannot paint or answer the mouse until it finishes.
//
// Held for the length of a batch and run ONCE at the end. Same shape as the corridor-strip hold in
// corridor-render.js, including the missed flag — a refresh skipped while held must still happen,
// or the map quietly ends up showing fewer buildings than are applied.
let proposedBuildingsRefreshHeld = 0;
let proposedBuildingsRefreshMissed = false;

async function withProposedBuildingsRefreshHeld(run) {
    proposedBuildingsRefreshHeld += 1;
    try {
        return await run();
    } finally {
        proposedBuildingsRefreshHeld -= 1;
        if (!proposedBuildingsRefreshHeld && proposedBuildingsRefreshMissed) {
            proposedBuildingsRefreshMissed = false;
            updateProposedBuildingsLayer();
        }
    }
}

// One proposal's buildings, in their own sub-layer.
//
// This is the answer to "why does a proposal not just draw itself?" — it now does. The layer used
// to be a single flat group rebuilt from the whole applied set, so applying one proposal redrew
// every building already on the map: quadratic in the plan's own size, and all of it synchronous
// Leaflet work. A sub-layer per proposal means an apply costs its own buildings and nothing else,
// and unapplying one drops exactly its group.
const proposedBuildingSublayers = new Map();

const PROPOSED_BUILDING_STYLE = {
    // Deep blue, matching the 3D proposed-building material (0x1e3a8a body / 0x1d4ed8 roof) — it
    // used to be the EXACT #ff3300 of selectedParcelStyle, so every placed building read as a
    // permanently selected parcel.
    fillColor: '#1d4ed8',
    fillOpacity: 0.45,
    color: '#1e3a8a',
    weight: 2
};
// The PLOT is hatched so it never reads as empty ground, and the building it would carry is drawn
// over it dashed — the 2D half of the statement the 3D view makes with a see-through volume: this
// is what belongs here, and nothing is built.
const INELIGIBLE_PLOT_STYLE = { fillColor: '#b0453a', fillOpacity: 0.14, color: '#b0453a', weight: 1.5, dashArray: '2, 5' };
const INELIGIBLE_MASS_STYLE = { fillColor: '#8a8f98', fillOpacity: 0.25, color: '#4b5563', weight: 2, dashArray: '6, 4' };

// One canvas for every proposed building, in a pane of its own.
//
// These 725+ polygons were the LAST bulk of the map-level SVG: each drawn with the default
// renderer, so every drag re-composited them and mapLoad kept fingering overlayPane. They are
// interactive:false decoration — the exact opposite of the corridor hit targets, which need SVG for
// its per-path pointer events. A pane above the parcels (400) and below the corridor strips (655)
// keeps today's paint order; pointer-events none keeps the canvas from ever swallowing a click,
// which is the invariant that put the hit targets back on SVG.
let _proposedBuildingCanvas = null;
function proposedBuildingCanvas() {
    if (_proposedBuildingCanvas) return _proposedBuildingCanvas;
    if (typeof map === 'undefined' || !map || typeof L === 'undefined' || typeof L.canvas !== 'function') return undefined;
    try {
        let pane = map.getPane('proposedBuildingsPane');
        if (!pane && typeof map.createPane === 'function') pane = map.createPane('proposedBuildingsPane');
        if (pane && pane.style) {
            pane.style.zIndex = '645';
            pane.style.pointerEvents = 'none';
        }
        _proposedBuildingCanvas = L.canvas({ pane: 'proposedBuildingsPane', padding: 0.5 });
    } catch (_) { return undefined; }
    return _proposedBuildingCanvas;
}

function ensureProposedBuildingLayer() {
    if (!proposedBuildingLayer) {
        proposedBuildingLayer = L.featureGroup().addTo(map);
    }
    return proposedBuildingLayer;
}

// 3D and the photoreal carve read the WHOLE set rather than a diff, so they still want one
// announcement per change — which is what the hold coalesces during a batch.
function announceProposedBuildings() {
    if (typeof window === 'undefined') return;
    try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
    // The paved/green surround of a freeform proposal follows its buildings on and off the map.
    try { window.updateBuildingGroundLayer?.(); } catch (error) { console.error('[buildings] ground surface refresh failed', error); }
}

function proposedBuildingKey(value) {
    return value === undefined || value === null ? '' : String(value);
}

function drawProposedBuildingsForProposal(proposalId, { announce = true } = {}) {
    if (typeof map === 'undefined' || !map) return false;
    const id = proposedBuildingKey(proposalId);
    ensureProposedBuildingLayer();

    const previous = proposedBuildingSublayers.get(id);
    if (previous) {
        try { proposedBuildingLayer.removeLayer(previous); } catch (_) { }
        proposedBuildingSublayers.delete(id);
    }

    const group = L.featureGroup();
    // Drawn even when the rule permitted no buildings at all: a block that left every plot out is
    // still a block, and an empty map would be the least explicable outcome of the three.
    appliedIneligibleBlockParts(id).forEach(part => {
        try {
            const isPlot = part.properties && part.properties.kind === 'plot';
            L.geoJSON(part, {
                style: isPlot ? INELIGIBLE_PLOT_STYLE : INELIGIBLE_MASS_STYLE,
                interactive: false,
                pane: 'proposedBuildingsPane',
                renderer: proposedBuildingCanvas()
            }).addTo(group);
        } catch (error) {
            console.warn('[buildings] could not draw a non-buildable plot', part?.properties?.parcelId, error);
        }
    });

    const list = ensureProposedBuildingsState();
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const building = list[index];
        if (!building || !building.properties) continue;
        if (proposedBuildingKey(building.properties.proposalId) !== id) continue;
        try {
            // The same rule realization and salt drive the map and model; source records stay intact.
            const state = window.PlanningViews.getState();
            const plan = window.UrbanRuleVariation.plannedDrawPlan(building, state.proposedForm, { turf }, state.proposedVariation);
            for (const [feature, envelope] of [[plan.massing, plan.massingStyle === 'envelope'], [plan.buildOut, false]]) {
                if (!feature) continue;
                L.geoJSON(feature, {
                    style: { ...PROPOSED_BUILDING_STYLE, color: window.PlanningViews.color('proposed'),
                        fillColor: window.PlanningViews.color('proposed'),
                        fillOpacity: envelope ? 0.12 : 1 },
                    interactive: false, pane: 'proposedBuildingsPane', renderer: proposedBuildingCanvas()
                }).addTo(group);
            }
        } catch (error) {
            console.error(`Error rendering proposed building at index ${index}:`, error, building);
            // A display failure cannot delete a proposal's source geometry.
            showErrorPopup(translateBuildingText(
                'blockify.modal.messages.renderingFailed',
                'Building block creation failed -- Error rendering the generated building shape. The parcel might be too complex.'
            ));
        }
    }

    group.addTo(proposedBuildingLayer);
    proposedBuildingSublayers.set(id, group);

    if (!announce) return true;
    if (proposedBuildingsRefreshHeld) proposedBuildingsRefreshMissed = true;
    else announceProposedBuildings();
    return true;
}

// Every proposal redrawn. Still needed — a removal, a state change or a boot has no single proposal
// to redraw — but it is now expressed as "draw each one", so the incremental path and the full one
// cannot drift apart.
function updateProposedBuildingsLayer({ announce = true } = {}) {
    if (proposedBuildingsRefreshHeld) {
        proposedBuildingsRefreshMissed = true;
        return;
    }
    if (proposedBuildingLayer) {
        map.removeLayer(proposedBuildingLayer);
        proposedBuildingLayer = null;
    }
    proposedBuildingSublayers.clear();

    const list = ensureProposedBuildingsState();
    // Announce every refresh, including one that empties the layer: unapplying the last proposed
    // building has to reach 3D and the photoreal carve too, or their meshes go stale.
    if (announce) announceProposedBuildings();

    const ids = [];
    const seen = new Set();
    const remember = value => {
        const key = proposedBuildingKey(value);
        if (seen.has(key)) return;
        seen.add(key);
        ids.push(key);
    };
    appliedIneligibleBlockParts().forEach(part => remember(part && part.properties && part.properties.proposalId));
    list.forEach(building => remember(building && building.properties && building.properties.proposalId));
    if (!ids.length) return;

    ensureProposedBuildingLayer();
    ids.forEach(id => drawProposedBuildingsForProposal(id, { announce: false }));
}

if (typeof window !== 'undefined') {
    window.drawProposedBuildingsForProposal = drawProposedBuildingsForProposal;
}

// THE block outline: a setback ring around the block, simplified, clipped back inside it, then
// inset to leave a courtyard. Both the urban-rule modal and the batch that puts a rule on every
// empty block call this, so a generated block and a hand-made one are the same object rather than
// two implementations that happen to agree today.
//
// Pure geometry in, geometry out: no sliders, no map, no modal state. The one thing a caller can
// hook is `onNarrowEdge`, which the modal uses to draw its debug line for the edge that stopped the
// inset — reporting, not deciding.
//
// Returns { outer, inner, widthAchieved, minSideLength } with `inner` null when the courtyard
// collapsed; the caller decides what a solid block means (the modal falls back to one).
// `minSideLength` is the narrow edge that stopped an inset, null when none did: it is copied into
// the building's properties, and a stored record cannot hold Infinity (JSON writes it as null).
function blockRingOutline(...args) { return window.BuildingRuleGeometry.blockRingOutline(...args); }
// Function to show the blockify modal
function showBlockifyModal() {
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        updateStatus(translateBuildingText('status.messages.no_block_selected', 'No block selected'));
        return false;
    }

    // Store the block globally for the modal
    blockifyBlock = block;
    let initialGeometryError = null;
    if (!blockifyGenerationSite) {
        try {
            blockifyGenerationSite = blockifyAuthoredSite || robustUnion(blockifyFeaturesForBlock(block));
        } catch (error) {
            // Keep the editor available for recovery, but never generate from a partial site.
            // Report the failure once its controls and error dialog are ready below.
            initialGeometryError = error;
        }
    }
    const blockLabel = getBlockifyDisplayName();

    console.log('[Blockify] showBlockifyModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

    // Build the specialized controls, then let the shared editor own the floating panel and map.
    if (!blockifyModal) {
        const container = document.createElement('div');
        container.id = 'blockify-container';

        const algorithmKeys = Object.keys(BLOCKIFY_ALGORITHMS);
        const defaultAlgo = algorithmKeys[0];
        const algorithmOptions = algorithmKeys.map(key => {
            const name = getBlockifyAlgorithmName(key);
            const entry = BLOCKIFY_ALGORITHMS[key];
            const i18nKey = `blockify.modal.algorithms.${entry.key}.name`;
            const selected = key === defaultAlgo ? 'selected' : '';
            return `<option value="${key}" ${selected} data-i18n-key="${i18nKey}">${name}</option>`;
        }).join('');

        const defaultDescKey = `blockify.modal.algorithms.${BLOCKIFY_ALGORITHMS[defaultAlgo].key}.description`;
        const defaultDesc = getBlockifyAlgorithmDescription(defaultAlgo);

        container.innerHTML = `
            <div id="blockify-sidebar">
                <div class="parameter-group blockify-freeform-only">
                    <label for="algorithm-select" data-i18n-key="blockify.modal.algorithmLabel">Algorithm:</label>
                    <select id="algorithm-select" disabled>
                        ${algorithmOptions}
                    </select>
                    <div id="algorithm-description" class="algorithm-description">
                        <span data-i18n-key="${defaultDescKey}">${defaultDesc}</span>
                    </div>
                </div>
                <section id="blockify-density-stats" class="building-density-card" aria-live="polite">
                    <h3 class="cb-kicker" data-i18n-key="densityStats.title" data-i18n-attr="text">Geometry statistics</h3>
                    <dl class="building-density-grid">
                        <div><dt data-i18n-key="densityStats.parcelArea" data-i18n-attr="text">Parcel area</dt><dd id="blockify-density-parcel">\u2014</dd></div>
                        <div><dt data-i18n-key="densityStats.footprint" data-i18n-attr="text">Building footprint</dt><dd id="blockify-density-footprint">\u2014</dd></div>
                        <div><dt data-i18n-key="densityStats.siteCoverage" data-i18n-attr="text">Site coverage (kig)</dt><dd id="blockify-density-coverage">\u2014</dd></div>
                        <div><dt data-i18n-key="densityStats.gbp" data-i18n-attr="text">Above-ground GBP</dt><dd id="blockify-density-gbp">\u2014</dd></div>
                        <div><dt data-i18n-key="densityStats.kin" data-i18n-attr="text">kin</dt><dd id="blockify-density-kin">\u2014</dd></div>
                    </dl>
                    <p id="blockify-density-hint" class="building-density-hint"></p>
                </section>
                <div class="parameter-group">
                    <label class="blockify-existing-toggle" for="blockify-existing-toggle">
                        <input type="checkbox" id="blockify-existing-toggle">
                        <span data-i18n-key="blockify.modal.existing.toggle" data-i18n-attr="text">Based on existing buildings</span>
                    </label>
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label class="blockify-rule-label" for="proposed-height-slider">
                        <input type="radio" id="blockify-rule-exact" name="blockify-existing-rule" value="exact" checked>
                        <span data-i18n-key="blockify.modal.existing.proposedHeight" data-i18n-attr="text">Proposed height (floors):</span>
                        <span id="proposed-height-value">${DEFAULT_PROPOSED_HEIGHT_FLOORS} (${CbFormat.formatLength(DEFAULT_PROPOSED_HEIGHT_FLOORS * DEFAULT_FLOOR_HEIGHT_M)})</span>
                    </label>
                    <input type="range" id="proposed-height-slider" min="1" max="20" value="${DEFAULT_PROPOSED_HEIGHT_FLOORS}" step="1">
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label class="blockify-rule-label" for="additional-floors-slider">
                        <input type="radio" id="blockify-rule-additional" name="blockify-existing-rule" value="additional">
                        <span data-i18n-key="blockify.modal.existing.additionalFloors" data-i18n-attr="text">Additional floors:</span>
                        <span id="additional-floors-value">${DEFAULT_ADDITIONAL_FLOORS}</span>
                    </label>
                    <input type="range" id="additional-floors-slider" min="1" max="20" value="${DEFAULT_ADDITIONAL_FLOORS}" step="1" disabled>
                </div>
                <div class="parameter-group blockify-existing-only" style="display:none">
                    <label for="floor-height-slider">
                        <span data-i18n-key="blockify.modal.existing.floorHeight" data-i18n-attr="text">Floor height (m):</span>
                        <span id="floor-height-value">${CbFormat.formatNumber(DEFAULT_FLOOR_HEIGHT_M, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="floor-height-slider" min="2.5" max="5" value="${DEFAULT_FLOOR_HEIGHT_M}" step="0.1">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="setback-slider">
                        <span data-i18n-key="blockify.modal.labels.setback" data-i18n-attr="text">Setback (m):</span>
                        <span id="setback-value">${CbFormat.formatNumber(DEFAULT_SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="setback-slider" min="0" max="50" value="${DEFAULT_SETBACK}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="chamfer-slider">
                        <span data-i18n-key="blockify.modal.labels.chamfer" data-i18n-attr="text">Chamfer (m):</span>
                        <span id="chamfer-value">${CbFormat.formatNumber(currentChamferM, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="chamfer-slider" min="0" max="10" value="${DEFAULT_CHAMFER_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="simplify-slider">
                        <span data-i18n-key="blockify.modal.labels.simplify" data-i18n-attr="text">Simplify (m):</span>
                        <span id="simplify-value">${CbFormat.formatNumber(currentSimplifyM, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="simplify-slider" min="0" max="20" value="${DEFAULT_SIMPLIFY_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="width-slider">
                        <span data-i18n-key="blockify.modal.labels.width" data-i18n-attr="text">Building Width (m):</span>
                        <span id="width-value">${CbFormat.formatNumber(DEFAULT_BUILDING_WIDTH, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="width-slider" min="1" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="height-slider">
                        <span data-i18n-key="blockify.modal.labels.height" data-i18n-attr="text">Building Height (m):</span>
                        <span id="height-value">${CbFormat.formatNumber(DEFAULT_BUILDING_HEIGHT, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                    </label>
                    <input type="range" id="height-slider" min="3" max="80" value="${DEFAULT_BUILDING_HEIGHT}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="blockify-ruletype-select" data-i18n-key="blockify.modal.labels.ruleType" data-i18n-attr="text">What the rule compels:</label>
                    <select id="blockify-ruletype-select">
                        <option value="exact" data-i18n-key="blockify.modal.labels.ruleTypeExact" data-i18n-attr="text">Exactly this height</option>
                        <option value="max" data-i18n-key="blockify.modal.labels.ruleTypeMax" data-i18n-attr="text">At most this height</option>
                        <option value="range" data-i18n-key="blockify.modal.labels.ruleTypeRange" data-i18n-attr="text">Between a minimum and this</option>
                    </select>
                </div>
                <div class="parameter-group blockify-freeform-only" id="blockify-minheight-group" style="display: none;">
                    <label for="blockify-minheight-slider">
                        <span data-i18n-key="blockify.modal.labels.minHeight" data-i18n-attr="text">Min Building Height (m):</span>
                        <span id="blockify-minheight-value">0.0</span>
                    </label>
                    <input type="range" id="blockify-minheight-slider" min="0" max="80" value="0" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only" id="blockify-mindepth-group" style="display: none;">
                    <label for="blockify-mindepth-slider">
                        <span data-i18n-key="blockify.modal.labels.minDepth" data-i18n-attr="text">Must build from street (m):</span>
                        <span id="blockify-mindepth-value">0.0</span>
                    </label>
                    <input type="range" id="blockify-mindepth-slider" min="0" max="100" value="0" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="blockify-minplot-slider">
                        <span data-i18n-key="blockify.modal.labels.minPlotArea" data-i18n-attr="text">Min Plot Size (m²):</span>
                        <span id="blockify-minplot-value">${DEFAULT_BLOCK_MIN_PLOT_AREA_M2}</span>
                    </label>
                    <input type="range" id="blockify-minplot-slider" min="0" max="10000" value="${DEFAULT_BLOCK_MIN_PLOT_AREA_M2}" step="10">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="gaps-slider">
                        <span data-i18n-key="blockify.modal.labels.gaps" data-i18n-attr="text">Number of gaps:</span>
                        <span id="gaps-value">0</span>
                    </label>
                    <input type="range" id="gaps-slider" min="0" max="10" value="0" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="gap-width-slider">
                        <span data-i18n-key="blockify.modal.labels.gapWidth" data-i18n-attr="text">Gap width (m):</span>
                        <span id="gap-width-value">5</span>
                    </label>
                    <input type="range" id="gap-width-slider" min="1" max="20" value="5" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="wings-slider">
                        <span data-i18n-key="blockify.modal.labels.wings" data-i18n-attr="text">Number of wings:</span>
                        <span id="wings-value">0</span>
                    </label>
                    <input type="range" id="wings-slider" min="0" max="10" value="0" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="wing-length-slider">
                        <span data-i18n-key="blockify.modal.labels.wingLength" data-i18n-attr="text">Wing length (m):</span>
                        <span id="wing-length-value">10</span>
                    </label>
                    <input type="range" id="wing-length-slider" min="10" max="200" value="10" step="1" disabled>
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <button type="button" id="blockify-manual-toggle" class="btn btn-block" aria-pressed="false" data-i18n-key="blockify.modal.manual.edit" data-i18n-attr="text">Edit shape manually</button>
                    <button type="button" id="blockify-geojson-upload" class="btn btn-block" data-i18n-key="blockify.modal.manual.uploadGeojson" data-i18n-attr="text">Import Freeform GeoJSON</button>
                    <input type="file" id="blockify-geojson-input" accept=".geojson,.json,application/geo+json,application/json" hidden>
                </div>
                <div class="parameter-info">
                    <p class="blockify-existing-only" style="display:none" data-i18n-key="blockify.modal.existing.helper">Each existing building is raised by the additional floors, up to the maximum height. Buildings already at or above the maximum stay unchanged.</p>
                </div>
            </div>
        <div id="blockify-controls" class="cb-dialog__footer">
            <p id="blockify-fit-warning" class="cb-banner cb-banner--warning" role="status" hidden
                data-i18n-key="blockify.modal.messages.siteTooSmall">${translateBuildingText('blockify.modal.messages.siteTooSmall', 'This land is too small for the requested block settings. Detect the whole block or add parcels, or reduce the setback, building depth or minimum plot size.')}</p>
            <div id="blockify-info" data-i18n-attr="text" role="status" aria-live="polite"></div>
            <div id="blockify-buttons">
                <button type="button" class="btn" id="btn-blockify-regenerate" hidden data-i18n-key="blockify.modal.regenerate" data-i18n-attr="text">Regenerate</button>
                <button type="button" class="btn" id="btn-blockify-freeform" data-i18n-key="proposalDrafts.freeform.title" data-i18n-attr="text">Convert to freeform building</button>
                <button type="button" class="btn btn-primary" id="btn-blockify-done" data-i18n-key="blockify.modal.done" data-i18n-attr="text">Done</button>
            </div>
        </div>
        `;

        const content = container.querySelector('#blockify-sidebar');
        const footer = container.querySelector('#blockify-controls');
        footer.classList.remove('cb-dialog__footer');
        // Keep the central rule and dimensions visible. Disabled experimental controls, import
        // tools and their supporting notes remain available without competing for the first view.
        const moreOptions = document.createElement('details');
        moreOptions.className = 'on-map-editor__more-options';
        const moreSummary = document.createElement('summary');
        moreSummary.setAttribute('data-i18n-key', 'onMapEditor.moreOptions');
        moreSummary.textContent = translateBuildingText('onMapEditor.moreOptions', 'More options');
        moreOptions.appendChild(moreSummary);
        const secondaryGroups = new Set();
        for (const selector of [
            '#algorithm-select', '#chamfer-slider', '#simplify-slider', '#gaps-slider', '#gap-width-slider', '#wings-slider',
            '#wing-length-slider', '#blockify-manual-toggle', '.parameter-info'
        ]) {
            const node = content.querySelector(selector);
            const group = node?.closest('.parameter-group') || node;
            if (group) secondaryGroups.add(group);
        }
        secondaryGroups.forEach(group => moreOptions.appendChild(group));
        content.appendChild(moreOptions);

        const densityStats = content.querySelector('#blockify-density-stats');
        if (densityStats) {
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = translateBuildingText('densityStats.title', 'Geometry statistics');
            details.appendChild(summary);
            details.appendChild(densityStats);
            content.appendChild(details);
        }
        blockifyModal = window.OnMapEditor?.open({
            owner: 'urban-rule',
            id: 'blockify-modal',
            title: translateBuildingText('blockify.modal.title', 'Urban rule'),
            content,
            footer,
            modes: ['2d', 'model'],
            onCancel: requestCloseBlockifyModal,
            onModeChange: mode => { if (mode === '2d' && blockifyMode === 'manual') renderManualPolygonEditor(); }
        });
        if (!blockifyModal) return false;
        blockifyMap = blockifyModal.map;
        blockifySurroundings = window.BuildingSurroundingsEditor.mount({
            session: blockifyModal, id: 'blockify-ground-treatment', initialTreatment: blockifyInitialGroundTreatment, initialDecorationDesign: blockifyInitialDecorationDesign,
            boundary: blockifyDesignBoundary,
            buildings: () => blockifyMode === 'existing' ? (generatedBuildingFeatures || []) : [generatedBuildingFeature].filter(Boolean),
            onChange: () => autosaveBlockifyDraft()
        });
        ensureBlockifyHistory();
        setBlockifyInfo('blockify.modal.generating', 'Generating building...');
        try {
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                window.i18n.applyTranslations(blockifyModal.root);
            }
        } catch (_) { }


        document.dispatchEvent(new CustomEvent('blockifyModalOpened'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

        // Add event listeners
        blockifyDesignChanges().start(document);
        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) {
            doneButton.addEventListener('click', saveBlockifyDesignForProposal);
            doneButton.disabled = true;
        }

        // Add slider event listeners
        document.getElementById('setback-slider').addEventListener('input', function (e) {
            currentSetback = parseFloat(e.target.value);
            document.getElementById('setback-value').textContent = CbFormat.formatNumber(currentSetback, { maxFractionDigits: 1, minFractionDigits: 1 });
            generateBuildingInModal();
        });

        const chamferSlider = document.getElementById('chamfer-slider');
        if (chamferSlider) {
            chamferSlider.addEventListener('input', function (e) {
                currentChamferM = parseFloat(e.target.value);
                document.getElementById('chamfer-value').textContent = CbFormat.formatNumber(currentChamferM, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateBuildingInModal();
            });
        }

        const simplifySlider = document.getElementById('simplify-slider');
        if (simplifySlider) {
            simplifySlider.addEventListener('input', function (e) {
                currentSimplifyM = parseFloat(e.target.value);
                document.getElementById('simplify-value').textContent = CbFormat.formatNumber(currentSimplifyM, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateBuildingInModal();
            });
        }

        document.getElementById('width-slider').addEventListener('input', function (e) {
            if (blockifyMode === 'manual') return;
            currentBuildingWidth = parseFloat(e.target.value);
            document.getElementById('width-value').textContent = CbFormat.formatNumber(currentBuildingWidth, { maxFractionDigits: 1, minFractionDigits: 1 });
            generateBuildingInModal();
        });

        const heightSlider = document.getElementById('height-slider');
        if (heightSlider) {
            heightSlider.addEventListener('input', function (e) {
                currentBuildingHeight = parseFloat(e.target.value);
                document.getElementById('height-value').textContent = CbFormat.formatNumber(currentBuildingHeight, { maxFractionDigits: 1, minFractionDigits: 1 });
                // Only affects 3D extrusion; regenerate 3D using the current geometry
                if (generatedBuildingFeature) {
                    // Keep the feature's own height in step with the slider. The footprint doesn't
                    // change, so nothing regenerates it — without this the saved building carries
                    // the height from the last full generate, and the 3D view (which reads
                    // properties.height) renders the proposal at the wrong height.
                    if (generatedBuildingFeature.properties) {
                        generatedBuildingFeature.properties.height = currentBuildingHeight;
                    }
                    refreshBlockPieceHeights();
                    syncBlockMinHeightSlider();
                    publishBlockifyPreview({
                        exampleBuildings: blockBuildOut,
                        envelopes: blockMassingPieces,
                        excluded: blockExcludedParcels.map(entry => entry?.feature).filter(feature => feature?.geometry)
                    });
                    // The draft carries its own copy of the feature and it is what gets published
                    // (serializeProposal reads editorPayload.context.buildings). Nothing regenerates
                    // the footprint here, so without this autosave a height-only edit was dropped.
                    autosaveBlockifyDraft();
                }
            });
        }

        const blockRuleTypeSelect = document.getElementById('blockify-ruletype-select');
        if (blockRuleTypeSelect) {
            blockRuleTypeSelect.value = blockRuleKind;
            blockRuleTypeSelect.addEventListener('change', function (e) {
                blockRuleKind = e.target.value;
                syncBlockMinHeightSlider();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockRegenerate = document.getElementById('btn-blockify-regenerate');
        if (blockRegenerate) {
            // Only the seed moves: the massing, and every number read off it, stay put.
            blockRegenerate.addEventListener('click', function () {
                blockVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinHeightSlider = document.getElementById('blockify-minheight-slider');
        if (blockMinHeightSlider) {
            blockMinHeightSlider.addEventListener('input', function (e) {
                blockMinHeightM = parseFloat(e.target.value);
                document.getElementById('blockify-minheight-value').textContent = CbFormat.formatNumber(blockMinHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
                refreshBlockPieceHeights();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinDepthSlider = document.getElementById('blockify-mindepth-slider');
        if (blockMinDepthSlider) {
            blockMinDepthSlider.addEventListener('input', function (e) {
                blockMinDepthM = parseFloat(e.target.value);
                document.getElementById('blockify-mindepth-value').textContent = CbFormat.formatNumber(blockMinDepthM, { maxFractionDigits: 1, minFractionDigits: 1 });
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        const blockMinPlotSlider = document.getElementById('blockify-minplot-slider');
        if (blockMinPlotSlider) {
            blockMinPlotSlider.addEventListener('input', function (e) {
                blockMinPlotAreaM2 = parseFloat(e.target.value);
                document.getElementById('blockify-minplot-value').textContent = blockMinPlotAreaM2.toString();
                if (generatedBuildingFeature) displayBuildingInModal(generatedBuildingFeature);
            });
        }

        // Enable gap sliders
        const gapsSlider = document.getElementById('gaps-slider');
        const gapWidthSlider = document.getElementById('gap-width-slider');
        if (gapsSlider) {
            gapsSlider.disabled = false;
            gapsSlider.value = 0;
            document.getElementById('gaps-value').textContent = '0';
            gapsSlider.addEventListener('input', function (e) {
                document.getElementById('gaps-value').textContent = e.target.value;
                gapPositions = syncPositions(gapPositions, parseInt(e.target.value) || 0);
                generateBuildingInModal();
            });
        }
        if (gapWidthSlider) {
            gapWidthSlider.disabled = false;
            gapWidthSlider.addEventListener('input', function (e) {
                document.getElementById('gap-width-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }

        // Enable wing sliders
        const wingsSlider = document.getElementById('wings-slider');
        const wingLengthSlider = document.getElementById('wing-length-slider');
        if (wingsSlider) {
            wingsSlider.disabled = false;
            wingsSlider.value = 0;
            document.getElementById('wings-value').textContent = '0';
            wingsSlider.addEventListener('input', function (e) {
                document.getElementById('wings-value').textContent = e.target.value;
                wingPositions = syncPositions(wingPositions, parseInt(e.target.value) || 0);
                generateBuildingInModal();
            });
        }
        if (wingLengthSlider) {
            wingLengthSlider.disabled = false;
            wingLengthSlider.addEventListener('input', function (e) {
                document.getElementById('wing-length-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }

        const manualToggle = document.getElementById('blockify-manual-toggle');
        if (manualToggle) {
            manualToggle.addEventListener('click', function () {
                if (blockifyMode === 'manual') exitToParametricMode();
                else enterManualMode();
            });
        }
        // Leaving the rule: one Freeform building, kept where it stands (proposal-editor-shell.js).
        document.getElementById('btn-blockify-freeform')?.addEventListener('click', convertBlockifyToFreeform);

        const geojsonBtn = document.getElementById('blockify-geojson-upload');
        const geojsonInput = document.getElementById('blockify-geojson-input');
        if (geojsonBtn && geojsonInput) {
            geojsonBtn.addEventListener('click', () => geojsonInput.click());
            geojsonInput.addEventListener('change', function (e) {
                const file = e.target.files && e.target.files[0];
                if (file) loadGeojsonFootprint(file);
                e.target.value = ''; // allow re-selecting the same file
            });
        }

        const existingToggle = document.getElementById('blockify-existing-toggle');
        if (existingToggle) {
            existingToggle.addEventListener('change', function (e) {
                if (e.target.checked) enterExistingMode();
                else exitExistingMode();
            });
        }

        // The two rules are exclusive: the radios pick one, and moving a slider activates its rule.
        document.querySelectorAll('input[name="blockify-existing-rule"]').forEach(radio => {
            radio.addEventListener('change', function (e) {
                if (!e.target.checked) return;
                existingRule = e.target.value === 'additional' ? 'additional' : 'exact';
                generateExistingBuildingsInModal();
            });
        });

        const proposedHeightSlider = document.getElementById('proposed-height-slider');
        if (proposedHeightSlider) {
            proposedHeightSlider.addEventListener('input', function (e) {
                currentProposedHeightFloors = parseInt(e.target.value) || DEFAULT_PROPOSED_HEIGHT_FLOORS;
                setExistingRule('exact');
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

        const additionalFloorsSlider = document.getElementById('additional-floors-slider');
        if (additionalFloorsSlider) {
            additionalFloorsSlider.addEventListener('input', function (e) {
                currentAdditionalFloors = parseInt(e.target.value) || DEFAULT_ADDITIONAL_FLOORS;
                setExistingRule('additional');
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

        const floorHeightSlider = document.getElementById('floor-height-slider');
        if (floorHeightSlider) {
            floorHeightSlider.addEventListener('input', function (e) {
                currentFloorHeightM = parseFloat(e.target.value) || DEFAULT_FLOOR_HEIGHT_M;
                updateExistingValueLabels();
                generateExistingBuildingsInModal();
            });
        }

    }

    // Display the block on the map
    displayBlockOnMap(block);

    // Reset parameter values
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
    currentChamferM = DEFAULT_CHAMFER_M;
    currentSimplifyM = DEFAULT_SIMPLIFY_M;
    blockRuleKind = DEFAULT_BLOCK_RULE_KIND;
    blockMinHeightM = 0;
    blockMinDepthM = 0;
    blockMinPlotAreaM2 = DEFAULT_BLOCK_MIN_PLOT_AREA_M2;
    blockVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
    blockMassingPieces = [];
    blockBuildOut = [];
    blockExcludedParcels = [];
    gapPositions = [];
    wingPositions = [];
    blockifyMode = 'parametric';
    blockifyPendingVertexActionIndex = null;
    manualOuterRing = [];
    existingRule = 'exact';
    currentProposedHeightFloors = DEFAULT_PROPOSED_HEIGHT_FLOORS;
    currentAdditionalFloors = DEFAULT_ADDITIONAL_FLOORS;
    currentFloorHeightM = DEFAULT_FLOOR_HEIGHT_M;
    existingFootprints = null;
    existingFootprintsPromise = null;
    generatedBuildingFeatures = null;

    // Restore a saved design (e.g. a copied proposal) over the freshly-reset defaults, so the
    // editor opens on the original shape with every control still live.
    const seed = blockifySeedState;
    blockifySeedState = null;
    if (seed) applyBlockifySeedState(seed);

    syncBlockifyControlsFromState();

    // Generate building immediately
    setTimeout(() => {
        if (initialGeometryError) {
            reportBlockifyGenerationError(initialGeometryError);
            return;
        }
        if (seed && seed.mode === 'existing') {
            // Existing-buildings mode refetches footprints; entering the mode does the drawing.
            enterExistingMode();
            return;
        }
        if (seed && seed.mode === 'manual' && Array.isArray(manualOuterRing) && manualOuterRing.length >= 3) {
            // Manual outlines are not slider-derived, so restore the ring rather than regenerate.
            setFootprintSlidersEnabled(false);
            updateManualToggleLabel();
            generateManualBuilding();
            return;
        }
        generateBuildingInModal();
    }, 500); // Small delay to ensure the map is fully initialized
    return !!blockifyModal;
}

// Push a saved blockify design back into the editor's module state. Anything the seed omits keeps
// the default that showBlockifyModal() just reset it to, so older proposals (which only stored
// width/height/setback/chamfer/algorithm) still restore cleanly.
function applyBlockifySeedState(seed) {
    if (!seed || typeof seed !== 'object') return;
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

    const setback = num(seed.setback);
    if (setback !== null) currentSetback = setback;
    const width = num(seed.width);
    if (width !== null) currentBuildingWidth = width;
    const height = num(seed.height);
    if (height !== null) currentBuildingHeight = height;
    const chamfer = num(seed.chamfer);
    if (chamfer !== null) currentChamferM = chamfer;
    const simplify = num(seed.simplify);
    if (simplify !== null) currentSimplifyM = simplify;

    if (Array.isArray(seed.gaps)) gapPositions = JSON.parse(JSON.stringify(seed.gaps));
    if (Array.isArray(seed.wings)) wingPositions = JSON.parse(JSON.stringify(seed.wings));

    // What the rule compels, and the variation it was saved with. Restoring the seed is what makes
    // a reopened design redraw the SAME street rather than a fresh one under the same name.
    const savedRule = (seed.rule && typeof seed.rule === 'object') ? seed.rule : null;
    if (savedRule) {
        if (window.UrbanRuleVariation.RULE_KINDS.includes(savedRule.kind)) blockRuleKind = savedRule.kind;
        const minHeight = num(savedRule.minHeightM);
        if (minHeight !== null) blockMinHeightM = minHeight;
        const minDepth = num(savedRule.minDepthM);
        if (minDepth !== null) blockMinDepthM = minDepth;
        const minPlot = num(savedRule.minPlotAreaM2);
        if (minPlot !== null) blockMinPlotAreaM2 = minPlot;
    }
    const savedSeed = num(seed.seed);
    if (savedSeed !== null) blockVariationSeed = savedSeed >>> 0;

    if (seed.mode === 'manual' && Array.isArray(seed.manualOuterRing) && seed.manualOuterRing.length >= 3) {
        blockifyMode = 'manual';
        manualOuterRing = seed.manualOuterRing.map(c => [c[0], c[1]]);
    } else if (seed.mode === 'existing') {
        blockifyMode = 'existing';
        if (seed.rule === 'exact' || seed.rule === 'additional') existingRule = seed.rule;
        const proposedFloors = num(seed.proposedHeightFloors);
        if (proposedFloors !== null) currentProposedHeightFloors = proposedFloors;
        const additionalFloors = num(seed.additionalFloors);
        if (additionalFloors !== null) currentAdditionalFloors = additionalFloors;
        const floorHeight = num(seed.floorHeightM);
        if (floorHeight !== null) currentFloorHeightM = floorHeight;
    }

    if (seed.algorithm) {
        const algorithmSelect = document.getElementById('algorithm-select');
        if (algorithmSelect) algorithmSelect.value = seed.algorithm;
    }
}

// Mirror the module state onto every modal control. Replaces the old partial sync (which only
// touched setback/chamfer/width) so a seeded design shows the values it was actually built with.
function syncBlockifyControlsFromState() {
    const setSlider = (sliderId, valueId, value, digits = 1) => {
        const slider = document.getElementById(sliderId);
        if (slider) slider.value = value;
        const label = document.getElementById(valueId);
        if (label) label.textContent = digits === 0 ? String(value) : CbFormat.formatNumber(Number(value), { maxFractionDigits: digits, minFractionDigits: digits });
    };

    setSlider('setback-slider', 'setback-value', currentSetback);
    setSlider('chamfer-slider', 'chamfer-value', currentChamferM);
    setSlider('simplify-slider', 'simplify-value', currentSimplifyM);
    setSlider('width-slider', 'width-value', currentBuildingWidth);
    setSlider('height-slider', 'height-value', currentBuildingHeight);
    setSlider('gaps-slider', 'gaps-value', Array.isArray(gapPositions) ? gapPositions.length : 0, 0);
    setSlider('wings-slider', 'wings-value', Array.isArray(wingPositions) ? wingPositions.length : 0, 0);

    const exactRadio = document.getElementById('blockify-rule-exact');
    const additionalRadio = document.getElementById('blockify-rule-additional');
    if (exactRadio) exactRadio.checked = existingRule === 'exact';
    if (additionalRadio) additionalRadio.checked = existingRule === 'additional';
    setSlider('proposed-height-slider', 'proposed-height-value', currentProposedHeightFloors, 0);
    setSlider('additional-floors-slider', 'additional-floors-value', currentAdditionalFloors, 0);
    setSlider('floor-height-slider', 'floor-height-value', currentFloorHeightM);
    if (typeof updateExistingValueLabels === 'function') updateExistingValueLabels();

    const ruleTypeSelect = document.getElementById('blockify-ruletype-select');
    if (ruleTypeSelect) ruleTypeSelect.value = blockRuleKind;
    setSlider('blockify-minplot-slider', 'blockify-minplot-value', blockMinPlotAreaM2, 0);
    syncBlockMinHeightSlider();
}

// Did the user change the design since the dialog opened? The auto-generated first design is not
// a change, so closing an untouched editor does not ask to "discard" it.
let blockifyDesignChangeTracker = null;
function blockifyDesignChanges() {
    if (!blockifyDesignChangeTracker) {
        blockifyDesignChangeTracker = window.DesignChangeTracker.createDesignChangeTracker({
            signature: () => JSON.stringify([blockifySurroundings?.signature, window.DesignChangeTracker.featuresSignature(
                [generatedBuildingFeature].concat(Array.isArray(generatedBuildingFeatures) ? generatedBuildingFeatures : []))])
        });
    }
    return blockifyDesignChangeTracker;
}

// Is there a generated design in the editor right now?
function blockifyHasGeneratedDesign() {
    return !!generatedBuildingFeature
        || (Array.isArray(generatedBuildingFeatures) && generatedBuildingFeatures.length > 0);
}

// The X / Esc path. Closing NEVER saves — only "Done" (saveBlockifyDesignForProposal) does. When
// the editor is running a commit-on-confirm session (a geometry edit, or a Build-palette creation)
// the design would be lost, so ask first; declining keeps the editor open.
async function requestCloseBlockifyModal() {
    if (typeof window !== 'undefined' && typeof window.confirmDiscardProposalDesignSession === 'function') {
        const proceed = await window.confirmDiscardProposalDesignSession({
            hasDesign: blockifyHasGeneratedDesign() && blockifyDesignChanges().changed()
        });
        if (!proceed) return;
    }
    closeBlockifyModal();
}

// Tear the blockify modal down. This is pure teardown: the design is committed (or not) by the
// caller — "Done" saves first, X/Esc discards the design session first.
function closeBlockifyModal(options = {}) {
    const { preservePending = false, continueDesignSession = false } = options;
    const hadModal = !!blockifyModal;
    blockifySurroundings?.destroy();
    blockifySurroundings = null;
    blockifyInitialGroundTreatment = null;
    blockifyInitialDecorationDesign = null;
    if (blockifyDesignChangeTracker) blockifyDesignChangeTracker.stop();
    blockifyHistoryKeydown?.();
    blockifyHistoryKeydown = null;
    blockifyHistory?.destroy?.();
    blockifyHistory = null;
    if (blockifyUndoButton?.parentNode) blockifyUndoButton.parentNode.removeChild(blockifyUndoButton);
    blockifyUndoButton = null;
    blockifyDragState = null;
    blockifyShapeHistoryRecorded = false;
    blockifyPendingVertexActionIndex = null;
    clearGapWingHandles();
    if (blockifyMap) {
        [blockifyParcelLayer, blockifyBoundaryLayer, blockifyBuildingLayer, blockifyFootprintLayer, blockifyDebugLayer,
            ...blockifyPieceLayers, ...blockifyExcludedLayers].forEach(layer => {
            if (layer && blockifyMap.hasLayer(layer)) blockifyMap.removeLayer(layer);
        });
    }
    blockifyParcelLayer = null;
    blockifyBoundaryLayer = null;
    blockifyBuildingLayer = null;
    blockifyFootprintLayer = null;
    blockifyDebugLayer = null;
    blockifyPieceLayers = [];
    blockifyExcludedLayers = [];
    blockifyModal?.close();
    blockifyModal = null;
    blockifyMap = null;

    // Clear the generated building
    generatedBuildingFeature = null;
    generatedBuildingFeatures = null;
    existingFootprints = null;
    existingFootprintsPromise = null;
    blockifyBlock = null;
    blockifyBlockNameOverride = null;
    blockifyAuthoredSite = null;
    blockifyGenerationSite = null;

    if (hadModal) {
        document.dispatchEvent(new CustomEvent('blockifyModalClosed'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));
    }

    // Reset parameters to defaults
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;

    if (!preservePending) {
        setPendingBuildingProposalContext(null);
        if (typeof window !== 'undefined') {
            window.pendingBuildingFromBlockify = null;
        }
    }
    if (typeof window !== 'undefined') {
        // Only "Done" commits — it tears down with preservePending after saving. Every other
        // close abandons the design session, leaving the edited object exactly as it was.
        if (!preservePending) window.discardProposalDraftDesignSession?.();
        if (!continueDesignSession) window.finishProposalDraftDesignSession?.();
    }
}

// Display the selected block on the shared application map.
function displayBlockOnMap(block) {
    console.log('[Blockify] displayBlockOnMap called with block:', block);
    // Clear existing layers (the block can change under an open editor: the rule re-run on the
    // parcels under a drop, blockifyRuleAtOutline).
    if (blockifyParcelLayer) {
        blockifyMap.removeLayer(blockifyParcelLayer);
        blockifyParcelLayer = null;
    }
    if (blockifyBoundaryLayer) {
        blockifyMap.removeLayer(blockifyBoundaryLayer);
        blockifyBoundaryLayer = null;
    }

    // Create a feature collection for all parcels in the block.
    //
    // One parcel with impossible coordinates used to take the whole editor to a map of the world:
    // its bounds stretch from wherever the bad vertex lands to the real block, and Leaflet dutifully
    // frames both. Drawing and framing the rest is strictly better — the editor stays usable and the
    // offender is named instead of being a mystery.
    const fitApi = (typeof window !== 'undefined') ? window.__blockifyMapFit : null;
    const rawFeatures = blockifyFeaturesForBlock(block);
    const split = fitApi ? fitApi.usableBlockFeatures(rawFeatures) : { usable: rawFeatures, rejected: [] };
    if (split.rejected.length) {
        console.error('[Blockify] leaving parcels out of the map — their geometry is not usable', split.rejected);
    }
    const featureCollection = {
        type: 'FeatureCollection',
        features: split.usable
    };

    // Add the parcels to the map
    blockifyParcelLayer = L.geoJSON(featureCollection, {
        pane: blockifyModal?.pane,
        style: {
            fillColor: 'red',
            fillOpacity: 0.2,
            color: 'red',
            weight: 2
        }
    }).addTo(blockifyMap);

    if (blockifyAuthoredSite?.geometry) {
        blockifyBoundaryLayer = L.geoJSON(blockifyAuthoredSite, {
            pane: blockifyModal?.pane,
            interactive: false,
            style: { color: '#6d28d9', weight: 3, opacity: 0.9, fillOpacity: 0, dashArray: '8 5' }
        }).addTo(blockifyMap);
    }
    const initialBoundary = blockifyAuthoredSite?.geometry ? blockifyAuthoredSite : featureCollection;
    if (blockifyAuthoredSite?.geometry || split.usable.length) blockifyModal?.fitFeature(initialBoundary, { maxZoom: 19 });
}

// Function to generate building in the modal only
// Reduce an outline's vertex count (turf.simplify / Douglas–Peucker, tolerance in metres) and clip it
// inside `parcel` so no edge ends up outside the parcel. Clipping an outline that is already inside
// returns it unchanged, so a fully-inside simplified outline keeps its low vertex count. Used by both
// the parametric builder and the manual (freeform) builder.
// A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
function buildingBlocksClipFailure(operation, error, site, operands) {
    const api = (typeof window !== 'undefined' && window.__parcelArrangement)
        || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    return api ? api.clipFailure(operation, error, { site }, operands) : error;
}

// One gap cut out of a block building. A gap the clipper could not cut is a building other than
// the one asked for, so it refuses; an empty difference keeps the building as it was (as before).
function cutBuildingGap(...args) { return window.BuildingRuleGeometry.cutBuildingGap(...args); }

function simplifyAndClipOutline(...args) { return window.BuildingRuleGeometry.simplifyAndClipOutline(...args); }

// The most vertices a manually-editable outline may carry. Manual mode drops a draggable handle on
// every vertex, so the raw parametric outline (a negative buffer rounds every corner into
// GEOM_BUFFER_STEPS segments — a big block's ring runs to tens of thousands of points) is unusable:
// the browser would try to create that many Leaflet markers and freeze. This is the editable budget.
const MANUAL_MAX_VERTICES = 60;

// Reduce a [lng,lat] ring to at most `target` vertices by raising the Douglas–Peucker tolerance until
// it fits (binary search on tolerance in metres). Rings already within budget are returned untouched
// so a small parcel keeps its exact corners. Returns a ring (open — no closing dup); on any failure
// returns the input unchanged so manual mode still gets *something* to edit.
function simplifyRingToVertexTarget(ring, target = MANUAL_MAX_VERTICES) {
    if (!Array.isArray(ring) || ring.length <= target) return ring;
    try {
        const closed = ring.slice();
        const f = closed[0], l = closed[closed.length - 1];
        if (!l || f[0] !== l[0] || f[1] !== l[1]) closed.push([f[0], f[1]]);
        const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closed] } };

        let best = null;
        let lo = 0.25, hi = 50; // metres
        for (let i = 0; i < 18; i++) {
            const mid = (lo + hi) / 2;
            let simplified;
            try {
                simplified = turf.simplify(feature, { tolerance: mid / 111320, highQuality: false, mutate: false });
            } catch (_) { break; }
            const coords = simplified && simplified.geometry && simplified.geometry.coordinates[0];
            const n = Array.isArray(coords) ? coords.length : Infinity;
            if (n > target) {
                lo = mid; // still too many → simplify harder
            } else {
                best = coords;
                hi = mid; // fits → try to keep more detail
            }
        }
        if (Array.isArray(best) && best.length >= 4) {
            const out = best.map(c => [c[0], c[1]]);
            const of = out[0], ol = out[out.length - 1];
            if (ol && of[0] === ol[0] && of[1] === ol[1]) out.pop(); // drop closing dup
            return out;
        }
    } catch (err) {
        console.warn('Ring simplification to vertex target failed', err);
    }
    return ring;
}

// Resize a positions array (fractions 0..1 along the ring) to `count`, preserving existing entries:
// remove from the end when shrinking, and when growing insert each new one at the middle of the
// currently-largest free span so additions spread out. Used to keep gap/wing placement in sync with
// the count sliders while never discarding positions the user has dragged.
function syncPositions(...args) { return window.BuildingRuleGeometry.syncPositions(...args); }

// Union N rectangular wings (protrusions) onto the building, each extending inward toward the
// courtyard. Wing bases sit at `positions` (fractions 0..1 along the outer ring, draggable), point
// toward the block centroid, and are capped so they never cross the opposite parcel border. Wings may
// overlap the building and each other; the result is unioned into a single footprint.
function addWingsToBuilding(...args) { return window.BuildingRuleGeometry.addWingsToBuilding(...args); }

function generateBuildingInModal() {
    setBlockifyFitWarning(false);
    // Existing-buildings mode derives geometry from fetched footprints, not the sliders.
    if (blockifyMode === 'existing') { generateExistingBuildingsInModal(); return; }
    // In manual mode the outline is user-edited, not slider-derived — route to the manual builder.
    if (blockifyMode === 'manual') { generateManualBuilding(); return; }
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        return;
    }

    // Update info text to show generating status
    setBlockifyInfo('blockify.modal.generating', 'Generating building...');

    try {
        // Clear previous debug overlays
        if (blockifyDebugLayer && blockifyMap) {
            blockifyMap.removeLayer(blockifyDebugLayer);
            blockifyDebugLayer = null;
        }
        // Create a superparcel by merging all parcels in the block (robust)
        console.log(`Creating superparcel from ${block.parcels.length} parcels`);
        const parcelFeatures = blockifyFeaturesForBlock(block);
        // The authored site remains the design boundary after it has been cut into child plots.
        // Keep those plots as the owner/constraint inputs below, but don't silently shrink a
        // copied site's building rule to the union of its produced children.
        let superparcel = blockifyGenerationSite || blockifyAuthoredSite || robustUnion(parcelFeatures);

        if (!superparcel) {
            throw new Error('Failed to create superparcel');
        }

        // Sanitize the superparcel
        superparcel = sanitizePolygonFeature(superparcel) || superparcel;
        superparcel = toSingleLargestPolygon(superparcel) || superparcel;
        if (!superparcel || !superparcel.geometry) {
            throw new Error('Failed to process superparcel');
        }
        // Keep the exact parcel outline to clip the building against — no edge should ever end up
        // outside the parcel (whether from simplification chords or, in manual mode, dragging a vertex
        // out). Remembered on the module so the manual builder can reuse it.
        const originalSuperparcel = superparcel;
        lastSuperparcel = originalSuperparcel;

        // Calculate the maximum possible setback
        const area = turf.area(superparcel);
        let perimeter = turf.length(superparcel);
        const maxSetback = Math.sqrt(area / Math.PI) * 0.5; // Use 50% of the radius as max setback

        // Validate and adjust setback if needed
        let SETBACK = currentSetback;
        if (SETBACK > maxSetback) {
            setBlockifyFitWarning(true);
            SETBACK = maxSetback;
            // Update the slider and display value
            const setbackSlider = document.getElementById('setback-slider');
            if (setbackSlider) {
                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = CbFormat.formatNumber(SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 });
                currentSetback = SETBACK;
            }
        }

        // The outline itself — setback ring, simplified, clipped, inset to a courtyard — is
        // blockRingOutline(), so the batch that puts an urban rule on every empty block runs the
        // same generator this modal does instead of a second implementation of it.
        const ring = blockRingOutline(superparcel, originalSuperparcel, {
            setback: SETBACK,
            width: currentBuildingWidth,
            simplifyM: currentSimplifyM
        }, {
            onNarrowEdge: (inc) => {
                const debugMode = document.getElementById('debugModeCheckbox');
                if (!debugMode || !debugMode.checked || !inc.minEdgePair) return;
                try {
                    const a = [inc.minEdgePair[0][1], inc.minEdgePair[0][0]];
                    const b = [inc.minEdgePair[1][1], inc.minEdgePair[1][0]];
                    blockifyDebugLayer = L.featureGroup().addTo(blockifyMap);
                    L.polyline([a, b], { pane: blockifyModal?.pane, color: '#ff0000', weight: 5, opacity: 0.8 }).addTo(blockifyDebugLayer)
                        .bindTooltip(`Narrow edge: ${(inc.minEdgeValue || 0).toFixed(2)} m`, { permanent: false });
                } catch (_) { }
            }
        });
        if (!ring) {
            const error = new Error('Failed to create outer building polygon');
            error.code = 'block-site-too-small';
            throw error;
        }
        const outerBuilding = ring.outer;
        const innerBuilding = ring.inner;
        const currentWidth = ring.widthAchieved;
        const minSideLength = ring.minSideLength;
        if (!innerBuilding || currentWidth < currentBuildingWidth - 0.01) setBlockifyFitWarning(true);

        if (!innerBuilding) {
            // Fallback: produce a solid building (no courtyard) rather than failing
            console.warn('Inner courtyard collapsed; producing solid building polygon');
            const solidFeature = toSingleLargestPolygon(outerBuilding) || outerBuilding;
            const outerCoordsOnly = solidFeature.geometry.coordinates[0];
            const buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: 0,
                    setback: SETBACK,
                    chamfer: Number(currentChamferM) || 0,
                    simplify: currentSimplifyM,
                    block: getBlockifyDisplayName(),
                    minSideLength: 0,
                    height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
                    numGaps: 0,
                    gapWidth: 0,
                    note: 'Inner courtyard omitted due to narrow geometry'
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [outerCoordsOnly]
                }
            };
            const chamfered = applySelectiveChamferToFeature(buildingFeature, Number(currentChamferM) || 0, CHAMFER_MAX_INTERNAL_ANGLE_DEG);
            generatedBuildingFeature = chamfered;
            displayBuildingInModal(chamfered);
            clearGapWingHandles(); // solid fallback: no courtyard, so no gap/wing handles
            setBlockifyInfo(
                'blockify.modal.messages.generatedSolidNoCourtyard',
                'Building generated (solid; setback: {{setback}}m). Courtyard omitted because inner offset split or produced edges < 2.0 m. Try decreasing width.',
                { setback: CbFormat.formatNumber(SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 }) }
            );
            const doneButton = document.getElementById('btn-blockify-done');
            if (doneButton) doneButton.disabled = false;
            return;
        }

        // If we had to reduce the width significantly, show a warning
        if (currentWidth < currentBuildingWidth * 0.5) {
            console.warn(`Building width was reduced from ${currentBuildingWidth}m to ${currentWidth}m to maintain minimum side length of 2m`);
        }

        // Get gap parameters
        const gapsSlider = document.getElementById('gaps-slider');
        const gapWidthSlider = document.getElementById('gap-width-slider');
        const numGaps = gapsSlider ? parseInt(gapsSlider.value) : 0;
        const gapWidth = gapWidthSlider ? parseFloat(gapWidthSlider.value) : 0; // in meters
        // Keep rings explicitly closed for distance math
        const ensureClosedRing = (coords = []) => {
            if (!Array.isArray(coords) || coords.length === 0) return [];
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (!last || first[0] !== last[0] || first[1] !== last[1]) {
                return coords.concat([first]);
            }
            return coords.slice();
        };

        const outerCoords = ensureClosedRing(outerBuilding.geometry.coordinates[0]);
        const innerCoords = ensureClosedRing(innerBuilding.geometry.coordinates[0]).reverse();
        lastOuterRing = outerCoords; // remembered so the draggable gap/wing handles project onto it
        let buildingFeature;

        // Start with the closed ring polygon (outer with inner hole)
        const closedRingFeature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [outerCoords, innerCoords]
            }
        };

        const wingsSlider = document.getElementById('wings-slider');
        const wingLengthSlider = document.getElementById('wing-length-slider');
        const numWings = wingsSlider ? parseInt(wingsSlider.value) : 0;
        const wingLength = wingLengthSlider ? parseFloat(wingLengthSlider.value) : 0;
        gapPositions = syncPositions(gapPositions, numGaps); wingPositions = syncPositions(wingPositions, numWings);
        buildingFeature = window.BuildingRuleGeometry.blockMassingFromRing(ring, superparcel, {
            width: currentWidth, setback: SETBACK, chamferM: Number(currentChamferM) || 0, simplifyM: currentSimplifyM,
            height: Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT, blockName: getBlockifyDisplayName(),
            gapPositions, gapWidthM: gapWidth, wingPositions, wingLengthM: wingLength
        });
        generatedBuildingFeature = buildingFeature;
        const actualOuterRing = blockifyOuterRing(buildingFeature);
        if (actualOuterRing?.length) lastOuterRing = [...actualOuterRing, actualOuterRing[0].slice()];
        displayBuildingInModal(buildingFeature);
        renderGapWingHandles();

        // Update the sliders to reflect the actual values used
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (setbackSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(setbackSlider.value) - SETBACK) > 0.01) {
                // Temporarily remove the event listener
                const oldSetbackListener = setbackSlider.onchange;
                setbackSlider.onchange = null;

                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = CbFormat.formatNumber(SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 });
                currentSetback = SETBACK;

                // Restore the event listener
                setTimeout(() => {
                    setbackSlider.onchange = oldSetbackListener;
                }, 10);
            }
        }

        if (widthSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(widthSlider.value) - currentWidth) > 0.01) {
                // Temporarily remove the event listener
                const oldWidthListener = widthSlider.onchange;
                widthSlider.onchange = null;

                widthSlider.value = currentWidth;
                document.getElementById('width-value').textContent = CbFormat.formatNumber(currentWidth, { maxFractionDigits: 1, minFractionDigits: 1 });
                currentBuildingWidth = currentWidth;

                // Restore the event listener
                setTimeout(() => {
                    widthSlider.onchange = oldWidthListener;
                }, 10);
            }
        }

        // Update the info text — but never over the left-out notice.
        //
        // displayBuildingInModal has just run reportBlockLeftOut, which says how many parcels the
        // block leaves out. Echoing the slider values on top of that
        // threw the left-out count away every time, which is a large part of why a block could apply
        // to four of its seven parcels with nothing on screen saying so.
        if (!blockMassingPieces.length) {
            setBlockifyInfo(
                'blockify.modal.messages.generatedSummary',
                'Building generated (width: {{width}}m, height: {{height}}m, setback: {{setback}}m)',
                {
                    width: CbFormat.formatNumber(currentWidth, { maxFractionDigits: 1, minFractionDigits: 1 }),
                    height: CbFormat.formatNumber(Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT, { maxFractionDigits: 1, minFractionDigits: 1 }),
                    setback: CbFormat.formatNumber(SETBACK, { maxFractionDigits: 1, minFractionDigits: 1 })
                }
            );
        }

        // Enable the Done button
        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) {
            doneButton.disabled = blockMassingPieces.length === 0;
        }

    } catch (error) {
        reportBlockifyGenerationError(error);
    }
}

// Initial site construction and later regeneration share the same visible, recoverable failure.
function reportBlockifyGenerationError(error) {
    console.error(`[${new Date().toISOString()}] Error creating building block:`, error);
    if (error.code === 'block-site-too-small') setBlockifyFitWarning(true);
    setBlockifyInfo(
        error.code === 'block-site-too-small' ? null : 'blockify.modal.messages.errorWithMessage',
        error.code === 'block-site-too-small' ? '' : 'Error: {{message}}',
        { message: error && error.message ? error.message : '' }
    );

    // Only show error popup for algorithmic failures, not for slider validation
    if (!error.message.includes('Failed to create outer building polygon')) {
        showErrorPopup(translateBuildingText(
            'blockify.modal.messages.creationFailed',
            'Building block creation failed -- perhaps the parcel is too complex. Consider breaking it up with roads or try a different blockification algorithm.'
        ));
    }

    // Disable create proposal button if there was an error
    const doneButton = document.getElementById('btn-blockify-done');
    if (doneButton) {
        doneButton.disabled = true;
    }
}

function autosaveBlockifyDraft(featuresOverride = null) {
    const activeDraft = typeof window !== 'undefined' ? window.getActiveProposalDesignDraft?.() : null;
    const block = getActiveBlockifyBlock();
    const features = blockifyMode === 'existing'
        ? (Array.isArray(featuresOverride) ? featuresOverride.filter(Boolean)
            : (featuresOverride ? [featuresOverride] : (generatedBuildingFeatures?.length ? generatedBuildingFeatures : [])))
        : [window.UrbanRuleVariation.massingWithRule(generatedBuildingFeature, currentBlockRule(), blockVariationSeed, { turf })].filter(Boolean);
    if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
        || !features.length || !block?.parcels?.length
        || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
    const parcelIds = [];
    const parentDetails = [];
    if (!block.syntheticSite) block.parcels.forEach(parcel => {
        const feature = blockifyFeatureForParcel(parcel);
        const props = feature?.properties;
        const parcelId = blockifyParcelId(parcel);
        if (!parcelId) return;
        const id = String(parcelId);
        parcelIds.push(id);
        parentDetails.push({ id, number: String(props?.BROJ_CESTICE || id) });
    });
    const buildings = JSON.parse(JSON.stringify(features));
    const algorithmSelect = document.getElementById('algorithm-select');
    const parameters = blockifyMode === 'existing'
        ? {
            mode: 'existing',
            typology: 'block',
            rule: existingRule,
            proposedHeightFloors: currentProposedHeightFloors,
            additionalFloors: currentAdditionalFloors,
            floorHeightM: currentFloorHeightM,
            algorithm: null
        }
        : {
            mode: blockifyMode,
            typology: 'block',
            simplify: Number(currentSimplifyM),
            gaps: JSON.parse(JSON.stringify(gapPositions || [])),
            wings: JSON.parse(JSON.stringify(wingPositions || [])),
            manualOuterRing: blockifyMode === 'manual' && Array.isArray(manualOuterRing)
                ? manualOuterRing.map(coordinate => [coordinate[0], coordinate[1]])
                : null,
            width: Number(currentBuildingWidth),
            height: Number(currentBuildingHeight),
            setback: Number(currentSetback),
            chamfer: Number(currentChamferM),
            algorithm: algorithmSelect?.value || null
        };
    window.syncActiveProposalDraftFromEditor('building', {
        parcelIds,
        parentDetails,
        blockName: getBlockifyDisplayName(),
        parameters,
        buildingFeature: buildings[0] || null,
        buildings,
        groundSurface: blockifySurroundings?.surface() || null,
        // A Block stays on its parcels (proposals/freeform-conversion.js): never a free placement.
        placement: { free: false, site: blockifyClone(blockifyDesignBoundary()) }
    }, { coalesceKey: 'blockify-live' });
}

// Function to display the building in the modal map
// The rule the block sliders currently describe. Heights are metres — the block editor's own
// parameter — and the build-out varies in whole storeys within them.
function currentBlockRule() {
    const params = {
        typology: 'block',
        kind: blockRuleKind,
        maxHeightM: Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT,
        minHeightM: blockMinHeightM,
        minDepthM: blockMinDepthM,
        floorHeightM: DEFAULT_FLOOR_HEIGHT_M,
        minPlotAreaM2: blockMinPlotAreaM2
    };
    return window.UrbanRuleVariation.normalizeBlockRule(params);
}

function blockParcelsForSplit() {
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels)) return [];
    return block.parcels.map((parcel, index) => {
        const feature = blockifyFeatureForParcel(parcel);
        const parcelId = blockifyParcelId(parcel) || `parcel-${index}`;
        return { feature, parcelId };
    }).filter(entry => entry.feature && entry.feature.geometry);
}

// Cut the finished massing into per-parcel buildings and derive the example built under it. Every
// mode funnels through here, so gaps, wings, chamfer, manual outlines and imported shapes are all
// split the same way without the generator upstream knowing anything about it.
function rebuildBlockPieces(massingFeature) {
    const parcels = blockParcelsForSplit();
    if (!massingFeature || !parcels.length) {
        blockMassingPieces = [];
        blockBuildOut = [];
        blockExcludedParcels = [];
        return;
    }
    const deps = { turf, largestPolygon: toSingleLargestPolygon };
    const split = window.UrbanRuleVariation.splitMassingByParcels(
        massingFeature, parcels, currentBlockRule(), blockVariationSeed, deps);
    blockMassingPieces = split.pieces;
    blockExcludedParcels = split.excluded;
    blockBuildOut = blockMassingPieces.map(piece => window.UrbanRuleVariation.realizeFeature(piece, deps));
}

// Height-only edits move a slider, not the footprint, so re-cutting every parcel would be wasted
// geometry on every input event. Restamp the height and re-derive instead.
function refreshBlockPieceHeights() {
    const rule = currentBlockRule();
    const deps = { turf };
    blockMassingPieces.forEach(piece => {
        piece.properties.height = rule.maxHeightM;
        piece.properties.urbanRule = rule;
    });
    blockBuildOut = blockMassingPieces.map(piece => window.UrbanRuleVariation.realizeFeature(piece, deps));
    refreshBlockifyDensityStats(blockMassingPieces);
}

function publishBlockifyPreview({ exampleBuildings = [], envelopes = [], excluded = [] } = {}) {
    if (!blockifyModal) return;
    blockifyModal.setPreview({
        groundSurface: blockifySurroundings?.refresh() || null,
        draftPreview: {
            kind: 'buildings',
            features: (Array.isArray(exampleBuildings) ? exampleBuildings : []).filter(feature => feature?.geometry)
        },
        boundary: blockifyDesignBoundary()?.geometry ? blockifyDesignBoundary() : null,
        envelopes: blockRuleKind === 'exact' ? [] : (Array.isArray(envelopes) ? envelopes : []).filter(feature => feature?.geometry),
        excluded: (Array.isArray(excluded) ? excluded : []).filter(feature => feature?.geometry)
    });
}

function displayBuildingInModal(buildingFeature) {
    [blockifyBuildingLayer, blockifyPieceLayers, blockifyExcludedLayers].forEach(entry => {
        (Array.isArray(entry) ? entry : [entry]).forEach(layer => {
            if (layer && blockifyMap) { try { blockifyMap.removeLayer(layer); } catch (_) { } }
        });
    });
    blockifyBuildingLayer = null;
    blockifyPieceLayers = [];
    blockifyExcludedLayers = [];

    if (!buildingFeature) {
        refreshBlockifyDensityStats([]);
        publishBlockifyPreview({ exampleBuildings: [], envelopes: [], excluded: [] });
        return;
    }
    if (buildingFeature.geometry.type === 'MultiLineString' || buildingFeature.geometry.type === 'MultiPolygon' || buildingFeature.geometry.type === 'Polygon') {
        rebuildBlockPieces(buildingFeature);

        // The massing outline stays as the block's overall shape; the per-parcel buildings are
        // drawn inside it so the ownership fabric is visible while the outline is being edited.
        blockifyBuildingLayer = L.geoJSON(buildingFeature, {
            pane: blockifyModal?.pane,
            style: { color: '#007bff', weight: 4, opacity: 1, fillOpacity: blockMassingPieces.length ? 0 : 0.2 },
            onEachFeature: (_feature, layer) => { layer.on('mousedown', startBlockifyMassMove); layer.on('touchstart', startBlockifyMassMove); }
        }).addTo(blockifyMap);

        blockMassingPieces.forEach(piece => {
            const color = piece.properties?.color || '#8899aa';
            const compelled = piece.properties?.minFootprint;
            // What the rule COMPELS is drawn solid; what it merely permits is drawn lighter. Two
            // tones, so the mandatory building line is visible as a line and not just a number.
            const layer = L.geoJSON(piece, {
                pane: blockifyModal?.pane,
                style: { fillColor: color, fillOpacity: compelled ? 0.35 : 0.75, color: '#33465c', weight: 1 },
                onEachFeature: (_feature, item) => { item.on('mousedown', startBlockifyMassMove); item.on('touchstart', startBlockifyMassMove); }
            }).addTo(blockifyMap);
            const height = piece.properties?.height || 0;
            layer.bindTooltip(`${piece.properties?.parcelId}: ${CbFormat.formatLength(height)}`, { direction: 'center' });
            blockifyPieceLayers.push(layer);

            if (compelled) {
                blockifyPieceLayers.push(L.geoJSON({ type: 'Feature', properties: {}, geometry: compelled }, {
                    pane: blockifyModal?.pane,
                    style: { fillColor: color, fillOpacity: 0.85, color: '#1b2a3a', weight: 1.5 }
                }).addTo(blockifyMap));
            }
        });

        // EVERY parcel the rule leaves out is drawn, 'no-massing-here' included. Hiding that one is
        // what made an applied block look like it had skipped parcels at random: a plot the ring
        // never reaches gets no building, and the editor showed nothing to say so.
        //
        // The block's own outline continues across it, dashed. A left-out plot is not a hole in the
        // block and not an error — it is a plot that cannot carry a building AS IT STANDS, and the
        // dashed shape is what it would carry once it is merged with a neighbour or bought. Drawing
        // only the hatched plot said "something went wrong here"; drawing the shape says "here is
        // what this is worth, and why you cannot have it yet".
        blockExcludedParcels.forEach(entry => {
            if (!entry || !entry.feature) return;
            const layer = L.geoJSON(entry.feature, {
                pane: blockifyModal?.pane,
                style: { fillColor: '#b0453a', fillOpacity: 0.16, color: '#b0453a', weight: 1.5, dashArray: '2, 5' }
            }).addTo(blockifyMap);
            layer.bindTooltip(blockExclusionReason(entry.status), { direction: 'center' });
            blockifyExcludedLayers.push(layer);

            if (!entry.wouldBe) return;
            const ghost = L.geoJSON({ type: 'Feature', properties: {}, geometry: entry.wouldBe }, {
                pane: blockifyModal?.pane,
                style: { fillColor: '#8a8f98', fillOpacity: 0.28, color: '#4b5563', weight: 2, dashArray: '6, 4' }
            }).addTo(blockifyMap);
            ghost.bindTooltip(blockExclusionReason(entry.status), { direction: 'center' });
            blockifyExcludedLayers.push(ghost);
        });

        publishBlockifyPreview({
            exampleBuildings: blockBuildOut,
            envelopes: blockMassingPieces,
            excluded: blockExcludedParcels.map(entry => entry?.feature).filter(feature => feature?.geometry)
        });
        reportBlockLeftOut();
        refreshBlockifyDensityStats(blockMassingPieces.length ? blockMassingPieces : [buildingFeature]);
        autosaveBlockifyDraft(blockMassingPieces.length ? blockMassingPieces : buildingFeature);
    }

// The footer says only what needs attention: the plots the rule leaves out (hatched on the map),
// never a running total of buildings and floor area. Empty when every plot builds. A block applied
// to four of its seven parcels must still say which three got nothing.
function reportBlockLeftOut() {
    const excluded = blockExcludedParcels.length;
    if (!blockMassingPieces.length && excluded) {
        setBlockifyFitWarning(true);
        setBlockifyInfo('blockify.modal.messages.rangeNoneExcluded', 'No buildings · {{excluded}}', { excluded: blockParcelsLeftOutPhrase(excluded) });
    } else if (excluded) {
        setBlockifyInfo('blockify.modal.messages.parcelsLeftOut', '{{count}} parcels left out', { count: excluded });
    } else {
        setBlockifyInfo(null, '');
    }
}
}

// A minimum only exists for the between-a-minimum-and-this rule, and it can never outrun the
// ceiling it sits under.
function syncBlockMinHeightSlider() {
    const group = document.getElementById('blockify-minheight-group');
    if (group) group.style.display = blockRuleKind === 'range' ? '' : 'none';
    // Under "exactly this height" every building is the full envelope, so there is no variation to
    // roll — hide the button rather than leave a control that provably does nothing.
    const regenerate = document.getElementById('btn-blockify-regenerate');
    if (regenerate) regenerate.hidden = blockRuleKind === 'exact';
    const depthGroup = document.getElementById('blockify-mindepth-group');
    if (depthGroup) depthGroup.style.display = blockRuleKind === 'range' ? '' : 'none';
    const depthSlider = document.getElementById('blockify-mindepth-slider');
    if (depthSlider) {
        // Compelling more depth than the block is deep would just compel the whole block, so the
        // slider stops at the building's own depth.
        const deepest = Number(currentBuildingWidth) || DEFAULT_BUILDING_WIDTH;
        depthSlider.max = String(deepest);
        if (blockMinDepthM > deepest) blockMinDepthM = deepest;
        depthSlider.value = String(blockMinDepthM);
        const depthLabel = document.getElementById('blockify-mindepth-value');
        if (depthLabel) depthLabel.textContent = CbFormat.formatNumber(blockMinDepthM, { maxFractionDigits: 1, minFractionDigits: 1 });
    }
    const slider = document.getElementById('blockify-minheight-slider');
    if (!slider) return;
    const ceiling = Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT;
    slider.max = String(ceiling);
    if (blockMinHeightM > ceiling) blockMinHeightM = ceiling;
    slider.value = String(blockMinHeightM);
    const label = document.getElementById('blockify-minheight-value');
    if (label) label.textContent = CbFormat.formatNumber(blockMinHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
}

function blockExclusionReason(status) {
    if (status === 'below-min-plot') {
        return translateBuildingText('blockify.modal.messages.excludedBelowMinPlot',
            'Smaller than the minimum plot size — it has to be merged with a neighbour before anything can be built here.');
    }
    if (status === 'no-massing-here') {
        return translateBuildingText('blockify.modal.messages.excludedNoMassing',
            'The building does not reach this plot — the setback, or the shape of the block, leaves it outside. Nothing is built here.');
    }
    return translateBuildingText('blockify.modal.messages.excludedSliver',
        'Only a splinter of the block falls on this plot — too small to be a building.');
}

// Draw a draggable handle on the modal map at each gap/wing position. Dragging one snaps it back onto
// the outer ring, updates its fraction (0..1 along the ring), and regenerates the block.
function clearGapWingHandles() {
    if (blockifyPolygonEditor) {
        try { blockifyPolygonEditor.destroy(); } catch (_) { }
        blockifyPolygonEditor = null;
    }
    if (blockifyHandleLayer && blockifyMap) {
        try { blockifyMap.removeLayer(blockifyHandleLayer); } catch (_) { }
    }
    blockifyHandleLayer = null;
}

function renderGapWingHandles() {
    clearGapWingHandles();
    if (!blockifyMap || typeof turf === 'undefined') return;
    if (!Array.isArray(lastOuterRing) || lastOuterRing.length < 2) return;
    if (!gapPositions.length && !wingPositions.length) return;

    let ringLine, ringLenM;
    try {
        ringLine = turf.lineString(lastOuterRing);
        ringLenM = turf.length(ringLine, { units: 'meters' });
    } catch (_) { return; }
    if (!(ringLenM > 0)) return;

    blockifyHandleLayer = L.layerGroup().addTo(blockifyMap);

    const addHandle = (posArray, idx, kind) => {
        const frac = (((posArray[idx] % 1) + 1) % 1);
        let coord;
        try { coord = turf.along(ringLine, frac * ringLenM, { units: 'meters' }).geometry.coordinates; }
        catch (_) { return; }
        const marker = L.marker([coord[1], coord[0]], {
            pane: blockifyModal?.handlePane,
            draggable: true,
            title: kind === 'gap'
                ? translateBuildingText('blockify.modal.handles.gap', 'Drag to move gap')
                : translateBuildingText('blockify.modal.handles.wing', 'Drag to move wing'),
            icon: L.divIcon({
                className: `blockify-handle blockify-handle--${kind}`,
                html: '<span></span>',
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            })
        });
        marker.on('dragend', () => {
            try {
                const ll = marker.getLatLng();
                const snapped = turf.nearestPointOnLine(ringLine, turf.point([ll.lng, ll.lat]), { units: 'meters' });
                const loc = snapped && snapped.properties ? snapped.properties.location : null;
                if (Number.isFinite(loc) && ringLenM > 0) {
                    posArray[idx] = (((loc / ringLenM) % 1) + 1) % 1;
                }
            } catch (_) { }
            generateBuildingInModal();
        });
        marker.addTo(blockifyHandleLayer);
    };

    for (let i = 0; i < gapPositions.length; i++) addHandle(gapPositions, i, 'gap');
    for (let i = 0; i < wingPositions.length; i++) addHandle(wingPositions, i, 'wing');
}

// --- Manual (freeform) footprint mode ---

const FOOTPRINT_SLIDER_IDS = ['setback-slider', 'chamfer-slider', 'simplify-slider', 'width-slider', 'gaps-slider', 'gap-width-slider', 'wings-slider', 'wing-length-slider'];

function setFootprintSlidersEnabled(enabled) {
    FOOTPRINT_SLIDER_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !enabled;
    });
}

function updateManualToggleLabel() {
    const btn = document.getElementById('blockify-manual-toggle');
    if (!btn) return;
    // Manual mode is a toggle that is on: the pressed look comes from aria-pressed (primitives.css).
    const manual = blockifyMode === 'manual';
    const key = manual ? 'blockify.modal.manual.back' : 'blockify.modal.manual.edit';
    btn.setAttribute('data-i18n-key', key);
    btn.textContent = manual
        ? translateBuildingText(key, 'Discard manual shape and return to generated geometry')
        : translateBuildingText(key, 'Edit shape manually');
    btn.setAttribute('aria-pressed', manual ? 'true' : 'false');
}

function enterManualMode() {
    const currentRing = blockifyOuterRing(generatedBuildingFeature);
    if (!Array.isArray(currentRing) || currentRing.length < 3) {
        showBuildingAlert('blockify.modal.manual.needShape', 'Generate a shape with the sliders first, then edit it manually.');
        return;
    }
    blockifyHistory?.record?.();
    blockifyMode = 'manual';
    blockifyPendingVertexActionIndex = null;
    // Seed the editable ring from the last clean outer ring (drop the closing duplicate vertex).
    const ring = currentRing.slice();
    if (ring.length >= 2) {
        const f = ring[0], l = ring[ring.length - 1];
        if (l && f[0] === l[0] && f[1] === l[1]) ring.pop();
    }
    // Cap the handle count: a large block's outline carries tens of thousands of vertices, which would
    // make manual mode drop that many draggable markers (a tab-freezing amount) and leaves nothing a
    // person could actually drag. Simplify to an editable budget first.
    const rawVertices = ring.length;
    manualOuterRing = simplifyRingToVertexTarget(ring.map(c => [c[0], c[1]]));
    manualBuildSucceeded = false;
    setFootprintSlidersEnabled(false);
    updateManualToggleLabel();
    if (rawVertices > manualOuterRing.length) {
        setBlockifyInfo('blockify.modal.manual.hintSimplified',
            'Manual mode: outline simplified to {{count}} draggable points. Drag a point to reshape, click an edge to add one, or select a point and use the trash button or Delete/Backspace to remove it. Height stays adjustable.',
            { count: manualOuterRing.length });
    } else {
        setBlockifyInfo('blockify.modal.manual.hint', 'Manual mode: drag a vertex to reshape, click an edge to add one, or select a vertex and use the trash button or Delete/Backspace to remove it. Height stays adjustable.');
    }
    generateManualBuilding();
}

async function exitToParametricMode() {
    const question = translateBuildingText('blockify.modal.manual.confirmReset', 'Discard manual edits and go back to the sliders?');
    // The app's own confirm (js/ui/dialogs.js); throwing the edits away is the destructive answer.
    const proceed = await window.CbDialog.confirm(question, {
        destructive: true,
        okText: translateBuildingText('proposalDrafts.discardDesign.confirm', 'Discard')
    });
    if (!proceed) return;
    blockifyHistory?.record?.();
    blockifyMode = 'parametric';
    blockifyPendingVertexActionIndex = null;
    manualOuterRing = [];
    setFootprintSlidersEnabled(true);
    updateManualToggleLabel();
    generateBuildingInModal();
}

// --- "Based on existing buildings" mode ---
// The proposal is derived from the existing footprints on the selected parcels under one of two
// exclusive rules (see proposedHeightForFootprint): 'exact' extrudes every footprint to the
// proposed height, 'additional' adds floors on top of each building's current height. Each
// building becomes its own Feature with its own properties.height, so a proposal is naturally
// multiple 3D objects.

// Union of ALL block parcels as the footprint query area. Deliberately not lastSuperparcel —
// that one is reduced to the single largest polygon for ring generation, which would drop
// buildings on disjoint parcels.
function getBlockQueryGeometry() {
    if (blockifyAuthoredSite?.geometry) return blockifyAuthoredSite.geometry;
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || !block.parcels.length) return null;
    try {
        const union = robustUnion(blockifyFeaturesForBlock(block));
        return union && union.geometry ? union.geometry : null;
    } catch (_) { return null; }
}

// Fetch the block's existing footprints once per modal open. Resolves to null when the city has
// no footprint source (supported: false), or to the (possibly empty) footprint array otherwise.
function ensureExistingFootprints() {
    if (existingFootprintsPromise) return existingFootprintsPromise;
    const geometry = getBlockQueryGeometry();
    if (!geometry) return Promise.resolve(null);
    existingFootprintsPromise = window.BuildingSourceClient.request('/buildings/footprints', { geometry }).then(payload => {
        if (!payload || payload.supported === false) return null;
        existingFootprints = (payload.footprints || []).filter(f => f && f.geometry);
        return existingFootprints;
    }).catch(err => {
        existingFootprintsPromise = null; // let the next toggle retry
        throw err;
    });
    return existingFootprintsPromise;
}

function setExistingToggleChecked(checked) {
    const cb = document.getElementById('blockify-existing-toggle');
    if (cb) cb.checked = !!checked;
}

// Swap the sidebar between the freeform sliders and the existing-buildings sliders.
function updateBlockifyModeUI() {
    const existing = blockifyMode === 'existing';
    document.querySelectorAll('#blockify-sidebar .blockify-freeform-only').forEach(el => {
        el.style.display = existing ? 'none' : '';
    });
    document.querySelectorAll('#blockify-sidebar .blockify-existing-only').forEach(el => {
        el.style.display = existing ? '' : 'none';
    });
    updateAdditionalFloorsAvailability();
    if (existing) {
        // Raised existing buildings are keyed to buildings, not parcels, so there is nothing to
        // cut. Clearing the pieces stops a parametric design's leftovers being saved under them.
        blockMassingPieces = [];
        blockBuildOut = [];
        blockExcludedParcels = [];
    } else {
        // The blanket un-hide above would also reveal the minimum, which belongs to one rule type.
        syncBlockMinHeightSlider();
    }
}

// "Additional floors" only means something when the source data knows current heights (or floor
// counts) — otherwise there is nothing to add to and the slider + its radio stay greyed out.
function updateAdditionalFloorsAvailability() {
    const slider = document.getElementById('additional-floors-slider');
    const radio = document.getElementById('blockify-rule-additional');
    if (!slider) return;
    const known = Array.isArray(existingFootprints) && existingFootprints.some(f =>
        f && (Number(f.height_m) > 0 || Number(f.floors) > 0));
    const available = blockifyMode === 'existing' && known;
    slider.disabled = !available;
    if (radio) radio.disabled = !available;
    if (!available && existingRule === 'additional') setExistingRule('exact');
}

function setExistingRule(rule) {
    existingRule = rule === 'additional' ? 'additional' : 'exact';
    const radio = document.getElementById(existingRule === 'additional' ? 'blockify-rule-additional' : 'blockify-rule-exact');
    if (radio) radio.checked = true;
}

function updateExistingValueLabels() {
    const proposedValue = document.getElementById('proposed-height-value');
    if (proposedValue) {
        proposedValue.textContent = `${currentProposedHeightFloors} (${CbFormat.formatLength(currentProposedHeightFloors * currentFloorHeightM)})`;
    }
    const additionalValue = document.getElementById('additional-floors-value');
    if (additionalValue) additionalValue.textContent = String(currentAdditionalFloors);
    const floorHeightValue = document.getElementById('floor-height-value');
    if (floorHeightValue) floorHeightValue.textContent = CbFormat.formatNumber(currentFloorHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
}

async function enterExistingMode() {
    blockifyMode = 'existing';
    generatedBuildingFeatures = null;
    clearGapWingHandles();
    updateBlockifyModeUI();
    setBlockifyInfo('blockify.modal.existing.loading', 'Loading existing buildings...');

    let footprints = null;
    try {
        footprints = await ensureExistingFootprints();
    } catch (err) {
        console.warn('[Blockify] existing footprints fetch failed:', err);
        exitExistingMode({ infoKey: 'blockify.modal.existing.loadFailed', infoFallback: 'Could not load existing buildings. Try again.' });
        return;
    }
    if (blockifyMode !== 'existing') return; // user toggled away while loading

    if (footprints === null) {
        exitExistingMode({ infoKey: 'blockify.modal.existing.notAvailable', infoFallback: 'Existing building data is not available for this city yet.' });
        return;
    }
    if (!footprints.length) {
        exitExistingMode({ infoKey: 'blockify.modal.existing.noneFound', infoFallback: 'No existing buildings found on the selected parcels.' });
        return;
    }

    renderExistingFootprintsLayer();
    updateAdditionalFloorsAvailability();
    generateExistingBuildingsInModal();
}

// Back to the freeform sliders. `revertInfo` carries the reason when the mode is being reverted
// automatically (unsupported city, no footprints, fetch failure) so the user sees why.
function exitExistingMode(revertInfo = null) {
    blockifyMode = 'parametric';
    generatedBuildingFeatures = null;
    setExistingToggleChecked(false);
    // Entering existing mode from manual mode leaves manual state behind — always land back on a
    // clean parametric state (sliders live, manual toggle label reset).
    manualOuterRing = [];
    setFootprintSlidersEnabled(true);
    updateManualToggleLabel();
    if (blockifyFootprintLayer && blockifyMap) {
        try { blockifyMap.removeLayer(blockifyFootprintLayer); } catch (_) { }
    }
    blockifyFootprintLayer = null;
    updateBlockifyModeUI();
    generateBuildingInModal();
    if (revertInfo && revertInfo.infoKey) setBlockifyInfo(revertInfo.infoKey, revertInfo.infoFallback);
}

// Grey dashed outlines of all fetched footprints, under the blue proposal shapes — shows what the
// proposal is based on, including buildings left unchanged.
function renderExistingFootprintsLayer() {
    if (!blockifyMap) return;
    if (blockifyFootprintLayer) {
        try { blockifyMap.removeLayer(blockifyFootprintLayer); } catch (_) { }
        blockifyFootprintLayer = null;
    }
    const list = Array.isArray(existingFootprints) ? existingFootprints : [];
    if (!list.length) return;
    blockifyFootprintLayer = L.geoJSON({
        type: 'FeatureCollection',
        features: list.map(f => ({ type: 'Feature', properties: {}, geometry: f.geometry }))
    }, {
        pane: blockifyModal?.pane,
        style: { color: '#555555', weight: 1.5, dashArray: '4 3', fillOpacity: 0.08 },
        interactive: false
    }).addTo(blockifyMap);
}

// The building's current height as far as the data knows it: measured height wins, floor count
// times the floor-height slider as fallback, null when neither is known.
function existingHeightForFootprint(fp) {
    const measured = Number(fp && fp.height_m);
    if (Number.isFinite(measured) && measured > 0) return measured;
    const floors = Number(fp && fp.floors);
    if (Number.isFinite(floors) && floors > 0) return floors * currentFloorHeightM;
    return null;
}

// Per-building proposed height under the active rule, or null to leave the building out.
// 'exact': every footprint is drawn at exactly the proposed height (even below its current one —
// the proposal states the intended height, it doesn't demolish anything).
// 'additional': current height + N floors, uncapped; buildings with unknown height are skipped
// because there is nothing to add to.
function proposedHeightForFootprint(fp) {
    const existingH = existingHeightForFootprint(fp);
    if (existingRule === 'additional') {
        if (existingH === null) return { existingH, proposedH: null };
        return { existingH, proposedH: existingH + currentAdditionalFloors * currentFloorHeightM };
    }
    return { existingH, proposedH: currentProposedHeightFloors * currentFloorHeightM };
}

function generateExistingBuildingsInModal() {
    if (blockifyMode !== 'existing') return;
    const list = Array.isArray(existingFootprints) ? existingFootprints : [];
    const blockName = getBlockifyDisplayName();

    const features = [];
    list.forEach(fp => {
        const { existingH, proposedH } = proposedHeightForFootprint(fp);
        if (proposedH === null) return;
        let geometry;
        try { geometry = JSON.parse(JSON.stringify(fp.geometry)); } catch (_) { return; }
        features.push({
            type: 'Feature',
            properties: {
                type: 'proposedBuilding',
                block: blockName,
                basedOnExisting: true,
                sourceBuildingId: fp.id != null ? fp.id : null,
                existingHeight: existingH,
                height: Math.round(proposedH * 100) / 100,
                buildingIndex: features.length
            },
            geometry
        });
    });

    generatedBuildingFeatures = features;
    generatedBuildingFeature = null;
    displayBuildingsInModal(features);
    if (existingRule === 'additional') {
        setBlockifyInfo('blockify.modal.existing.summary', 'Existing buildings: {{total}} · raising: {{count}}', {
            count: features.length,
            total: list.length,
            existingBuildings: { key: 'blockify.modal.existing.buildingCount', count: list.length }
        });
    } else {
        setBlockifyInfo('blockify.modal.existing.summaryExact', 'Proposed buildings: {{count}} · height: {{height}} m', {
            count: features.length,
            height: CbFormat.formatNumber(currentProposedHeightFloors * currentFloorHeightM, { maxFractionDigits: 1, minFractionDigits: 1 })
        });
    }
    const doneButton = document.getElementById('btn-blockify-done');
    if (doneButton) doneButton.disabled = features.length === 0;
}

// Array flavour of displayBuildingInModal: draw all proposed buildings at once (existing mode).
function displayBuildingsInModal(features) {
    if (blockifyBuildingLayer) {
        blockifyMap.removeLayer(blockifyBuildingLayer);
        blockifyBuildingLayer = null;
    }
    if (!Array.isArray(features) || !features.length) {
        refreshBlockifyDensityStats([]);
        publishBlockifyPreview({ exampleBuildings: [], envelopes: [], excluded: [] });
        return;
    }
    blockifyBuildingLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
        pane: blockifyModal?.pane,
        style: {
            color: '#007bff',
            weight: 4,
            opacity: 1,
            fillOpacity: 0.2
        }
    }).addTo(blockifyMap);
    publishBlockifyPreview({ exampleBuildings: features, envelopes: [], excluded: [] });
    refreshBlockifyDensityStats(features);
    autosaveBlockifyDraft(features);
}

// Build the block from the user-edited outer ring: re-inset by the current building width so it
// stays a ring-with-hole (or a solid building if the courtyard collapses).
function generateManualBuilding() {
    if (blockifyMode !== 'manual') return;
    if (!Array.isArray(manualOuterRing) || manualOuterRing.length < 3) return;
    try {
        const ensureClosed = (coords) => {
            const a = coords.slice();
            const f = a[0], l = a[a.length - 1];
            if (!l || f[0] !== l[0] || f[1] !== l[1]) a.push([f[0], f[1]]);
            return a;
        };
        let outerBuilding = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ensureClosed(manualOuterRing)] } };
        outerBuilding = sanitizePolygonFeature(outerBuilding) || outerBuilding;
        outerBuilding = toSingleLargestPolygon(outerBuilding) || outerBuilding;
        if (!outerBuilding || !outerBuilding.geometry) throw new Error('Invalid manual outline');
        // Guarantee the outline stays inside the parcel (an edge between two inside-vertices can still
        // cross outside a concave parcel). No auto-simplify here — the user controls the vertices.
        outerBuilding = simplifyAndClipOutline(outerBuilding, 0, blockifyDesignBoundary());

        const cleanOuter = ensureClosed(outerBuilding.geometry.coordinates[0]);
        const width = Number(currentBuildingWidth) || DEFAULT_BUILDING_WIDTH;
        const baseProps = {
            type: 'proposedBuilding',
            block: getBlockifyDisplayName(),
            height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
            manual: true
        };

        let buildingFeature;
        const inc = incrementalInsetPolygon(outerBuilding, width, 0);
        if (inc && inc.feature && inc.feature.geometry) {
            const innerCoords = ensureClosed(inc.feature.geometry.coordinates[0]).reverse();
            buildingFeature = { type: 'Feature', properties: Object.assign({ width }, baseProps), geometry: { type: 'Polygon', coordinates: [cleanOuter, innerCoords] } };
        } else {
            // courtyard collapsed → solid footprint
            buildingFeature = { type: 'Feature', properties: Object.assign({ width: 0 }, baseProps), geometry: { type: 'Polygon', coordinates: [cleanOuter] } };
        }

        generatedBuildingFeature = buildingFeature;
        manualBuildSucceeded = true;
        displayBuildingInModal(buildingFeature);
        renderManualPolygonEditor();

        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) doneButton.disabled = false;
    } catch (err) {
        console.error('Manual building generation failed:', err);
        // If the outline was never buildable in the first place (the failure happened on entry, before
        // any successful manual build), don't strand the user in a manual mode with dead sliders and an
        // unactionable "move the vertex back" — there's no good vertex to move back to. Drop straight
        // back to the parametric sliders, which produced a working shape, and say why.
        if (!manualBuildSucceeded) {
            blockifyMode = 'parametric';
            manualOuterRing = [];
            setFootprintSlidersEnabled(true);
            updateManualToggleLabel();
            clearGapWingHandles();
            setBlockifyInfo('blockify.modal.manual.entryFailed',
                'This outline is too complex to edit by hand — back to the sliders. Tip: raise "Simplify (m)" to smooth it, then try editing again.');
            try { generateBuildingInModal(); } catch (_) { }
            return;
        }
        // Mid-edit failure (a bad drag off a previously-good shape): the vertex-back hint is right, and
        // the last good shape is still on screen.
        setBlockifyInfo('blockify.modal.manual.error', 'Could not build from the manual outline. Try moving the vertex back.');
    }
}

// The block editor and freeform-building editor intentionally share this controller. It preserves
// manual mode's proven drag cadence (cheap live outline, full rebuild on release) and adds the same
// edge-click insertion and selected-vertex deletion behavior to both tools.
function renderManualPolygonEditor() {
    const initialSelectedVertexIndex = blockifyPendingVertexActionIndex;
    blockifyPendingVertexActionIndex = null;
    clearGapWingHandles();
    if (!blockifyMap || !Array.isArray(manualOuterRing) || manualOuterRing.length < 3) return;
    if (!window.PolygonGeometryEditor || typeof window.PolygonGeometryEditor.create !== 'function') {
        console.error('Shared polygon geometry editor is unavailable.');
        return;
    }
    blockifyPolygonEditor = window.PolygonGeometryEditor.create({
        map: blockifyMap,
        leaflet: L,
        turf,
        pane: blockifyModal?.pane,
        handlePane: blockifyModal?.handlePane,
        ring: manualOuterRing,
        boundary: () => blockifyDesignBoundary(),
        undo: false,
        initialSelectedVertexIndex,
        showInitialDeleteAction: Number.isInteger(initialSelectedVertexIndex),
        vertexTitle: translateBuildingText('blockify.modal.manual.vertex', 'Drag to reshape'),
        deleteTitle: translateBuildingText('blockify.modal.manual.deleteVertex', 'Delete selected vertex'),
        onLiveChange: ({ ring }) => {
            manualOuterRing = ring;
        },
        onDragStart: () => blockifyHistory?.record?.(),
        onCommit: ({ ring, reason, vertexIndex }) => {
            if (reason !== 'move') blockifyHistory?.record?.();
            blockifyPendingVertexActionIndex = reason === 'move' ? vertexIndex : null;
            manualOuterRing = ring;
            generateManualBuilding();
            // Successful regeneration consumes this while recreating the controller; a failed
            // regeneration leaves the current controller alive to show its own release action.
            blockifyPendingVertexActionIndex = null;
        }
    });
}

// Fixed GeoJSON footprints are Freeform buildings, not a set of parcel rules. Continue the same
// design session in that editor so all polygons and holes remain editable before Done commits.
function loadGeojsonFootprint(file) {
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            await window.openFreeformGeoJSONBuildings(JSON.parse(reader.result), {
                blockName: getBlockifyDisplayName(),
                closeSource: () => closeBlockifyModal({ preservePending: true, continueDesignSession: true })
            });
        } catch (error) {
            console.error('GeoJSON building import failed', error);
            showBuildingAlert('blockify.modal.manual.uploadNoPolygon', 'Could not import the file. Use valid Polygon or MultiPolygon building footprints.');
        }
    };
    reader.onerror = () => showBuildingAlert('blockify.modal.manual.uploadError', 'Could not read that file.');
    reader.readAsText(file);
}

// Function to apply the building to the main map
function applyBuildingToMap() {
    if (generatedBuildingFeature) {
        // Add the building to the proposed buildings array
        proposedBuildings.push(generatedBuildingFeature);

        // Update the proposed buildings layer
        updateProposedBuildingsLayer();

        // Show proposed buildings layer
        document.getElementById('showProposedBuildings').checked = true;

        updateStatus(translateBuildingText('status.messages.blockify_created_proposed_building_block', 'Created proposed building block for {{block}} (width: {{width}}m, setback: {{setback}}m)', { block: getBlockifyDisplayName(), width: CbFormat.formatNumber(generatedBuildingFeature.properties.width, { maxFractionDigits: 1, minFractionDigits: 1 }), setback: CbFormat.formatNumber(generatedBuildingFeature.properties.setback, { maxFractionDigits: 1, minFractionDigits: 1 }) }))
        // Close the modal
        closeBlockifyModal();
    } else {
        // Show error message if no building has been generated
        setBlockifyInfo('blockify.modal.messages.noBuilding', 'No building generated yet. Please try regenerating.');
    }
}

// Replace the existing generateBuilding function
function generateBuilding() {
    // This function is deprecated, using generateBuildingInModal instead
    generateBuildingInModal();
}

// `initialState` (optional) restores a previously-saved design instead of the defaults — see
// applyBlockifySeedState. Used by "Copy into new proposal" to reopen a fork's original building.
function openUrbanRuleForParcels({ blockName, parcelIds, initialState = null, site = null, initialGroundTreatment = null, initialDecorationDesign = null }) {
    const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
    const normalizedSite = normalizeBlockifySite(site);
    if (!ids.length && !normalizedSite?.geometry) {
        updateStatus(translateBuildingText('status.messages.select_parcels_before_launching_the_buildings_tool', 'Select parcels before launching the buildings tool.'));
        return false;
    }
    blockifySeedState = initialState || null;
    blockifyInitialGroundTreatment = initialGroundTreatment;
    blockifyInitialDecorationDesign = initialDecorationDesign;
    blockifyAuthoredSite = normalizedSite;
    const resolve = typeof window.resolveDesignParcelFeature === 'function'
        ? window.resolveDesignParcelFeature
        : id => window.LiveParcelFabric?.get?.(id);
    const features = ids.map(id => resolve(id)).filter(Boolean);
    if (!ids.length && normalizedSite?.geometry) features.push(normalizedSite);
    if (ids.length && features.length !== ids.length) {
        updateStatus(translateBuildingText('status.messages.could_not_resolve_parcel_data_for_the_selected_parcels', 'Could not resolve parcel data for the selected parcels.'));
        return false;
    }

    blockifyBlock = {
        parcels: ids.length ? ids : [{ id: '__placement-site__', feature: normalizedSite }],
        parcelIds: ids,
        syntheticSite: ids.length === 0,
        site: normalizedSite,
        valid: true,
        polygon: null
    };
    // The modal constructs the parcel union where it can present a recoverable geometry error.
    blockifyGenerationSite = normalizedSite;
    blockifyBlockNameOverride = blockName || describeParcelSelection(ids);
    return showBlockifyModal();
}

window.openUrbanRuleForParcels = openUrbanRuleForParcels;

// Function to capture current blockify configuration for later proposal creation
// Measure the block footprint and, if it's larger than the recommended size, ask the user to confirm.
// Returns true to proceed (not oversized, user accepted, or the measurement/confirm was unavailable),
// false only when the user actively backs out. Never throws — a warning must not block a valid save.
async function confirmBlockSizeIfOversized(block) {
    try {
        if (typeof ProposalWarnings === 'undefined' || typeof turf === 'undefined') return true;
        let outline = blockifyDesignBoundary()?.geometry ? blockifyDesignBoundary() : null;
        if (!outline && block && Array.isArray(block.parcels)) {
            outline = robustUnion(blockifyFeaturesForBlock(block));
        }
        if (!outline || !outline.geometry) return true;
        const perimeterM = turf.length(outline, { units: 'kilometers' }) * 1000;
        const assessment = ProposalWarnings.assessBlockSize(perimeterM);
        if (!assessment.oversized) return true;
        const confirmFn = (typeof window !== 'undefined') ? window.showStyledConfirm : null;
        if (typeof confirmFn !== 'function') return true; // no styled confirm → don't stand in the way
        const message = translateBuildingText(
            'blockify.modal.warnings.oversizedBlock',
            'This block is large — walking around it would take about {{minutes}} minutes. Recommended blocks are between 50×50 m and 200×200 m, so they can be walked around in about 2½ to 10 minutes. Do you want to proceed?',
            { minutes: assessment.roundedMinutes }
        );
        return await confirmFn(message, {
            okText: translateBuildingText('blockify.modal.warnings.proceed', 'Proceed anyway'),
            cancelText: translateBuildingText('blockify.modal.warnings.cancel', 'Go back')
        });
    } catch (err) {
        console.warn('[blockify] oversized-block check failed', err);
        return true;
    }
}

async function saveBlockifyDesignForProposal() {
    // Existing-buildings mode saves one feature per raised building; every other mode saves the
    // block's massing cut into one building per parcel. The cut pieces remain the economic and
    // ownership units, while `blockMassing` below preserves the authored block-wide shape (including
    // courtyard holes) as design geometry. Conflating those two shapes is what made both selected
    // edge plots and the common courtyard disappear after apply/reload.
    const existingModeFeatures = blockifyMode === 'existing'
        ? ((Array.isArray(generatedBuildingFeatures) && generatedBuildingFeatures.length) ? generatedBuildingFeatures : null)
        : null;
    if (!generatedBuildingFeature && !existingModeFeatures) {
        const info = document.getElementById('blockify-info');
        if (info) setBlockifyInfo('blockify.modal.messages.generateBeforeFinishing', 'Generate a building before finishing.');
        return;
    }

    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        const info = document.getElementById('blockify-info');
        if (info) setBlockifyInfo('blockify.modal.messages.blockHasNoParcels', 'Block has no parcels.');
        return;
    }

    // Gentle nudge before committing an oversized block: quote how long it would take to walk around
    // and let the user proceed anyway. Best-effort — a measurement hiccup must never block the save.
    if (!(await confirmBlockSizeIfOversized(block))) return;

    const parentDetails = [];
    const normalizedParcelIds = [];

    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
        if (typeof multiParcelSelection.clearSelection === 'function') {
            multiParcelSelection.clearSelection();
        }
    }

    if (!block.syntheticSite) block.parcels.forEach(parcel => {
        const feature = blockifyFeatureForParcel(parcel);
        const props = feature?.properties;
        const parcelId = blockifyParcelId(parcel);
        if (!parcelId) return;
        const idStr = parcelId.toString();
        let number = idStr;
        try {
            if (props?.BROJ_CESTICE) {
                number = String(props.BROJ_CESTICE);
            }
        } catch (_) { }
        normalizedParcelIds.push(idStr);
        parentDetails.push({ id: idStr, number });
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection?.selectedParcels) {
            multiParcelSelection.selectedParcels.add(idStr);
        }
    });

    if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.updateUI === 'function') {
        multiParcelSelection.updateUI();
    }

    if (!normalizedParcelIds.length && !block.syntheticSite) {
        const info = document.getElementById('blockify-info');
        if (info) setBlockifyInfo('blockify.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
        return;
    }

    const algorithmSelect = document.getElementById('algorithm-select');
    // Existing-buildings mode saves one feature per raised building (each with its own height);
    // freeform/manual modes keep the single-feature shape. createProposal() consumes either via
    // `buildings` (array) with `buildingFeature` as the single/primary fallback.
    const clonedBuildings = existingModeFeatures
        ? JSON.parse(JSON.stringify(existingModeFeatures))
        : [window.UrbanRuleVariation.massingWithRule(generatedBuildingFeature, currentBlockRule(), blockVariationSeed, { turf })];
    const clonedFeature = clonedBuildings[0];
    const blockMassing = blockifyMode !== 'existing' && generatedBuildingFeature?.geometry
        ? blockifyClone(clonedFeature)
        : null;

    // Save enough to rebuild this exact design later (see applyBlockifySeedState). Width/height/
    // setback/chamfer/algorithm alone are lossy: a manual outline isn't slider-derived at all, and
    // gaps/wings/simplify silently disappear on regeneration. Copies would otherwise change shape.
    // Keyed on the MODE, not on whether buildings came out as an array: every mode saves an array
    // now, and writing mode:'existing' for a parametric design would lose its whole shape on re-edit.
    const parameters = blockifyMode === 'existing'
        ? {
            mode: 'existing',
            typology: 'block',
            rule: existingRule,
            proposedHeightFloors: currentProposedHeightFloors,
            additionalFloors: currentAdditionalFloors,
            floorHeightM: currentFloorHeightM,
            algorithm: null
        }
        : {
            mode: blockifyMode,
            typology: 'block',
            simplify: Number.isFinite(Number(currentSimplifyM)) ? Number(currentSimplifyM) : null,
            gaps: Array.isArray(gapPositions) ? JSON.parse(JSON.stringify(gapPositions)) : [],
            wings: Array.isArray(wingPositions) ? JSON.parse(JSON.stringify(wingPositions)) : [],
            manualOuterRing: (blockifyMode === 'manual' && Array.isArray(manualOuterRing))
                ? manualOuterRing.map(c => [c[0], c[1]])
                : null,
            width: Number.isFinite(Number(currentBuildingWidth)) ? Number(currentBuildingWidth) : null,
            height: Number.isFinite(Number(currentBuildingHeight)) ? Number(currentBuildingHeight) : null,
            setback: Number.isFinite(Number(currentSetback)) ? Number(currentSetback) : null,
            chamfer: Number.isFinite(Number(currentChamferM)) ? Number(currentChamferM) : null,
            algorithm: algorithmSelect ? algorithmSelect.value : null,
            // What the rule compels and which example build-out it was saved with, so reopening
            // reproduces the same street rather than a different one under the same name.
            rule: currentBlockRule(),
            seed: blockVariationSeed
        };

    // The plots this rule leaves out, and the building each would carry. Saved with the proposal so
    // the 3D view can show them as see-through volumes long after the editor is closed: a left-out
    // plot is part of the block that cannot take a building AS IT STANDS, and without this the
    // applied result is a gap with no explanation anywhere.
    const ineligibleParcels = blockExcludedParcels.map(entry => ({
        status: entry.status,
        height: (currentBlockRule() || {}).maxHeightM || Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT,
        geometry: entry.feature?.geometry ? JSON.parse(JSON.stringify(entry.feature.geometry)) : null,
        wouldBe: entry.wouldBe ? JSON.parse(JSON.stringify(entry.wouldBe)) : null
    }));

    const context = {
        parcelIds: normalizedParcelIds.slice(),
        parentDetails: parentDetails.slice(),
        blockName: getBlockifyDisplayName(),
        parameters,
        groundSurface: blockifySurroundings?.surface() || null,
        ineligibleParcels,
        buildingFeature: clonedFeature,
        ...(blockMassing ? { blockMassing } : {}),
        placement: { free: false, site: blockifyClone(blockifyDesignBoundary()) }
    };
    context.buildings = clonedBuildings;

    window.pendingBuildingFromBlockify = clonedFeature;
    setPendingBuildingProposalContext(context);

    closeBlockifyModal({ preservePending: true });

    if (typeof updateStatus === 'function') {
        updateStatus(translateBuildingText('status.messages.building_design_saved_add_proposal_details_to_submit', 'Building design saved. Add design details to submit.'));
    }

    const description = document.getElementById('proposalDescription');
    if (description) {
        if (!description.value.trim()) {
            const selectedLabel = translateBuildingText('blockify.modal.messages.selectedParcels', 'selected parcels');
            description.value = translateBuildingText(
                'blockify.modal.messages.defaultProposalDescription',
                'Building design for {{blockName}}',
                { blockName: context.blockName || selectedLabel }
            );
        }
        description.focus();
    }
}

// DEPRECATED: createProposalWithBuilding
// Building proposals are now handled by the unified createProposal() in proposals.js.
// The building geometry should be prepared via pendingBuildingProposalContext before calling createProposal().
// This function is kept for backward compatibility but simply delegates to the unified flow.
function createProposalWithBuilding() {
    // Just call the unified createProposal - it will pick up pendingBuildingProposalContext
    if (typeof createProposal === 'function') {
        createProposal();
    } else if (typeof window.createProposal === 'function') {
        window.createProposal();
    } else {
        console.error('createProposal function not available');
        if (typeof showBuildingAlert === 'function') {
            showBuildingAlert('proposal_workflow_unavailable', 'Design workflow is unavailable.');
        }
    }
}

window.createProposalWithBuilding = createProposalWithBuilding;
