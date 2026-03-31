// Define coordinate systems (legacy defaults). City-specific definitions are registered via CityConfigManager.
const proj4Global = (typeof proj4 !== 'undefined') ? proj4 : null;
if (proj4Global) {
    proj4Global.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs');
    proj4Global.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
} else {
    console.warn('[map-core] proj4 is missing; coordinate transforms may be unavailable.');
}

const IS_PROPOSAL_DEEP_LINK = (() => {
    if (typeof window === 'undefined' || !window.location) return false;
    try {
        const path = window.location.pathname || '';
        if (/^\/proposals\/\d+(?:\/)?$/i.test(path)) return true;
        if (typeof window.shouldSkipWelcomeForProposalLink === 'function') {
            return window.shouldSkipWelcomeForProposalLink();
        }
    } catch (_) { /* ignore */ }
    return false;
})();

try {
    if (IS_PROPOSAL_DEEP_LINK) {
        window.skipParcelFetchUntilProposalLoaded = true;
    }
} catch (_) { /* noop */ }

const MapCityConfigManager = window.CityConfigManager || null;
const CURRENT_CITY_CONFIG = MapCityConfigManager ? MapCityConfigManager.getCurrentCityConfig() : null;
const CITY_MAP_CONFIG = MapCityConfigManager ? MapCityConfigManager.getMapConfig() : {};
const CITY_LATLNG_PADDING = MapCityConfigManager ? MapCityConfigManager.getLatLngPadding() : 0.12;
const GLOBAL_PARCEL_ZOOM_RANGE = { min: 17, max: Infinity };
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
let baseTileLayer = null;

const BasemapManager = (typeof window !== 'undefined' && window.BasemapManager) ? window.BasemapManager : null;

const parcelState = (typeof window !== 'undefined' && window.ParcelsState) ? window.ParcelsState : null;
const resolveParcelCache = () => (parcelState && typeof parcelState.getParcelCache === 'function')
    ? parcelState.getParcelCache()
    : (typeof parcelCache !== 'undefined' ? parcelCache : null);
const resolveParcelLayer = () => (parcelState && typeof parcelState.getParcelLayer === 'function')
    ? parcelState.getParcelLayer()
    : (typeof window !== 'undefined' ? window.parcelLayer : null);
const parcelFetchConfig = (typeof window !== 'undefined' && window.ParcelFetchConfig) ? window.ParcelFetchConfig : null;
const getFeatureParcelId = (feature) => {
    if (typeof ensureParcelId === 'function') return ensureParcelId(feature);
    return feature?.properties?.parcelId ?? feature?.properties?.parcel_id;
};

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

if (IS_PROPOSAL_DEEP_LINK) {
    // Keep parcels idle but start from city context so coverage/debug tools don't blow up
    const fallbackCenter = CITY_MAP_CONFIG.defaultCenter || DEFAULT_FALLBACK_LATLNG;
    map.setView(fallbackCenter, resolveInitialZoom());
} else if (INITIAL_VIEW && INITIAL_VIEW.type === 'bounds' && Array.isArray(INITIAL_VIEW.value) && INITIAL_VIEW.value.length === 2) {
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

// Add base map layer based on user preference
if (BasemapManager) {
    baseTileLayer = BasemapManager.applyBasemap(map, BasemapManager.getStoredBasemapKey());
}

// Add scale control
L.control.scale({
    metric: true,
    imperial: false,
    position: 'bottomright'
}).addTo(map);

function isZoomWithinParcelRange() {
    if (parcelFetchZoomMin === null) return true;
    const z = map.getZoom();
    if (parcelFetchZoomMax === null || parcelFetchZoomMax === Infinity) {
        return z >= parcelFetchZoomMin;
    }
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
            const baseUrl = (typeof getBackendBase === 'function')
                ? `${getBackendBase().replace(/\/$/, '')}/oss/wfs`
                : 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
            return `${baseUrl}?${new URLSearchParams({
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
        if (typeof ParcelFetchController !== 'undefined' && ParcelFetchController && typeof ParcelFetchController.handleMoveEnd === 'function') {
            ParcelFetchController.handleMoveEnd(map, {
                parcelFetchConfig,
                resolveParcelCache,
                resolveParcelLayer,
                isZoomWithinParcelRange
            });
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
            const layerRef = resolveParcelLayer();
            if (layerRef && map.hasLayer(layerRef)) {
                try { map.removeLayer(layerRef); } catch (_) { }
            }
            // Hide buildings as well when below allowed zoom
            if (typeof window.buildingLayer !== 'undefined' && window.buildingLayer && map.hasLayer(window.buildingLayer)) {
                try { map.removeLayer(window.buildingLayer); } catch (_) { }
            }
            if (typeof updateStatus === 'function') updateStatus('Parcels disabled at this zoom');
        } else {
            // If user zoomed back in and parcels are enabled, ensure layer is added
            const layerRef = resolveParcelLayer();
            if (layerRef && !map.hasLayer(layerRef)) {
                try { layerRef.addTo(map); } catch (_) { }
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

    // Set up cursor spinner for parcel fetching/merging
    const mapElement = document.getElementById('map');
    if (mapElement && typeof window.ParcelActivityListener !== 'undefined') {
        window.ParcelActivityListener.init(mapElement, {
            getIsFetching: () => (typeof window.ParcelsState !== 'undefined' &&
                typeof window.ParcelsState.isFetchingParcels === 'function' &&
                window.ParcelsState.isFetchingParcels()),
            getIsMerging: () => (typeof window.isParcelMergeInProgress === 'function' && window.isParcelMergeInProgress()),
            getInternalFlag: () => (typeof window._fetchParcelDataInProgress !== 'undefined' && window._fetchParcelDataInProgress),
            intervalMs: 120
        });
    }

    // Define parcel fetch zoom thresholds (default min 17, no maximum limit)
    const zoomRange = (parcelFetchConfig && typeof parcelFetchConfig.getZoomRange === 'function')
        ? parcelFetchConfig.getZoomRange()
        : GLOBAL_PARCEL_ZOOM_RANGE;
    parcelFetchZoomMin = Number.isFinite(zoomRange?.min) ? zoomRange.min : GLOBAL_PARCEL_ZOOM_RANGE.min;
    parcelFetchZoomMax = Number.isFinite(zoomRange?.max) ? zoomRange.max : GLOBAL_PARCEL_ZOOM_RANGE.max;

    // Initial load only if within zoom range and not in proposal deep-link mode
    const shouldSkipInitialFetch = (typeof window !== 'undefined' && window.skipParcelFetchUntilProposalLoaded);
    if (!shouldSkipInitialFetch && typeof fetchParcelData === 'function') {
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

    // Nudge map rendering on first init to avoid gray tiles before any user resize
    if (typeof map !== 'undefined' && map && map.invalidateSize) {
        requestAnimationFrame(() => {
            try { map.invalidateSize(); } catch (_) { }
        });
        setTimeout(() => {
            try { map.invalidateSize(); } catch (_) { }
        }, 80);
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

// Hook up base map selector once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    if (BasemapManager) {
        BasemapManager.initBasemapSelector(map);
    }
});

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
window.getTileLoadingStats = BasemapManager ? BasemapManager.getTileLoadingStats : () => ({ totalErrors: 0, lastErrorTime: null, recentErrors: [], hasRecentErrors: false });

// Export global variables
window.map = map;
window.buildingLayer = buildingLayer;
window.roadLayer = roadLayer;
window.blockLayer = blockLayer;
window.currentCenterline = currentCenterline;
window.currentWidthLines = currentWidthLines;
window.TOTAL_SPENT = TOTAL_SPENT;
window.SQM_AVG_PRICE = SQM_AVG_PRICE; 