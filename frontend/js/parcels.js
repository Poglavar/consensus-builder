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
    opacity: 1
};

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

function convertGeoJSON(geojson) {
    const converted = JSON.parse(JSON.stringify(geojson));
    converted.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates && feature.geometry.type === 'Polygon') {
            const currentCoords = feature.geometry.coordinates[0];
            const looksLikeHTRS = currentCoords.length > 0 && Math.abs(currentCoords[0][0]) > 1000;
            if (looksLikeHTRS) {
                if (feature.properties.calculatedArea === undefined) {
                    feature.properties.calculatedArea = calculateArea([currentCoords]);
                }
                feature.geometry.coordinates[0] = currentCoords.map(coord => {
                    const [lat, lon] = htrs96ToWGS84(coord[0], coord[1]);
                    return [lon, lat];
                });
            } else {
                if (feature.properties.calculatedArea === undefined) {
                    try {
                        const htrsCoords = currentCoords.map(coord => wgs84ToHTRS96(coord[1], coord[0]));
                        feature.properties.calculatedArea = calculateArea([htrsCoords]);
                    } catch (e) {
                        feature.properties.calculatedArea = 0;
                    }
                }
            }
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
    } else {
        fetchParcelData();
    }
    updateStatus("Showing all parcels");
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
function onParcelClick(e) {
    if (window.measureMode) return;
    const feature = e.target.feature;
    const isRoad = localStorage.getItem(`parcel_${feature.properties.CESTICA_ID}_isRoad`) === 'true';

    // Check if multi-selection is active and handle it
    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.isActive) {
        const wasToggled = multiParcelSelection.toggleParcel(e.target);
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
            showParcelInfoPanel(splitFeatures[0], calculateRoadMetrics(splitFeatures[0].geometry.coordinates));
            return;
        }
    }
    const metrics = calculateRoadMetrics(feature.geometry.coordinates);
    showParcelInfoPanel(feature, metrics);
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
                    const pIsRoad = localStorage.getItem(`parcel_${pId}_isRoad`) === 'true';
                    l.setStyle(pIsRoad ? roadStyle : normalStyle);
                }
            }
        });
    }

    // Set the selected parcel style
    selectedParcelId = parcelId.toString();
    e.target.setStyle(selectedParcelStyle);
    e.target.bringToFront();

    const blockName = feature.properties.block;
    if (blockName && document.getElementById('parcelBlocksCheckbox').checked) {
        highlightBlock(blockName);
    }

    currentParcel = {
        id: parcelId,
        layer: e.target,
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

function onEachFeature(feature, layer) {
    if (feature.properties) {
        layer.on('click', onParcelClick);
    }
}

function showParcelInfo(parcelId) {
    const selectedLayer = parcelLayer.getLayers().find(layer => {
        return layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID === parcelId;
    });
    if (selectedLayer) {
        selectedParcelId = parcelId.toString();
        map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const isRoad = localStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                if (layer.feature.properties.CESTICA_ID !== parcelId) {
                    layer.setStyle(isRoad ? roadStyle : normalStyle);
                }
            } else {
                console.warn('Layer in parcelLayer loop (showParcelInfo) lacks feature or properties:', layer);
            }
        });
        selectedLayer.setStyle(selectedParcelStyle);
        selectedLayer.bringToFront();
        currentParcel = {
            id: parcelId,
            layer: selectedLayer,
            isRoad: localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
        };
        showParcelInfoPanel(selectedLayer.feature);
        document.getElementById('roadCheckbox').checked = currentParcel.isRoad;
        document.getElementById('parcel-info-panel').classList.add('visible');
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

function showParcelInfoPanel(feature, metrics) {
    const area = feature.properties.calculatedArea;
    const formattedArea = area ? Math.round(Number(area)).toLocaleString('hr-HR') : 'N/A';
    const estimatedPrice = area ? area * SQM_AVG_PRICE : 0;
    const formattedPrice = estimatedPrice ? estimatedPrice.toLocaleString('hr-HR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }) : 'N/A';
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
    const blockName = feature.properties.block;
    const blockHtml = blockName ?
        `<span class="block-tag" onclick="highlightAndCenterBlock('${blockName}')" style="cursor: pointer; background-color: #007bff; color: white; padding: 2px 8px; border-radius: 12px;">${blockName}</span>` :
        'Not part of a block';
    const content = `
        <div class="metric-group">
            <div class="metric-label">Block:</div>
            <div class="metric-value">${blockHtml}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Parcel Number:</div>
            <div class="metric-value">${feature.properties.BROJ_CESTICE}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Parcel Area:</div>
            <div class="metric-value">${formattedArea} m²</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Est. Market Price:</div>
            <div class="metric-value">${formattedPrice} €</div>
        </div>
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
            <div class="metric-label">As RoadWidth Consistency:</div>
            <div class="metric-value">${formattedTolerance}% within ±10% of average</div>
        </div>
    `;
    document.getElementById('info-content').innerHTML = content;
    document.getElementById('parcel-info-panel').classList.add('visible');
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
            updateStatus(`Fetching data for ${missingCells.size} new grid cells...`);
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
            onEachFeature: onEachFeature
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
        const showParcels = document.getElementById('parcelsCheckbox').checked;
        if (showParcels) {
            showAllParcels();
        } else {
            hideAllParcels();
        }
        if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked && typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }

        // Re-apply proposal highlights if any are active
        if (typeof reapplyProposalHighlights === 'function') {
            reapplyProposalHighlights();
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        updateStatus('Error fetching data. Please try again.');
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
// Assumes parcelLayer and showParcelInfo are globally available
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
            if (typeof showParcelInfo === 'function') {
                showParcelInfo(foundLayer.feature.properties.CESTICA_ID);
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

        // Update the parcel's appearance
        currentParcel.layer.setStyle(e.target.checked ? roadStyle : normalStyle);

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
window.showParcelInfo = showParcelInfo;
window.showAllParcels = showAllParcels;
window.showOnlyRoadParcels = showOnlyRoadParcels;
window.hideAllParcels = hideAllParcels;
window.toggleParcelNumbers = toggleParcelNumbers;
window.clearLocalParcelData = clearLocalParcelData;
window.handleParcelLayerChange = handleParcelLayerChange;
window.isRoad = isRoad;
window.onEachFeature = onEachFeature;
window.onParcelClick = onParcelClick;
window.showParcelInfoPanel = showParcelInfoPanel;
window.hideParcelInfoPanel = hideParcelInfoPanel;
window.updateVisibleParcelsCount = updateVisibleParcelsCount;
window.clearParcelNumberLabels = clearParcelNumberLabels;
window.getRequiredGridCells = getRequiredGridCells;
window.parcelLayer = parcelLayer;
window.roadStyle = roadStyle;
window.normalStyle = normalStyle; 