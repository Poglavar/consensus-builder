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
// Add blockify modal variables
let blockifyMap = null;
let blockifyParcelLayer = null;
let blockifyBuildingLayer = null;
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
let blockifyLiveLayer = null;    // transient dashed outline shown while dragging a manual vertex
// Manual (freeform) footprint mode: a one-way branch from the parametric sliders. In manual mode the
// outer ring's vertices are draggable, the footprint sliders are inert, and the courtyard is still
// re-inset by the (frozen) building width. Height stays live. "Back to sliders" regenerates
// parametrically and discards manual edits. See the roadmap in URBAN-RULE-BLOCKS-ROADMAP.md.
let blockifyMode = 'parametric';  // 'parametric' | 'manual' | 'existing'
let manualOuterRing = [];         // editable outer-ring vertices ([lng,lat], open — no closing dup)
let manualBuildSucceeded = false; // has any manual build produced a shape? gates the trapped-state recovery
// Design to restore when the modal next opens, instead of starting from the defaults. Set by
// openUrbanRuleForParcels({ initialState }) — used by "Copy into new proposal" so a fork reopens
// the editor showing the original design, with every control live. Consumed once, then cleared.
let blockifySeedState = null;
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
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateBuildingText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatBuildingText(fallback, params);
}

function showBuildingAlert(key, fallback, params = {}) {
    const message = key
        ? translateBuildingText(`alerts.messages.${key}`, fallback, params)
        : translateBuildingText('', fallback, params);
    const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
        ? window.showStyledAlert
        : window.alert;
    if (typeof alertFn === 'function') {
        alertFn(message);
    }
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
        return blockStorage.blocks.get(selectedBlockName);
    }
    return null;
}

function describeParcelSelection(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return translateBuildingText('blockify.modal.messages.selectedParcels', 'Selected Parcels');
    if (ids.length === 1) return translateBuildingText('blockify.modal.messages.singleParcelLabel', 'Parcel {{id}}', { id: ids[0] });
    return translateBuildingText('blockify.modal.messages.multiParcelLabel', '{{count}} Parcels', { count: ids.length });
}

// --- 3D preview state ---
let blockifyThreeLoadPromise = null;
let blockify3D = {
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    frameId: null,
    container: null,
    originHTRS: null,
    modelGroup: null,
    parcelLinesGroup: null,
    contextGroup: null,
    resizeHandler: null,
    hasCenteredOnce: false,
    anchorLngLat: { lng: 0, lat: 0 }
};

function loadBlockifyContextBuildings(buildingFeature, anchor) {
    if (!blockify3D.contextGroup || !window.ContextBuildings3D || !buildingFeature || !buildingFeature.geometry) return;
    let queryGeom = buildingFeature.geometry;
    // Prefer the active block's parcels as a stable, bigger query area when available.
    try {
        const parcels = (typeof getActiveBlockifyBlock === 'function') ? (getActiveBlockifyBlock()?.parcels || []) : [];
        const fc = turf.featureCollection(parcels.map(p => p && p.feature).filter(Boolean));
        if (fc.features.length > 0) {
            const bbox = turf.bbox(fc);
            if (bbox && bbox.every(v => isFinite(v))) {
                const [minX, minY, maxX, maxY] = bbox;
                queryGeom = {
                    type: 'Polygon',
                    coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
                };
            }
        }
    } catch (_) { }

    const latLngToLocalXY = (lng, lat) => {
        const xy = projectToLocalMeters(lng, lat, anchor);
        return xy || [NaN, NaN];
    };
    try {
        window.ContextBuildings3D.loadInto(blockify3D.contextGroup, {
            geometry: queryGeom,
            latLngToLocalXY
        });
    } catch (e) {
        console.warn('[building-blocks] context buildings load failed:', e);
    }
}

function setBlockify3DAnchor(lng, lat) {
    const safeLng = Number.isFinite(lng) ? lng : 0;
    const safeLat = Number.isFinite(lat) ? lat : 0;
    blockify3D.anchorLngLat = { lng: safeLng, lat: safeLat };
}

// The ground-metres frame lives in frontend/js/local-frame.js (loaded first). Same formula as
// before — this is a de-dup, not a behaviour change.
function projectToLocalMeters(lng, lat, anchor) {
    return window.LocalFrame.projectToLocalMeters(lng, lat, anchor);
}

const BLOCKIFY_ALGORITHMS = {
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

// Function to show error popup
function showErrorPopup(message) {
    // Create modal container
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
    // Must sit ABOVE the blockify/urban-rule modal (z-index 12050) — at the old 2000 this "too
    // complex" dialog rendered behind the editor, so the user only saw it after closing the editor.
    modal.style.zIndex = '30050';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.backgroundColor = 'white';
    modalContent.style.padding = '20px';
    modalContent.style.borderRadius = '5px';
    modalContent.style.maxWidth = '400px';
    modalContent.style.textAlign = 'center';

    // Add message
    const messageElement = document.createElement('p');
    messageElement.textContent = message;
    messageElement.style.marginBottom = '20px';

    // Add OK button
    const okButton = document.createElement('button');
    okButton.textContent = 'OK';
    okButton.style.padding = '8px 16px';
    okButton.style.backgroundColor = '#007bff';
    okButton.style.color = 'white';
    okButton.style.border = 'none';
    okButton.style.borderRadius = '4px';
    okButton.style.cursor = 'pointer';
    okButton.onclick = function () {
        document.body.removeChild(modal);
    };

    // Assemble modal
    modalContent.appendChild(messageElement);
    modalContent.appendChild(okButton);
    modal.appendChild(modalContent);

    // Add to document
    document.body.appendChild(modal);
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
    // Wait for sidebar-management.js to load and define toggleLayer
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

function upsertProposedBuildingFeature(feature, { updateLayer = true, save = true } = {}) {
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

function removeProposedBuildingFeature(proposalId, { updateLayer = true, save = true } = {}) {
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

function markProposedBuildingState(proposalId, state, { updateLayer = true, save = true } = {}) {
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

async function ensureThreeForBlockify() {
    if (typeof THREE !== 'undefined') return true;
    if (blockifyThreeLoadPromise) {
        await blockifyThreeLoadPromise;
        return typeof THREE !== 'undefined';
    }
    blockifyThreeLoadPromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js';
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
    await blockifyThreeLoadPromise;
    return typeof THREE !== 'undefined';
}

// --- 3D helper functions ---

function refitBlockifyCamera(bboxOverride) {
    try {
        if (!blockify3D || !blockify3D.camera || !blockify3D.controls) return;
        const camera = blockify3D.camera;
        const controls = blockify3D.controls;
        let bbox = bboxOverride || null;
        if (!bbox) {
            if (blockify3D.modelGroup) {
                bbox = new THREE.Box3().setFromObject(blockify3D.modelGroup);
            }
        }
        if (!bbox || bbox.isEmpty()) return;
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        controls.target.copy(center);
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const fov = camera.fov * (Math.PI / 180);
        const minDist = 50;
        const dist = Math.max(minDist, (maxDim / 2) / Math.tan(fov / 2) * 1.3);
        camera.near = Math.max(0.1, dist / 100);
        camera.far = Math.max(2000, dist * 40);
        camera.updateProjectionMatrix();
        camera.position.set(center.x + dist, center.y + dist, center.z + dist);
        camera.lookAt(center);
    } catch (err) {
        console.warn('[3D] refitBlockifyCamera failed', err);
    }
}

function drawParcelsIn3D(parcelGroup, block) {
    try {
        // Clear previous
        for (let i = parcelGroup.children.length - 1; i >= 0; i--) {
            const ch = parcelGroup.children[i];
            if (ch.geometry) ch.geometry.dispose();
            if (ch.material) ch.material.dispose();
            parcelGroup.remove(ch);
        }
        const origin = blockify3D.originHTRS || [0, 0];
        const parcelFillMat = new THREE.MeshLambertMaterial({ color: 0xcc6666, transparent: true, opacity: 0.35, depthWrite: false });
        const parcelLineMat = new THREE.LineBasicMaterial({ color: 0xaa3333, linewidth: 1 });
        const roadFillMat = new THREE.MeshLambertMaterial({ color: 0xb0b0b0, transparent: true, opacity: 0.35, depthWrite: false });
        const roadLineMat = new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1 });

        block.parcels.forEach(p => {
            const geom = p?.feature?.geometry;
            if (!geom || !Array.isArray(geom.coordinates)) return;

            const rings = (geom.type === 'Polygon') ? geom.coordinates : ((geom.type === 'MultiPolygon') ? geom.coordinates[0] : []);
            const outerRing = rings[0];

            if (!Array.isArray(outerRing) || outerRing.length < 3) return;

            const props = p?.feature?.properties || {};
            const parcelId = typeof ensureParcelId === 'function' ? ensureParcelId(p?.feature) : (props.parcelId ?? props.parcel_id ?? props.id);
            let isRoadParcel = props.isRoad === true;
            try {
                if (!isRoadParcel && parcelId && typeof window.isRoadParcel === 'function') {
                    isRoadParcel = window.isRoadParcel(parcelId);
                }
            } catch (_) { }

            const fillMat = isRoadParcel ? roadFillMat : parcelFillMat;
            const edgeMat = isRoadParcel ? roadLineMat : parcelLineMat;

            const shape = new THREE.Shape();
            outerRing.forEach(([lng, lat], idx) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });
            const geom3 = new THREE.ShapeGeometry(shape);
            const mesh = new THREE.Mesh(geom3, fillMat);
            parcelGroup.add(mesh);

            // Outline - parcels in XY plane at Z=0
            const points = outerRing.map(([lng, lat]) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                return new THREE.Vector3(x - origin[0], y - origin[1], 0);
            });
            const closed = points[0] && points[points.length - 1] && !points[0].equals(points[points.length - 1])
                ? [...points, points[0].clone()] : points;
            const lineGeom = new THREE.BufferGeometry().setFromPoints(closed);
            const line = new THREE.Line(lineGeom, edgeMat);
            parcelGroup.add(line);
        });
    } catch (e) {
        console.warn('drawParcelsIn3D failed', e);
    }
}


function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        let value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).substr(-2);
    }
    return color;
}

function buildExtrudedMeshes(geometry, depth, material, roofMaterial = null, anchor = null) {
    const meshes = [];
    const polygons = [];
    if (!geometry) return meshes;
    if (geometry.type === 'Polygon') {
        polygons.push(geometry.coordinates);
    } else if (geometry.type === 'MultiPolygon') {
        polygons.push(...geometry.coordinates);
    }

    // Use provided anchor (block-level) for consistent alignment
    const safeAnchor = anchor && typeof anchor === 'object' ? anchor : { lng: 0, lat: 0 };
    const toFlat = (coord) => {
        if (!Array.isArray(coord) || coord.length < 2) return null;
        const projected = projectToLocalMeters(coord[0], coord[1], safeAnchor);
        if (!projected || projected.some(v => !isFinite(v))) return null;
        return projected;
    };

    polygons.forEach((rings, polyIdx) => {
        if (!Array.isArray(rings) || rings.length === 0) return;

        const flatOuter = (rings[0] || []).map(toFlat).filter(Boolean);
        if (flatOuter.length < 3) return;
        const flatHoles = rings.slice(1).map(ring => ring.map(toFlat).filter(Boolean)).filter(h => h.length >= 3);
        const shape = new THREE.Shape();
        flatOuter.forEach(([x, y], idx) => {
            if (idx === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
        });
        flatHoles.forEach(hole => {
            const holePath = new THREE.Path();
            hole.forEach(([x, y], idx) => {
                if (idx === 0) holePath.moveTo(x, y); else holePath.lineTo(x, y);
            });
            shape.holes.push(holePath);
        });

        try {
            const extrudeSettings = { depth, bevelEnabled: false, steps: 1 };
            const extrudeGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            meshes.push(new THREE.Mesh(extrudeGeom, material));

            const roofGeom = new THREE.ShapeGeometry(shape);
            roofGeom.translate(0, 0, depth);
            const roofMat = roofMaterial || material;
            meshes.push(new THREE.Mesh(roofGeom, roofMat));
        } catch (e) {
            console.warn('[3D] Failed to extrude polygon', polyIdx, e);
        }
    });
    return meshes;
}

// --- Simplified 3D rendering (override legacy) ---
function initBlockify3D(block) {
    // Legacy entrypoint now delegates to the simplified renderer
    initBlockify3DSimple();
}

function initBlockify3DSimple() {
    const container = document.getElementById('blockify-3d');
    if (!container) return;
    if (!container.style.minHeight) container.style.minHeight = '260px';
    if (!container.style.height) container.style.height = '260px';

    if (typeof THREE === 'undefined') {
        ensureThreeForBlockify().then(ok => { if (ok) initBlockify3DSimple(); });
        return;
    }

    try { if (blockify3D.frameId) cancelAnimationFrame(blockify3D.frameId); } catch (_) { }
    try { if (blockify3D.controls && blockify3D.controls.dispose) blockify3D.controls.dispose(); } catch (_) { }
    try { if (blockify3D.resizeHandler) window.removeEventListener('resize', blockify3D.resizeHandler); } catch (_) { }
    try { if (blockify3D.renderer) { blockify3D.renderer.dispose(); if (blockify3D.renderer.forceContextLoss) blockify3D.renderer.forceContextLoss(); } } catch (_) { }
    try { container.innerHTML = ''; } catch (_) { }

    const width = Math.max(1, container.clientWidth || 600);
    const height = Math.max(1, container.clientHeight || 300);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f9fb);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';

    const OrbitControlsCtor = THREE.OrbitControls || (typeof window !== 'undefined' ? window.OrbitControls : null);
    const controls = OrbitControlsCtor ? new OrbitControlsCtor(camera, renderer.domElement) : { update: () => { }, dispose: () => { } };
    if (controls.enableDamping !== undefined) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
    }

    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(300, 300, 500);
    scene.add(amb);
    scene.add(dir);

    const grid = new THREE.GridHelper(500, 20, 0xcccccc, 0xeeeeee);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0;
    scene.add(grid);

    // Context buildings (existing neighbours) sit underneath the proposal as
    // ghost reference geometry. Kept out of modelGroup so the camera fit ignores them.
    const contextGroup = new THREE.Group();
    scene.add(contextGroup);

    // Parcels group for outlines
    const parcelLinesGroup = new THREE.Group();
    scene.add(parcelLinesGroup);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    function handleResize() {
        const w = container.clientWidth || width;
        const h = container.clientHeight || height;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', handleResize);

    function animate() {
        controls.update();
        renderer.render(scene, camera);
        blockify3D.frameId = requestAnimationFrame(animate);
    }
    animate();

    blockify3D.renderer = renderer;
    blockify3D.scene = scene;
    blockify3D.camera = camera;
    blockify3D.controls = controls;
    blockify3D.container = container;
    blockify3D.modelGroup = modelGroup;
    blockify3D.parcelLinesGroup = parcelLinesGroup;
    blockify3D.contextGroup = contextGroup;
    blockify3D.originHTRS = [0, 0];
    blockify3D.resizeHandler = handleResize;
}

function updateBlockify3DScene(buildingFeatureOrFeatures) {
    // Accepts a single Feature (freeform/manual mode) or an array of Features with per-building
    // properties.height (existing-buildings mode). An empty array clears the proposal meshes.
    const features = Array.isArray(buildingFeatureOrFeatures)
        ? buildingFeatureOrFeatures.filter(f => f && f.geometry)
        : (buildingFeatureOrFeatures && buildingFeatureOrFeatures.geometry ? [buildingFeatureOrFeatures] : []);
    if (!Array.isArray(buildingFeatureOrFeatures) && !features.length) return;
    if (typeof THREE === 'undefined') return;
    if (!blockify3D || !blockify3D.renderer) {
        initBlockify3DSimple();
    }
    if (!blockify3D || !blockify3D.modelGroup || !blockify3D.scene) return;

    const prevCamPos = blockify3D.camera ? blockify3D.camera.position.clone() : null;
    const prevTarget = blockify3D.controls && blockify3D.controls.target ? blockify3D.controls.target.clone() : null;

    const group = blockify3D.modelGroup;
    // clear
    for (let i = group.children.length - 1; i >= 0; i--) {
        const ch = group.children[i];
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material) ch.material.dispose();
        group.remove(ch);
    }

    if (!features.length) return; // scene stays cleared (e.g. no buildings left to raise)

    let fallbackHeightMeters = Number.isFinite(currentBuildingHeight) ? currentBuildingHeight : DEFAULT_BUILDING_HEIGHT;
    fallbackHeightMeters = Math.max(3, Math.min(80, Math.round(fallbackHeightMeters))) || 20;

    // Compute anchor from active block parcels or building footprint
    let anchor = blockify3D.anchorLngLat;
    try {
        const activeBlock = getActiveBlockifyBlock();
        const coords = activeBlock?.parcels?.flatMap(p => p?.feature?.geometry?.coordinates || []) || [];
        let sx = 0, sy = 0, c = 0;
        const pushCoord = (pair) => {
            if (!Array.isArray(pair)) return;
            const lng = Number(pair[0]);
            const lat = Number(pair[1]);
            if (!isFinite(lng) || !isFinite(lat)) return;
            sx += lng; sy += lat; c += 1;
        };
        coords.forEach(poly => {
            if (Array.isArray(poly)) {
                poly.forEach(ring => {
                    if (Array.isArray(ring)) {
                        ring.forEach(pushCoord);
                    }
                });
            }
        });
        if (c > 0) {
            anchor = { lng: sx / c, lat: sy / c };
        } else {
            // Fallback: compute anchor from building feature coordinates
            // Handle both Polygon and MultiPolygon
            const geom = features[0].geometry;
            let firstCoord = null;
            if (geom.type === 'Polygon' && geom.coordinates?.[0]?.[0]) {
                firstCoord = geom.coordinates[0][0];
            } else if (geom.type === 'MultiPolygon' && geom.coordinates?.[0]?.[0]?.[0]) {
                firstCoord = geom.coordinates[0][0][0];
            }
            if (Array.isArray(firstCoord) && firstCoord.length >= 2) {
                anchor = { lng: Number(firstCoord[0]) || 0, lat: Number(firstCoord[1]) || 0 };
            }
        }
        setBlockify3DAnchor(anchor.lng, anchor.lat);
    } catch (_) { }

    loadBlockifyContextBuildings(features[0], anchor);

    const mat = new THREE.MeshPhongMaterial({
        color: 0x1e3a8a, // deeper blue
        emissive: 0x0a1f33,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
        side: THREE.DoubleSide
    });
    const roofMat = new THREE.MeshPhongMaterial({
        color: 0x1d4ed8, // roof blue
        emissive: 0x0a1f33,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
        side: THREE.DoubleSide
    });

    const meshes = [];
    features.forEach(feature => {
        // Per-building heights only apply in existing-buildings mode. In freeform mode the height
        // slider updates currentBuildingHeight without regenerating the feature, so its
        // properties.height can be stale — the fallback keeps the slider live there.
        const propH = Number(feature.properties && feature.properties.height);
        const heightMeters = (feature.properties && feature.properties.basedOnExisting && Number.isFinite(propH) && propH > 0)
            ? Math.min(propH, 400)
            : fallbackHeightMeters;
        meshes.push(...buildExtrudedMeshes(feature.geometry, heightMeters, mat, roofMat, anchor));
    });
    if (!meshes.length) {
        console.warn('[3D] No meshes built for building features');
        return;
    }
    meshes.forEach(mesh => {
        mesh.position.z = 0.05;
        group.add(mesh);
        try {
            const edges = new THREE.EdgesGeometry(mesh.geometry);
            const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, depthTest: true }));
            group.add(line);
        } catch (_) { }
    });

    // reset scale before measuring
    group.scale.set(1, 1, 1);

    let bbox = new THREE.Box3().setFromObject(group);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0);
    if (maxDim < 5) {
        const scale = 50 / Math.max(maxDim, 0.0001);
        group.scale.set(scale, scale, scale);
        bbox = new THREE.Box3().setFromObject(group);
    }

    // Draw parcel outlines in 3D
    if (blockify3D.parcelLinesGroup) {
        const linesGroup = blockify3D.parcelLinesGroup;
        for (let i = linesGroup.children.length - 1; i >= 0; i--) {
            const ch = linesGroup.children[i];
            if (ch.geometry) ch.geometry.dispose();
            linesGroup.remove(ch);
        }
        const parcels = getActiveBlockifyBlock()?.parcels || [];
        const lineMat = new THREE.LineBasicMaterial({ color: 0x555555, linewidth: 1, depthTest: true });
        parcels.forEach(p => {
            const geom = p?.feature?.geometry;
            if (!geom) return;
            const addRing = (coords) => {
                const pts = coords
                    .map(([lng, lat]) => {
                        const projected = projectToLocalMeters(lng, lat, anchor);
                        if (!projected || projected.some(v => !isFinite(v))) return null;
                        return new THREE.Vector3(projected[0], projected[1], 0.02);
                    })
                    .filter(Boolean);
                if (pts.length < 3) return;
                const g = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
                const line = new THREE.Line(g, lineMat);
                linesGroup.add(line);
            };
            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(ring => addRing(ring));
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => poly.forEach(ring => addRing(ring)));
            }
        });
    }

    if (!bbox.isEmpty()) {
        if (!blockify3D.hasCenteredOnce) {
            refitBlockifyCamera(bbox);
            blockify3D.hasCenteredOnce = true;
        } else if (prevCamPos && prevTarget) {
            try {
                blockify3D.camera.position.copy(prevCamPos);
                blockify3D.controls.target.copy(prevTarget);
                blockify3D.camera.updateProjectionMatrix();
            } catch (_) { }
        }
    }
}

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
            const cityIds = (Array.isArray(p.buildingProposal.parentParcelIds) && p.buildingProposal.parentParcelIds.length)
                ? p.buildingProposal.parentParcelIds
                : (Array.isArray(p.parcelIds) && p.parcelIds.length ? p.parcelIds
                    : (Array.isArray(p.parentParcelIds) ? p.parentParcelIds : []));
            if (cityIds.length && !cityIds.some(id => isInCityFn(id, cityId))) return;
        }

        const proposalId = p.proposalId || p.id;
        if (!proposalId) return;

        const bp = p.buildingProposal;
        const features = Array.isArray(p.geometry && p.geometry.buildings) ? p.geometry.buildings : [];

        if (!features.length) return;

        // Base props should act as defaults only. Per-building properties (parcelId, buildingIndex, etc.)
        // must NOT be overridden by proposal-level buildingProperties; otherwise we can collapse multiple
        // buildings into one on reload (e.g. 5 buildings -> 4).
        const baseProps = {
            ...(p.buildingProperties || p.properties || {}),
            parentParcelIds: bp.parentParcelIds || p.parcelIds || [],
            parentParcelNumbers: bp.parentParcelNumbers || null,
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
            if (upsertProposedBuildingFeature(hydrated, { updateLayer: false, save: false })) {
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

        // If there are buildings and checkbox is checked, update the layer
        const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
        if (list.length > 0 && showProposedBuildingsCheckbox && showProposedBuildingsCheckbox.checked) {
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
    const removed = removeProposedBuildingFeature(proposalId, { updateLayer: true, save: true });
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
function updateProposedBuildingsLayer() {
    if (proposedBuildingLayer) {
        map.removeLayer(proposedBuildingLayer);
        proposedBuildingLayer = null;
    }

    const list = ensureProposedBuildingsState();
    if (list.length > 0) {
        // Sync global so 3D mode can rebuild immediately
        if (typeof window !== 'undefined') {
            window.proposedBuildings = list;
            try { window.dispatchEvent(new CustomEvent('proposedBuildingsUpdated')); } catch (_) { }
        }
        proposedBuildingLayer = L.featureGroup().addTo(map);

        list.forEach((building, index) => {
            try {
                L.geoJSON(building, {
                    style: {
                        fillColor: '#ff3300',
                        fillOpacity: 0.4,
                        color: '#ff3300',
                        weight: 2
                    },
                    // Buildings are an overlay on top of parcels; keep parcels clickable.
                    interactive: false
                }).addTo(proposedBuildingLayer);
            } catch (error) {
                console.error(`Error rendering proposed building at index ${index}:`, error, building);
                // Remove the faulty building from the array to prevent further errors
                list.splice(index, 1);
                // Show the popup to the user
                showErrorPopup(translateBuildingText(
                    'blockify.modal.messages.renderingFailed',
                    'Building block creation failed -- Error rendering the generated building shape. The parcel might be too complex.'
                ));
                // Optionally, stop processing further buildings if one fails
                // return; // Uncomment this line if you want to stop after the first error
            }
        });
    }
}

// Function to show the blockify modal
function showBlockifyModal() {
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        updateStatus('No block selected');
        return;
    }

    // Store the block globally for the modal
    blockifyBlock = block;
    const blockLabel = getBlockifyDisplayName();

    console.log('[Blockify] showBlockifyModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

    // Create modal elements
    if (!document.getElementById('blockify-modal')) {
        const modalDiv = document.createElement('div');
        modalDiv.id = 'blockify-modal';
        modalDiv.style.position = 'fixed';
        modalDiv.style.top = '0';
        modalDiv.style.left = '0';
        modalDiv.style.width = '100%';
        modalDiv.style.height = '100%';
        modalDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modalDiv.style.display = 'flex';
        modalDiv.style.alignItems = 'center';
        modalDiv.style.justifyContent = 'center';

        const container = document.createElement('div');
        container.id = 'blockify-container';
        // Styles moved to CSS (frontend/css/modals.css)

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
            <div id="blockify-header">
                <h2 data-i18n-key="blockify.modal.title">Urban Rule</h2>
                <button id="blockify-close" type="button" class="close-circle-btn close-circle-btn--lg" data-i18n-key="blockify.modal.closeAria" data-i18n-attr="aria-label" aria-label="Close blockify modal">×</button>
            </div>
            <div id="blockify-body">
            <div id="blockify-main">
                <div id="blockify-map"></div>
                <div id="blockify-3d"></div>
                <div id="blockify-controls">
                    <div id="blockify-info" data-i18n-attr="text"></div>
                    <div id="blockify-buttons">
                        <button class="btn btn-proposal" id="btn-blockify-done" data-i18n-key="blockify.modal.done" data-i18n-attr="text">Done</button>
                    </div>
                </div>
            </div>
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
                <h3 data-i18n-key="blockify.modal.parametersTitle">Parameters</h3>
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
                        <span id="proposed-height-value">${DEFAULT_PROPOSED_HEIGHT_FLOORS} (${(DEFAULT_PROPOSED_HEIGHT_FLOORS * DEFAULT_FLOOR_HEIGHT_M).toFixed(1)} m)</span>
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
                        <span id="floor-height-value">${DEFAULT_FLOOR_HEIGHT_M.toFixed(1)}</span>
                    </label>
                    <input type="range" id="floor-height-slider" min="2.5" max="5" value="${DEFAULT_FLOOR_HEIGHT_M}" step="0.1">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="setback-slider">
                        <span data-i18n-key="blockify.modal.labels.setback" data-i18n-attr="text">Setback (m):</span>
                        <span id="setback-value">${DEFAULT_SETBACK.toFixed(1)}</span>
                    </label>
                    <input type="range" id="setback-slider" min="0" max="50" value="${DEFAULT_SETBACK}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="chamfer-slider">
                        <span data-i18n-key="blockify.modal.labels.chamfer" data-i18n-attr="text">Chamfer (m):</span>
                        <span id="chamfer-value">${currentChamferM.toFixed(1)}</span>
                    </label>
                    <input type="range" id="chamfer-slider" min="0" max="10" value="${DEFAULT_CHAMFER_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="simplify-slider">
                        <span data-i18n-key="blockify.modal.labels.simplify" data-i18n-attr="text">Simplify (m):</span>
                        <span id="simplify-value">${currentSimplifyM.toFixed(1)}</span>
                    </label>
                    <input type="range" id="simplify-slider" min="0" max="20" value="${DEFAULT_SIMPLIFY_M}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="width-slider">
                        <span data-i18n-key="blockify.modal.labels.width" data-i18n-attr="text">Building Width (m):</span>
                        <span id="width-value">${DEFAULT_BUILDING_WIDTH.toFixed(1)}</span>
                    </label>
                    <input type="range" id="width-slider" min="1" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                </div>
                <div class="parameter-group blockify-freeform-only">
                    <label for="height-slider">
                        <span data-i18n-key="blockify.modal.labels.height" data-i18n-attr="text">Building Height (m):</span>
                        <span id="height-value">${DEFAULT_BUILDING_HEIGHT.toFixed(1)}</span>
                    </label>
                    <input type="range" id="height-slider" min="3" max="80" value="${DEFAULT_BUILDING_HEIGHT}" step="0.5">
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
                    <button type="button" id="blockify-manual-toggle" class="btn btn-secondary" data-i18n-key="blockify.modal.manual.edit" data-i18n-attr="text">Edit shape manually</button>
                    <button type="button" id="blockify-geojson-upload" class="btn btn-secondary" data-i18n-key="blockify.modal.manual.uploadGeojson" data-i18n-attr="text">Upload GeoJSON</button>
                    <input type="file" id="blockify-geojson-input" accept=".geojson,.json,application/geo+json,application/json" style="display:none">
                </div>
                <div class="parameter-info">
                    <p class="blockify-freeform-only" data-i18n-key="blockify.modal.helper.adjust">Adjust parameters using the sliders to modify the building shape.</p>
                    <p class="blockify-freeform-only" data-i18n-key="blockify.modal.helper.setback">Setback is the distance from the parcel boundary to the outer building edge.</p>
                    <p class="blockify-freeform-only" data-i18n-key="blockify.modal.helper.width">Building width is the thickness of the building from outer to inner edge.</p>
                    <p class="blockify-existing-only" style="display:none" data-i18n-key="blockify.modal.existing.helper">Each existing building is raised by the additional floors, up to the maximum height. Buildings already at or above the maximum stay unchanged.</p>
                </div>
            </div>
        </div>
        `;

        modalDiv.appendChild(container);
        document.body.appendChild(modalDiv);

        setBlockifyInfo('blockify.modal.generating', 'Generating building...');
        try {
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                window.i18n.applyTranslations(container);
            }
        } catch (_) { }


        document.dispatchEvent(new CustomEvent('blockifyModalOpened'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

        // Add event listeners
        document.getElementById('blockify-close').addEventListener('click', requestCloseBlockifyModal);
        document.addEventListener('keydown', handleBlockifyKeydown);
        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) {
            doneButton.addEventListener('click', saveBlockifyDesignForProposal);
            doneButton.disabled = true;
        }

        // Add slider event listeners
        document.getElementById('setback-slider').addEventListener('input', function (e) {
            currentSetback = parseFloat(e.target.value);
            document.getElementById('setback-value').textContent = currentSetback.toFixed(1);
            generateBuildingInModal();
        });

        const chamferSlider = document.getElementById('chamfer-slider');
        if (chamferSlider) {
            chamferSlider.addEventListener('input', function (e) {
                currentChamferM = parseFloat(e.target.value);
                document.getElementById('chamfer-value').textContent = currentChamferM.toFixed(1);
                generateBuildingInModal();
            });
        }

        const simplifySlider = document.getElementById('simplify-slider');
        if (simplifySlider) {
            simplifySlider.addEventListener('input', function (e) {
                currentSimplifyM = parseFloat(e.target.value);
                document.getElementById('simplify-value').textContent = currentSimplifyM.toFixed(1);
                generateBuildingInModal();
            });
        }

        document.getElementById('width-slider').addEventListener('input', function (e) {
            currentBuildingWidth = parseFloat(e.target.value);
            document.getElementById('width-value').textContent = currentBuildingWidth.toFixed(1);
            generateBuildingInModal();
        });

        const heightSlider = document.getElementById('height-slider');
        if (heightSlider) {
            heightSlider.addEventListener('input', function (e) {
                currentBuildingHeight = parseFloat(e.target.value);
                document.getElementById('height-value').textContent = currentBuildingHeight.toFixed(1);
                // Only affects 3D extrusion; regenerate 3D using the current geometry
                if (generatedBuildingFeature) {
                    // Keep the feature's own height in step with the slider. The footprint doesn't
                    // change, so nothing regenerates it — without this the saved building carries
                    // the height from the last full generate, and the 3D view (which reads
                    // properties.height) renders the proposal at the wrong height.
                    if (generatedBuildingFeature.properties) {
                        generatedBuildingFeature.properties.height = currentBuildingHeight;
                    }
                    updateBlockify3DScene(generatedBuildingFeature);
                    // The draft carries its own copy of the feature and it is what gets published
                    // (serializeProposal reads editorPayload.context.buildings). Nothing regenerates
                    // the footprint here, so without this autosave a height-only edit was dropped.
                    autosaveBlockifyDraft();
                }
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

        // No outside-click close: a stray click on the backdrop would throw the design away.
        // The editor is left only via the X (discard, after confirming) or Done (save).
        // Prevent the 3D canvas from being occluded by map interactions
        const threeDiv = document.getElementById('blockify-3d');
        if (threeDiv) {
            threeDiv.style.pointerEvents = 'auto';
            console.log('[Blockify] 3D div found and styled:', threeDiv);
        } else {
            console.warn('[Blockify] 3D div NOT found after modal creation');
        }
    }

    // Initialize the blockify map if needed
    if (!blockifyMap) {
        blockifyMap = L.map('blockify-map', {
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: true
        });

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(blockifyMap);
    }

    // Display the block on the map
    displayBlockOnMap(block);

    // Reset parameter values
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
    currentChamferM = DEFAULT_CHAMFER_M;
    currentSimplifyM = DEFAULT_SIMPLIFY_M;
    gapPositions = [];
    wingPositions = [];
    blockifyMode = 'parametric';
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
        if (label) label.textContent = digits === 0 ? String(value) : Number(value).toFixed(digits);
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
        const proceed = await window.confirmDiscardProposalDesignSession({ hasDesign: blockifyHasGeneratedDesign() });
        if (!proceed) return;
    }
    closeBlockifyModal();
}

// Escape closes the editor exactly like the X does (discard, after confirming).
function handleBlockifyKeydown(event) {
    if (event.key !== 'Escape') return;
    if (!document.getElementById('blockify-modal')) return;
    event.preventDefault();
    requestCloseBlockifyModal();
}

// Tear the blockify modal down. This is pure teardown: the design is committed (or not) by the
// caller — "Done" saves first, X/Esc discards the design session first.
function closeBlockifyModal(options = {}) {
    const { preservePending = false } = options;
    document.removeEventListener('keydown', handleBlockifyKeydown);
    // Remove the map instance properly
    if (blockifyMap) {
        if (blockifyParcelLayer) {
            blockifyMap.removeLayer(blockifyParcelLayer);
            blockifyParcelLayer = null;
        }
        if (blockifyBuildingLayer) {
            blockifyMap.removeLayer(blockifyBuildingLayer);
            blockifyBuildingLayer = null;
        }
        if (blockifyFootprintLayer) {
            blockifyMap.removeLayer(blockifyFootprintLayer);
            blockifyFootprintLayer = null;
        }
        blockifyMap.remove();
        blockifyMap = null;
    }

    // Clear the generated building
    generatedBuildingFeature = null;
    generatedBuildingFeatures = null;
    existingFootprints = null;
    existingFootprintsPromise = null;
    blockifyBlock = null;
    blockifyBlockNameOverride = null;

    // Dispose 3D resources
    try {
        if (blockify3D && blockify3D.renderer) {
            if (blockify3D.frameId) cancelAnimationFrame(blockify3D.frameId);
            if (blockify3D.controls && blockify3D.controls.dispose) blockify3D.controls.dispose();
            try { if (blockify3D.renderer && blockify3D.renderer.forceContextLoss) blockify3D.renderer.forceContextLoss(); } catch (_) { }
            if (blockify3D.renderer && blockify3D.renderer.dispose) blockify3D.renderer.dispose();
            if (blockify3D.resizeHandler) window.removeEventListener('resize', blockify3D.resizeHandler);
            try { if (blockify3D.container) blockify3D.container.innerHTML = ''; } catch (_) { }
        }
        blockify3D = { renderer: null, scene: null, camera: null, controls: null, frameId: null, container: null, originHTRS: null, modelGroup: null, contextGroup: null, resizeHandler: null };
    } catch (_) { }

    // Remove the modal from DOM
    const modal = document.getElementById('blockify-modal');
    if (modal) {
        // Remove all event listeners
        const closeBtn = document.getElementById('blockify-close');
        const doneBtn = document.getElementById('btn-blockify-done');
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (closeBtn) closeBtn.removeEventListener('click', requestCloseBlockifyModal);
        if (doneBtn) doneBtn.removeEventListener('click', saveBlockifyDesignForProposal);
        if (setbackSlider) setbackSlider.removeEventListener('input', null);
        if (widthSlider) widthSlider.removeEventListener('input', null);

        // Remove the modal
        modal.remove();
        document.dispatchEvent(new CustomEvent('blockifyModalClosed'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));
    }

    // Force a reflow of the main map
    if (map) {
        map.invalidateSize();
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
        window.finishProposalDraftDesignSession?.();
    }
}

// Display the block on the blockify map
function displayBlockOnMap(block) {
    console.log('[Blockify] displayBlockOnMap called with block:', block);
    // Clear existing layers
    if (blockifyParcelLayer) {
        blockifyMap.removeLayer(blockifyParcelLayer);
        blockifyParcelLayer = null;
    }

    // Create a feature collection for all parcels in the block
    const features = block.parcels.map(parcel => parcel.feature);
    const featureCollection = {
        type: 'FeatureCollection',
        features: features
    };

    // Add the parcels to the map
    blockifyParcelLayer = L.geoJSON(featureCollection, {
        style: {
            fillColor: 'red',
            fillOpacity: 0.2,
            color: 'red',
            weight: 2
        }
    }).addTo(blockifyMap);

    // Fit the map to the bounds of the block
    blockifyMap.fitBounds(blockifyParcelLayer.getBounds(), {
        padding: [50, 50]
    });

    // Initialize 3D preview after map bounds fit
    try { initBlockify3DSimple(); } catch (e) { console.warn('3D init failed', e); }
}

// Function to generate building in the modal only
// Reduce an outline's vertex count (turf.simplify / Douglas–Peucker, tolerance in metres) and clip it
// inside `parcel` so no edge ends up outside the parcel. The clip only runs when the outline actually
// pokes out, so a fully-inside simplified outline keeps its low vertex count. Used by both the
// parametric builder and the manual (freeform) builder.
function simplifyAndClipOutline(feature, simplifyM, parcel) {
    let outline = feature;
    if (simplifyM > 0 && outline && outline.geometry) {
        try {
            const tolDeg = simplifyM / 111320; // ~metres → degrees of latitude
            const s = turf.simplify(outline, { tolerance: tolDeg, highQuality: true, mutate: false });
            const cleaned = toSingleLargestPolygon(sanitizePolygonFeature(s) || s) || s;
            if (cleaned && cleaned.geometry && turf.area(cleaned) > 0) outline = cleaned;
        } catch (err) {
            console.warn('Outline simplification failed', err);
        }
    }
    if (parcel && parcel.geometry && outline && outline.geometry) {
        try {
            let inside = false;
            try { inside = turf.booleanWithin(outline, parcel); } catch (_) { inside = false; }
            if (!inside) {
                const clipped = turf.intersect(outline, parcel);
                if (clipped && clipped.geometry && turf.area(clipped) > 0) {
                    outline = toSingleLargestPolygon(clipped) || outline;
                }
            }
        } catch (err) {
            console.warn('Clip-to-parcel failed', err);
        }
    }
    return outline;
}

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
function syncPositions(positions, count) {
    const out = Array.isArray(positions) ? positions.map(v => ((v % 1) + 1) % 1) : [];
    while (out.length > count) out.pop();
    while (out.length < count) {
        if (out.length === 0) { out.push(0); continue; }
        const sorted = out.slice().sort((a, b) => a - b);
        let bestGap = -1, bestMid = 0;
        for (let i = 0; i < sorted.length; i++) {
            const a = sorted[i];
            const b = (i + 1 < sorted.length) ? sorted[i + 1] : sorted[0] + 1; // wrap past 1
            const gap = b - a;
            if (gap > bestGap) { bestGap = gap; bestMid = ((a + b) / 2) % 1; }
        }
        out.push(bestMid);
    }
    return out;
}

// Union N rectangular wings (protrusions) onto the building, each extending inward toward the
// courtyard. Wing bases sit at `positions` (fractions 0..1 along the outer ring, draggable), point
// toward the block centroid, and are capped so they never cross the opposite parcel border. Wings may
// overlap the building and each other; the result is unioned into a single footprint.
function addWingsToBuilding(buildingFeature, { outerCoords, superparcel, wingWidth, buildingWidth, numWings, wingLength, positions }) {
    if (!buildingFeature || !Array.isArray(outerCoords) || outerCoords.length < 2) return buildingFeature;

    const ringLength = (coords) => {
        let len = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            len += turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
        }
        return len;
    };
    const pointAtDistance = (coords, targetDist) => {
        let accum = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segLen = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
            if (accum + segLen >= targetDist) {
                const t = (targetDist - accum) / segLen;
                return {
                    point: [
                        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                        coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                    ],
                    segmentIndex: i
                };
            }
            accum += segLen;
        }
        return { point: coords[coords.length - 1], segmentIndex: coords.length - 2 };
    };
    const getTangentAt = (coords, segIndex) => {
        const p1 = coords[segIndex];
        const p2 = coords[segIndex + 1] || coords[0];
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const mag = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        return { tx: dx / mag, ty: dy / mag };
    };

    const perimeter = ringLength(outerCoords);
    if (!Number.isFinite(perimeter) || perimeter <= 0) return buildingFeature;

    const centroid = turf.centroid(buildingFeature);
    const [cx, cy] = centroid.geometry.coordinates;

    // Ray-cast inward to find how far the parcel border is on the opposite side; caps wing length
    const polygonBoundary = (superparcel && turf.polygonToLine) ? turf.polygonToLine(superparcel) : null;
    const distanceToOppositeBorder = (startPoint, bearingDeg) => {
        if (!polygonBoundary) return wingLength;
        const rayEnd = turf.destination(turf.point(startPoint), 5000, bearingDeg, { units: 'meters' });
        const ray = turf.lineString([startPoint, rayEnd.geometry.coordinates]);
        const intersections = turf.lineIntersect(ray, polygonBoundary);
        let closestPositive = Infinity;
        if (intersections && intersections.features) {
            for (const feat of intersections.features) {
                const pt = feat.geometry && feat.geometry.coordinates;
                if (!pt) continue;
                const dist = turf.distance(turf.point(startPoint), turf.point(pt), { units: 'meters' });
                if (dist > 0.5 && dist < closestPositive) closestPositive = dist;
            }
        }
        return Number.isFinite(closestPositive) ? closestPositive : wingLength;
    };

    // Wing bases come from the draggable position array (fractions along the ring); fall back to even
    // spacing if positions weren't supplied.
    const fracs = (Array.isArray(positions) && positions.length === numWings)
        ? positions.map(f => (((f % 1) + 1) % 1))
        : Array.from({ length: numWings }, (_, w) => (numWings ? w / numWings : 0));
    const halfWidth = Math.max(wingWidth, 1) / 2;
    const borderMargin = 1; // keep the wing tip just short of the opposite parcel border

    let result = buildingFeature;
    for (let w = 0; w < numWings; w++) {
        const centerDist = fracs[w] * perimeter;
        const info = pointAtDistance(outerCoords, centerDist);
        const base = info.point;
        const tan = getTangentAt(outerCoords, info.segmentIndex);

        // Inward normal (toward the block centroid)
        let nx = -tan.ty, ny = tan.tx;
        if (nx * (cx - base[0]) + ny * (cy - base[1]) < 0) { nx = -nx; ny = -ny; }

        const inwardBearingDeg = (Math.atan2(nx, ny) * 180) / Math.PI;
        const tangentBearingDeg = (Math.atan2(tan.tx, tan.ty) * 180) / Math.PI;

        // The rectangle starts on the outer ring, so the first `buildingWidth` metres overlap the
        // building wall (watertight union) and `wingLength` is the protrusion past the inner edge
        // into the courtyard. Cap the total so the wing never crosses the opposite parcel border.
        const wallBridge = Math.max(buildingWidth, 0);
        const maxLen = distanceToOppositeBorder(base, inwardBearingDeg) - borderMargin;
        const len = Math.min(wallBridge + wingLength, maxLen);
        if (len <= 0) continue;

        // Rectangle spanning the wing width (along the ring tangent) and its length (inward).
        const baseLeft = turf.destination(turf.point(base), halfWidth, tangentBearingDeg, { units: 'meters' }).geometry.coordinates;
        const baseRight = turf.destination(turf.point(base), halfWidth, (tangentBearingDeg + 180) % 360, { units: 'meters' }).geometry.coordinates;
        const tipLeft = turf.destination(turf.point(baseLeft), len, inwardBearingDeg, { units: 'meters' }).geometry.coordinates;
        const tipRight = turf.destination(turf.point(baseRight), len, inwardBearingDeg, { units: 'meters' }).geometry.coordinates;

        let wingPoly;
        try { wingPoly = turf.polygon([[baseLeft, baseRight, tipRight, tipLeft, baseLeft]]); } catch (_) { continue; }
        if (!wingPoly || !wingPoly.geometry) continue;

        try {
            const unioned = turf.union(result, wingPoly);
            if (unioned && unioned.geometry) result = unioned;
        } catch (e) {
            console.warn('Wing union failed for wing', w, e);
        }
    }

    // turf.union drops properties; restore the building's and record the wing params
    result.properties = Object.assign({}, buildingFeature.properties, { numWings, wingLength });
    return result;
}

function generateBuildingInModal() {
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
        // Ensure 3D is initialized (in case init earlier was skipped)
        try { if (!blockify3D || !blockify3D.renderer) initBlockify3DSimple(); } catch (_) { }

        // Clear previous debug overlays
        if (blockifyDebugLayer && blockifyMap) {
            blockifyMap.removeLayer(blockifyDebugLayer);
            blockifyDebugLayer = null;
        }
        // Create a superparcel by merging all parcels in the block (robust)
        console.log(`Creating superparcel from ${block.parcels.length} parcels`);
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = robustUnion(parcelFeatures);

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
            SETBACK = maxSetback;
            // Update the slider and display value
            const setbackSlider = document.getElementById('setback-slider');
            if (setbackSlider) {
                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
                currentSetback = SETBACK;
            }
        }

        // Create the outer building polygon (setback from superparcel) with robust negative buffer
        let outerBuilding = robustNegativeBuffer(superparcel, SETBACK);
        outerBuilding = toSingleLargestPolygon(outerBuilding) || outerBuilding;
        if (!outerBuilding || !outerBuilding.geometry) {
            throw new Error('Failed to create outer building polygon');
        }

        // Reduce the OUTLINE's vertex count, then clip it inside the parcel:
        //  - the negative buffer rounds every corner into up to GEOM_BUFFER_STEPS segments, and curved
        //    parcel edges are densely digitised, so the raw outline can carry hundreds of vertices —
        //    unusable for manual editing. turf.simplify (Douglas–Peucker) collapses those to a handful;
        //    higher "Simplify (m)" = fewer vertices. (Applied here, AFTER the buffer, is why it now
        //    actually reduces the visible outline — simplifying the parcel earlier was undone by the
        //    buffer re-rounding the corners.)
        //  - a simplification chord can bow slightly past the boundary, so clip to the parcel after.
        outerBuilding = simplifyAndClipOutline(outerBuilding, currentSimplifyM, originalSuperparcel);
        if (!outerBuilding || !outerBuilding.geometry) {
            throw new Error('Failed to create outer building polygon');
        }

        // Incrementally inset inner ring; keep last valid geometry even if a step fails the 2 m rule
        let innerBuilding = null;
        let currentWidth = currentBuildingWidth;
        let minSideLength = Infinity; // no longer enforces a threshold; kept only for diagnostic display
        let attempts = 0;
        const MAX_ATTEMPTS = 10;
        while (currentWidth > 0 && attempts < MAX_ATTEMPTS) {
            const inc = incrementalInsetPolygon(outerBuilding, currentWidth, 0);
            if (inc && inc.feature) {
                innerBuilding = inc.feature; // keep last valid
                if (inc.reason === 'ok' && Math.abs(inc.achievedInset - currentWidth) < 1e-3) {
                    // achieved full width cleanly
                    break;
                }
                // record min edge for debug
                if (isFinite(inc.minEdgeValue)) {
                    minSideLength = inc.minEdgeValue;
                }
                const debugMode = document.getElementById('debugModeCheckbox');
                if (debugMode && debugMode.checked && inc.minEdgePair) {
                    try {
                        const a = [inc.minEdgePair[0][1], inc.minEdgePair[0][0]];
                        const b = [inc.minEdgePair[1][1], inc.minEdgePair[1][0]];
                        blockifyDebugLayer = L.featureGroup().addTo(blockifyMap);
                        L.polyline([a, b], { color: '#ff0000', weight: 5, opacity: 0.8 }).addTo(blockifyDebugLayer)
                            .bindTooltip(`Narrow edge: ${(inc.minEdgeValue || 0).toFixed(2)} m`, { permanent: false });
                    } catch (_) { }
                }
            }
            if (inc && inc.reason === 'ok') {
                break;
            }
            // didn't achieve full width → reduce and retry
            currentWidth *= 0.9;
            attempts++;
        }

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
                { setback: SETBACK.toFixed(1) }
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

        if (numGaps === 0 || gapWidth <= 0) {
            // Default: closed polygon with hole
            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    chamfer: Number(currentChamferM) || 0,
                    simplify: currentSimplifyM,
                    block: getBlockifyDisplayName(),
                    minSideLength: minSideLength,
                    height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
                    numGaps,
                    gapWidth
                },
                geometry: closedRingFeature.geometry
            };
        } else {
            // Cut N gaps from the ring using perpendicular cuts along the outer circumference
            // Helper: compute total ring length
            const ringLength = (coords) => {
                let len = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    len += turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
                }
                return len;
            };
            // Helper: interpolate a point along the ring at a given distance, also return segment index
            const pointAtDistance = (coords, targetDist) => {
                let accum = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    const segLen = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]), { units: 'meters' });
                    if (accum + segLen >= targetDist) {
                        const t = (targetDist - accum) / segLen;
                        return {
                            point: [
                                coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                                coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                            ],
                            segmentIndex: i,
                            t: t
                        };
                    }
                    accum += segLen;
                }
                return { point: coords[coords.length - 1], segmentIndex: coords.length - 2, t: 1 };
            };
            // Helper: get tangent direction at a point on the ring (direction along the circumference)
            const getTangentAt = (coords, segIndex) => {
                const p1 = coords[segIndex];
                const p2 = coords[segIndex + 1] || coords[0];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                const mag = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                return { tx: dx / mag, ty: dy / mag };
            };

            // Helper: find half the distance from a start point to the opposite superparcel edge along a bearing
            const polygonBoundary = turf.polygonToLine ? turf.polygonToLine(superparcel) : null;
            const halfDistanceToOppositeBorder = (startPoint, bearingDeg) => {
                if (!polygonBoundary) return Math.max(currentWidth, 1);

                const rayEnd = turf.destination(turf.point(startPoint), 5000, bearingDeg, { units: 'meters' });
                const ray = turf.lineString([startPoint, rayEnd.geometry.coordinates]);
                const intersections = turf.lineIntersect(ray, polygonBoundary);

                let closestPositive = Infinity;
                if (intersections && intersections.features) {
                    for (const feat of intersections.features) {
                        const pt = feat.geometry && feat.geometry.coordinates;
                        if (!pt) continue;
                        const dist = turf.distance(turf.point(startPoint), turf.point(pt), { units: 'meters' });
                        // Ignore the start point (or near-zero) and keep the nearest forward hit
                        if (dist > 0.5 && dist < closestPositive) {
                            closestPositive = dist;
                        }
                    }
                }

                if (!Number.isFinite(closestPositive) || closestPositive === Infinity) {
                    return Math.max(currentWidth, 1);
                }

                return Math.max(closestPositive / 2, 1);
            };

            const outerPerimeter = ringLength(outerCoords);
            if (!Number.isFinite(outerPerimeter) || outerPerimeter <= 0) {
                throw new Error('Failed to measure outer ring perimeter');
            }

            const stride = outerPerimeter / numGaps;
            let effectiveGapWidth = Math.min(gapWidth, stride * 0.9);
            if (!Number.isFinite(effectiveGapWidth) || effectiveGapWidth < 1) effectiveGapWidth = 1;

            // Step 1: Gap centres come from the draggable position array (fractions along the ring).
            // Self-heal if it drifted out of sync with the count (e.g. generation triggered by another
            // slider, or a freshly loaded modal).
            if (gapPositions.length !== numGaps) gapPositions = syncPositions(gapPositions, numGaps);
            const gapCenterDistances = gapPositions.map(f => (((f % 1) + 1) % 1) * outerPerimeter);

            // Step 2: For each gap, create perpendicular cuts
            let resultGeom = closedRingFeature;
            for (let g = 0; g < numGaps; g++) {
                const gapCenterDist = gapCenterDistances[g];

                // Find the two edge points: gapWidth/2 in each direction along the circumference
                const halfGap = effectiveGapWidth / 2;
                const dist1 = (gapCenterDist - halfGap + outerPerimeter) % outerPerimeter;
                const dist2 = (gapCenterDist + halfGap) % outerPerimeter;

                const edge1Info = pointAtDistance(outerCoords, dist1);
                const edge2Info = pointAtDistance(outerCoords, dist2);
                const edge1 = edge1Info.point;
                const edge2 = edge2Info.point;

                // Get tangent at each edge point to compute perpendicular
                const tan1 = getTangentAt(outerCoords, edge1Info.segmentIndex);
                const tan2 = getTangentAt(outerCoords, edge2Info.segmentIndex);

                // Perpendicular to tangent (pointing inward, roughly)
                // Perpendicular is (-ty, tx) or (ty, -tx); we want inward
                // Use centroid to determine which direction is inward
                const centroid = turf.centroid(closedRingFeature);
                const [cx, cy] = centroid.geometry.coordinates;

                // For edge1: perpendicular candidates
                let perp1x = -tan1.ty, perp1y = tan1.tx;
                // Check if this points toward centroid
                const toCentroid1x = cx - edge1[0];
                const toCentroid1y = cy - edge1[1];
                if (perp1x * toCentroid1x + perp1y * toCentroid1y < 0) {
                    perp1x = -perp1x;
                    perp1y = -perp1y;
                }

                let perp2x = -tan2.ty, perp2y = tan2.tx;
                const toCentroid2x = cx - edge2[0];
                const toCentroid2y = cy - edge2[1];
                if (perp2x * toCentroid2x + perp2y * toCentroid2y < 0) {
                    perp2x = -perp2x;
                    perp2y = -perp2y;
                }

                // Check if the two perpendicular directions would cause intersecting lines
                // and adjust them to be parallel if needed
                // Compute angle of each perpendicular direction
                const angle1 = Math.atan2(perp1y, perp1x);
                const angle2 = Math.atan2(perp2y, perp2x);

                // Normalize angle difference to [-PI, PI]
                let angleDiff = angle2 - angle1;
                while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

                // If angles differ, the lines are not parallel
                // Average the angles to make them parallel, each rotating by half the difference
                const avgAngle = angle1 + angleDiff / 2;

                // Use the averaged (parallel) direction for both lines
                const finalPerpX = Math.cos(avgAngle);
                const finalPerpY = Math.sin(avgAngle);

                // Use a ray from the gap center to the opposite superparcel edge; cut to its midpoint
                const gapCenterInfo = pointAtDistance(outerCoords, gapCenterDist);
                const gapBearingDeg = (Math.atan2(finalPerpX, finalPerpY) * 180) / Math.PI;
                const outwardBearingDeg = (gapBearingDeg + 180) % 360;
                const marginOuterM = 5; // small outward margin to avoid precision artefacts
                const innerDepthM = halfDistanceToOppositeBorder(gapCenterInfo.point, gapBearingDeg);

                // Line 1: from slightly outside edge1 to midpoint toward opposite border
                const line1outer = turf.destination(turf.point(edge1), marginOuterM, outwardBearingDeg, { units: 'meters' }).geometry.coordinates;
                const line1inner = turf.destination(turf.point(edge1), innerDepthM, gapBearingDeg, { units: 'meters' }).geometry.coordinates;

                // Line 2: from slightly outside edge2 to midpoint toward opposite border
                const line2outer = turf.destination(turf.point(edge2), marginOuterM, outwardBearingDeg, { units: 'meters' }).geometry.coordinates;
                const line2inner = turf.destination(turf.point(edge2), innerDepthM, gapBearingDeg, { units: 'meters' }).geometry.coordinates;

                // Build a quadrilateral cutter: outer1 -> outer2 -> inner2 -> inner1 -> outer1
                const cutterCoords = [line1outer, line2outer, line2inner, line1inner, line1outer];
                const cutterPoly = turf.polygon([cutterCoords]);

                if (cutterPoly && cutterPoly.geometry) {
                    try {
                        const diff = turf.difference(resultGeom, cutterPoly);
                        if (diff && diff.geometry) {
                            resultGeom = diff;
                        }
                    } catch (e) {
                        console.warn('Gap cutter difference failed for gap', g, e);
                    }
                }
            }

            // Normalize result geometry
            let finalGeom = resultGeom.geometry;
            if (!finalGeom || (finalGeom.type !== 'Polygon' && finalGeom.type !== 'MultiPolygon')) {
                // Fallback to closed ring
                finalGeom = closedRingFeature.geometry;
            }

            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    chamfer: Number(currentChamferM) || 0,
                    simplify: currentSimplifyM,
                    block: getBlockifyDisplayName(),
                    minSideLength: minSideLength,
                    height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT),
                    numGaps,
                    gapWidth: effectiveGapWidth
                },
                geometry: finalGeom
            };
        }

        // Add wings (protrusions toward the courtyard), unioned onto the building
        const wingsSlider = document.getElementById('wings-slider');
        const wingLengthSlider = document.getElementById('wing-length-slider');
        const numWings = wingsSlider ? parseInt(wingsSlider.value) : 0;
        const wingLength = wingLengthSlider ? parseFloat(wingLengthSlider.value) : 0;
        if (wingPositions.length !== numWings) wingPositions = syncPositions(wingPositions, numWings);
        if (numWings > 0 && wingLength > 0) {
            buildingFeature = addWingsToBuilding(buildingFeature, {
                outerCoords,
                superparcel,
                wingWidth: currentWidth,
                buildingWidth: currentWidth,
                numWings,
                wingLength,
                positions: wingPositions
            });
        }

        // Chamfer every real convex corner (internal angle up to CHAMFER_MAX_INTERNAL_ANGLE_DEG). The
        // old 100° cap only cut near-right-angle corners, so obtuse corners on irregular blocks were
        // skipped — chamfering looked arbitrary ("2 of 4", outer-but-not-inner). Corners rounded into
        // arcs by the negative buffer sit at ~174° and are still skipped (nothing sharp to cut), as
        // are reflex/notch corners (>180°).
        buildingFeature = applySelectiveChamferToFeature(buildingFeature, Number(currentChamferM) || 0, CHAMFER_MAX_INTERNAL_ANGLE_DEG);
        generatedBuildingFeature = buildingFeature;
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
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
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
                document.getElementById('width-value').textContent = currentWidth.toFixed(1);
                currentBuildingWidth = currentWidth;

                // Restore the event listener
                setTimeout(() => {
                    widthSlider.onchange = oldWidthListener;
                }, 10);
            }
        }

        // Update the info text
        setBlockifyInfo(
            'blockify.modal.messages.generatedSummary',
            'Building generated (width: {{width}}m, height: {{height}}m, setback: {{setback}}m)',
            {
                width: currentWidth.toFixed(1),
                height: (Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT).toFixed(1),
                setback: SETBACK.toFixed(1)
            }
        );

        // Enable the Done button
        const doneButton = document.getElementById('btn-blockify-done');
        if (doneButton) {
            doneButton.disabled = false;
        }

    } catch (error) {
        console.error('Error creating building block:', error);
        setBlockifyInfo(
            'blockify.modal.messages.errorWithMessage',
            'Error: {{message}}',
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
}

function autosaveBlockifyDraft(featuresOverride = null) {
    const activeDraft = typeof window !== 'undefined' ? window.getActiveProposalDesignDraft?.() : null;
    const block = getActiveBlockifyBlock();
    const features = Array.isArray(featuresOverride)
        ? featuresOverride.filter(Boolean)
        : (featuresOverride ? [featuresOverride] : (generatedBuildingFeatures?.length ? generatedBuildingFeatures : [generatedBuildingFeature].filter(Boolean)));
    if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
        || !features.length || !block?.parcels?.length
        || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
    const parcelIds = [];
    const parentDetails = [];
    block.parcels.forEach(parcel => {
        const props = parcel?.feature?.properties;
        const parcelId = typeof ensureParcelId === 'function'
            ? ensureParcelId(parcel?.feature)
            : (props?.parcelId ?? props?.parcel_id ?? props?.id);
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
            rule: existingRule,
            proposedHeightFloors: currentProposedHeightFloors,
            additionalFloors: currentAdditionalFloors,
            floorHeightM: currentFloorHeightM,
            algorithm: null
        }
        : {
            mode: blockifyMode,
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
        buildings
    }, { coalesceKey: 'blockify-live' });
}

// Function to display the building in the modal map
function displayBuildingInModal(buildingFeature) {
    if (blockifyBuildingLayer) {
        blockifyMap.removeLayer(blockifyBuildingLayer);
        blockifyBuildingLayer = null;
    }
    if (!buildingFeature) return;
    if (buildingFeature.geometry.type === 'MultiLineString' || buildingFeature.geometry.type === 'MultiPolygon' || buildingFeature.geometry.type === 'Polygon') {
        blockifyBuildingLayer = L.geoJSON(buildingFeature, {
            style: {
                color: '#007bff',
                weight: 4,
                opacity: 1,
                fillOpacity: 0.2
            }
        }).addTo(blockifyMap);
        try { updateBlockify3DScene(buildingFeature); } catch (e) { console.warn('3D update failed', e); }
        autosaveBlockifyDraft(buildingFeature);
    }
}

// Draw a draggable handle on the modal map at each gap/wing position. Dragging one snaps it back onto
// the outer ring, updates its fraction (0..1 along the ring), and regenerates the block.
function clearGapWingHandles() {
    if (blockifyHandleLayer && blockifyMap) {
        try { blockifyMap.removeLayer(blockifyHandleLayer); } catch (_) { }
    }
    blockifyHandleLayer = null;
    clearManualLiveOutline();
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
        if (el) el.disabled = !enabled;
    });
}

function updateManualToggleLabel() {
    const btn = document.getElementById('blockify-manual-toggle');
    if (!btn) return;
    if (blockifyMode === 'manual') {
        btn.textContent = translateBuildingText('blockify.modal.manual.back', 'Back to sliders');
        btn.classList.add('active');
    } else {
        btn.textContent = translateBuildingText('blockify.modal.manual.edit', 'Edit shape manually');
        btn.classList.remove('active');
    }
}

function enterManualMode() {
    if (!Array.isArray(lastOuterRing) || lastOuterRing.length < 4) {
        showBuildingAlert('blockify.modal.manual.needShape', 'Generate a shape with the sliders first, then edit it manually.');
        return;
    }
    blockifyMode = 'manual';
    // Seed the editable ring from the last clean outer ring (drop the closing duplicate vertex).
    const ring = lastOuterRing.slice();
    if (ring.length >= 2) {
        const f = ring[0], l = ring[ring.length - 1];
        if (l && f[0] === l[0] && f[1] === l[1]) ring.pop();
    }
    // Cap the handle count: a large block's outline carries tens of thousands of vertices, which would
    // make manual mode drop that many draggable markers (a tab-freezing amount) and leaves nothing a
    // person could actually drag. Simplify to an editable budget first; the subsequent build re-clips
    // it inside the parcel so the simplification can't push an edge out.
    const rawVertices = ring.length;
    manualOuterRing = simplifyRingToVertexTarget(ring.map(c => [c[0], c[1]]));
    manualBuildSucceeded = false;
    setFootprintSlidersEnabled(false);
    updateManualToggleLabel();
    if (rawVertices > manualOuterRing.length) {
        setBlockifyInfo('blockify.modal.manual.hintSimplified',
            'Manual mode: outline simplified to {{count}} draggable points so you can reshape it. Drag any point; height stays adjustable.',
            { count: manualOuterRing.length });
    } else {
        setBlockifyInfo('blockify.modal.manual.hint', 'Manual mode: drag the vertices to reshape the outline. Height stays adjustable.');
    }
    generateManualBuilding();
}

function exitToParametricMode() {
    const proceed = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm(translateBuildingText('blockify.modal.manual.confirmReset', 'Discard manual edits and go back to the sliders?'))
        : true;
    if (!proceed) return;
    blockifyMode = 'parametric';
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

function getBackendBaseForBlockify() {
    try { return (typeof window.getBackendBase === 'function') ? window.getBackendBase() : ''; }
    catch (_) { return ''; }
}

// Union of ALL block parcels as the footprint query area. Deliberately not lastSuperparcel —
// that one is reduced to the single largest polygon for ring generation, which would drop
// buildings on disjoint parcels.
function getBlockQueryGeometry() {
    const block = getActiveBlockifyBlock();
    if (!block || !Array.isArray(block.parcels) || !block.parcels.length) return null;
    try {
        const union = robustUnion(block.parcels.map(p => p && p.feature).filter(Boolean));
        return union && union.geometry ? union.geometry : null;
    } catch (_) { return null; }
}

// Fetch the block's existing footprints once per modal open. Resolves to null when the city has
// no footprint source (supported: false), or to the (possibly empty) footprint array otherwise.
function ensureExistingFootprints() {
    if (existingFootprintsPromise) return existingFootprintsPromise;
    const geometry = getBlockQueryGeometry();
    if (!geometry) return Promise.resolve(null);
    let city;
    try { city = window.CityConfigManager && window.CityConfigManager.getCurrentCityId(); } catch (_) { }
    existingFootprintsPromise = fetch(`${getBackendBaseForBlockify()}/buildings/footprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry, city })
    }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    }).then(payload => {
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
        proposedValue.textContent = `${currentProposedHeightFloors} (${(currentProposedHeightFloors * currentFloorHeightM).toFixed(1)} m)`;
    }
    const additionalValue = document.getElementById('additional-floors-value');
    if (additionalValue) additionalValue.textContent = String(currentAdditionalFloors);
    const floorHeightValue = document.getElementById('floor-height-value');
    if (floorHeightValue) floorHeightValue.textContent = currentFloorHeightM.toFixed(1);
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
        setBlockifyInfo('blockify.modal.existing.summary', 'Raising {{count}} of {{total}} existing buildings.', {
            count: features.length,
            total: list.length
        });
    } else {
        setBlockifyInfo('blockify.modal.existing.summaryExact', 'Proposing {{count}} buildings at {{height}} m.', {
            count: features.length,
            height: (currentProposedHeightFloors * currentFloorHeightM).toFixed(1)
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
        try { updateBlockify3DScene([]); } catch (_) { } // clear the 3D proposal meshes
        return;
    }
    blockifyBuildingLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
        style: {
            color: '#007bff',
            weight: 4,
            opacity: 1,
            fillOpacity: 0.2
        }
    }).addTo(blockifyMap);
    try { updateBlockify3DScene(features); } catch (e) { console.warn('3D update failed', e); }
    autosaveBlockifyDraft(features);
}

// Build the block from the user-edited outer ring: re-inset by the (frozen) building width so it
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
        outerBuilding = simplifyAndClipOutline(outerBuilding, 0, lastSuperparcel);

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
        renderManualVertexHandles();

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

// Draggable handle at each outer-ring vertex; drag reshapes the manual outline.
function renderManualVertexHandles() {
    clearGapWingHandles();
    if (!blockifyMap || !Array.isArray(manualOuterRing) || manualOuterRing.length < 3) return;
    blockifyHandleLayer = L.layerGroup().addTo(blockifyMap);
    manualOuterRing.forEach((coord, idx) => {
        const marker = L.marker([coord[1], coord[0]], {
            draggable: true,
            title: translateBuildingText('blockify.modal.manual.vertex', 'Drag to reshape'),
            icon: L.divIcon({
                className: 'blockify-handle blockify-handle--vertex',
                html: '<span></span>',
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            })
        });
        // Live: the outline follows the vertex as it moves (a cheap dashed polygon, no re-inset).
        marker.on('drag', () => {
            const ll = marker.getLatLng();
            manualOuterRing[idx] = [ll.lng, ll.lat];
            drawManualLiveOutline();
        });
        // Release: constrain the vertex to the parcel, then do the full rebuild (inset + clip).
        marker.on('dragend', () => {
            const ll = marker.getLatLng();
            let pt = [ll.lng, ll.lat];
            if (lastSuperparcel && lastSuperparcel.geometry) {
                try {
                    if (!turf.booleanPointInPolygon(turf.point(pt), lastSuperparcel)) {
                        const line = turf.polygonToLine(lastSuperparcel);
                        const snapped = turf.nearestPointOnLine(line, turf.point(pt));
                        if (snapped && snapped.geometry) pt = snapped.geometry.coordinates;
                    }
                } catch (_) { }
            }
            manualOuterRing[idx] = pt;
            marker.setLatLng([pt[1], pt[0]]);
            clearManualLiveOutline();
            generateManualBuilding();
        });
        marker.addTo(blockifyHandleLayer);
    });
}

// Lightweight dashed outline of the manual ring, redrawn while a vertex is being dragged so the shape
// visibly follows the cursor without paying for the full inset/clip rebuild on every mouse move.
function clearManualLiveOutline() {
    if (blockifyLiveLayer && blockifyMap) {
        try { blockifyMap.removeLayer(blockifyLiveLayer); } catch (_) { }
    }
    blockifyLiveLayer = null;
}

function drawManualLiveOutline() {
    clearManualLiveOutline();
    if (!blockifyMap || !Array.isArray(manualOuterRing) || manualOuterRing.length < 3) return;
    const latlngs = manualOuterRing.map(c => [c[1], c[0]]);
    blockifyLiveLayer = L.polygon(latlngs, {
        color: '#fb8c00', weight: 2, dashArray: '5,5', fill: false, interactive: false
    }).addTo(blockifyMap);
}

// Pull the largest Polygon out of an uploaded GeoJSON (Feature / FeatureCollection / geometry) and
// return its outer ring as [lng,lat] vertices (closing duplicate stripped), or null if none.
function extractOuterRingFromGeojson(data) {
    const geoms = [];
    const collect = (g) => {
        if (!g || typeof g !== 'object') return;
        if (g.type === 'FeatureCollection' && Array.isArray(g.features)) g.features.forEach(collect);
        else if (g.type === 'Feature') collect(g.geometry);
        else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) g.geometries.forEach(collect);
        else if (g.type === 'Polygon') geoms.push(g);
        else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) g.coordinates.forEach(poly => geoms.push({ type: 'Polygon', coordinates: poly }));
    };
    collect(data);
    if (!geoms.length) return null;
    let best = null, bestArea = -1;
    for (const g of geoms) {
        try { const a = turf.area(turf.feature(g)); if (a > bestArea) { bestArea = a; best = g; } } catch (_) { }
    }
    const outer = best && best.coordinates && best.coordinates[0];
    if (!Array.isArray(outer) || outer.length < 3) return null;
    const ring = outer.filter(c => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])).map(c => [c[0], c[1]]);
    if (ring.length >= 2) {
        const f = ring[0], l = ring[ring.length - 1];
        if (l && f[0] === l[0] && f[1] === l[1]) ring.pop();
    }
    return ring.length >= 3 ? ring : null;
}

// Load an uploaded GeoJSON footprint straight into manual mode (it's clipped to the parcel on build).
function loadGeojsonFootprint(file) {
    const reader = new FileReader();
    reader.onload = () => {
        let ring = null;
        try { ring = extractOuterRingFromGeojson(JSON.parse(reader.result)); }
        catch (err) { console.error('GeoJSON parse failed', err); }
        if (!ring) {
            showBuildingAlert('blockify.modal.manual.uploadNoPolygon', 'No usable polygon found in that file.');
            return;
        }
        blockifyMode = 'manual';
        manualOuterRing = ring;
        setFootprintSlidersEnabled(false);
        updateManualToggleLabel();
        setBlockifyInfo('blockify.modal.manual.hint', 'Manual mode: drag the vertices to reshape the outline. Height stays adjustable.');
        generateManualBuilding();
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

        updateStatus(`Created proposed building block for ${getBlockifyDisplayName()} (width: ${generatedBuildingFeature.properties.width.toFixed(1)}m, setback: ${generatedBuildingFeature.properties.setback.toFixed(1)}m)`)
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

function redirectBlockifyToCreateProposal() {
    if (typeof showProposalDialog === 'function') {
        showProposalDialog();
        setTimeout(() => {
            try {
                if (typeof handleProposalToolButton === 'function') handleProposalToolButton('urban-rule');
            } catch (_) { }
        }, 0);
        return;
    }
    if (typeof updateStatus === 'function') updateStatus('Use the Create Proposal modal.');
}

// Update the blockifySelectedBlock function to route through the Create Proposal modal
function blockifySelectedBlock() {
    redirectBlockifyToCreateProposal();
}

// `initialState` (optional) restores a previously-saved design instead of the defaults — see
// applyBlockifySeedState. Used by "Copy into new proposal" to reopen a fork's original building.
function openUrbanRuleForParcels({ blockName, parcels, initialState = null }) {
    const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
    if (!rawParcels.length) {
        updateStatus('Select parcels before launching the buildings tool.');
        return;
    }
    blockifySeedState = initialState || null;

    const seenIds = new Set();
    const normalizedParcels = [];
    rawParcels.forEach(layer => {
        try {
            const props = layer?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(layer?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const idStr = parcelId.toString();
            if (seenIds.has(idStr)) return;
            seenIds.add(idStr);
            normalizedParcels.push(layer);
        } catch (_) { }
    });

    if (!normalizedParcels.length) {
        updateStatus('Could not resolve parcel data for the selected parcels.');
        return;
    }

    const parcelIds = Array.from(seenIds);
    blockifyBlock = {
        parcels: normalizedParcels,
        parcelIds,
        valid: true,
        polygon: null
    };
    blockifyBlockNameOverride = blockName || describeParcelSelection(parcelIds);
    showBlockifyModal();
}
// Backward compatibility
function openBlockifyForParcels(opts) {
    return openUrbanRuleForParcels(opts);
}

window.openUrbanRuleForParcels = openUrbanRuleForParcels;
window.openBlockifyForParcels = openBlockifyForParcels;

// Function to capture current blockify configuration for later proposal creation
// Measure the block footprint and, if it's larger than the recommended size, ask the user to confirm.
// Returns true to proceed (not oversized, user accepted, or the measurement/confirm was unavailable),
// false only when the user actively backs out. Never throws — a warning must not block a valid save.
async function confirmBlockSizeIfOversized(block) {
    try {
        if (typeof ProposalWarnings === 'undefined' || typeof turf === 'undefined') return true;
        let outline = (lastSuperparcel && lastSuperparcel.geometry) ? lastSuperparcel : null;
        if (!outline && block && Array.isArray(block.parcels)) {
            outline = robustUnion(block.parcels.map(p => p && p.feature).filter(Boolean));
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
    const existingModeFeatures = (blockifyMode === 'existing' && Array.isArray(generatedBuildingFeatures) && generatedBuildingFeatures.length)
        ? generatedBuildingFeatures
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

    block.parcels.forEach(parcel => {
        const props = parcel?.feature?.properties;
        const parcelId = typeof ensureParcelId === 'function'
            ? ensureParcelId(parcel?.feature)
            : (props?.parcelId ?? props?.parcel_id ?? props?.id);
        if (!parcelId) return;
        const idStr = parcelId.toString();
        let number = idStr;
        try {
            if (parcel.feature?.properties?.BROJ_CESTICE) {
                number = String(parcel.feature.properties.BROJ_CESTICE);
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

    if (!normalizedParcelIds.length) {
        const info = document.getElementById('blockify-info');
        if (info) setBlockifyInfo('blockify.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
        return;
    }

    const algorithmSelect = document.getElementById('algorithm-select');
    // Existing-buildings mode saves one feature per raised building (each with its own height);
    // freeform/manual modes keep the single-feature shape. createProposal() consumes either via
    // `buildings` (array) with `buildingFeature` as the single/primary fallback.
    const clonedBuildings = existingModeFeatures ? JSON.parse(JSON.stringify(existingModeFeatures)) : null;
    const clonedFeature = clonedBuildings ? clonedBuildings[0] : JSON.parse(JSON.stringify(generatedBuildingFeature));

    // Save enough to rebuild this exact design later (see applyBlockifySeedState). Width/height/
    // setback/chamfer/algorithm alone are lossy: a manual outline isn't slider-derived at all, and
    // gaps/wings/simplify silently disappear on regeneration. Copies would otherwise change shape.
    const parameters = clonedBuildings
        ? {
            mode: 'existing',
            rule: existingRule,
            proposedHeightFloors: currentProposedHeightFloors,
            additionalFloors: currentAdditionalFloors,
            floorHeightM: currentFloorHeightM,
            algorithm: null
        }
        : {
            mode: blockifyMode,
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
            algorithm: algorithmSelect ? algorithmSelect.value : null
        };

    const context = {
        parcelIds: normalizedParcelIds.slice(),
        parentDetails: parentDetails.slice(),
        blockName: getBlockifyDisplayName(),
        parameters,
        buildingFeature: clonedFeature
    };
    if (clonedBuildings) context.buildings = clonedBuildings;

    window.pendingBuildingFromBlockify = clonedFeature;
    setPendingBuildingProposalContext(context);

    closeBlockifyModal({ preservePending: true });

    if (typeof updateStatus === 'function') {
        updateStatus('Building design saved. Add proposal details to submit.');
    }

    const description = document.getElementById('proposalDescription');
    if (description) {
        if (!description.value.trim()) {
            const selectedLabel = translateBuildingText('blockify.modal.messages.selectedParcels', 'selected parcels');
            description.value = translateBuildingText(
                'blockify.modal.messages.defaultProposalDescription',
                'Building proposal for {{blockName}}',
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
            showBuildingAlert('proposal_workflow_unavailable', 'Proposal workflow is unavailable.');
        }
    }
}

window.createProposalWithBuilding = createProposalWithBuilding;
