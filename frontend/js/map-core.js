// Define coordinate systems (legacy defaults). City-specific definitions are registered via CityConfigManager.
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs');
proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

const MapCityConfigManager = window.CityConfigManager || null;
const CURRENT_CITY_CONFIG = MapCityConfigManager ? MapCityConfigManager.getCurrentCityConfig() : null;
const CITY_MAP_CONFIG = MapCityConfigManager ? MapCityConfigManager.getMapConfig() : {};
const CITY_LATLNG_PADDING = MapCityConfigManager ? MapCityConfigManager.getLatLngPadding() : 0.12;
const GLOBAL_PARCEL_ZOOM_RANGE = { min: 17, max: 19 };
const DEFAULT_FALLBACK_LATLNG = CURRENT_CITY_CONFIG?.projection?.fallbackLatLng || [45.815, 15.982];
const DEFAULT_FALLBACK_DATASET = CURRENT_CITY_CONFIG?.projection?.fallbackDataset || [458900, 5074000];

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

function resolveInitialZoom() {
    const initialView = CITY_MAP_CONFIG?.initialView || {};
    if (Number.isFinite(initialView.zoom)) {
        return initialView.zoom;
    }
    if (Number.isFinite(CITY_MAP_CONFIG?.defaultZoom)) {
        return CITY_MAP_CONFIG.defaultZoom;
    }
    return GLOBAL_PARCEL_ZOOM_RANGE.min;
}

// Initialize the map with city-specific defaults
const map = L.map('map', {
    zoomControl: false  // Disable default zoom control
});

const INITIAL_VIEW = CITY_MAP_CONFIG?.initialView || null;
const hasDefaultCenter = Array.isArray(CITY_MAP_CONFIG?.defaultCenter) && CITY_MAP_CONFIG.defaultCenter.length === 2;

if (INITIAL_VIEW && INITIAL_VIEW.type === 'bounds' && Array.isArray(INITIAL_VIEW.value) && INITIAL_VIEW.value.length === 2) {
    map.fitBounds(INITIAL_VIEW.value);
} else if (INITIAL_VIEW && INITIAL_VIEW.type === 'center' && (Array.isArray(INITIAL_VIEW.center) || hasDefaultCenter)) {
    const center = Array.isArray(INITIAL_VIEW.center) ? INITIAL_VIEW.center : CITY_MAP_CONFIG.defaultCenter;
    map.setView(center || DEFAULT_FALLBACK_LATLNG, resolveInitialZoom());
} else if (hasDefaultCenter) {
    map.setView(CITY_MAP_CONFIG.defaultCenter, resolveInitialZoom());
} else if (Array.isArray(CITY_MAP_CONFIG?.fitBounds) && CITY_MAP_CONFIG.fitBounds.length === 2) {
    // Backwards compatibility
    map.fitBounds(CITY_MAP_CONFIG.fitBounds);
} else {
    map.setView(DEFAULT_FALLBACK_LATLNG, resolveInitialZoom());
}

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
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
        console.error('Invalid city dataset coordinates:', easting, northing);
        return DEFAULT_FALLBACK_LATLNG;
    }
    const bounds = CURRENT_CITY_CONFIG?.projection?.datasetBounds;
    if (bounds) {
        const outOfBounds = easting < bounds.minX || easting > bounds.maxX || northing < bounds.minY || northing > bounds.maxY;
        if (outOfBounds) {
            console.warn('Dataset coordinates outside configured bounds:', easting, northing);
            return DEFAULT_FALLBACK_LATLNG;
        }
    }
    try {
        const converter = MapCityConfigManager ? MapCityConfigManager.datasetToLatLng : null;
        const [lat, lon] = converter ? converter(easting, northing) : [northing, easting];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error('Conversion returned invalid numbers');
        }
        return [lat, lon];
    } catch (error) {
        console.error('Error in coordinate conversion:', error);
        return DEFAULT_FALLBACK_LATLNG;
    }
}

// Convert WGS84 coordinates to HTRS96/TM
function wgs84ToHTRS96(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.error('Invalid WGS84 coordinates:', lat, lon);
        return DEFAULT_FALLBACK_DATASET;
    }
    try {
        const converter = MapCityConfigManager ? MapCityConfigManager.latLngToDataset : null;
        const [easting, northing] = converter ? converter(lat, lon) : [lon, lat];
        if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
            throw new Error('Conversion returned invalid numbers');
        }
        return [easting, northing];
    } catch (error) {
        console.error('Error in coordinate conversion:', error);
        return DEFAULT_FALLBACK_DATASET;
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

// Fetch buildings from data source
async function fetchBuildings() {
    // Only fetch on zoom levels 17–19
    try {
        const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
        if (!isFinite(z) || z < 17 || z > 19) {
            return;
        }
    } catch (_) { /* noop */ }
    if (typeof updateStatus === 'function') {
        updateStatus('Fetching buildings...');
    }

    try {
        const bounds = map.getBounds();
        const bbox = getBboxFromBounds(bounds);

        const builder = (typeof buildBuildingRequestParams === 'function') ? buildBuildingRequestParams : null;
        const req = builder ? builder(bbox) : null;
        const url = req ? req.url : (function () {
            const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
            const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
            return `${baseUrl}?${new URLSearchParams({
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
        })();

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
        let formatted = `${TOTAL_SPENT}`;
        if (MapCityConfigManager && typeof MapCityConfigManager.formatCurrency === 'function') {
            formatted = MapCityConfigManager.formatCurrency(TOTAL_SPENT);
        } else {
            formatted = new Intl.NumberFormat('de-DE', {
                style: 'currency',
                currency: 'EUR',
                maximumFractionDigits: 0
            }).format(TOTAL_SPENT);
        }
        totalSpentElement.textContent = formatted;
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
                if (typeof updateVisibleParcelsCount === 'function') {
                    updateVisibleParcelsCount();
                }
                isMapMoving = false;
                return;
            }
            const latLngPadding = Number((typeof window !== 'undefined' && window.PARCEL_FETCH_LATLNG_PADDING !== undefined)
                ? window.PARCEL_FETCH_LATLNG_PADDING
                : 0.12);
            const expandedBounds = (bounds && typeof bounds.pad === 'function' && latLngPadding > 0)
                ? bounds.pad(latLngPadding)
                : bounds;
            let gridRadiusValue = 0;
            if (typeof window !== 'undefined') {
                if (window.PARCEL_FETCH_GRID_RADIUS !== undefined) {
                    gridRadiusValue = window.PARCEL_FETCH_GRID_RADIUS;
                } else if (window.PARCEL_FETCH_GRID_PADDING !== undefined) {
                    gridRadiusValue = window.PARCEL_FETCH_GRID_PADDING;
                }
            }
            const gridRadius = Number.isFinite(gridRadiusValue) ? gridRadiusValue : 0;
            const requiredCells = getRequiredGridCells(expandedBounds, gridRadius);
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
                const debounceMs = Number((typeof window !== 'undefined' && window.PARCEL_FETCH_DEBOUNCE_MS !== undefined)
                    ? window.PARCEL_FETCH_DEBOUNCE_MS
                    : 500);
                window.parcelsTimeout = setTimeout(() => {
                    if (typeof fetchParcelData === 'function') {
                        fetchParcelData(expandedBounds).then(() => {
                            if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof window.parcelLayer !== 'undefined' && window.parcelLayer) {
                                const layer = window.parcelLayer.getLayers().find(l =>
                                    l.feature.properties.CESTICA_ID.toString() === selectedParcelId
                                );
                                if (layer && typeof selectedParcelStyle !== 'undefined') {
                                    layer.setStyle(selectedParcelStyle);
                                    layer.bringToFront();
                                }
                            }
                            if (typeof updateVisibleParcelsCount === 'function') {
                                updateVisibleParcelsCount();
                            }
                        });
                    }
                }, debounceMs);
            }
        }

        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
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
            // Hide buildings as well when below allowed zoom
            if (typeof window.buildingLayer !== 'undefined' && window.buildingLayer && map.hasLayer(window.buildingLayer)) {
                try { map.removeLayer(window.buildingLayer); } catch (_) { }
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
    parcelFetchZoomMin = GLOBAL_PARCEL_ZOOM_RANGE.min;
    parcelFetchZoomMax = GLOBAL_PARCEL_ZOOM_RANGE.max;

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

// Update map dimensions display
function updateMapDimensions() {
    const dimensionsText = document.getElementById('map-dimensions-text');
    if (!dimensionsText) return;

    try {
        const mapSize = map.getSize();
        const sidebar = document.getElementById('sidebar');
        const isSidebarVisible = sidebar && !sidebar.classList.contains('collapsed');
        const sidebarWidth = isSidebarVisible ? 320 : 0;

        const visibleWidth = mapSize.x - sidebarWidth;
        const visibleHeight = mapSize.y;

        dimensionsText.textContent = `${visibleWidth} × ${visibleHeight} px`;
    } catch (err) {
        console.warn('Failed to update map dimensions:', err);
    }
}

// Update dimensions on map events
map.on('resize', updateMapDimensions);
map.on('moveend', updateMapDimensions);

// Initial update
setTimeout(updateMapDimensions, 100);

// Update when sidebar is toggled
const originalToggleSidebar = window.toggleSidebar;
window.toggleSidebar = function () {
    if (originalToggleSidebar) {
        originalToggleSidebar();
    }
    setTimeout(updateMapDimensions, 350); // Wait for sidebar animation
};

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
window.updateMapDimensions = updateMapDimensions;

// Export global variables
window.map = map;
window.buildingLayer = buildingLayer;
window.roadLayer = roadLayer;
window.blockLayer = blockLayer;
window.currentCenterline = currentCenterline;
window.currentWidthLines = currentWidthLines;
window.TOTAL_SPENT = TOTAL_SPENT;
window.SQM_AVG_PRICE = SQM_AVG_PRICE; 