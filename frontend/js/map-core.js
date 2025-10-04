// Define coordinate systems
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs');
proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

// Global constants
const SQM_AVG_PRICE = 133; // Average price per square meter in EUR
let TOTAL_SPENT = 0; // Total amount spent on roads in EUR

// Global map variables
let buildingLayer = null;
let roadLayer = null;
let blockLayer = null;
let currentCenterline = null;
let currentWidthLines = [];
let timeout = null;
let buildingsTimeout;
let isMapMoving = false;
let parcelFetchZoomMin = null;
let parcelFetchZoomMax = null;

// Initialize the map with specific bounds
const map = L.map('map', {
    zoomControl: false  // Disable default zoom control
}).fitBounds([
    [45.7645, 15.9572], // SW - adjusted to be more zoomed in
    [45.7647, 15.9582]  // NE - adjusted to be more zoomed in
]);

// Zoom control removed - users can zoom with mouse wheel/trackpad

// Add OpenStreetMap layer
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Add scale control
L.control.scale({
    metric: true,
    imperial: false,
    position: 'bottomright'
}).addTo(map);

function isZoomWithinParcelRange() {
    if (parcelFetchZoomMin === null || parcelFetchZoomMax === null) return true;
    const z = map.getZoom();
    return z >= parcelFetchZoomMin && z <= parcelFetchZoomMax;
}

// Convert HTRS96/TM coordinates to WGS84
function htrs96ToWGS84(easting, northing) {
    // Validate inputs to ensure they're finite numbers
    if (!isFinite(easting) || !isFinite(northing)) {
        console.error('Invalid HTRS96/TM coordinates:', easting, northing);
        // Return a default value in Zagreb
        return [45.815, 15.982];
    }

    // Check if coordinates are within valid range for Croatia
    // Croatia HTRS96/TM bounds: approximately [E: 240000-730000, N: 4460000-5160000]
    if (easting < 240000 || easting > 730000 || northing < 4460000 || northing > 5160000) {
        console.warn('HTRS96/TM coordinates outside Croatia bounds:', easting, northing);
        // Return a default value in Zagreb instead of attempting conversion
        return [45.815, 15.982];
    }

    try {
        const [lon, lat] = proj4('EPSG:3765', 'EPSG:4326', [easting, northing]);
        // Check if the result is valid
        if (!isFinite(lat) || !isFinite(lon) ||
            lat < 42 || lat > 47 || // Latitude range for Croatia
            lon < 13 || lon > 20) { // Longitude range for Croatia
            console.error('Invalid conversion result:', lat, lon);
            return [45.815, 15.982]; // Default value in Zagreb
        }
        return [lat, lon];
    } catch (error) {
        console.error('Error in coordinate conversion:', error);
        return [45.815, 15.982]; // Default value in Zagreb
    }
}

// Convert WGS84 coordinates to HTRS96/TM
function wgs84ToHTRS96(lat, lon) {
    // Validate inputs to ensure they're finite numbers
    if (!isFinite(lat) || !isFinite(lon)) {
        console.error('Invalid WGS84 coordinates:', lat, lon);
        // Return a default value near Zagreb
        return [458900, 5074000];
    }

    try {
        const [easting, northing] = proj4('EPSG:4326', 'EPSG:3765', [lon, lat]);
        // Check if the result is valid
        if (!isFinite(easting) || !isFinite(northing)) {
            console.error('Invalid conversion result:', easting, northing);
            return [458900, 5074000]; // Default value near Zagreb
        }
        return [easting, northing];
    } catch (error) {
        console.error('Error in coordinate conversion:', error);
        return [458900, 5074000]; // Default value near Zagreb
    }
}

// Convert map bounds to HTRS96/TM bbox string
function getBboxFromBounds(bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const [minX, minY] = wgs84ToHTRS96(sw.lat, sw.lng);
    const [maxX, maxY] = wgs84ToHTRS96(ne.lat, ne.lng);
    return `${minX},${minY},${maxX},${maxY}`;
}

// Clear existing centerline and width lines
function clearRoadVisualization() {
    if (currentCenterline) {
        map.removeLayer(currentCenterline);
        currentCenterline = null;
    }
    if (currentWidthLines) {
        currentWidthLines.forEach(line => map.removeLayer(line));
        currentWidthLines = [];
    }
}

// Draw road analysis visualization
function drawRoadVisualization(metrics) {
    clearRoadVisualization();

    // Draw centerline
    currentCenterline = L.geoJSON(metrics.centerline, {
        style: {
            color: 'yellow',
            weight: 3,
            dashArray: '10, 5',
            opacity: 0.8,
            className: 'centerline'
        }
    }).addTo(map);

    // Draw width lines
    currentWidthLines = metrics.widthLines.map(line => {
        // Leaflet expects [lat, lng]
        return L.polyline([
            [line[0][1], line[0][0]], // first point
            [line[1][1], line[1][0]]  // second point
        ], {
            color: 'orange',
            weight: 1,
            opacity: 0.8,
            className: 'width-line'
        }).addTo(map);
    });
}

// Fetch buildings from API
async function fetchBuildings() {
    if (typeof updateStatus === 'function') {
        updateStatus('Fetching buildings...');
    }

    try {
        const bounds = map.getBounds();
        const bbox = getBboxFromBounds(bounds);

        const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
        const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
        const url = `${baseUrl}?${new URLSearchParams({
            token: token,
            service: 'WFS',
            version: '1.0.0',
            request: 'GetFeature',
            maxFeatures: '2000',
            outputFormat: 'json',
            typeName: 'oss:DKP_ZGRADE',
            srsName: 'EPSG:3765',
            bbox: bbox
        }).toString()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch building data');
        const data = await response.json();

        // Convert the data to WGS84
        const convertedData = typeof convertGeoJSON === 'function' ? convertGeoJSON(data) : data;

        // Update the building layer
        if (buildingLayer) {
            map.removeLayer(buildingLayer);
        }

        buildingLayer = L.geoJSON(convertedData, {
            style: {
                fillColor: 'blue',
                fillOpacity: 0.2,
                color: 'blue',
                weight: 1
            }
        }).addTo(map);

        // Notify other modules (e.g., 3D) that buildings layer has updated
        try { window.buildingLayer = buildingLayer; } catch (_) { }
        try { window.dispatchEvent(new CustomEvent('buildingsLayerUpdated')); } catch (_) { }

        if (typeof updateStatus === 'function') {
            updateStatus(`Loaded ${data.features.length} buildings`);
        }
    } catch (error) {
        console.error('Error fetching building data:', error);
        if (typeof updateStatus === 'function') {
            updateStatus('Error fetching building data. Please try again.');
        }
    }
}

// Function to update the total spent display
function updateTotalSpentDisplay() {
    const totalSpentElement = document.getElementById('total-spent-value');
    if (totalSpentElement) {
        totalSpentElement.textContent = new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency: 'EUR',
            maximumFractionDigits: 0
        }).format(TOTAL_SPENT);
    }
}

// Set up map event handlers
function setupMapEventHandlers() {
    // Map movement handlers
    map.on('moveend', () => {
        if (!isMapMoving) return;

        // Handle buildings update
        if (document.getElementById('showBuildings').checked) {
            clearTimeout(buildingsTimeout);
            buildingsTimeout = setTimeout(fetchBuildings, 1000);
        }

        // Optimize: Only delay if network fetch is needed and zoom is within range
        const bounds = map.getBounds();
        if (typeof getRequiredGridCells === 'function' && typeof parcelCache !== 'undefined') {
            if (!isZoomWithinParcelRange()) {
                // Outside zoom range: do not fetch parcels, hide parcel layer if present
                if (typeof window.parcelLayer !== 'undefined' && window.parcelLayer && map.hasLayer(window.parcelLayer)) {
                    try { map.removeLayer(window.parcelLayer); } catch (_) { }
                }
                if (typeof updateStatus === 'function') updateStatus('Parcels disabled at this zoom');
                isMapMoving = false;
                return;
            }
            const requiredCells = getRequiredGridCells(bounds);
            const missingCells = Array.from(requiredCells).filter(cell => !parcelCache.grid.has(cell));

            if (typeof window.parcelsTimeout !== 'undefined') {
                clearTimeout(window.parcelsTimeout);
            }
            if (missingCells.length === 0) {
                // All data is already in memory – skip fetching to avoid flicker
                if (typeof window.parcelLayer !== 'undefined' && window.parcelLayer) {
                    if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
                        const layer = window.parcelLayer.getLayers().find(l =>
                            l.feature.properties.CESTICA_ID.toString() === selectedParcelId
                        );
                        if (layer && typeof selectedParcelStyle !== 'undefined') {
                            layer.setStyle(selectedParcelStyle);
                            layer.bringToFront();
                        }
                    }
                }
            } else {
                // Data missing, debounce network request
                window.parcelsTimeout = setTimeout(() => {
                    if (typeof fetchParcelData === 'function') {
                        fetchParcelData().then(() => {
                            if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof window.parcelLayer !== 'undefined' && window.parcelLayer) {
                                const layer = window.parcelLayer.getLayers().find(l =>
                                    l.feature.properties.CESTICA_ID.toString() === selectedParcelId
                                );
                                if (layer && typeof selectedParcelStyle !== 'undefined') {
                                    layer.setStyle(selectedParcelStyle);
                                    layer.bringToFront();
                                }
                            }
                        });
                    }
                }, 1000);
            }
        }

        isMapMoving = false;
    });

    // Add handlers for map movement start
    map.on('movestart', () => {
        isMapMoving = true;
    });

    // Add event listener for zoom
    map.on('zoomend', () => {
        const within = isZoomWithinParcelRange();
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
        if (!within) {
            // Hide parcels if zoomed out beyond threshold
            if (typeof window.parcelLayer !== 'undefined' && window.parcelLayer && map.hasLayer(window.parcelLayer)) {
                try { map.removeLayer(window.parcelLayer); } catch (_) { }
            }
            if (typeof updateStatus === 'function') updateStatus('Parcels disabled at this zoom');
        } else {
            // If user zoomed back in and parcels are enabled, ensure layer is added
            if (typeof window.parcelLayer !== 'undefined' && window.parcelLayer && !map.hasLayer(window.parcelLayer)) {
                try { window.parcelLayer.addTo(map); } catch (_) { }
            }
        }
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    });

    // Add map click handler to close visualization and panels
    map.on('click', () => {
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }
    });
}

// Initialize map core functionality
function initializeMapCore() {
    // Set up event handlers
    setupMapEventHandlers();

    // Update the total spent display
    updateTotalSpentDisplay();

    // Define parcel fetch zoom thresholds to fixed levels 17–19
    parcelFetchZoomMin = 17;
    parcelFetchZoomMax = 19;

    // Initial load only if within zoom range
    if (typeof fetchParcelData === 'function') {
        const within = isZoomWithinParcelRange();
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
        if (within) {
            fetchParcelData();
        } else if (typeof updateStatus === 'function') {
            updateStatus('Parcels disabled at this zoom');
        }
    }
}

// Make functions globally available
window.htrs96ToWGS84 = htrs96ToWGS84;
window.wgs84ToHTRS96 = wgs84ToHTRS96;
window.getBboxFromBounds = getBboxFromBounds;
window.clearRoadVisualization = clearRoadVisualization;
window.drawRoadVisualization = drawRoadVisualization;
window.fetchBuildings = fetchBuildings;
window.updateTotalSpentDisplay = updateTotalSpentDisplay;
window.setupMapEventHandlers = setupMapEventHandlers;
window.initializeMapCore = initializeMapCore;
window.isZoomWithinParcelRange = isZoomWithinParcelRange;

// Export global variables
window.map = map;
window.buildingLayer = buildingLayer;
window.roadLayer = roadLayer;
window.blockLayer = blockLayer;
window.currentCenterline = currentCenterline;
window.currentWidthLines = currentWidthLines;
window.TOTAL_SPENT = TOTAL_SPENT;
window.SQM_AVG_PRICE = SQM_AVG_PRICE; 