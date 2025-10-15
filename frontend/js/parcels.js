/*
    This file contains various parcel-related functionality.
    It is used to locate parcels, show parcel info, toggle parcel numbers
    and other related functionality.
*/

// --- Parcel Layer Styles ---
const roadStyle = {
    fillColor: '#00ff00',
    fillOpacity: 0.2,
    color: '#00ff00',
    weight: 1
};
const normalStyle = {
    fillColor: 'red',
    fillOpacity: 0.2,
    color: 'red',
    weight: 1
};
const selectedParcelStyle = {
    fillColor: '#ff3300',
    fillOpacity: 0.4,
    color: '#ff3300',
    weight: 4,
    opacity: 1,
    dashArray: ''
};

const appliedProposalStyleTemplate = {
    color: normalStyle.color,
    weight: normalStyle.weight,
    opacity: normalStyle.opacity !== undefined ? normalStyle.opacity : 1,
    dashArray: normalStyle.dashArray || '',
    fillColor: normalStyle.fillColor,
    fillOpacity: 0
};

let parcelsWithAppliedSpatialProposals = new Set();

function createAppliedProposalStyle() {
    return { ...appliedProposalStyleTemplate };
}

function parcelHasAppliedSpatialProposal(parcelId) {
    if (parcelId === undefined || parcelId === null) return false;
    return parcelsWithAppliedSpatialProposals.has(parcelId.toString());
}

function getParcelBaseStyle(parcelId, options = {}) {
    const { isRoad: isRoadOverride } = options || {};
    const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
    const roadFlag = typeof isRoadOverride === 'boolean'
        ? isRoadOverride
        : (idStr ? isRoad(idStr) : false);
    if (roadFlag) {
        return { ...roadStyle };
    }
    if (idStr && parcelHasAppliedSpatialProposal(idStr)) {
        return createAppliedProposalStyle();
    }
    return { ...normalStyle };
}

function recomputeParcelsWithAppliedSpatialProposals() {
    const result = new Set();
    if (typeof proposalStorage !== 'undefined' && proposalStorage && typeof proposalStorage.getAllProposals === 'function') {
        try {
            const proposals = proposalStorage.getAllProposals();
            proposals.forEach(proposal => {
                if (!proposal) return;
                const status = (proposal.status || '').toLowerCase();
                const parcelIds = [];
                const buildingProposal = proposal.buildingProposal || null;
                if (buildingProposal) {
                    const buildingStatus = (buildingProposal.status || status).toLowerCase();
                    if (buildingStatus === 'applied' || buildingStatus === 'executed') {
                        const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
                            ? buildingProposal.parentParcelIds
                            : proposal.parcelIds;
                        if (Array.isArray(ids)) parcelIds.push(...ids);
                    }
                } else if ((proposal.type === 'building' || proposal.buildingGeometry) && (status === 'applied' || status === 'executed')) {
                    if (Array.isArray(proposal.parcelIds)) parcelIds.push(...proposal.parcelIds);
                }

                const structureProposal = proposal.structureProposal || null;
                if (structureProposal) {
                    const kind = (structureProposal.kind || '').toLowerCase();
                    const structureStatus = (structureProposal.status || status).toLowerCase();
                    if ((kind === 'park' || kind === 'square') && (structureStatus === 'applied' || structureStatus === 'executed')) {
                        const ids = Array.isArray(structureProposal.parentParcelIds) && structureProposal.parentParcelIds.length > 0
                            ? structureProposal.parentParcelIds
                            : proposal.parcelIds;
                        if (Array.isArray(ids)) parcelIds.push(...ids);
                    }
                }

                parcelIds
                    .filter(id => id !== undefined && id !== null)
                    .forEach(id => result.add(id.toString()));
            });
        } catch (error) {
            console.warn('recomputeParcelsWithAppliedSpatialProposals failed', error);
        }
    }
    parcelsWithAppliedSpatialProposals = result;
    return result;
}

function refreshParcelStylesForAppliedProposals() {
    recomputeParcelsWithAppliedSpatialProposals();
    if (!parcelLayer) return;

    const selectedId = selectedParcelId ? selectedParcelId.toString() : null;
    const hasMultiSelection = typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.isActive;

    parcelLayer.eachLayer(layer => {
        const parcelId = layer?.feature?.properties?.CESTICA_ID;
        if (parcelId === undefined || parcelId === null) return;
        const idStr = parcelId.toString();

        if (selectedId && idStr === selectedId) {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
            return;
        }

        if (hasMultiSelection && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.has(idStr)) {
            layer.setStyle({
                fillColor: '#ff9800',
                fillOpacity: 0.6,
                color: '#f57c00',
                weight: 3
            });
            return;
        }

        const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
            layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
            return;
        }

        layer.setStyle(getParcelBaseStyle(idStr));
    });

    if (hasMultiSelection && typeof multiParcelSelection.reapplyMultiParcelHighlights === 'function') {
        multiParcelSelection.reapplyMultiParcelHighlights();
    }

    if (typeof rehighlightSelectedBlockParcels === 'function') {
        rehighlightSelectedBlockParcels();
    }

    if (selectedId) {
        const selectedLayer = parcelLayer.getLayers().find(layer =>
            layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === selectedId
        );
        if (selectedLayer) {
            selectedLayer.setStyle(selectedParcelStyle);
            selectedLayer.bringToFront();
        }
    }
}

// Make selectedParcelStyle globally available
window.selectedParcelStyle = selectedParcelStyle;

/**
 * Focus on a proposal when clicked from parcel info panel
 * @param {string} proposalHash - The proposal hash to focus on
 */
function focusOnProposal(proposalHash) {
    // Do not force proposals mode; keep normal interactions available

    // Focus on the proposal immediately - the unified function handles proper sequencing
    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (proposal && proposal.parcelIds && proposal.parcelIds.length > 0) {
            selectAndHighlightProposal(proposalHash, proposal.parcelIds[0], true);
        }
    } else if (typeof centerOnProposal === 'function') {
        // Fallback to old function
        centerOnProposal(proposalHash);
    }
}

// Make focusOnProposal globally available
window.focusOnProposal = focusOnProposal;

/**
 * Handle user accepting a proposal from the parcel info panel
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
function acceptProposalFromParcelInfo(proposalHash, parcelId) {
    // Call the existing function from proposals.js
    if (typeof handleUserAcceptProposal === 'function') {
        handleUserAcceptProposal(proposalHash, parcelId);
    }

    // Refresh the parcel info panel to show updated status
    setTimeout(() => {
        const parcel = typeof parcelLayer !== 'undefined' && parcelLayer ?
            parcelLayer.getLayers().find(layer => {
                return layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
            }) : null;

        if (parcel) {
            showParcelInfoPanel(parcel.feature);
        }
    }, 100);
}

/**
 * Handle user rejecting a proposal from the parcel info panel
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
function rejectProposalFromParcelInfo(proposalHash, parcelId) {
    // Call the existing function from proposals.js
    if (typeof rejectProposal === 'function') {
        rejectProposal(proposalHash, parcelId);
    }

    // Refresh the parcel info panel to show updated status
    setTimeout(() => {
        const parcel = typeof parcelLayer !== 'undefined' && parcelLayer ?
            parcelLayer.getLayers().find(layer => {
                return layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
            }) : null;

        if (parcel) {
            showParcelInfoPanel(parcel.feature);
        }
    }, 100);
}

/**
 * Show proposal details panel when Details button is clicked
 * @param {string} proposalHash - The proposal hash
 * @param {string} parcelId - The parcel ID
 */
function showProposalDetails(proposalHash, parcelId) {
    // 1. Close the Parcel Info panel
    hideParcelInfoPanel();

    // 2. Select the proposal and show its details immediately
    if (typeof selectAndHighlightProposal === 'function') {
        selectAndHighlightProposal(proposalHash, parcelId, true);
    } else if (typeof selectProposalFromList === 'function') {
        // Fallback to old function
        selectProposalFromList(proposalHash, parcelId);
    }
}

/**
 * Switch between tabs in the parcel info panel
 * @param {HTMLElement} tabButton - The clicked tab button
 * @param {string} tabId - The ID of the tab content to show
 */
function switchParcelTab(tabButton, tabId) {
    // Remove active class from all tab buttons
    const tabButtons = document.querySelectorAll('.parcel-tab-btn');
    tabButtons.forEach(btn => btn.classList.remove('active'));

    // Add active class to clicked button
    tabButton.classList.add('active');

    // Hide all tab contents
    const tabContents = document.querySelectorAll('.parcel-tab-content');
    tabContents.forEach(content => content.classList.remove('active'));

    // Show selected tab content
    const selectedTab = document.getElementById(tabId);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }
}

// Make these functions globally available
window.acceptProposalFromParcelInfo = acceptProposalFromParcelInfo;
window.rejectProposalFromParcelInfo = rejectProposalFromParcelInfo;
window.showProposalDetails = showProposalDetails;
window.switchParcelTab = switchParcelTab;

// --- Parcel Layer State ---
let parcelLayer = null;
let selectedParcelId = null;
let currentParcel = null;
let currentParcelCoordinates = null;
let splitLayer = null;
let parcelsTimeout;
const PARCEL_FETCH_LATLNG_PADDING = 0.12;
const PARCEL_FETCH_DEBOUNCE_MS = 500;
const PARCEL_FETCH_GRID_RADIUS = 1;

const parcelCache = {
    grid: new Map(),  // Key: "easting,northing" grid cell, Value: { data: [] }
    gridSize: 500     // Size in meters (HTRS96/TM coordinates)
};
const parcelLayerIndex = new Map();
let parcelLayerIndexVersion = 0;
let isFetchingParcels = false;
let parcelCoverageVersion = 0;
let parcelMergeInProgress = false;

function setParcelMergeInProgressState(inProgress) {
    const next = !!inProgress;
    if (parcelMergeInProgress === next) {
        return;
    }
    parcelMergeInProgress = next;
    if (typeof window !== 'undefined') {
        window.parcelMergeInProgress = parcelMergeInProgress;
    }
    const eventName = parcelMergeInProgress ? 'parcelMergeStarted' : 'parcelMergeFinished';
    try {
        window.dispatchEvent(new CustomEvent(eventName, {
            detail: {
                timestamp: Date.now()
            }
        }));
    } catch (_) { }
}

if (typeof window !== 'undefined') {
    window.PARCEL_FETCH_GRID_RADIUS = PARCEL_FETCH_GRID_RADIUS;
    window.PARCEL_FETCH_GRID_PADDING = PARCEL_FETCH_GRID_RADIUS; // legacy name retained
    window.PARCEL_FETCH_LATLNG_PADDING = PARCEL_FETCH_LATLNG_PADDING;
    window.PARCEL_FETCH_DEBOUNCE_MS = PARCEL_FETCH_DEBOUNCE_MS;
    window.parcelCoverageVersion = parcelCoverageVersion;
    window.parcelLayerIndexVersion = parcelLayerIndexVersion;
    window.isParcelMergeInProgress = () => parcelMergeInProgress;
    window.parcelMergeInProgress = parcelMergeInProgress;
}

// --- Helper Functions ---

/**
 * Fetches a URL with a specified number of retries on failure.
 * @param {string} url The URL to fetch.
 * @param {object} options Fetch options.
 * @param {number} retries Number of retries.
 * @param {number} delay Delay between retries in ms.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                if (i > 0) {
                    console.log(`Successfully fetched ${url} after ${i + 1} attempts.`);
                }
                return response;
            }
            if (response.status >= 400 && response.status < 500) {
                // Don't retry on client errors
                lastError = new Error(`Failed to fetch parcel data with client error: ${response.status}`);
                break;
            }
            lastError = new Error(`Server error: ${response.status}`);
            console.warn(`Attempt ${i + 1} for ${url} failed with status ${response.status}. Retrying...`);
        } catch (error) {
            lastError = error;
            console.warn(`Attempt ${i + 1} for ${url} failed with error: ${error.message}. Retrying...`);
        }
        if (i < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

function isRoad(parcelId) {
    return PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
}

function getGridKey(easting, northing) {
    const gridEasting = Math.floor(easting / parcelCache.gridSize);
    const gridNorthing = Math.floor(northing / parcelCache.gridSize);
    return `${gridEasting},${gridNorthing}`;
}

function getRequiredGridCells(bounds, extraRadius = 0) {
    const cells = new Set();
    if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof wgs84ToHTRS96 !== 'function') {
        return cells;
    }

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const center = typeof bounds.getCenter === 'function'
        ? bounds.getCenter()
        : {
            lat: (sw.lat + ne.lat) / 2,
            lng: (sw.lng + ne.lng) / 2
        };

    const enforceRadius = Number.isFinite(extraRadius) ? Math.max(0, Math.floor(extraRadius)) : 0;

    const [centerEasting, centerNorthing] = wgs84ToHTRS96(center.lat, center.lng);
    const centerGridE = Math.floor(centerEasting / parcelCache.gridSize);
    const centerGridN = Math.floor(centerNorthing / parcelCache.gridSize);

    const [rawSwEasting, rawSwNorthing] = wgs84ToHTRS96(sw.lat, sw.lng);
    const [rawNeEasting, rawNeNorthing] = wgs84ToHTRS96(ne.lat, ne.lng);

    const minEasting = Math.min(rawSwEasting, rawNeEasting);
    const maxEasting = Math.max(rawSwEasting, rawNeEasting);
    const minNorthing = Math.min(rawSwNorthing, rawNeNorthing);
    const maxNorthing = Math.max(rawSwNorthing, rawNeNorthing);
    const epsilon = 1e-6;

    const minGridE = Math.floor(minEasting / parcelCache.gridSize);
    const maxGridE = Math.max(minGridE, Math.floor((maxEasting - epsilon) / parcelCache.gridSize));
    const minGridN = Math.floor(minNorthing / parcelCache.gridSize);
    const maxGridN = Math.max(minGridN, Math.floor((maxNorthing - epsilon) / parcelCache.gridSize));

    let radiusEast = Math.max(0,
        centerGridE - minGridE,
        maxGridE - centerGridE
    );
    let radiusNorth = Math.max(0,
        centerGridN - minGridN,
        maxGridN - centerGridN
    );

    radiusEast = Math.max(radiusEast, enforceRadius);
    radiusNorth = Math.max(radiusNorth, enforceRadius);

    const radius = Math.max(radiusEast, radiusNorth);

    for (let e = centerGridE - radius; e <= centerGridE + radius; e++) {
        for (let n = centerGridN - radius; n <= centerGridN + radius; n++) {
            cells.add(`${e},${n}`);
        }
    }

    return cells;
}

function computeGridKeysForBounds(bounds) {
    if (!bounds || typeof bounds.getSouthWest !== 'function') {
        return [];
    }
    if (typeof getRequiredGridCells === 'function') {
        const keys = Array.from(getRequiredGridCells(bounds, 0));
        if (keys.length) {
            return keys;
        }
    }
    try {
        if (typeof bounds.getCenter === 'function' && typeof wgs84ToHTRS96 === 'function') {
            const center = bounds.getCenter();
            const coords = wgs84ToHTRS96(center.lat, center.lng);
            if (Array.isArray(coords) && coords.length >= 2) {
                return [getGridKey(coords[0], coords[1])];
            }
        }
    } catch (_) { }
    return [];
}

function indexParcelLayer(layer) {
    if (!layer || typeof layer.getBounds !== 'function') {
        return;
    }

    unindexParcelLayer(layer);

    let keys = [];
    try {
        const bounds = layer.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            keys = computeGridKeysForBounds(bounds);
        }
    } catch (_) { }

    if (!Array.isArray(keys) || !keys.length) {
        return;
    }

    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    if (!uniqueKeys.length) {
        return;
    }

    layer.__parcelGridKeys = uniqueKeys;
    uniqueKeys.forEach(key => {
        let bucket = parcelLayerIndex.get(key);
        if (!bucket) {
            bucket = new Set();
            parcelLayerIndex.set(key, bucket);
        }
        bucket.add(layer);
    });
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function unindexParcelLayer(layer) {
    if (!layer || !Array.isArray(layer.__parcelGridKeys) || !layer.__parcelGridKeys.length) {
        return;
    }
    const keys = layer.__parcelGridKeys.slice();
    delete layer.__parcelGridKeys;
    keys.forEach(key => {
        if (!key) {
            return;
        }
        const bucket = parcelLayerIndex.get(key);
        if (!bucket) {
            return;
        }
        bucket.delete(layer);
        if (bucket.size === 0) {
            parcelLayerIndex.delete(key);
        }
    });
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function clearParcelLayerIndex() {
    parcelLayerIndex.clear();
    if (parcelLayer && typeof parcelLayer.eachLayer === 'function') {
        parcelLayer.eachLayer(layer => {
            if (layer && layer.__parcelGridKeys) {
                delete layer.__parcelGridKeys;
            }
        });
    }
    parcelLayerIndexVersion += 1;
    try { if (typeof window !== 'undefined') window.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { }
}

function getParcelLayersWithinBounds(bounds) {
    if (!parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
        return [];
    }
    if (!bounds || typeof bounds.getSouthWest !== 'function') {
        return parcelLayer.getLayers ? parcelLayer.getLayers() : [];
    }

    const layers = new Set();
    if (parcelLayerIndex.size && typeof getRequiredGridCells === 'function') {
        try {
            const keys = getRequiredGridCells(bounds, 0);
            keys.forEach(key => {
                const bucket = parcelLayerIndex.get(key);
                if (bucket) {
                    bucket.forEach(candidate => {
                        if (candidate) {
                            layers.add(candidate);
                        }
                    });
                }
            });
        } catch (_) { }
    }

    if (layers.size) {
        const indexedLayers = Array.from(layers);
        indexedLayers._source = 'index';
        return indexedLayers;
    }

    const fallback = [];
    parcelLayer.eachLayer(layer => {
        if (layer) {
            fallback.push(layer);
        }
    });
    fallback._source = 'full-scan';
    return fallback;
}

function calculateArea(coordinates) {
    const ring = coordinates[0];
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area += ring[ring.length - 1][0] * ring[0][1] - ring[0][0] * ring[ring.length - 1][1];
    return Math.abs(area / 2);
}

async function yieldToMainThread() {
    if (typeof window !== 'undefined') {
        if (typeof window.requestIdleCallback === 'function') {
            await new Promise(resolve => window.requestIdleCallback(() => resolve()));
            return;
        }
        if (typeof window.requestAnimationFrame === 'function') {
            await new Promise(resolve => window.requestAnimationFrame(() => resolve()));
            return;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
}

// Ensure a ring is in WGS84; if values look like HTRS96/TM, convert to WGS84 [lng, lat]
function ensureRingIsWGS(ring) {
    if (!Array.isArray(ring) || ring.length === 0) return ring;
    const first = ring[0];
    if (!Array.isArray(first) || first.length < 2) return ring;
    const looksLikeHTRS = Math.abs(first[0]) > 1000 || Math.abs(first[1]) > 1000;
    if (!looksLikeHTRS) return ring;
    return ring.map(coord => {
        const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
        return [lon, lat];
    });
}

function cloneCoordinates(coords) {
    if (!Array.isArray(coords)) {
        return coords;
    }
    return coords.map(item => Array.isArray(item) ? cloneCoordinates(item) : item);
}

function convertGeoJSON(geojson) {
    const baseType = geojson && typeof geojson.type === 'string' ? geojson.type : 'FeatureCollection';
    const sourceFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
    const converted = {
        type: baseType,
        features: []
    };

    sourceFeatures.forEach(originalFeature => {
        if (!originalFeature || typeof originalFeature !== 'object') {
            return;
        }

        const properties = Object.assign({}, originalFeature.properties || {});
        let geometry = null;
        if (originalFeature.geometry && typeof originalFeature.geometry === 'object') {
            geometry = {
                type: originalFeature.geometry.type,
                coordinates: cloneCoordinates(originalFeature.geometry.coordinates)
            };
        }

        if (geometry && geometry.coordinates && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const shouldComputeArea = properties.calculatedArea === undefined;
            let computedArea = shouldComputeArea ? 0 : properties.calculatedArea;

            polygons.forEach(polyCoords => {
                if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;
                const exterior = polyCoords[0];
                if (!Array.isArray(exterior) || exterior.length === 0) return;
                const looksLikeHTRS = Math.abs(exterior[0][0]) > 1000 || Math.abs(exterior[0][1]) > 1000;

                if (looksLikeHTRS) {
                    if (shouldComputeArea) {
                        try {
                            computedArea += calculateArea([exterior]);
                        } catch (_) {
                            // ignore area errors, keep accumulator as-is
                        }
                    }
                    for (let r = 0; r < polyCoords.length; r++) {
                        const ring = polyCoords[r];
                        if (!Array.isArray(ring) || ring.length === 0) continue;
                        polyCoords[r] = ring.map(coord => {
                            const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
                            return [lon, lat];
                        });
                    }
                } else {
                    if (shouldComputeArea) {
                        try {
                            const htrsCoords = exterior.map(coord => wgs84ToHTRS96(coord[1], coord[0]));
                            computedArea += calculateArea([htrsCoords]);
                        } catch (_) {
                            // ignore area errors
                        }
                    }
                }
            });

            if (shouldComputeArea) {
                properties.calculatedArea = computedArea;
            }
        }

        converted.features.push({
            type: 'Feature',
            properties,
            geometry
        });
    });

    return converted;
}

function cloneFeatureDeep(feature) {
    if (!feature || typeof feature !== 'object') {
        return null;
    }
    const clone = {
        type: feature.type || 'Feature',
        properties: Object.assign({}, feature.properties || {})
    };
    if (feature.geometry && typeof feature.geometry === 'object') {
        clone.geometry = {
            type: feature.geometry.type,
            coordinates: cloneCoordinates(feature.geometry.coordinates)
        };
    } else {
        clone.geometry = null;
    }
    return clone;
}

// --- Parcel Layer Management ---
function showAllParcels() {
    if (parcelLayer) {
        parcelLayer.addTo(map);
        parcelLayer.eachLayer(layer => {
            layer.addTo(map);
        });
        // updateStatus("Showing all parcels");
    } else {
        fetchParcelData();
        // Don't call updateStatus here since fetchParcelData will handle it
    }
}

function showOnlyRoadParcels() {
    if (!parcelLayer) {
        fetchParcelData();
        setTimeout(() => showOnlyRoadParcels(), 1000);
        return;
    }
    parcelLayer.addTo(map);
    let roadCount = 0;
    parcelLayer.eachLayer(layer => {
        const parcelId = layer.feature.properties.CESTICA_ID;
        const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
        if (isRoad) {
            if (!map.hasLayer(layer)) {
                map.addLayer(layer);
            }
            roadCount++;
        } else {
            if (map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        }
    });
    updateStatus(`Showing ${roadCount} road parcels only`);
}

function hideAllParcels() {
    if (parcelLayer) {
        map.removeLayer(parcelLayer);
    }
    updateStatus("All parcels hidden");
}

function updateVisibleParcelsCount() {
    const label = document.getElementById('parcels-in-view');
    if (!label) return;

    if (!parcelLayer || typeof parcelLayer.getLayers !== 'function' || typeof map === 'undefined' || !map) {
        label.textContent = 'Parcels in map view / total: 0 / 0';
        return;
    }

    const layers = parcelLayer.getLayers();
    const totalParcels = layers.length;

    if (!totalParcels) {
        label.textContent = 'Parcels in map view / total: 0 / 0';
        return;
    }

    const bounds = map.getBounds();
    if (!bounds || typeof bounds.intersects !== 'function') {
        label.textContent = `Parcels in map view / total: 0 / ${totalParcels}`;
        return;
    }

    const visibleParcels = layers.filter(layer => {
        try {
            const layerBounds = layer && typeof layer.getBounds === 'function' ? layer.getBounds() : null;
            return layerBounds ? bounds.intersects(layerBounds) : false;
        } catch (_) {
            return false;
        }
    });

    label.textContent = `Parcels in map view / total: ${visibleParcels.length} / ${totalParcels}`;
}

// --- Parcel Info and Interaction ---
function onParcelClick(e) {
    if (window.measureMode) return;
    const targetLayer = e && e.target ? e.target : null;
    if (!targetLayer || !targetLayer.feature) return;
    const feature = targetLayer.feature;
    const isRoad = PersistentStorage.getItem(`parcel_${feature.properties.CESTICA_ID}_isRoad`) === 'true';

    // Check if multi-selection is active and handle it
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
        const wasToggled = multiParcelSelection.toggleParcel(targetLayer);
        if (wasToggled) {
            L.DomEvent.stopPropagation(e);
            return; // Exit early to avoid single parcel selection logic
        }
    }

    // Normal single parcel selection logic - only runs when multi-selection is off or failed
    // Clear any existing multi-selection highlights if they exist
    if (typeof multiParcelSelection !== 'undefined' && !multiParcelSelection.isActive) {
        multiParcelSelection.clearSelection();
    }

    // Rest of the original single parcel selection logic
    if (splitLayer && map.hasLayer(splitLayer)) {
        map.removeLayer(splitLayer);
        splitLayer = null;
    }

    if (!isRoad && feature.properties.geometries) {
        const splitFeatures = feature.properties.geometries;
        if (splitFeatures && splitFeatures.length > 0) {
            const style = {
                color: '#ff0000',
                weight: 3,
                opacity: 0.8,
                fillColor: '#ff0000',
                fillOpacity: 0.3
            };
            splitLayer = L.layerGroup().addTo(map);
            splitFeatures.forEach(geom => {
                const layer = L.geoJSON(geom, { style });
                splitLayer.addLayer(layer);
            });
            showParcelInfoPanel(splitFeatures[0]);
            return;
        }
    }
    showParcelInfoPanel(feature);
    currentParcelCoordinates = feature.geometry.coordinates;
    const parcelId = feature.properties.CESTICA_ID;
    const currentIsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
    document.getElementById('roadCheckbox').checked = currentIsRoad;

    const previousSelectedId = selectedParcelId ? selectedParcelId.toString() : null;
    const previousLayer = currentParcel && currentParcel.layer ? currentParcel.layer : null;
    if (previousLayer && previousSelectedId && previousSelectedId !== parcelId.toString()) {
        const keepHighlighted = typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive &&
            multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.has(previousSelectedId);
        if (!keepHighlighted) {
            const wasRoad = PersistentStorage.getItem(`parcel_${previousSelectedId}_isRoad`) === 'true';
            try {
                previousLayer.setStyle(getParcelBaseStyle(previousSelectedId, { isRoad: wasRoad }));
            } catch (_) { }
        }
    }

    // Set the selected parcel style
    selectedParcelId = parcelId.toString();
    targetLayer.setStyle(selectedParcelStyle);
    targetLayer.bringToFront();

    if (typeof window !== 'undefined') {
        window.selectedParcelId = selectedParcelId;
    }

    const blockName = feature.properties.block;
    const blocksActive = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
    if (blocksActive) {
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        if (blockName) {
            // If blocks mode is on and parcel has a block, select its block
            highlightAndCenterBlock(blockName);
        } else if (currentSelectedBlockName) {
            // Clicking a non-block parcel while a block is selected should exit block selection
            try { if (typeof clearSelectedBlockAndUI === 'function') clearSelectedBlockAndUI(); } catch (_) { }
        }
    }

    currentParcel = {
        id: parcelId,
        layer: targetLayer,
        isRoad: currentIsRoad
    };
    if (typeof window !== 'undefined') {
        window.currentParcel = currentParcel;
    }

    // Show the create proposal button if we have a single parcel selected
    const createProposalButton = document.getElementById('createProposalFromParcelButton');
    if (createProposalButton) {
        createProposalButton.style.display = 'inline-block';
    }

    // Update the sidebar Create Proposal button visibility
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.updateCreateProposalButton) {
        multiParcelSelection.updateCreateProposalButton();
    }

    document.getElementById('parcel-info-panel').classList.add('visible');
    L.DomEvent.stopPropagation(e);

    // Update sidebar button states (enables Single Building when applicable)
    try { if (typeof updateBlockButtonStates === 'function') updateBlockButtonStates(); } catch (_) { }

}

function highlightFeature(e) {
    const layer = e.target;
    const parcelId = layer.feature.properties.CESTICA_ID.toString();
    const proposalUIActive = (typeof isProposalUIActive === 'function') ? isProposalUIActive() : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);

    // Only use proposal hover overlay when Proposal UI is active
    try {
        if (proposalUIActive && typeof proposalStorage !== 'undefined') {
            const proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
            if (proposals && proposals.length > 0) {
                if (typeof showProposalInfoHoverOverlay === 'function') {
                    showProposalInfoHoverOverlay(parcelId);
                    return; // Do not apply default hover styling
                }
            }
        }
    } catch (_) { }

    // Skip highlight if parcel is part of currently highlighted proposal, but only when proposal UI is active
    if (proposalUIActive && window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.parcelIds.includes(parcelId)) {
        return;
    }
    // Do not highlight over the currently selected parcel
    if (parcelId === selectedParcelId) {
        return;
    }
    // Do not highlight over multi-selected parcels
    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
        multiParcelSelection.isActive &&
        multiParcelSelection.selectedParcels.has(parcelId);
    if (isMultiSelected) {
        return;
    }
    // Proposal-aware: only change border, not fill
    layer.setStyle({
        weight: 5,
        color: '#666',
        dashArray: '',
        // Do not change fillColor/fillOpacity
    });
    if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        layer.bringToFront();
    }
}

function resetHighlight(e) {
    const layer = e.target;
    const parcelId = layer.feature.properties.CESTICA_ID.toString();
    const proposalUIActive = (typeof isProposalUIActive === 'function') ? isProposalUIActive() : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);

    // Clear the proposal hover overlay only when Proposal UI is active
    try {
        if (proposalUIActive && typeof clearProposalInfoHoverOverlay === 'function') {
            clearProposalInfoHoverOverlay();
        }
    } catch (_) { }

    // Do not reset the style of the currently selected parcel (normal)
    if (parcelId === selectedParcelId) {
        return;
    }
    // Keep selected block parcels highlighted in blue ONLY when Parcel Blocks are shown
    try {
        const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
            const parcelHighlightStyle = {
                fillColor: '#3388ff',
                fillOpacity: 0.4,
                color: '#3388ff',
                weight: 2
            };
            layer.setStyle(parcelHighlightStyle);
            return;
        }
    } catch (_) { }

    // Otherwise, reset to its original style (road or normal)
    // But check if this parcel is part of multi-selection first
    const isMultiSelected2 = typeof multiParcelSelection !== 'undefined' &&
        multiParcelSelection.isActive &&
        multiParcelSelection.selectedParcels.has(parcelId);

    if (isMultiSelected2) {
        // Restore multi-selection highlighting
        layer.setStyle({
            fillColor: '#ff9800',
            fillOpacity: 0.6,
            color: '#f57c00',
            weight: 3
        });
    } else {
        // Restore normal or road style using the original style definitions
        // but preserve block highlight if this parcel is part of the selected block
        try {
            const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                ? selectedBlockName
                : (typeof window !== 'undefined' ? window.selectedBlockName : null);
            const layerBlockName = layer?.feature?.properties?.block;
            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
            if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
            } else {
                layer.setStyle(getParcelBaseStyle(parcelId));
            }
        } catch (_) {
            layer.setStyle(getParcelBaseStyle(parcelId));
        }
    }
}

// This function will be called on each created feature
function onEachFeature(feature, layer) {
    layer.on({
        mouseover: highlightFeature,
        mouseout: resetHighlight,
        click: onParcelClick
    });
}

function selectParcel(parcelId, showPanel = true) {
    const selectedLayer = parcelLayer.getLayers().find(layer => {
        return layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
    });

    if (selectedLayer) {
        selectedParcelId = parcelId.toString();
        window.selectedParcelId = parcelId.toString();
        if (!(typeof window !== 'undefined' && window.suppressCameraMoves)) {
            map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
        }
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const layerParcelId = layer.feature.properties.CESTICA_ID.toString();
                const isRoad = PersistentStorage.getItem(`parcel_${layerParcelId}_isRoad`) === 'true';
                if (layerParcelId !== parcelId.toString()) {
                    // Check if this parcel is part of multi-selection before resetting style
                    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                        multiParcelSelection.isActive &&
                        multiParcelSelection.selectedParcels.has(layerParcelId);
                    if (!isMultiSelected) {
                        layer.setStyle(getParcelBaseStyle(layerParcelId, { isRoad }));
                    }
                }
            }
        });
        selectedLayer.setStyle(selectedParcelStyle);
        selectedLayer.bringToFront();
        currentParcel = {
            id: parcelId,
            layer: selectedLayer,
            isRoad: PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
        };
        window.currentParcel = currentParcel;

        // Only show the panel if requested (desktop behavior)
        if (showPanel) {
            showParcelInfoPanel(selectedLayer.feature);
            document.getElementById('roadCheckbox').checked = currentParcel.isRoad;
            document.getElementById('parcel-info-panel').classList.add('visible');
        }
        if (typeof neighborHighlightActive !== 'undefined' && neighborHighlightActive) {
            highlightNeighbors(selectedLayer);
        }
        if (typeof verticesDisplayActive !== 'undefined' && verticesDisplayActive) {
            verticesDisplayActive = false;
            const verticesBtn = document.getElementById('verticesButton');
            if (verticesBtn) verticesBtn.classList.remove('active');
            clearVertexMarkers();
        }
        updateStatus(
            `Selected parcel ${selectedLayer.feature.properties.BROJ_CESTICE}`);
    }
}

function showParcelInfoPanel(feature) {
    const area = feature.properties.calculatedArea;
    const formattedArea = area ? Math.round(Number(area)).toLocaleString('hr-HR') : 'N/A';
    const estimatedPrice = area ? area * SQM_AVG_PRICE : 0;
    const formattedPrice = estimatedPrice ? estimatedPrice.toLocaleString('hr-HR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }) : 'N/A';

    const blockName = feature.properties.block;
    const blockHtml = blockName ?
        `<span class="block-tag" onclick="highlightAndCenterBlock('${blockName}')" style="cursor: pointer; background-color: #007bff; color: white; padding: 2px 8px; border-radius: 12px;">${blockName}</span>` :
        'Not part of a block';

    // Get parcel ownership information
    const parcelId = feature.properties.CESTICA_ID;
    const parcelProposals = (typeof proposalStorage !== 'undefined')
        ? proposalStorage.getProposalsForParcel(parcelId.toString(), { hydrateRoadAssets: false })
        : [];
    const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
    let ownershipHtml = 'No owner';

    if (ownerId && typeof agentStorage !== 'undefined') {
        const owner = agentStorage.getAgent(ownerId);
        if (owner) {
            ownershipHtml = `
                <div class="parcel-owner" onclick="showAgentDialog('${owner.id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                    <img src="${getAvatarImagePath(owner.avatarIndex)}" class="agent-avatar" style="width: 30px; height: 30px; border-radius: 50%; border: 2px solid #007bff;">
                    <span class="owner-name" style="color: #007bff; font-weight: 500;">${owner.name}</span>
                </div>
            `;
        } else {
            ownershipHtml = `<span style="color: #666;">Agent not found (${ownerId})</span>`;
        }
    }

    // Get proposals for this parcel
    let proposalsHtml = 'No proposals';
    if (parcelProposals.length > 0) {
        const proposalItems = parcelProposals.map(proposal => {
            const isRoadProposal = proposal.type === 'road' && proposal.roadProposal;
            const statusText = proposal.status || 'Active';
            const statusClass = proposal.status === 'Executed' || proposal.status === 'Applied' ? 'executed' :
                proposal.status === 'Rejected' ? 'rejected' : 'active';

            // Check if current parcel has accepted this proposal
            const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

            // Check if proposal is still active (not executed)
            const isActive = proposal.status !== 'Executed' && proposal.status !== 'Applied';

            // Generate action buttons based on proposal type and state
            let actionButtons = '';
            if (isRoadProposal) {
                // Road proposals have apply/unapply buttons
                const roadStatus = proposal.roadProposal.status;
                if (roadStatus === 'applied') {
                    actionButtons = `
                            <button class="btn btn-sm btn-warning" onclick="event.stopPropagation(); if(typeof ProposalManager !== 'undefined') ProposalManager.unapplyProposal('${proposal.proposalHash}')" style="font-size: 11px; padding: 2px 6px;">
                                Un-apply
                            </button>
                        `;
                } else {
                    actionButtons = `
                            <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); if(typeof ProposalManager !== 'undefined') ProposalManager.applyProposal('${proposal.proposalHash}')" style="font-size: 11px; padding: 2px 6px;">
                                Apply
                            </button>
                        `;
                }
            } else {
                // Regular parcel proposals have accept/reject buttons
                if (isActive) {
                    if (hasAccepted) {
                        actionButtons = `
                                <button class="btn btn-sm btn-success" disabled style="font-size: 11px; padding: 2px 6px; margin-right: 4px;">
                                    ✓ Accepted
                                </button>
                                <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); rejectProposalFromParcelInfo('${proposal.proposalHash}', '${parcelId}')" style="font-size: 11px; padding: 2px 6px; margin-right: 4px;">
                                    Reject
                                </button>
                            `;
                    } else {
                        actionButtons = `
                                <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); acceptProposalFromParcelInfo('${proposal.proposalHash}', '${parcelId}')" style="font-size: 11px; padding: 2px 6px; margin-right: 4px;">
                                    Accept
                                </button>
                            `;
                    }
                }

                const canCompare = typeof isProposalApplied === 'function'
                    ? isProposalApplied(proposal)
                    : ((proposal.status || '').toLowerCase() === 'applied' || (proposal.status || '').toLowerCase() === 'executed');

                if (canCompare) {
                    actionButtons += `
                            <button class="btn btn-sm btn-info" onclick="event.stopPropagation(); showProposalCompareModal('${proposal.proposalHash}', '${parcelId}')" style="font-size: 11px; padding: 2px 6px;">
                                Compare
                            </button>
                        `;
                }
            }

            return `
                    <div class="proposal-item" onclick="showProposalDetails('${proposal.proposalHash}', '${parcelId}')" style="cursor: pointer;">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title">${proposal.title || proposal.type || 'Proposal'}${isRoadProposal ? ' (Road)' : ''}</span>
                            <span class="proposal-item-status ${statusClass}">${statusText}</span>
                        </div>
                        <div class="proposal-item-details">
                            ID: ${proposal.proposalHash.substring(0, 8)}
                        </div>
                        <div class="proposal-item-details">
                            Author: ${proposal.author || proposal.username || 'Unknown'}
                        </div>
                        ${proposal.budget && !isRoadProposal ? `<div class="proposal-item-details">Budget: ${proposal.budget} ETH</div>` : ''}
                        <div class="proposal-item-actions" style="margin-top: 8px; text-align: right;">
                            ${actionButtons}
                        </div>
                    </div>
                `;
        }).join('');

        proposalsHtml = `
            <div class="parcel-proposals-list">
                ${proposalItems}
            </div>
        `;
    }

    // Populate Info Tab
    const infoContent = `
        <div class="metric-group">
            <div class="metric-label">Owner:</div>
            <div class="metric-value">${ownershipHtml}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Block:</div>
            <div class="metric-value">${blockHtml}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Parcel Area:</div>
            <div class="metric-value">${formattedArea} m²</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Est. Market Price:</div>
            <div class="metric-value">${formattedPrice} €</div>
        </div>
        <div id="roadMeasurements" style="display: none;">
            <!-- Road measurements will be inserted here when button is clicked -->
        </div>
    `;

    // Populate Proposals Tab
    const proposalsContent = `
        <div class="metric-group">
            <div class="metric-label">Proposals (${parcelProposals.length}):</div>
            <div class="metric-value">${proposalsHtml}</div>
        </div>
    `;

    // Update the title to include parcel number
    const titleElement = document.getElementById('parcel-info-title');
    if (titleElement) {
        const broj = feature.properties.BROJ_CESTICE;
        const cesticaId = feature.properties.CESTICA_ID;
        const isDebug = document.body && document.body.classList && document.body.classList.contains('debug-mode');
        if (isDebug) {
            titleElement.innerHTML = `Parcel Info (${broj}) <span style="font-size:11px;color:#666;margin-left:6px;">ID: <span style="font-family:monospace;">${cesticaId}</span></span>`;
        } else {
            titleElement.textContent = `Parcel Info (${broj})`;
        }
    }

    // Update the Proposals tab title with count
    const proposalCount = parcelProposals.length;
    const proposalsTabButton = document.querySelector('.parcel-tab-btn[onclick*="proposals-tab"]');
    if (proposalsTabButton) {
        proposalsTabButton.textContent = proposalCount > 0 ? `Proposals (${proposalCount})` : 'Proposals';
    }

    // Populate the tabs
    document.getElementById('info-content').innerHTML = infoContent;
    document.getElementById('proposals-content').innerHTML = proposalsContent;

    // Show the panel
    document.getElementById('parcel-info-panel').classList.add('visible');

    // If multi-select is active, automatically switch to Info tab
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
        switchParcelTab(document.querySelector('.parcel-tab-btn[onclick*="info-tab"]'), 'info-tab');
    }

    // Reset the measure as road button state when showing a new parcel
    resetMeasureAsRoadButton();
}

// Function to reset the measure as road button to its initial state
function resetMeasureAsRoadButton() {
    const button = document.getElementById('measureAsRoadButton');
    const measurementsDiv = document.getElementById('roadMeasurements');

    if (button) {
        button.innerHTML = 'Measure as road';
        button.disabled = false;
    }

    if (measurementsDiv) {
        measurementsDiv.style.display = 'none';
        measurementsDiv.innerHTML = '';
    }
}

// --- Proposal Compare Modal ---
function showProposalCompareModal(proposalHash, parcelId) {
    try {
        const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(proposalHash) : null;
        if (!proposal) {
            alert('Proposal not found.');
            return;
        }

        const canCompare = typeof isProposalApplied === 'function'
            ? isProposalApplied(proposal)
            : ((proposal.status || '').toLowerCase() === 'applied' || (proposal.status || '').toLowerCase() === 'executed');
        if (!canCompare) {
            if (typeof updateStatus === 'function') {
                updateStatus('Only the currently applied proposal can be compared.');
            } else {
                alert('Only the currently applied proposal can be compared.');
            }
            return;
        }

        // Create or reuse modal container
        let modal = document.querySelector('.proposal-info-modal.compare-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'proposal-info-modal compare-modal';
            document.body.appendChild(modal);
        }

        // Build modal content
        const content = document.createElement('div');
        content.className = 'proposal-info-modal-content';
        content.innerHTML = `
            <div class="proposal-info-modal-header">
                <h2>Compare: Current vs Proposed</h2>
                <button class="proposal-info-modal-close" aria-label="Close">×</button>
            </div>
            <div class="proposal-info-modal-body" id="compare-modal-body"></div>
            <div class="proposal-info-modal-footer">
                <button class="btn btn-secondary" id="compare-close-btn">Close</button>
            </div>
        `;

        // Clear and append
        modal.innerHTML = '';
        modal.appendChild(content);

        // Wire close events
        const close = () => hideProposalCompareModal();
        content.querySelector('.proposal-info-modal-close').addEventListener('click', close);
        content.querySelector('#compare-close-btn').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        // Render placeholder; actual metrics computed in a separate function so we can reuse
        const body = content.querySelector('#compare-modal-body');
        body.innerHTML = '<div>Loading comparison…</div>';

        // Ensure existing buildings are loaded, then compute and render
        ensureExistingBuildingsLoaded()
            .then(() => {
                try {
                    const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                    body.innerHTML = tableHtml;
                } catch (err) {
                    console.error('Error building comparison table:', err);
                    body.innerHTML = '<div style="color:#dc3545">Failed to build comparison.</div>';
                }
            })
            .catch((err) => {
                console.error('Error ensuring buildings loaded:', err);
                // Proceed with best-effort computation even if buildings failed to load
                try {
                    const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                    body.innerHTML = tableHtml;
                } catch (e2) {
                    console.error('Error building comparison table (fallback):', e2);
                    body.innerHTML = '<div style="color:#dc3545">Failed to build comparison.</div>';
                }
            });

        // Show modal
        modal.style.display = 'flex';
    } catch (e) {
        console.error('showProposalCompareModal error:', e);
        alert('Could not open comparison modal.');
    }
}

function hideProposalCompareModal() {
    const modal = document.querySelector('.proposal-info-modal.compare-modal');
    if (modal) modal.style.display = 'none';
}

// Expose for onclick usage
window.showProposalCompareModal = showProposalCompareModal;

// Wait until existing buildings are available; fetch if needed
function ensureExistingBuildingsLoaded() {
    return new Promise((resolve, reject) => {
        try {
            const ready = () => {
                const bl = typeof window !== 'undefined' ? window.buildingLayer : null;
                if (bl && typeof bl.getLayers === 'function' && bl.getLayers().length > 0) {
                    resolve();
                    return true;
                }
                return false;
            };

            if (ready()) return; // already loaded

            // If we can fetch, listen for update and trigger fetch
            const onUpdated = () => {
                if (ready()) {
                    try { window.removeEventListener('buildingsLayerUpdated', onUpdated); } catch (_) { }
                    resolve();
                }
            };
            try { window.addEventListener('buildingsLayerUpdated', onUpdated, { once: true }); } catch (_) { }

            if (typeof fetchBuildings === 'function') {
                fetchBuildings();
            } else {
                // No fetch function available
                resolve();
            }
        } catch (e) {
            reject(e);
        }
    });
}

// Build the HTML table for comparison; metrics are computed in helper below
function buildProposalComparisonTable(proposal, parcelId) {
    const metrics = computeComparisonMetrics(proposal, parcelId);

    const fmt = (v) => {
        if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
        if (typeof v === 'number') return Math.round(Number(v)).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        return String(v);
    };

    // Adjust proposed market value by subtracting parking cost (10,000€ per spot)
    const PARKING_SPOT_COST = 10000;
    const adjustedProposedMarket = metrics.marketValue.proposed - (metrics.parking.proposed * PARKING_SPOT_COST);

    const rows = [
        { label: 'Parcel area (m²)', current: metrics.parcelArea.current, proposed: metrics.parcelArea.proposed },
        { label: 'Building footprint (m²)', current: metrics.footprint.current, proposed: metrics.footprint.proposed },
        { label: 'Building height (m)', current: metrics.height.current, proposed: metrics.height.proposed },
        { label: 'Building floors', current: metrics.floors.current, proposed: metrics.floors.proposed },
        { label: 'Square meters (m²)', current: metrics.squareMeters.current, proposed: metrics.squareMeters.proposed },
        { label: 'Parking spots', current: metrics.parking.current, proposed: metrics.parking.proposed },
        { label: 'Estimated market value (€)', current: metrics.marketValue.current, proposed: adjustedProposedMarket },
    ];

    const adjustedDiff = adjustedProposedMarket - metrics.marketValue.current;
    const summaryHtml = adjustedDiff > 0
        ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-profit">Profit!</span></div>
                <div class="metric-value">You can profit by accepting this proposal.</div>
            </div>
        `
        : (adjustedDiff < 0
            ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-loss">Loss!</span></div>
                <div class="metric-value">If you accept this proposal your property will be worth less than today.</div>
            </div>
        ` : '');

    const table = `
        <div class="proposal-details">
            ${summaryHtml}
            <div class="metric-group">
                <div class="metric-label">Difference in market value (profit)</div>
                <div class="metric-value ${adjustedDiff >= 0 ? 'profit-positive' : 'profit-negative'}"><span class="animated-amount">${fmt(adjustedDiff)} €</span></div>
            </div>
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Currently</th>
                        <th>Proposed</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                        <tr>
                            <td class="label">${r.label}</td>
                            <td class="value">${fmt(r.current)}</td>
                            <td class="value">${fmt(r.proposed)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
    return table;
}

// Compute comparison metrics based on current parcel and proposal data
function computeComparisonMetrics(proposal, parcelId) {
    // 1) parcel area
    const parcelLayerRef = typeof parcelLayer !== 'undefined' ? parcelLayer : null;
    const parcelLayerObj = parcelLayerRef ? parcelLayerRef.getLayers().find(l => String(l?.feature?.properties?.CESTICA_ID) === String(parcelId)) : null;
    const parcelFeature = parcelLayerObj ? parcelLayerObj.feature : null;
    const parcelArea = parcelFeature ? (parcelFeature.properties?.calculatedArea || safeArea(parcelFeature)) : 0;

    // Proposed parcel area: same as current unless geometry from road splitting exists in proposal
    // For now, follow spec: same for building proposals; roads may change area if polygon intersects
    let proposedParcelArea = parcelArea;
    try {
        if (proposal.type === 'road' && proposal.roadGeometry && proposal.roadGeometry.polygon && parcelFeature) {
            const remaining = turf.difference(parcelFeature, proposal.roadGeometry.polygon);
            proposedParcelArea = remaining ? turf.area(remaining) : parcelArea;
        }
    } catch (_) { proposedParcelArea = parcelArea; }

    // 2) building footprint (current) based on existing buildings layer
    let currentFootprint = 0;
    let currentHeightFromBuildings = null; // meters (area-weighted if multiple)
    try {
        const parcelPoly = parcelFeature;
        const bLayer = (typeof window !== 'undefined') ? window.buildingLayer : null;
        if (parcelPoly && bLayer && typeof bLayer.getLayers === 'function') {
            const layers = bLayer.getLayers();
            let totalIntersectArea = 0;
            let heightAreaProduct = 0;

            for (let i = 0; i < layers.length; i++) {
                const l = layers[i];
                const feat = l && l.feature ? l.feature : null;
                if (!feat || !feat.geometry) continue;
                try {
                    // Quick bbox check to skip non-intersecting
                    if (typeof l.getBounds === 'function' && l.getBounds && parcelLayerObj && parcelLayerObj.getBounds) {
                        const parcelBounds = parcelLayerObj.getBounds();
                        try { if (!parcelBounds.intersects(l.getBounds())) continue; } catch (_) { }
                    }

                    const inter = turf.intersect(parcelPoly, feat);
                    if (inter) {
                        const a = turf.area(inter);
                        if (isFinite(a) && a > 0) {
                            currentFootprint += a;
                            totalIntersectArea += a;
                            const h = extractBuildingHeightMeters(feat.properties);
                            if (isFinite(h) && h > 0) {
                                heightAreaProduct += h * a; // area-weighted aggregation
                            }
                        }
                    }
                } catch (_) { }
            }

            if (totalIntersectArea > 0 && heightAreaProduct > 0) {
                currentHeightFromBuildings = heightAreaProduct / totalIntersectArea;
            }
        }
    } catch (_) { }

    // proposed: intersection of proposed building polygon and parcel
    let proposedFootprint = 0;
    try {
        if (proposal.buildingGeometry && parcelFeature) {
            const inter = turf.intersect(parcelFeature, { type: 'Feature', geometry: proposal.buildingGeometry, properties: {} });
            proposedFootprint = inter ? turf.area(inter) : 0;
        }
    } catch (_) { proposedFootprint = 0; }

    // 3) building height
    const currentHeight = isFinite(currentHeightFromBuildings) && currentHeightFromBuildings > 0
        ? Math.round(currentHeightFromBuildings)
        : 10; // fallback default
    // For proposed: try to pull from building properties if available; default 10 if missing
    let proposedHeight = 10;
    try {
        // Prefer height from buildingGeometry Feature properties if provided
        if (proposal.buildingGeometry && proposal.buildingGeometry.properties && isFinite(Number(proposal.buildingGeometry.properties.height))) {
            proposedHeight = Math.round(Number(proposal.buildingGeometry.properties.height));
        } else if (proposal.properties && isFinite(Number(proposal.properties.height))) {
            proposedHeight = Math.round(Number(proposal.properties.height));
        } else if (proposal.title && /\b(\d{1,3})m\b/i.test(proposal.title)) {
            const m = proposal.title.match(/\b(\d{1,3})m\b/i);
            if (m) proposedHeight = Number(m[1]);
        }
    } catch (_) { }

    // 4) floors
    const currentFloors = Math.floor(currentHeight / 3);
    const proposedFloors = Math.floor(proposedHeight / 3);

    // 5) square meters
    const currentSqm = currentFootprint * currentFloors;
    const proposedSqm = proposedFootprint * proposedFloors;

    // 6) parking spots
    const currentParking = 4;
    const proposedParking = 0;

    // 7) estimated market value
    const sqmPrice = 3500; // As per spec for comparison
    const currentMarket = currentSqm * sqmPrice;
    const proposedMarket = proposedSqm * sqmPrice;

    return {
        parcelArea: { current: parcelArea, proposed: proposedParcelArea },
        footprint: { current: currentFootprint, proposed: proposedFootprint },
        height: { current: currentHeight, proposed: proposedHeight },
        floors: { current: currentFloors, proposed: proposedFloors },
        squareMeters: { current: currentSqm, proposed: proposedSqm },
        parking: { current: currentParking, proposed: proposedParking },
        marketValue: { current: currentMarket, proposed: proposedMarket }
    };
}

function safeArea(feature) {
    try { return turf.area(feature); } catch (_) { return 0; }
}

// Extract height from building properties if available
function extractBuildingHeightMeters(props) {
    if (!props) return null;
    try {
        // Try common fields first
        if (isFinite(Number(props.height))) return Number(props.height);
        if (isFinite(Number(props.HEIGHT))) return Number(props.HEIGHT);
        if (isFinite(Number(props.visina))) return Number(props.visina);
        if (isFinite(Number(props.Visina))) return Number(props.Visina);

        // Try floors then convert to meters (3m per floor)
        const floorsCandidates = [props.floors, props.FLOORS, props.kat, props.KAT, props.katova, props.KATOVA, props.storeys, props.STOREYS];
        for (let i = 0; i < floorsCandidates.length; i++) {
            const f = Number(floorsCandidates[i]);
            if (isFinite(f) && f > 0) return f * 3;
        }
    } catch (_) { }
    return null;
}

// Function to measure parcel as road when button is clicked
function measureAsRoad() {
    if (!currentParcel || !currentParcel.layer) {
        updateStatus('No parcel selected for road measurement.');
        return;
    }

    const button = document.getElementById('measureAsRoadButton');
    const measurementsDiv = document.getElementById('roadMeasurements');

    // Show loading state
    button.innerHTML = '⏳ Calculating...';
    button.disabled = true;

    try {
        // Calculate road metrics
        const feature = currentParcel.layer.feature;
        const metrics = calculateRoadMetrics(feature.geometry.coordinates);

        // Format the measurements
        const formattedLength = metrics ? Number(metrics.length).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedAvgWidth = metrics ? Number(metrics.widths.average).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedMaxWidth = metrics ? Number(metrics.widths.maximum).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedMinWidth = metrics ? Number(metrics.widths.minimum).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }) : 'N/A';
        const formattedTolerance = metrics ? Number(metrics.widths.tolerancePercentage).toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1
        }) : 'N/A';

        // Display the measurements
        measurementsDiv.innerHTML = `
        <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
        <div class="metric-group">
            <div class="metric-label">As Road Length:</div>
            <div class="metric-value">${formattedLength} m</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">As Road Width:</div>
            <div class="metric-value">
                Average: ${formattedAvgWidth} m<br>
                Maximum: ${formattedMaxWidth} m<br>
                Minimum: ${formattedMinWidth} m
            </div>
        </div>
        <div class="metric-group">
                <div class="metric-label">As Road Width Consistency:</div>
            <div class="metric-value">${formattedTolerance}% within ±10% of average</div>
        </div>
    `;

        measurementsDiv.style.display = 'block';

        // Update button to show completion and disable it since measurements are now shown
        button.innerHTML = 'Measurements added';
        button.disabled = true;

        updateStatus('Road measurements calculated and added to panel.');

    } catch (error) {
        console.error('Error calculating road metrics:', error);
        updateStatus('Error calculating road measurements.');
        button.innerHTML = 'Measure as road';
        button.disabled = false;
    }
}

function hideParcelInfoPanel() {
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');
    clearRoadVisualization();

    const previouslySelectedId = selectedParcelId ? selectedParcelId.toString() : null;
    selectedParcelId = null;
    window.selectedParcelId = null;
    currentParcel = null;
    window.currentParcel = null;
    currentParcelCoordinates = null;

    if (typeof refreshParcelStylesForAppliedProposals === 'function') {
        refreshParcelStylesForAppliedProposals();
    } else if (previouslySelectedId && parcelLayer) {
        const previousLayer = parcelLayer.getLayers().find(layer => {
            const id = layer?.feature?.properties?.CESTICA_ID;
            return id !== undefined && id !== null && id.toString() === previouslySelectedId;
        });
        if (previousLayer) {
            const isRoad = PersistentStorage.getItem(`parcel_${previouslySelectedId}_isRoad`) === 'true';
            previousLayer.setStyle(getParcelBaseStyle(previouslySelectedId, { isRoad }));
        }
    }

    // Leaving parcel details should also clear any proposal overlays/highlights
    try { if (typeof clearProposalInfoHoverOverlay === 'function') clearProposalInfoHoverOverlay(); } catch (_) { }
    try { if (typeof clearProposalHighlights === 'function') clearProposalHighlights(); } catch (_) { }

    // Hide the create proposal button
    const createProposalButton = document.getElementById('createProposalFromParcelButton');
    if (createProposalButton) {
        createProposalButton.style.display = 'none';
    }

    // Update the sidebar Create Proposal button visibility
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.updateCreateProposalButton) {
        multiParcelSelection.updateCreateProposalButton();
    }

    if (typeof neighborHighlightActive !== 'undefined' && neighborHighlightActive) {
        neighborHighlightActive = false;
        const neighborBtn = document.getElementById('neighboursButton');
        if (neighborBtn) neighborBtn.classList.remove('active');
        clearHighlightedNeighbors();
    }
    if (typeof verticesDisplayActive !== 'undefined' && verticesDisplayActive) {
        verticesDisplayActive = false;
        const verticesBtn = document.getElementById('verticesButton');
        if (verticesBtn) verticesBtn.classList.remove('active');
        clearVertexMarkers();
    }
}

// Function to create proposal from single parcel
function createProposalFromSingleParcel() {
    console.log('createProposalFromSingleParcel called');

    if (!currentParcel || !currentParcel.layer) {
        updateStatus('No parcel selected. Please select a parcel first.');
        return;
    }

    // Add the current parcel to multi-selection and show proposal dialog
    if (typeof multiParcelSelection !== 'undefined') {
        // Only clear existing selection if multi-select is not active
        // If multi-select is active, this function shouldn't be called
        if (!multiParcelSelection.isActive) {
            multiParcelSelection.selectedParcels.clear();
            multiParcelSelection.selectedParcels.add(currentParcel.id);
            showProposalDialog();
        } else {
            // Multi-select is active, so we shouldn't interfere with existing selection
            console.warn('createProposalFromSingleParcel called while multi-select is active - this should not happen');
            updateStatus('Please use the main "Create Proposal" button when multiple parcels are selected.');
        }
    }
}

// --- Parcel Number Labels ---
let parcelNumberLabels = [];
let parcelNumberLabelFilter = null;

function toggleParcelNumbers() {
    const checkbox = document.getElementById('showParcelNumbers');
    const show = checkbox ? checkbox.checked : false;
    if (show) {
        drawParcelNumberLabels();
    } else {
        clearParcelNumberLabels();
    }
}

function drawParcelNumberLabels() {
    clearParcelNumberLabels();
    if (!parcelLayer) return;

    parcelLayer.eachLayer(layer => {
        if (!layer?.feature?.properties) return;
        const brojCestice = layer.feature.properties.BROJ_CESTICE;
        if (!brojCestice) return;
        const parcelId = layer.feature.properties.CESTICA_ID ? layer.feature.properties.CESTICA_ID.toString() : null;
        if (parcelNumberLabelFilter && parcelId && !parcelNumberLabelFilter.has(parcelId)) {
            return;
        }

        let labelLatLng = null;
        const geometry = layer.feature.geometry;

        if (geometry && typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            try {
                const centroid = turf.centerOfMass(geometry);
                const coords = centroid?.geometry?.coordinates;
                if (Array.isArray(coords) && coords.length >= 2) {
                    const [lng, lat] = coords;
                    if (Number.isFinite(lat) && Number.isFinite(lng)) {
                        labelLatLng = L.latLng(lat, lng);
                    }
                }
            } catch (error) {
                console.warn('Unable to compute centroid for parcel label', error);
            }
        }

        if (!labelLatLng && typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && typeof bounds.getCenter === 'function') {
                const center = bounds.getCenter();
                if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                    labelLatLng = center;
                }
            }
        }

        if (!labelLatLng) return;

        const label = L.marker(labelLatLng, {
            icon: L.divIcon({
                className: 'parcel-number-label',
                html: `${brojCestice}`,
                iconSize: [40, 18],
                iconAnchor: [20, 9]
            }),
            interactive: false
        }).addTo(map);
        parcelNumberLabels.push(label);
    });
}

function clearParcelNumberLabels() {
    parcelNumberLabels.forEach(label => map.removeLayer(label));
    parcelNumberLabels = [];
}

function refreshParcelNumberLabelsIfVisible() {
    const checkbox = document.getElementById('showParcelNumbers');
    if (checkbox && checkbox.checked) {
        drawParcelNumberLabels();
    }
}

function setParcelNumberLabelFilter(ids) {
    if (ids && ids.size) {
        parcelNumberLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
    } else {
        parcelNumberLabelFilter = null;
    }
    refreshParcelNumberLabelsIfVisible();
}

// --- Parcel Data Fetching and Management ---
async function fetchParcelData(customBounds) {
    if (isFetchingParcels) {
        // updateStatus("Already fetching parcel data...");
        return;
    }
    // Respect zoom guard to avoid fetching when zoomed too far out/in
    try {
        if (!customBounds && typeof window.isZoomWithinParcelRange === 'function' && !window.isZoomWithinParcelRange()) {
            updateStatus('Parcels disabled at this zoom');
            return;
        }
    } catch (_) { }
    isFetchingParcels = true;
    setParcelMergeInProgressState(true);
    updateStatus('Fetching data...');
    const newParcelIdsSet = new Set();
    try {
        const viewBounds = customBounds || map.getBounds();
        if (!viewBounds) {
            updateStatus('Unable to determine map bounds for parcel fetch.');
            return;
        }
        const latLngPadding = (!customBounds && typeof viewBounds.pad === 'function')
            ? Number((typeof window !== 'undefined' && window.PARCEL_FETCH_LATLNG_PADDING !== undefined)
                ? window.PARCEL_FETCH_LATLNG_PADDING
                : PARCEL_FETCH_LATLNG_PADDING)
            : 0;
        const boundsForCells = (!customBounds && typeof viewBounds.pad === 'function' && latLngPadding > 0)
            ? viewBounds.pad(latLngPadding)
            : viewBounds;
        const gridRadius = Number((typeof window !== 'undefined' && window.PARCEL_FETCH_GRID_RADIUS !== undefined)
            ? window.PARCEL_FETCH_GRID_RADIUS
            : PARCEL_FETCH_GRID_RADIUS);
        const requiredCells = getRequiredGridCells(boundsForCells, gridRadius);
        const missingCells = new Set(requiredCells);
        for (const cell of requiredCells) {
            if (parcelCache.grid.has(cell)) {
                missingCells.delete(cell);
            }
        }
        if (missingCells.size > 0) {
            const totalCells = missingCells.size;
            let completedCells = 0;
            updateStatus(`Fetching data for ${totalCells} new grid cells (0/${totalCells})...`);
            const fetchPromises = Array.from(missingCells).map(async (cell) => {
                const [gridEasting, gridNorthing] = cell.split(',').map(Number);
                const swEasting = gridEasting * parcelCache.gridSize;
                const swNorthing = gridNorthing * parcelCache.gridSize;
                const neEasting = (gridEasting + 1) * parcelCache.gridSize;
                const neNorthing = (gridNorthing + 1) * parcelCache.gridSize;
                const bbox = `${swEasting},${swNorthing},${neEasting},${neNorthing}`;
                const builder = (typeof buildParcelRequestParams === 'function') ? buildParcelRequestParams : null;
                let allFeatures = [];
                let startIndex = 0;
                const count = 2000;
                let more = true;
                while (more) {
                    const req = builder ? builder(bbox, { count, startIndex }) : null;
                    const url = req ? req.url : (function () {
                        const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
                        const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
                        return `${baseUrl}?${new URLSearchParams({
                            token: token,
                            service: 'WFS',
                            version: '2.0.0',
                            request: 'GetFeature',
                            outputFormat: 'json',
                            typeName: 'oss:DKP_CESTICE',
                            srsName: 'EPSG:3765',
                            bbox: bbox,
                            count: String(count),
                            startIndex: String(startIndex)
                        }).toString()}`;
                    })();
                    const response = await fetchWithRetry(url);
                    const data = await response.json();
                    const features = Array.isArray(data.features) ? data.features : [];
                    allFeatures = allFeatures.concat(features);
                    const numberReturned = Number(data.numberReturned || features.length);
                    // If WFS 2.0 numberMatched is provided, use it for termination
                    const numberMatched = Number(data.numberMatched);
                    if (isFinite(numberMatched) && numberMatched > 0) {
                        more = startIndex + numberReturned < numberMatched && numberReturned > 0;
                    } else {
                        // Fallback: stop when a page returns fewer than requested
                        more = numberReturned === count && numberReturned > 0;
                    }
                    startIndex += numberReturned;
                }
                const cellData = { type: 'FeatureCollection', features: allFeatures };
                parcelCache.grid.set(cell, cellData);
                completedCells++;
                updateStatus(`Fetching data for ${totalCells} new grid cells (${completedCells}/${totalCells})...`);
                allFeatures.forEach(feature => {
                    const parcelId = feature?.properties?.CESTICA_ID;
                    if (parcelId !== undefined && parcelId !== null) {
                        newParcelIdsSet.add(String(parcelId));
                    }
                });
            });
            const settledPromises = await Promise.allSettled(fetchPromises);
            settledPromises
                .filter(p => p.status === 'rejected')
                .forEach(p => console.error("Failed to fetch parcel grid cell:", p.reason));
        }

        setParcelMergeInProgressState(true);
        updateStatus('Merging parcel data...');

        // Build set of existing parcel IDs already on the map to avoid reprocessing
        const existingParcelIds = new Set();
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const parcelId = layer.feature?.properties?.CESTICA_ID;
                if (parcelId !== undefined && parcelId !== null) {
                    existingParcelIds.add(String(parcelId));
                }
            });
        }

        // Merge and process features - ONLY from required cells
        const featuresMap = new Map();
        const serverParcelIds = new Set();
        const modifiedParcelSet = (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getModifiedParcelsSet === 'function')
            ? ProposalManager._getModifiedParcelsSet()
            : (function () {
                try {
                    const list = JSON.parse(PersistentStorage.getItem('modified_parcels') || '[]');
                    if (Array.isArray(list)) {
                        return new Set(list.map(String));
                    }
                } catch (_) { }
                return new Set();
            })();

        let storedGeometryCount = 0;
        let storedPropertiesCount = 0;
        let processedFeatureCount = 0;

        // Process features from required cells
        for (const cell of requiredCells) {
            const cellData = parcelCache.grid.get(cell);
            if (!cellData || !Array.isArray(cellData.features)) {
                continue;
            }
            for (const feature of cellData.features) {
                const parcelId = String(feature.properties.CESTICA_ID);
                serverParcelIds.add(parcelId);

                // Skip if modified or already exists on map
                if (modifiedParcelSet.has(parcelId) || existingParcelIds.has(parcelId)) {
                    continue;
                }

                const storedGeometryStr = PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
                const storedPropertiesStr = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
                if (storedGeometryStr) {
                    try {
                        const storedGeometry = JSON.parse(storedGeometryStr);
                        feature.geometry = {
                            type: 'Polygon',
                            coordinates: [storedGeometry]
                        };
                        feature.properties.calculatedArea = calculateArea([storedGeometry]);
                        storedGeometryCount++;
                    } catch (e) { console.error(`Error parsing stored geometry for ${parcelId}:`, e); }
                }
                if (storedPropertiesStr) {
                    try {
                        const storedProperties = JSON.parse(storedPropertiesStr);
                        const originalCalculatedArea = feature.properties.calculatedArea;
                        feature.properties = { ...feature.properties, ...storedProperties };
                        if (storedGeometryStr) {
                            feature.properties.calculatedArea = originalCalculatedArea;
                        } else {
                            feature.properties.calculatedArea = calculateArea(feature.geometry.coordinates);
                        }
                        storedPropertiesCount++;
                    } catch (e) { console.error(`Error parsing stored properties for ${parcelId}:`, e); }
                }
                if (!storedGeometryStr && storedPropertiesStr) {
                    feature.properties.calculatedArea = calculateArea(feature.geometry.coordinates);
                }
                const govtPlanAppliedValue = PersistentStorage.getItem(`parcel_${parcelId}_government_plan_applied`);
                if (govtPlanAppliedValue) {
                    feature.properties.governmentPlanApplied = true;
                    feature.properties.government_plan_applied = true;
                    feature.properties.governmentPlanAppliedHash = govtPlanAppliedValue;
                    feature.properties.government_plan_applied_hash = govtPlanAppliedValue;
                }
                if (!featuresMap.has(parcelId)) {
                    featuresMap.set(parcelId, feature);
                }
                processedFeatureCount += 1;
                if (processedFeatureCount % 200 === 0) {
                    await yieldToMainThread();
                }
            }
        }

        // Only add modified parcels from localStorage (not ALL parcels)
        // These are parcels that have been split or edited and aren't in the server data
        let addedFromPersistentStorage = 0;
        for (const parcelId of modifiedParcelSet) {
            if (!featuresMap.has(parcelId) && !existingParcelIds.has(parcelId)) {
                const geometryStr = PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
                const propertiesStr = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
                if (geometryStr && propertiesStr) {
                    try {
                        const geometry = JSON.parse(geometryStr);
                        const properties = JSON.parse(propertiesStr);
                        if (!properties.calculatedArea) {
                            properties.calculatedArea = calculateArea([geometry]);
                        }
                        const govtPlanAppliedValue = PersistentStorage.getItem(`parcel_${parcelId}_government_plan_applied`);
                        if (govtPlanAppliedValue) {
                            properties.governmentPlanApplied = true;
                            properties.government_plan_applied = true;
                            properties.governmentPlanAppliedHash = govtPlanAppliedValue;
                            properties.government_plan_applied_hash = govtPlanAppliedValue;
                        }
                        const newFeature = {
                            type: 'Feature',
                            properties: properties,
                            geometry: {
                                type: 'Polygon',
                                coordinates: [geometry]
                            }
                        };
                        featuresMap.set(parcelId, newFeature);
                        addedFromPersistentStorage++;
                    } catch (e) { console.error(`Error reconstructing feature ${parcelId} from PersistentStorage:`, e); }
                }
            }
        }
        // Convert only NEW features from HTRS96 to WGS84
        const newFeatures = Array.from(featuresMap.values());
        const convertedFeatures = [];
        const conversionChunkSize = 200;

        if (newFeatures.length > 0) {
            for (let start = 0; start < newFeatures.length; start += conversionChunkSize) {
                const chunk = newFeatures.slice(start, start + conversionChunkSize);
                const convertedChunk = convertGeoJSON({
                    type: 'FeatureCollection',
                    features: chunk
                });
                if (convertedChunk && Array.isArray(convertedChunk.features)) {
                    convertedFeatures.push(...convertedChunk.features);
                }
                await yieldToMainThread();
            }
        }

        // For the parcelDataLoaded event, we need all features (existing + new)
        // But we only need to process/render the new ones
        const allFeatures = [];

        // Add existing features from parcelLayer
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                if (layer.feature) {
                    allFeatures.push(layer.feature);
                }
            });
        }

        // Add newly converted features
        allFeatures.push(...convertedFeatures);

        const convertedData = {
            type: 'FeatureCollection',
            features: allFeatures
        };

        const newConvertedFeatures = convertedFeatures; // All converted features are new
        if (!parcelLayer) {
            parcelLayer = L.featureGroup().addTo(map);
            window.parcelLayer = parcelLayer; // Update global reference
        }

        await yieldToMainThread();
        recomputeParcelsWithAppliedSpatialProposals();

        const styleFeature = (feature) => {
            const parcelId = feature.properties.CESTICA_ID;
            const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            return getParcelBaseStyle(parcelId, { isRoad });
        };
        const attachParcelEvents = function (feature, layer) {
            layer.on({
                mouseover: highlightFeature,
                mouseout: resetHighlight,
                click: onParcelClick
            });
        };

        // Add new parcels to the map FIRST (convertedFeatures only contains NEW parcels)
        const featureAddChunkSize = 150;
        for (let start = 0; start < convertedFeatures.length; start += featureAddChunkSize) {
            const chunk = convertedFeatures.slice(start, start + featureAddChunkSize);

            if (chunk.length > 0) {
                L.geoJSON({
                    type: 'FeatureCollection',
                    features: chunk
                }, {
                    style: styleFeature,
                    onEachFeature: attachParcelEvents
                }).eachLayer(layer => {
                    parcelLayer.addLayer(layer);
                    indexParcelLayer(layer);
                    const parcelId = layer.feature.properties.CESTICA_ID;
                    const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    if (isRoad) {
                        const roadName = PersistentStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';
                        layer.bindTooltip(roadName, {
                            permanent: false,
                            direction: 'center',
                            className: 'road-name-tooltip'
                        });
                        layer.feature.properties.isRoad = true;
                        layer.feature.properties.roadName = roadName;
                        layer.feature.properties.roadId = PersistentStorage.getItem(`parcel_${parcelId}_roadId`) || '';
                        layer.feature.properties.roadConfidence =
                            PersistentStorage.getItem(`parcel_${parcelId}_roadConfidence`) || '0';
                    }
                });
            }
            await yieldToMainThread();
        }

        // Don't remove parcels from the map - just keep adding new ones
        // This prevents issues with:
        // 1. Parent parcels being removed before proposals can apply
        // 2. Parcels disappearing when panning
        // 3. Complex parent-child relationship tracking
        // The user can clear the cache manually if memory becomes an issue

        parcelCoverageVersion += 1;
        try { window.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { }
        try {
            window.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                detail: {
                    version: parcelCoverageVersion,
                    source: 'fetch',
                    timestamp: Date.now()
                }
            }));
        } catch (_) { }
        // Update block info for parcels
        if (typeof blockStorage !== 'undefined' && blockStorage.load) {
            blockStorage.load();
            blockStorage.blocks.forEach((block, blockName) => {
                block.parcels = [];
                parcelLayer.eachLayer(layer => {
                    const parcelId = layer.feature.properties.CESTICA_ID;
                    if (block.parcelIds.includes(parcelId)) {
                        layer.feature.properties.block = blockName;
                        layer.feature.properties.blockValid = block.valid;
                        block.parcels.push(layer);
                    }
                });
            });
        }
        refreshParcelStylesForAppliedProposals();
        updateVisibleParcelsCount();

        const totalOnMap = parcelLayer ? parcelLayer.getLayers().length : 0;
        const newCount = convertedFeatures.length;
        if (newCount > 0) {
            updateStatus(`Added ${newCount} new parcels (${totalOnMap} total in layer)`);
        } else {
            updateStatus(`No new parcels to load (${totalOnMap} parcels visible)`);
        }
        const showParcelsElem = document.getElementById('showParcels');
        const showParcels = showParcelsElem ? showParcelsElem.checked : true;
        if (showParcels) {
            // Add parcels to map without calling showAllParcels() to avoid redundant status messages
            parcelLayer.addTo(map);
            parcelLayer.eachLayer(layer => {
                layer.addTo(map);
            });
        } else {
            hideAllParcels();
        }
        if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked && typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }
        // Trigger a redraw event for listeners that need to refresh overlays after parcels load
        try { window.dispatchEvent(new CustomEvent('parcelBlocksShouldRedraw')); } catch (_) { }

        // Re-apply blue highlighting for selected block parcels (now that more parcels may be present)
        try {
            if (typeof rehighlightSelectedBlockParcels === 'function') {
                rehighlightSelectedBlockParcels();
            }
        } catch (_) { }

        // Notify other modules that parcel data (and parcelLayer) are ready
        setParcelMergeInProgressState(false);
        const newParcelIds = newConvertedFeatures.map(f => String(f.properties.CESTICA_ID));
        window.dispatchEvent(new CustomEvent('parcelDataLoaded', {
            detail: {
                features: Array.isArray(convertedData.features) ? convertedData.features.slice() : [],
                parcelIds: Array.isArray(convertedData.features)
                    ? convertedData.features.map(feature => String(feature.properties.CESTICA_ID))
                    : [],
                newFeatures: newConvertedFeatures,
                newParcelIds: newParcelIds
            }
        }));
        refreshParcelNumberLabelsIfVisible();
        // Note: Visual controllers (proposal mode, single-selection, blocks, etc.) should listen to this event and
        //       update their own layers instead of fetchParcelData trying to do it here.
    } catch (error) {
        console.error('Error fetching data:', error);
        updateStatus('Error fetching data. Please try again.');
    } finally {
        isFetchingParcels = false;
        setParcelMergeInProgressState(false);
    }
}

async function refreshParcelDataWithBusyState(customBounds) {
    const button = document.getElementById('refreshParcelDataButton');
    const task = () => fetchParcelData(customBounds);
    if (button && typeof runWithButtonBusyState === 'function') {
        return runWithButtonBusyState(button, 'Refreshing...', task);
    }
    return task();
}

async function clearLocalParcelData() {
    updateStatus('Clearing local parcel data...');
    let count = 0;
    const keysToDelete = [];
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key === 'cadastre_blocks') {
            continue;
        }
        if (key.startsWith('parcel_') ||
            key.startsWith('road_') ||
            key.includes('_geometry') ||
            key.includes('_properties') ||
            key.includes('_isRoad') ||
            key.includes('_roadName') ||
            key.includes('_split_')) {
            keysToDelete.push(key);
            count++;
        }
    }
    keysToDelete.forEach(key => {
        PersistentStorage.removeItem(key);
    });

    PersistentStorage.removeItem('modified_parcels');

    // Final message shown after clearing
    const clearedMessage = `Cleared ${count} parcel-related items from local storage`;

    if (parcelLayer) {
        parcelLayer.clearLayers();
    }
    clearParcelLayerIndex();
    parcelCache.grid.clear();
    parcelCoverageVersion += 1;
    try { window.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { }
    try {
        window.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
            detail: {
                version: parcelCoverageVersion,
                source: 'clear',
                timestamp: Date.now()
            }
        }));
    } catch (_) { }
    clearParcelNumberLabels();
    currentParcel = null;
    selectedParcelId = null;
    hideParcelInfoPanel();
    if (typeof hideBlockInfo === 'function') hideBlockInfo();
    if (typeof hideRoadInfoPanel === 'function') hideRoadInfoPanel();

    // Set the final status message after fetchParcelData has run its course
    updateStatus(clearedMessage);
}

function handleParcelLayerChange(checkbox) {
    const showParcelsCheckbox = document.getElementById('showParcels');
    const showRoadParcelsCheckbox = document.getElementById('showRoadParcels');
    if (checkbox.id === 'showParcels' && checkbox.checked) {
        showRoadParcelsCheckbox.checked = false;
    } else if (checkbox.id === 'showRoadParcels' && checkbox.checked) {
        showParcelsCheckbox.checked = false;
    }
    if (showParcelsCheckbox.checked) {
        showAllParcels();
    } else if (showRoadParcelsCheckbox.checked) {
        showOnlyRoadParcels();
    } else {
        hideAllParcels();
    }
}

// Parcel locating functionality
// Assumes parcelLayer and selectParcel are globally available
document.addEventListener('DOMContentLoaded', function () {
    const locateInput = document.getElementById('locateParcelInput');
    const locateButton = document.getElementById('locateParcelButton');
    const locateError = document.getElementById('locateParcelError');

    if (!locateInput || !locateButton || !locateError) {
        // UI elements not present
        return;
    }

    function locateParcel() {
        const value = locateInput.value.trim();
        locateError.textContent = '';
        if (!value) return;

        // Ensure the 'Show parcel numbers' checkbox is checked
        const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');
        if (showParcelNumbersCheckbox && !showParcelNumbersCheckbox.checked) {
            showParcelNumbersCheckbox.checked = true;
            if (typeof toggleParcelNumbers === 'function') {
                toggleParcelNumbers();
            }
        }

        if (typeof parcelLayer === 'undefined' || !parcelLayer) {
            locateError.textContent = 'Parcel data not loaded';
            return;
        }

        // Find the layer with the matching parcel number (BROJ_CESTICE)
        const foundLayer = parcelLayer.getLayers().find(layer =>
            layer.feature &&
            layer.feature.properties &&
            layer.feature.properties.BROJ_CESTICE &&
            layer.feature.properties.BROJ_CESTICE.toString() === value
        );

        if (foundLayer) {
            if (typeof selectParcel === 'function') {
                selectParcel(foundLayer.feature.properties.CESTICA_ID);
            }
            locateError.textContent = '';
        } else {
            locateError.textContent = 'Parcel not found';
        }
    }

    locateButton.addEventListener('click', locateParcel);
    locateInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            locateParcel();
        }
    });
});

// Add road checkbox event listener
document.getElementById('roadCheckbox').addEventListener('change', function (e) {
    if (currentParcel) {
        const wasRoad = currentParcel.isRoad;
        currentParcel.isRoad = e.target.checked;

        // Check if this parcel is part of multi-selection
        const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
            multiParcelSelection.isActive &&
            multiParcelSelection.selectedParcels.has(currentParcel.id.toString());

        // Only update appearance if not part of multi-selection
        if (!isMultiSelected) {
            currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: e.target.checked }));
        }
        // If it's multi-selected, keep the multi-selection highlighting

        // Store the road status in PersistentStorage
        PersistentStorage.setItem(`parcel_${currentParcel.id}_isRoad`, e.target.checked);

        // Update TOTAL_SPENT based on the parcel's market price
        const area = currentParcel.layer.feature.properties.calculatedArea || 0;
        const parcelPrice = area * SQM_AVG_PRICE;

        if (e.target.checked && !wasRoad) {
            // Parcel was marked as road - add to total
            TOTAL_SPENT += parcelPrice;
        } else if (!e.target.checked && wasRoad) {
            // Parcel was unmarked as road - subtract from total
            TOTAL_SPENT -= parcelPrice;
        }

        // Update the display
        updateTotalSpentDisplay();

        try {
            window.dispatchEvent(new CustomEvent('parcelRoadStatusChanged', {
                detail: {
                    parcelId: currentParcel.id,
                    cesticaId: currentParcel.layer?.feature?.properties?.CESTICA_ID,
                    isRoad: e.target.checked
                }
            }));
        } catch (_) { }
    }
});

// --- Expose to window for HTML/other JS ---
window.fetchParcelData = fetchParcelData;
window.refreshParcelDataWithBusyState = refreshParcelDataWithBusyState;
window.selectParcel = selectParcel;
window.showAllParcels = showAllParcels;
window.showOnlyRoadParcels = showOnlyRoadParcels;
window.hideAllParcels = hideAllParcels;
window.toggleParcelNumbers = toggleParcelNumbers;
window.clearLocalParcelData = clearLocalParcelData;
window.handleParcelLayerChange = handleParcelLayerChange;
window.isRoad = isRoad;
window.onEachFeature = onEachFeature;
window.showParcelInfoPanel = showParcelInfoPanel;
window.hideParcelInfoPanel = hideParcelInfoPanel;
window.updateVisibleParcelsCount = updateVisibleParcelsCount;
window.clearParcelNumberLabels = clearParcelNumberLabels;
window.refreshParcelNumberLabelsIfVisible = refreshParcelNumberLabelsIfVisible;
window.setParcelNumberLabelFilter = setParcelNumberLabelFilter;
window.getRequiredGridCells = getRequiredGridCells;
window.parcelLayer = parcelLayer;
window.parcelsTimeout = parcelsTimeout;
window.roadStyle = roadStyle;
window.normalStyle = normalStyle;
window.recomputeParcelsWithAppliedSpatialProposals = recomputeParcelsWithAppliedSpatialProposals;
window.refreshParcelStylesForAppliedProposals = refreshParcelStylesForAppliedProposals;
window.parcelHasAppliedSpatialProposal = parcelHasAppliedSpatialProposal;
window.indexParcelLayer = indexParcelLayer;
window.unindexParcelLayer = unindexParcelLayer;
window.clearParcelLayerIndex = clearParcelLayerIndex;
window.getParcelLayersWithinBounds = getParcelLayersWithinBounds;

function refreshAllMapLayers() {
    // Update block info for parcels
    if (typeof blockStorage !== 'undefined' && typeof parcelLayer !== 'undefined' && parcelLayer && blockStorage.load) {
        blockStorage.load();
        blockStorage.blocks.forEach((block, blockName) => {
            block.parcels = [];
            parcelLayer.eachLayer(layer => {
                const parcelId = layer.feature.properties.CESTICA_ID;
                if (block.parcelIds.includes(parcelId)) {
                    layer.feature.properties.block = blockName;
                    layer.feature.properties.blockValid = block.valid;
                    block.parcels.push(layer);
                }
            });
        });
    }

    if (typeof refreshParcelStylesForAppliedProposals === 'function') {
        refreshParcelStylesForAppliedProposals();
    }

    const showParcelsElem = document.getElementById('showParcels');
    const showParcels = showParcelsElem ? showParcelsElem.checked : true;
    if (showParcels) {
        if (parcelLayer) {
            parcelLayer.addTo(map);
            parcelLayer.eachLayer(layer => {
                layer.addTo(map);
            });
        }
    } else {
        if (typeof hideAllParcels === 'function') {
            hideAllParcels();
        }
    }

    if (typeof updateVisibleParcelsCount === 'function') {
        updateVisibleParcelsCount();
    }
    if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked && typeof updateBlockLayer === 'function') {
        updateBlockLayer();
    }
    // Trigger a redraw event for listeners that need to refresh overlays after parcels load
    try { window.dispatchEvent(new CustomEvent('parcelBlocksShouldRedraw')); } catch (_) { }

    // Re-apply blue highlighting for selected block parcels (now that more parcels may be present)
    try {
        if (typeof rehighlightSelectedBlockParcels === 'function') {
            rehighlightSelectedBlockParcels();
        }
    } catch (_) { }

    if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
        refreshParcelNumberLabelsIfVisible();
    }
}

function setupMap() {
    // ... Map initialization ...

    // Define the click handler here, where it has access to map-related scope
    // if it needs it. This also makes it the definitive "original" handler.
    window.onParcelClick = function onParcelClick(e) {
        const parcelId = e.target.feature.properties.CESTICA_ID.toString();

        // Handle multi-parcel selection if active
        if (multiParcelSelection.isActive) {
            if (multiParcelSelection.toggleParcel(e.target)) {
                return; // Stop further processing if multi-selection handled it
            }
        }

        // Standard single-parcel selection logic
        if (selectedParcelId === parcelId) {
            // Deselect if clicking the same parcel again
            if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
            if (currentParcel) {
                // Check if this parcel is part of multi-selection before resetting style
                const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                    multiParcelSelection.isActive &&
                    multiParcelSelection.selectedParcels.has(currentParcel.id.toString());
                if (!isMultiSelected) {
                    // Preserve block highlight if part of selected block
                    const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                        ? selectedBlockName
                        : (typeof window !== 'undefined' ? window.selectedBlockName : null);
                    const layerBlockName = currentParcel.layer?.feature?.properties?.block;
                    if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                        currentParcel.layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                    } else {
                        currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: currentParcel.isRoad }));
                    }
                }
            }
            selectedParcelId = null;
            currentParcel = null;
        } else {
            // Select a new parcel
            if (currentParcel) {
                // Check if the previous parcel is part of multi-selection before resetting style
                const isPrevMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                    multiParcelSelection.isActive &&
                    multiParcelSelection.selectedParcels.has(currentParcel.id.toString());
                if (!isPrevMultiSelected) {
                    // Preserve block highlight if part of selected block
                    const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                        ? selectedBlockName
                        : (typeof window !== 'undefined' ? window.selectedBlockName : null);
                    const layerBlockName = currentParcel.layer?.feature?.properties?.block;
                    if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                        currentParcel.layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                    } else {
                        currentParcel.layer.setStyle(getParcelBaseStyle(currentParcel.id, { isRoad: currentParcel.isRoad }));
                    }
                }
            }
            selectParcel(e.target);
        }
    };

    // Store the definitive original handler
    if (typeof originalOnParcelClick === 'undefined' || originalOnParcelClick === null) {
        originalOnParcelClick = window.onParcelClick;
    }

    fetchParcels();
    loadBuildings();
    // ... other setup calls ...
}