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

// Make selectedParcelStyle globally available
window.selectedParcelStyle = selectedParcelStyle;

/**
 * Focus on a proposal when clicked from parcel info panel
 * @param {string} proposalHash - The proposal hash to focus on
 */
function focusOnProposal(proposalHash) {
    // Enable show proposals mode and clear multi-selection
    if (typeof enableShowProposalsMode === 'function') {
        enableShowProposalsMode();
    } else {
        // Fallback if helper function not available
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
            showProposalsCheckbox.checked = true;
            // Trigger the change event to update the proposal layer
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
        }
    }

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

    // 2. Enable show proposals mode and clear multi-selection
    if (typeof enableShowProposalsMode === 'function') {
        enableShowProposalsMode();
    } else {
        // Fallback if helper function not available
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
            showProposalsCheckbox.checked = true;
            // Trigger the change event to update the proposal layer
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
        }
    }

    // 3. Select the proposal and show its details immediately
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
const parcelCache = {
    grid: new Map(),  // Key: "easting,northing" grid cell, Value: { data: [] }
    gridSize: 500     // Size in meters (HTRS96/TM coordinates)
};
let isFetchingParcels = false;

// --- Helper Functions ---
function isRoad(parcelId) {
    return localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
}

function getGridKey(easting, northing) {
    const gridEasting = Math.floor(easting / parcelCache.gridSize);
    const gridNorthing = Math.floor(northing / parcelCache.gridSize);
    return `${gridEasting},${gridNorthing}`;
}

function getRequiredGridCells(bounds) {
    const cells = new Set();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const [swEasting, swNorthing] = wgs84ToHTRS96(sw.lat, sw.lng);
    const [neEasting, neNorthing] = wgs84ToHTRS96(ne.lat, ne.lng);
    const startEastingGrid = Math.floor(swEasting / parcelCache.gridSize);
    const endEastingGrid = Math.ceil(neEasting / parcelCache.gridSize);
    const startNorthingGrid = Math.floor(swNorthing / parcelCache.gridSize);
    const endNorthingGrid = Math.ceil(neNorthing / parcelCache.gridSize);
    for (let eastingGrid = startEastingGrid; eastingGrid <= endEastingGrid; eastingGrid++) {
        for (let northingGrid = startNorthingGrid; northingGrid <= endNorthingGrid; northingGrid++) {
            cells.add(`${eastingGrid},${northingGrid}`);
        }
    }
    return cells;
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

function convertGeoJSON(geojson) {
    const converted = JSON.parse(JSON.stringify(geojson));
    converted.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
            // Normalize to an array of polygons (each polygon is an array of linear rings)
            const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            polygons.forEach((polyCoords) => {
                if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;

                // Determine if this polygon is HTRS based on its exterior ring
                const exterior = polyCoords[0];
                if (!Array.isArray(exterior) || exterior.length === 0) return;
                const looksLikeHTRS = Math.abs(exterior[0][0]) > 1000 || Math.abs(exterior[0][1]) > 1000;

                if (looksLikeHTRS) {
                    // Calculate area once per polygon (outer ring only) if not set
                    if (feature.properties.calculatedArea === undefined) {
                        try {
                            const areaSum = polygons.reduce((sum, p) => sum + calculateArea([p[0]]), 0);
                            feature.properties.calculatedArea = areaSum;
                        } catch (e) {
                            feature.properties.calculatedArea = 0;
                        }
                    }

                    // Convert ALL rings in this polygon from HTRS to WGS84
                    for (let r = 0; r < polyCoords.length; r++) {
                        const ring = polyCoords[r];
                        if (!Array.isArray(ring) || ring.length === 0) continue;
                        polyCoords[r] = ring.map(coord => {
                            const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
                            return [lon, lat];
                        });
                    }
                } else {
                    // Already in WGS84 – compute area (outer ring only) in HTRS96 for accuracy if not set
                    if (feature.properties.calculatedArea === undefined) {
                        try {
                            const htrsCoords = exterior.map(coord => wgs84ToHTRS96(coord[1], coord[0]));
                            const area = calculateArea([htrsCoords]);
                            if (feature.geometry.type === 'MultiPolygon') {
                                feature.properties.calculatedArea = (feature.properties.calculatedArea || 0) + area;
                            } else {
                                feature.properties.calculatedArea = area;
                            }
                        } catch (e) {
                            feature.properties.calculatedArea = 0;
                        }
                    }
                }
            });
        }
    });
    return converted;
}

// --- Parcel Layer Management ---
function showAllParcels() {
    if (parcelLayer) {
        parcelLayer.addTo(map);
        parcelLayer.eachLayer(layer => {
            layer.addTo(map);
        });
        updateStatus("Showing all parcels");
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
        const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
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
    if (!parcelLayer) return;
    const bounds = map.getBounds();
    const visibleParcels = parcelLayer.getLayers().filter(layer => {
        const layerBounds = layer.getBounds();
        return bounds.intersects(layerBounds);
    });
    document.getElementById('parcels-in-view').textContent = `Parcels in map view: ${visibleParcels.length}`;
}

// --- Parcel Info and Interaction ---
function findSmallestParcelAtLatLng(latlng) {
    if (!parcelLayer || !latlng) return null;
    const point = turf.point([latlng.lng, latlng.lat]);
    let bestLayer = null;
    let bestArea = Infinity;
    try {
        const layers = parcelLayer.getLayers();
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            if (!layer || !layer.feature || !layer.feature.geometry) continue;
            try {
                if (typeof layer.getBounds === 'function') {
                    const b = layer.getBounds();
                    if (b && b.isValid && b.isValid() && !b.contains(latlng)) continue;
                }
            } catch (_) { }
            try {
                if (turf.booleanPointInPolygon(point, layer.feature)) {
                    const a = layer.feature.properties && isFinite(layer.feature.properties.calculatedArea)
                        ? Number(layer.feature.properties.calculatedArea)
                        : turf.area(layer.feature);
                    if (a < bestArea) { bestArea = a; bestLayer = layer; }
                }
            } catch (_) { }
        }
    } catch (_) { }
    return bestLayer;
}

function onParcelClick(e) {
    if (window.measureMode) return;
    const clickedLatLng = e && e.latlng ? e.latlng : null;
    const smallestLayer = findSmallestParcelAtLatLng(clickedLatLng);
    const targetLayer = smallestLayer || e.target;
    const feature = targetLayer.feature;
    const isRoad = localStorage.getItem(`parcel_${feature.properties.CESTICA_ID}_isRoad`) === 'true';

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
    const currentIsRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
    document.getElementById('roadCheckbox').checked = currentIsRoad;

    // Reset all parcels to normal style first
    if (selectedParcelId && parcelLayer) {
        parcelLayer.eachLayer(l => {
            if (l.feature && l.feature.properties) {
                const pId = l.feature.properties.CESTICA_ID;
                if (pId && pId.toString() !== parcelId.toString()) {
                    // Check if this parcel is part of multi-selection before resetting style
                    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                        multiParcelSelection.isActive &&
                        multiParcelSelection.selectedParcels.has(pId.toString());
                    if (!isMultiSelected) {
                        const pIsRoad = localStorage.getItem(`parcel_${pId}_isRoad`) === 'true';
                        l.setStyle(pIsRoad ? roadStyle : normalStyle);
                    }
                }
            }
        });
    }

    // Set the selected parcel style
    selectedParcelId = parcelId.toString();
    targetLayer.setStyle(selectedParcelStyle);
    targetLayer.bringToFront();

    const blockName = feature.properties.block;
    if (blockName && document.getElementById('parcelBlocksCheckbox').checked) {
        highlightAndCenterBlock(blockName);
    }

    currentParcel = {
        id: parcelId,
        layer: targetLayer,
        isRoad: currentIsRoad
    };

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
}

function highlightFeature(e) {
    const layer = e.target;
    const parcelId = layer.feature.properties.CESTICA_ID.toString();
    // Skip highlight if parcel is part of currently highlighted proposal
    if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.parcelIds.includes(parcelId)) {
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
    // Do not reset the style of the currently selected parcel (normal)
    if (parcelId === selectedParcelId) {
        return;
    }
    // Keep selected block parcels highlighted in blue
    try {
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
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
    // Keep selected block parcels highlighted in blue
    try {
        const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        const layerBlockName = layer?.feature?.properties?.block;
        if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
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

    // Proposal-aware: restore gold border if this is the selected proposal parcel
    if (parcelId === window.selectedParcelInProposal) {
        // Use the same color logic as applyProposalHighlights
        const proposals = proposalStorage.getProposalsForParcel(parcelId);
        const colors = proposals.map(p => getProposalColor(p.proposalHash));
        const fillColor = blendColors(colors);
        const fillOpacity = Math.max(0.25, 0.5 - 0.1 * (proposals.length - 1));
        layer.setStyle({
            fillColor,
            fillOpacity,
            color: 'gold',
            weight: 5,
            dashArray: ''
        });
        return;
    }
    // Proposal-aware: restore proposal highlight if needed
    const showProposals = document.getElementById('showProposalsCheckbox')?.checked;
    if (showProposals && typeof proposalStorage !== 'undefined') {
        // Only consider non-executed proposals
        const proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
        if (proposals.length > 0) {
            // Use the same color logic as updateProposalLayer
            const colors = proposals.map(p => getProposalColor(p.proposalHash));
            const fillColor = blendColors(colors);
            const fillOpacity = Math.max(0.25, 0.5 - 0.1 * (proposals.length - 1));
            layer.setStyle({
                fillColor,
                fillOpacity,
                color: '#222',
                weight: 3,
                dashArray: '5, 5',
            });
            return;
        }
    }
    // Otherwise, reset to its original style (road or normal)
    // But check if this parcel is part of multi-selection first
    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
        multiParcelSelection.isActive &&
        multiParcelSelection.selectedParcels.has(parcelId);

    if (isMultiSelected) {
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
            if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
            } else {
                layer.setStyle(isRoad(parcelId) ? roadStyle : normalStyle);
            }
        } catch (_) {
            layer.setStyle(isRoad(parcelId) ? roadStyle : normalStyle);
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
        map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const layerParcelId = layer.feature.properties.CESTICA_ID.toString();
                const isRoad = localStorage.getItem(`parcel_${layerParcelId}_isRoad`) === 'true';
                if (layerParcelId !== parcelId.toString()) {
                    // Check if this parcel is part of multi-selection before resetting style
                    const isMultiSelected = typeof multiParcelSelection !== 'undefined' &&
                        multiParcelSelection.isActive &&
                        multiParcelSelection.selectedParcels.has(layerParcelId);
                    if (!isMultiSelected) {
                        layer.setStyle(isRoad ? roadStyle : normalStyle);
                    }
                }
            }
        });
        selectedLayer.setStyle(selectedParcelStyle);
        selectedLayer.bringToFront();
        currentParcel = {
            id: parcelId,
            layer: selectedLayer,
            isRoad: localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
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
    const ownerId = localStorage.getItem(`parcel_${parcelId}_owner`);
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
    if (typeof proposalStorage !== 'undefined') {
        const proposals = proposalStorage.getProposalsForParcel(parcelId.toString());
        if (proposals && proposals.length > 0) {
            const proposalItems = proposals.map(proposal => {
                const statusText = proposal.status || 'Active';
                const statusClass = proposal.status === 'Executed' ? 'executed' :
                    proposal.status === 'Rejected' ? 'rejected' : 'active';

                // Check if current parcel has accepted this proposal
                const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

                // Check if proposal is still active (not executed)
                const isActive = proposal.status !== 'Executed';

                // Generate action buttons based on acceptance status and proposal state
                let actionButtons = '';
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

                return `
                    <div class="proposal-item" onclick="showProposalDetails('${proposal.proposalHash}', '${parcelId}')" style="cursor: pointer;">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title">${proposal.title || proposal.type || 'Proposal'}</span>
                            <span class="proposal-item-status ${statusClass}">${statusText}</span>
                        </div>
                        <div class="proposal-item-details">
                            ID: ${proposal.proposalHash.substring(0, 8)}
                        </div>
                        <div class="proposal-item-details">
                            Author: ${proposal.author || proposal.username || 'Unknown'}
                        </div>
                        ${proposal.budget ? `<div class="proposal-item-details">Budget: ${proposal.budget} ETH</div>` : ''}
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
            <div class="metric-label">Proposals (${typeof proposalStorage !== 'undefined' ? proposalStorage.getProposalsForParcel(parcelId.toString()).length : 0}):</div>
            <div class="metric-value">${proposalsHtml}</div>
        </div>
    `;

    // Update the title to include parcel number
    const titleElement = document.getElementById('parcel-info-title');
    if (titleElement) {
        titleElement.textContent = `Parcel Info (${feature.properties.BROJ_CESTICE})`;
    }

    // Update the Proposals tab title with count
    const proposalCount = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposalsForParcel(parcelId.toString()).length : 0;
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
    document.getElementById('parcel-info-panel').classList.remove('visible');
    clearRoadVisualization();
    selectedParcelId = null;

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
function toggleParcelNumbers() {
    const show = document.getElementById('showParcelNumbers').checked;
    clearParcelNumberLabels();
    if (show && parcelLayer) {
        parcelLayer.eachLayer(layer => {
            if (!layer.feature || !layer.feature.properties) return;
            const brojCestice = layer.feature.properties.BROJ_CESTICE;
            if (!brojCestice) return;
            const coords = layer.feature.geometry.coordinates && layer.feature.geometry.coordinates[0];
            if (!coords || coords.length === 0) return;
            let latSum = 0, lngSum = 0;
            coords.forEach(coord => {
                if (!Array.isArray(coord) || coord.length < 2) return;
                lngSum += coord[0];
                latSum += coord[1];
            });
            const n = coords.length;
            if (n === 0) return;
            const centroid = [latSum / n, lngSum / n];
            if (!isFinite(centroid[0]) || !isFinite(centroid[1])) return;
            const label = L.marker([centroid[0], centroid[1]], {
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
}
function clearParcelNumberLabels() {
    parcelNumberLabels.forEach(label => map.removeLayer(label));
    parcelNumberLabels = [];
}

// --- Parcel Data Fetching and Management ---
async function fetchParcelData() {
    if (isFetchingParcels) {
        updateStatus("Already fetching parcel data...");
        return;
    }
    isFetchingParcels = true;
    const status = document.getElementById('status');
    updateStatus('Fetching data...');
    try {
        const bounds = map.getBounds();
        const requiredCells = getRequiredGridCells(bounds);
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
                const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
                const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
                const url = `${baseUrl}?${new URLSearchParams({
                    token: token,
                    service: 'WFS',
                    version: '1.0.0',
                    request: 'GetFeature',
                    maxFeatures: '2000',
                    outputFormat: 'json',
                    typeName: 'oss:DKP_CESTICE',
                    srsName: 'EPSG:3765',
                    bbox: bbox
                }).toString()}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch parcel data');
                const data = await response.json();
                parcelCache.grid.set(cell, data);
                completedCells++;
                updateStatus(`Fetching data for ${totalCells} new grid cells (${completedCells}/${totalCells})...`);
            });
            await Promise.all(fetchPromises);
        }
        // Merge and process features
        const featuresMap = new Map();
        const serverParcelIds = new Set();
        let storedGeometryCount = 0;
        let storedPropertiesCount = 0;
        for (const cell of requiredCells) {
            const cellData = parcelCache.grid.get(cell);
            if (cellData && cellData.features) {
                cellData.features.forEach(feature => {
                    const parcelId = String(feature.properties.CESTICA_ID);
                    serverParcelIds.add(parcelId);
                    const storedGeometryStr = localStorage.getItem(`parcel_${parcelId}_geometry`);
                    const storedPropertiesStr = localStorage.getItem(`parcel_${parcelId}_properties`);
                    if (storedGeometryStr) {
                        try {
                            const storedGeometry = JSON.parse(storedGeometryStr);
                            feature.geometry.coordinates[0] = storedGeometry;
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
                    if (!featuresMap.has(parcelId)) {
                        featuresMap.set(parcelId, feature);
                    }
                });
            }
        }
        // Add features from localStorage only
        let addedFromLocalStorage = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('parcel_') && key.endsWith('_geometry')) {
                const parcelId = key.substring('parcel_'.length, key.length - '_geometry'.length);
                if (!featuresMap.has(parcelId)) {
                    const geometryStr = localStorage.getItem(key);
                    const propertiesStr = localStorage.getItem(`parcel_${parcelId}_properties`);
                    if (geometryStr && propertiesStr) {
                        try {
                            const geometry = JSON.parse(geometryStr);
                            const properties = JSON.parse(propertiesStr);
                            if (!properties.calculatedArea) {
                                properties.calculatedArea = calculateArea([geometry]);
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
                            addedFromLocalStorage++;
                        } catch (e) { console.error(`Error reconstructing feature ${parcelId} from localStorage:`, e); }
                    }
                }
            }
        }
        const allFeatures = Array.from(featuresMap.values());
        const convertedData = convertGeoJSON({
            type: 'FeatureCollection',
            features: allFeatures
        });
        if (parcelLayer) {
            parcelLayer.clearLayers();
        } else {
            parcelLayer = L.featureGroup().addTo(map);
        }
        L.geoJSON(convertedData, {
            style: (feature) => {
                const parcelId = feature.properties.CESTICA_ID;
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                return isRoad ? roadStyle : normalStyle;
            },
            onEachFeature: function (feature, layer) {
                layer.on({
                    mouseover: highlightFeature,
                    mouseout: resetHighlight,
                    click: onParcelClick
                });
            }
        }).eachLayer(layer => {
            parcelLayer.addLayer(layer);
            const parcelId = layer.feature.properties.CESTICA_ID;
            const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            if (isRoad) {
                const roadName = localStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';
                layer.bindTooltip(roadName, {
                    permanent: false,
                    direction: 'center',
                    className: 'road-name-tooltip'
                });
                layer.feature.properties.isRoad = true;
                layer.feature.properties.roadName = roadName;
                layer.feature.properties.roadId = localStorage.getItem(`parcel_${parcelId}_roadId`) || '';
                layer.feature.properties.roadConfidence =
                    localStorage.getItem(`parcel_${parcelId}_roadConfidence`) || '0';
            }
        });
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
        updateVisibleParcelsCount();
        updateStatus(`Loaded ${allFeatures.length} parcels from ${requiredCells.size} grid cells`);
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
        window.dispatchEvent(new CustomEvent('parcelDataLoaded'));
        // Note: Visual controllers (proposal mode, single-selection, blocks, etc.) should listen to this event and
        //       update their own layers instead of fetchParcelData trying to do it here.
    } catch (error) {
        console.error('Error fetching data:', error);
        updateStatus('Error fetching data. Please try again.');
    } finally {
        isFetchingParcels = false;
    }
}

async function clearLocalParcelData() {
    const status = document.getElementById('status');
    updateStatus('Clearing local parcel data...');
    let count = 0;
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
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
        localStorage.removeItem(key);
    });

    // Store the count message before calling fetchParcelData
    const clearedMessage = `Cleared ${count} parcel-related items from local storage`;

    await fetchParcelData();

    if (parcelLayer) {
        parcelLayer.clearLayers();
    }
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
            currentParcel.layer.setStyle(e.target.checked ? roadStyle : normalStyle);
        }
        // If it's multi-selected, keep the multi-selection highlighting

        // Store the road status in localStorage
        localStorage.setItem(`parcel_${currentParcel.id}_isRoad`, e.target.checked);

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
    }
});

// --- Expose to window for HTML/other JS ---
window.fetchParcelData = fetchParcelData;
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
window.getRequiredGridCells = getRequiredGridCells;
window.parcelLayer = parcelLayer;
window.parcelsTimeout = parcelsTimeout;
window.roadStyle = roadStyle;
window.normalStyle = normalStyle;

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
                        currentParcel.layer.setStyle(currentParcel.isRoad ? roadStyle : normalStyle);
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
                        currentParcel.layer.setStyle(currentParcel.isRoad ? roadStyle : normalStyle);
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