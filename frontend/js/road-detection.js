// OSM Road Detection and Naming System
let osmRoadLayer = null;
let osmData = null;
let roadDetectionProgress = { current: 0, total: 0 };
const OSM_CACHE_KEY = 'osm_roads_cache';
const OSM_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
let wfsRoadUseLayer = null;
let gupRoadLayer = null;
const GUP_ROAD_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let gupRoadCache = {
    featureCollection: null,
    key: null,
    timestamp: 0
};
const GUP_ARCGIS_DEFAULT_URL = 'https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/Ulice_200409/FeatureServer/1/query';

// WFS (OSS) config for land use (DKP_NACINI_UPORABE)
const OSS_WFS_BASE = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
const OSS_TOKEN = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
// Usage codes considered as roads
const ROAD_USAGE_CODES = new Set(['520', '521', '522', '523', '524', '526', '544', '545', '547']);
const HTRS_WFS_CONVERSION = { sourceSrid: 'EPSG:3765', suppressHTRSWarning: true };

// ============================================================================
// Road Parcels Storage Module
// Centralized storage for road parcel IDs using a single array in PersistentStorage
// ============================================================================
const ROAD_PARCELS_KEY = 'roadParcels';

// In-memory cache for fast lookups
let roadParcelsSet = new Set();
let roadParcelsLoaded = false;

/**
 * Load road parcels from PersistentStorage into memory
 */
function loadRoadParcels() {
    if (roadParcelsLoaded) return;
    try {
        const stored = PersistentStorage.getItem(ROAD_PARCELS_KEY);
        if (stored) {
            const arr = JSON.parse(stored);
            if (Array.isArray(arr)) {
                // New writes enter through markRoadFeature(), which resolves explicit cadastral
                // provenance before touching this registry. Stored values are identifiers, not a
                // second geometry source, and are never reinterpreted from their spelling.
                roadParcelsSet = new Set(arr.map(String).filter(Boolean));
            }
        }
        roadParcelsLoaded = true;
    } catch (e) {
        console.warn('Failed to load roadParcels from storage:', e);
        roadParcelsSet = new Set();
        roadParcelsLoaded = true;
    }
}

/**
 * Save road parcels to PersistentStorage
 */
function saveRoadParcels() {
    try {
        const arr = Array.from(roadParcelsSet);
        PersistentStorage.setItem(ROAD_PARCELS_KEY, JSON.stringify(arr));
    } catch (e) {
        console.warn('Failed to save roadParcels to storage:', e);
    }
}

/**
 * Check if a parcel is marked as a road
 * @param {string} parcelId
 * @returns {boolean}
 */
function isRoadParcel(parcelId) {
    if (!parcelId) return false;
    loadRoadParcels();
    return roadParcelsSet.has(String(parcelId));
}

/**
 * Mark a parcel as a road
 * @param {string} parcelId
 */
function addRoadParcel(parcelId) {
    if (!parcelId) return;
    loadRoadParcels();
    const id = String(parcelId);
    if (!roadParcelsSet.has(id)) {
        roadParcelsSet.add(id);
        saveRoadParcels();
    }
}

/**
 * Remove road status from a parcel
 * @param {string} parcelId
 */
function removeRoadParcel(parcelId) {
    if (!parcelId) return;
    loadRoadParcels();
    const id = String(parcelId);
    if (roadParcelsSet.has(id)) {
        roadParcelsSet.delete(id);
        saveRoadParcels();
    }
}

/**
 * Clear all road parcels
 */
function clearAllRoadParcels() {
    roadParcelsSet.clear();
    roadParcelsLoaded = true;
    PersistentStorage.removeItem(ROAD_PARCELS_KEY);
}

/**
 * Get all road parcel IDs
 * @returns {string[]}
 */
function getAllRoadParcels() {
    loadRoadParcels();
    return Array.from(roadParcelsSet);
}

/**
 * Get the count of road parcels
 * @returns {number}
 */
function getRoadParcelCount() {
    loadRoadParcels();
    return roadParcelsSet.size;
}

/**
 * Repaint all road parcels with road styling after parcels are loaded
 * Call this after browser reload once parcels are available
 */
// Expose road parcels API globally
window.isRoadParcel = isRoadParcel;
window.addRoadParcel = addRoadParcel;
window.removeRoadParcel = removeRoadParcel;
window.clearAllRoadParcels = clearAllRoadParcels;
window.getAllRoadParcels = getAllRoadParcels;
window.getRoadParcelCount = getRoadParcelCount;

// ============================================================================

function resolveParcelId(feature) {
    if (!feature || typeof feature !== 'object') return null;
    try {
        if (typeof ensureParcelId === 'function') {
            const ensured = ensureParcelId(feature);
            if (ensured !== undefined && ensured !== null) return ensured.toString();
        }
    } catch (_) { }
    const props = feature.properties || {};
    const candidates = [props.parcelId];
    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null) {
            try { return candidate.toString(); } catch (_) { return String(candidate); }
        }
    }
    return null;
}

function roadDetectionServices() {
    const fabric = window.LiveParcelFabric;
    const presenter = window.ParcelPresenter;
    if (!fabric || typeof fabric.queryBounds !== 'function'
        || typeof fabric.list !== 'function'
        || typeof fabric.cadastreIdsForParcelIds !== 'function') return null;
    if (!presenter || typeof presenter.getLayer !== 'function') return null;
    return { fabric, presenter };
}

function roadDetectionFeaturesInView() {
    const services = roadDetectionServices();
    if (!services || typeof map === 'undefined' || !map || typeof map.getBounds !== 'function') return [];
    return services.fabric.queryBounds(map.getBounds(), { includeCorridors: true });
}

function roadDetectionFeatureBounds(feature) {
    try {
        const bounds = turf.bbox(feature);
        return Array.isArray(bounds) && bounds.length >= 4 && bounds.every(Number.isFinite)
            ? bounds
            : null;
    } catch (_) {
        return null;
    }
}

function roadDetectionBoundsIntersect(left, right) {
    return !!left && !!right
        && left[0] <= right[2] && left[2] >= right[0]
        && left[1] <= right[3] && left[3] >= right[1];
}

function roadDetectionCadastreIds(feature) {
    const services = roadDetectionServices();
    const parcelId = resolveParcelId(feature);
    if (!services || !parcelId) return [];
    try {
        return services.fabric.cadastreIdsForParcelIds([parcelId]);
    } catch (error) {
        console.warn(`[road-detection] Missing cadastral provenance for ${parcelId}`, error);
        return [];
    }
}

function roadDetectionLayer(featureOrId) {
    const services = roadDetectionServices();
    const id = typeof featureOrId === 'string'
        ? featureOrId
        : resolveParcelId(featureOrId);
    return services && id ? services.presenter.getLayer(id) : null;
}

function markRoadFeature(feature) {
    const cadastreIds = roadDetectionCadastreIds(feature);
    if (!cadastreIds.length) return false;
    cadastreIds.forEach(addRoadParcel);
    const layer = roadDetectionLayer(feature);
    if (layer && typeof layer.setStyle === 'function') layer.setStyle(roadStyle);
    return true;
}

function isMarkedRoadFeature(feature) {
    const cadastreIds = roadDetectionCadastreIds(feature);
    return cadastreIds.some(isRoadParcel);
}

// Fetch DKP_NACINI_UPORABE features in current bbox, paginated if needed
async function fetchWFSUsageInBbox() {
    const bounds = map.getBounds();
    const bbox = typeof getBboxFromBounds === 'function' ? getBboxFromBounds(bounds) : null;
    if (!bbox) {
        throw new Error('Could not compute bbox');
    }

    const params = {
        token: OSS_TOKEN,
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        outputFormat: 'json',
        typeName: 'oss:DKP_NACINI_UPORABE',
        srsName: 'EPSG:3765',
        bbox: bbox,
        count: '4000'
    };

    let startIndex = 0;
    const allFeatures = [];
    while (true) {
        const usp = new URLSearchParams(params);
        if (startIndex > 0) usp.set('startIndex', String(startIndex));
        const url = `${OSS_WFS_BASE}?${usp.toString()}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to fetch DKP_NACINI_UPORABE');
        const data = await resp.json();
        const features = Array.isArray(data.features) ? data.features : [];
        allFeatures.push(...features);
        const numberReturned = Number(data.numberReturned || features.length);
        const numberMatched = Number(data.numberMatched);
        if (isFinite(numberMatched) && numberMatched > 0) {
            if (startIndex + numberReturned >= numberMatched || numberReturned === 0) break;
        } else {
            if (numberReturned < Number(params.count)) break;
        }
        startIndex += numberReturned;
    }

    return { type: 'FeatureCollection', features: allFeatures };
}

async function fetchJsonWithRetry(url, options = {}, retries = 3, delay = 2000) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                return await response.json();
            }
            if (response.status >= 400 && response.status < 500) {
                lastError = new Error(`Request failed with status ${response.status}`);
                break;
            }
            lastError = new Error(`Server error ${response.status}`);
        } catch (error) {
            lastError = error;
        }

        if (attempt < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError || new Error('Failed to fetch JSON');
}

// Check if two polygonal features are geometrically identical (within tolerance)
// Compute Intersection-over-Union (IoU) between two polygonal features
function computeIoU(featureA, featureB) {
    try {
        const areaA = turf.area(featureA);
        const areaB = turf.area(featureB);
        if (!isFinite(areaA) || !isFinite(areaB) || areaA <= 0 || areaB <= 0) return 0;
        let inter = null;
        try { inter = turf.intersect(featureA, featureB); } catch (_) { inter = null; }
        const areaI = inter ? turf.area(inter) : 0;
        const areaU = areaA + areaB - areaI;
        if (areaU <= 0) return 0;
        return areaI / areaU;
    } catch (_) {
        return 0;
    }
}

// Main entry: Detect roads from DGU DKP_NACINI_UPORABE by parcel intersection
async function detectRoadsFromWFS() {
    if (!roadDetectionServices()) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const trigger = async () => {
        const progressContainer = document.getElementById('progressContainer');
        const progressText = document.getElementById('progressText');
        const progressFill = document.getElementById('progressFill');
        if (progressContainer) progressContainer.style.display = 'block';
        if (progressText) progressText.textContent = 'Fetching DGU usage data...';

        try {
            const usageData = await fetchWFSUsageInBbox();
            // Filter by road usage codes and polygonal geometry
            let roadUseFeatures = (usageData.features || []).filter(f => {
                const code = String(f?.properties?.SIFRA_VRSTE_UPORABE || '');
                const isPoly = f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
                return isPoly && ROAD_USAGE_CODES.has(code);
            });

            // Convert all usage features to WGS84 if needed
            try {
                const fc = { type: 'FeatureCollection', features: roadUseFeatures };
                const converted = typeof convertGeoJSON === 'function' ? convertGeoJSON(fc, HTRS_WFS_CONVERSION) : fc;
                roadUseFeatures = converted.features;
            } catch (_) { }

            if (progressText) {
                progressText.textContent = `Matching ${roadUseFeatures.length} DGU polygons to parcel geometries (overlap)...`;
            }

            // The committed fabric is the sole geometry source. Leaflet is only updated after a
            // parcel has been classified.
            const parcelEntries = roadDetectionFeaturesInView().map(feature => ({
                feature,
                bounds: roadDetectionFeatureBounds(feature)
            })).filter(entry => entry.bounds);

            let processed = 0;
            const marked = new Set();
            const total = roadUseFeatures.length;

            for (const usage of roadUseFeatures) {
                processed++;
                // Prefilter by bounds overlap to reduce comparisons
                const usageBounds = roadDetectionFeatureBounds(usage);
                const candidates = usageBounds
                    ? parcelEntries.filter(entry => roadDetectionBoundsIntersect(usageBounds, entry.bounds))
                    : parcelEntries;

                for (const pe of candidates) {
                    const parcelGeoJSON = pe.feature;
                    if (!parcelGeoJSON || !parcelGeoJSON.geometry) continue;
                    // Compute overlap ratios instead of strict IoU threshold
                    let overlapA = 0; // intersection / area(parcel)
                    let overlapB = 0; // intersection / area(usage)
                    try {
                        const areaA = turf.area(parcelGeoJSON);
                        const areaB = turf.area(usage);
                        if (!isFinite(areaA) || !isFinite(areaB) || areaA <= 0 || areaB <= 0) {
                            continue;
                        }
                        let inter = null;
                        try { inter = turf.intersect(parcelGeoJSON, usage); } catch (_) { inter = null; }
                        const areaI = inter ? turf.area(inter) : 0;
                        overlapA = areaI / areaA;
                        overlapB = areaI / areaB;
                    } catch (_) { }

                    // Loosen match: consider a match if either polygon overlaps the other by >= 90%
                    if (overlapA >= 0.9 || overlapB >= 0.9) {
                        const parcelId = resolveParcelId(pe.feature);
                        if (!parcelId) continue;
                        if (markRoadFeature(pe.feature)) marked.add(parcelId);
                    }
                }

                const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
                if (progressFill) progressFill.style.width = `${pct}%`;
                if (progressText) progressText.textContent = `Geometry matching: ${processed}/${total} (${pct}%)`;
                await new Promise(r => setTimeout(r, 0));
            }

            updateStatus(`Geometry-based DGU detection complete. Marked ${marked.size} parcels as roads.`);
            updateParcelStyles();
        } catch (err) {
            console.error('Error detecting roads from DGU:', err);
            updateStatus('Error detecting roads from DGU.');
        } finally {
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        }
    };

    const button = document.querySelector('button[onclick="detectRoadsFromWFS()"]');
    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Detecting...', trigger);
    }
    return trigger();
}

// Expose for UI
window.detectRoadsFromWFS = detectRoadsFromWFS;

// Draw-only overlay for DGU road usage polygons
async function drawWFSRoadParcels() {
    const status = document.getElementById('status');
    updateStatus('Fetching DGU road usage polygons...');
    try {
        const usageData = await fetchWFSUsageInBbox();
        const roadUseFeatures = (usageData.features || []).filter(f => {
            const code = String(f?.properties?.SIFRA_VRSTE_UPORABE || '');
            return ROAD_USAGE_CODES.has(code);
        });

        // Convert to WGS84 if needed and draw
        let fc = { type: 'FeatureCollection', features: roadUseFeatures };
        try {
            fc = typeof convertGeoJSON === 'function' ? convertGeoJSON(fc, HTRS_WFS_CONVERSION) : fc;
        } catch (_) { }

        if (wfsRoadUseLayer) {
            map.removeLayer(wfsRoadUseLayer);
            wfsRoadUseLayer = null;
        }

        wfsRoadUseLayer = L.geoJSON(fc, {
            style: {
                color: '#2a9d8f',
                weight: 2,
                fillColor: '#2a9d8f',
                fillOpacity: 0.15
            },
            onEachFeature: (feature, layer) => {
                const code = feature?.properties?.SIFRA_VRSTE_UPORABE;
                const broj = feature?.properties?.BROJ;
                const ko = feature?.properties?.MATICNI_BROJ_KO;
                layer.bindTooltip(`KO: ${ko || '-'} | BROJ: ${broj || '-'} | UPORABA: ${code || '-'}`);
            }
        }).addTo(map);

        updateStatus(`Drew ${roadUseFeatures.length} DGU road-usage polygons`);

        // Ensure the checkbox reflects visibility state
        const wfsCheckbox = document.getElementById('showWFSPolygons');
        if (wfsCheckbox) {
            wfsCheckbox.checked = true;
        }
    } catch (e) {
        console.error('Error drawing DGU road usage polygons:', e);
        updateStatus('Error drawing DGU road usage polygons.');
    }
}

window.drawWFSRoadParcels = drawWFSRoadParcels;

// Toggle visibility for DGU polygons layer
function toggleWFSPolygons() {
    try {
        const checkbox = document.getElementById('showWFSPolygons');
        if (!checkbox) return;

        if (checkbox.checked) {
            // If layer exists, ensure it's on the map; otherwise draw it now
            if (wfsRoadUseLayer) {
                if (!map.hasLayer(wfsRoadUseLayer)) {
                    wfsRoadUseLayer.addTo(map);
                    updateStatus('DGU polygons shown');
                }
            } else {
                // Fetch and draw if not already present
                drawWFSRoadParcels();
            }
        } else {
            // Remove the layer if present
            if (wfsRoadUseLayer && map.hasLayer(wfsRoadUseLayer)) {
                map.removeLayer(wfsRoadUseLayer);
                updateStatus('DGU polygons hidden');
            }
        }
    } catch (err) {
        console.error('Error toggling DGU polygons:', err);
    }
}

window.toggleWFSPolygons = toggleWFSPolygons;

// Function to fetch road data from OpenStreetMap using Overpass API
async function fetchOSMRoads() {
    const status = document.getElementById('status');
    updateStatus('Fetching road data from OpenStreetMap...');

    try {
        const bounds = map.getBounds();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        // Check cache first
        const cachedData = checkOSMCache(south, west, north, east);
        if (cachedData) {
            updateStatus('Using cached OSM road data');
            return cachedData;
        }

        // Overpass API query for roads (highway) and railways; exclude footpaths explicitly
        const overpassQuery = `
            [out:json][timeout:60];
            (
                way[highway][name](${south},${west},${north},${east});
                way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street)$"](${south},${west},${north},${east});
                way[railway](${south},${west},${north},${east});
            );
            out body geom;
        `;

        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

        const response = await fetch(overpassUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch OSM data: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache the result
        cacheOSMData(data, south, west, north, east);

        updateStatus(`Fetched ${data.elements.length} roads from OpenStreetMap`);
        return data;
    } catch (error) {
        console.error('Error fetching OSM data:', error);
        updateStatus(`Error fetching OSM data: ${error.message}`);
        return null;
    }
}

// Function to store OSM data in cache
function cacheOSMData(data, south, west, north, east) {
    const cacheItem = {
        data: data,
        bounds: { south, west, north, east },
        timestamp: Date.now()
    };
    PersistentStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cacheItem));
}

// Function to check if valid cached data exists
function checkOSMCache(south, west, north, east) {
    try {
        const cachedItem = JSON.parse(PersistentStorage.getItem(OSM_CACHE_KEY));
        if (!cachedItem) return null;

        // Check if cache is expired
        if (Date.now() - cachedItem.timestamp > OSM_CACHE_EXPIRY) {
            console.log('OSM cache expired');
            return null;
        }

        // Check if current bounds are contained within cached bounds
        const cachedBounds = cachedItem.bounds;
        if (south < cachedBounds.south || north > cachedBounds.north ||
            west < cachedBounds.west || east > cachedBounds.east) {
            console.log('Current view outside cached bounds');
            return null;
        }

        console.log('Using cached OSM data');
        return cachedItem.data;
    } catch (error) {
        console.error('Error reading OSM cache:', error);
        return null;
    }
}

// Convert OSM ways to GeoJSON
function osmToGeoJSON(osmData) {
    const features = [];

    if (!osmData || !osmData.elements) return { type: 'FeatureCollection', features: [] };

    for (const element of osmData.elements) {
        if (element.type !== 'way' || !element.geometry || element.geometry.length < 2) continue;

        const coordinates = element.geometry.map(node => [node.lon, node.lat]);

        const feature = {
            type: 'Feature',
            properties: {
                id: element.id,
                name: element.tags.name || 'Unnamed Road',
                highway: element.tags.highway,
                railway: element.tags.railway,
                width: element.tags.width,
                // The node ids ARE the topology in OSM: two ways are connected exactly when they
                // share a node. Dropping them (as this used to) turns a connected street network
                // into a heap of unrelated lines, which is why OSM roads look "disconnected".
                osmNodes: Array.isArray(element.nodes) ? element.nodes : null,
                osmTags: element.tags
            },
            geometry: {
                type: 'LineString',
                coordinates: coordinates
            }
        };

        features.push(feature);
    }

    return {
        type: 'FeatureCollection',
        features: features
    };
}

// Display the fetched OSM roads on the map
function displayOSMRoads(osmGeoJSON) {
    window.osmRoadGeoJSON = osmGeoJSON;
    if (window.osmRoadLayer) {
        map.removeLayer(window.osmRoadLayer);
    }
    window.osmRoadLayer = L.geoJSON(osmGeoJSON, {
        style: function (feature) {
            const isRail = !!feature.properties.railway;
            if (isRail) {
                return { color: '#444', weight: 2, opacity: 0.8, dashArray: '4,4' };
            }
            function getRandomColor() {
                const hue = Math.floor(Math.random() * 360);
                return `hsl(${hue}, 70%, 60%)`;
            }
            return { color: getRandomColor(), weight: 3, opacity: 0.6 };
        },
        onEachFeature: (feature, layer) => {
            const name = feature.properties.name || 'Unnamed';
            const type = feature.properties.railway ? `railway:${feature.properties.railway}` : feature.properties.highway;
            layer.bindTooltip(`${name} (${type})`);
        }
    });
    // Only add to map if checkbox is checked
    const cb = document.getElementById('showOSMRoadLines');
    if (!cb || cb.checked) {
        window.osmRoadLayer.addTo(map);
    }
}

function computeBoundsKey(bounds) {
    if (!bounds || typeof bounds.getWest !== 'function') {
        return 'global';
    }
    const precision = 4;
    return [
        bounds.getWest().toFixed(precision),
        bounds.getSouth().toFixed(precision),
        bounds.getEast().toFixed(precision),
        bounds.getNorth().toFixed(precision)
    ].join(',');
}

async function fetchGUPRoads(force = false) {
    const dataSource = typeof getCurrentDataSource === 'function'
        ? getCurrentDataSource()
        : 'oss.uredjenazemlja.hr';

    const bounds = map && typeof map.getBounds === 'function' ? map.getBounds() : null;
    const bboxHTRS = bounds && typeof getBboxFromBounds === 'function' ? getBboxFromBounds(bounds) : '';
    const geometryEnvelope = bounds
        ? JSON.stringify({
            xmin: bounds.getWest(),
            ymin: bounds.getSouth(),
            xmax: bounds.getEast(),
            ymax: bounds.getNorth(),
            spatialReference: { wkid: 4326 }
        })
        : null;

    const cacheKey = `${dataSource}:${computeBoundsKey(bounds)}`;
    const cacheAge = Date.now() - (gupRoadCache.timestamp || 0);
    if (!force && gupRoadCache.featureCollection && gupRoadCache.key === cacheKey && cacheAge < GUP_ROAD_CACHE_TTL) {
        return gupRoadCache.featureCollection;
    }

    let featureCollection = { type: 'FeatureCollection', features: [] };

    if (dataSource === 'localhost') {
        const builderOptions = { bboxHTRS };
        const params = typeof buildStreetRequestParams === 'function'
            ? buildStreetRequestParams(builderOptions)
            : null;
        const base = typeof getBackendBase === 'function' ? getBackendBase() : '';
        const url = params?.url || `${base ? base : 'http://localhost:3000'}/streets${bboxHTRS ? `?bbox=${encodeURIComponent(bboxHTRS)}` : ''}`;
        const data = await fetchJsonWithRetry(url);
        if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
            featureCollection = data;
        }
    } else {
        const features = [];
        const limit = 2000;
        let offset = 0;
        let more = true;
        let guard = 0;

        while (more && guard < 20) {
            const builderOptions = { limit, offset };
            if (geometryEnvelope) {
                builderOptions.geometry = geometryEnvelope;
                builderOptions.geometrySR = 4326;
            }
            const params = typeof buildStreetRequestParams === 'function'
                ? buildStreetRequestParams(builderOptions)
                : null;

            const baseParams = new URLSearchParams({
                where: '1=1',
                outFields: '*',
                outSR: '4326',
                f: 'geojson',
                returnGeometry: 'true',
                resultRecordCount: String(limit),
                resultOffset: String(offset)
            });
            if (geometryEnvelope) {
                baseParams.set('geometry', geometryEnvelope);
                baseParams.set('geometryType', 'esriGeometryEnvelope');
                baseParams.set('inSR', '4326');
                baseParams.set('spatialRel', 'esriSpatialRelIntersects');
            }
            const fallbackUrl = `${GUP_ARCGIS_DEFAULT_URL}?${baseParams.toString()}`;
            const url = params?.url || fallbackUrl;

            const chunk = await fetchJsonWithRetry(url);
            const chunkFeatures = Array.isArray(chunk?.features) ? chunk.features : [];
            features.push(...chunkFeatures);

            const exceeded = Boolean(chunk?.exceededTransferLimit || chunk?.properties?.exceededTransferLimit);
            if (!exceeded || chunkFeatures.length < limit) {
                more = false;
            } else {
                offset += limit;
                guard++;
            }
        }

        featureCollection = { type: 'FeatureCollection', features };
    }

    featureCollection.features = (featureCollection.features || []).filter(feature => {
        if (!feature || !feature.geometry) return false;
        const type = feature.geometry.type;
        return type === 'LineString' || type === 'MultiLineString';
    }).map((feature, index) => {
        const props = feature && typeof feature.properties === 'object' ? feature.properties : {};
        feature.properties = props;
        if (!props.id) {
            props.id = feature.id || props.OBJECTID || `gup_${index}`;
        }
        if (!props.name) {
            props.name = props.NAZIV || props.naziv || props.ULICA || props.ulica || props.Name || props.name || 'Unnamed GUP Road';
        }
        props.source = props.source || 'GUP';
        return feature;
    });

    gupRoadCache = {
        featureCollection,
        key: cacheKey,
        timestamp: Date.now()
    };

    return featureCollection;
}

function displayGUPRoads(geojson) {
    if (!geojson) return;
    window.gupRoadGeoJSON = geojson;
    if (gupRoadLayer) {
        if (map.hasLayer(gupRoadLayer)) {
            map.removeLayer(gupRoadLayer);
        }
    }
    gupRoadLayer = L.geoJSON(geojson, {
        style: {
            color: '#6a5acd',
            weight: 3,
            opacity: 0.7
        },
        onEachFeature: (feature, layer) => {
            const name = feature?.properties?.name || 'Unnamed GUP Road';
            layer.bindTooltip(name);
        }
    });
    window.gupRoadLayer = gupRoadLayer;
    const cb = document.getElementById('showGUPRoadLines');
    if (!cb || cb.checked) {
        gupRoadLayer.addTo(map);
    }
}

async function drawGUPRoads() {
    const button = document.querySelector('button[onclick="drawGUPRoads()"]');
    const run = async () => {
        updateStatus('Fetching GUP road data...');
        try {
            const roads = await fetchGUPRoads();
            if (!roads || !roads.features || roads.features.length === 0) {
                updateStatus('No GUP road data available for this view.');
                return;
            }
            displayGUPRoads(roads);
            const cb = document.getElementById('showGUPRoadLines');
            if (cb) {
                cb.checked = true;
                toggleGUPRoadLines();
            }
            updateStatus(`Displayed ${roads.features.length} GUP road segments.`);
        } catch (error) {
            console.error('Error drawing GUP roads:', error);
            updateStatus('Error drawing GUP road data.');
        }
    };

    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Loading...', run, { restoreFocus: true });
    }
    return run();
}

async function detectRoadsFromGUP() {
    if (!roadDetectionServices()) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const button = document.querySelector('button[onclick="detectRoadsFromGUP()"]');
    const execute = async () => {
        const progressContainer = document.getElementById('progressContainer');
        const progressText = document.getElementById('progressText');
        const progressFill = document.getElementById('progressFill');

        if (progressContainer) progressContainer.style.display = 'block';
        if (progressText) progressText.textContent = 'Fetching GUP street data...';

        try {
            const roads = await fetchGUPRoads();
            if (!roads || !roads.features || roads.features.length === 0) {
                updateStatus('No GUP road data available for detection.');
                return;
            }

            displayGUPRoads(roads);
            const cb = document.getElementById('showGUPRoadLines');
            if (cb) {
                cb.checked = true;
                toggleGUPRoadLines();
            }

            const parcelsInView = roadDetectionFeaturesInView();

            if (parcelsInView.length === 0) {
                updateStatus('No parcels in the current view to analyze.');
                return;
            }

            updateStatus(`Analyzing ${parcelsInView.length} parcels against GUP streets...`);
            if (progressText) progressText.textContent = 'Matching parcels to GUP streets...';
            if (progressFill) progressFill.style.width = '10%';

            const marked = await detectRoadsByOSMLinesFirst(parcelsInView, roads);
            updateParcelStyles();
            updateStatus(`GUP detection complete. Marked ${marked} parcels as roads.`);
        } catch (error) {
            console.error('Error detecting roads from GUP:', error);
            updateStatus('Error detecting roads using GUP data.');
        } finally {
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        }
    };

    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Detecting...', execute, { restoreFocus: true });
    }
    return execute();
}

function toggleGUPRoadLines() {
    const cb = document.getElementById('showGUPRoadLines');
    if (!cb) return;

    if (cb.checked) {
        if (gupRoadLayer) {
            gupRoadLayer.addTo(map);
        } else if (window.gupRoadGeoJSON) {
            displayGUPRoads(window.gupRoadGeoJSON);
        }
    } else if (gupRoadLayer) {
        map.removeLayer(gupRoadLayer);
    }
}

// Toggle OSM road lines visibility
function toggleOSMRoadLines() {
    const cb = document.getElementById('showOSMRoadLines');
    if (cb && window.osmRoadLayer) {
        if (cb.checked) {
            window.osmRoadLayer.addTo(map);
        } else {
            map.removeLayer(window.osmRoadLayer);
        }
    }
}

// Function to detect which parcels are roads based on OSM data
async function detectRoadsFromOSM() {
    if (!roadDetectionServices()) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const execute = async () => {
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        if (progressContainer) {
            progressContainer.style.display = 'block';
        }
        if (progressText) {
            progressText.textContent = 'Fetching OSM data...';
        }

        try {
            const osmData = await fetchOSMRoads();
            if (!osmData) {
                updateStatus('Failed to fetch OSM road data.');
                return;
            }

            const osmGeoJSON = osmToGeoJSON(osmData);
            displayOSMRoads(osmGeoJSON);

            const parcels = roadDetectionFeaturesInView();
            const totalParcels = parcels.length;
            if (totalParcels === 0) {
                updateStatus('No parcels in the current view to analyze.');
                return;
            }
            roadDetectionProgress = { current: 0, total: totalParcels };

            updateStatus(`Analyzing ${totalParcels} parcels...`);

            const foundRoads = await detectRoadsByOSMLinesFirst(parcels, osmGeoJSON);
            updateStatus(`Road detection complete. Found ${foundRoads} road parcels and assigned names.`);
            updateParcelStyles();
        } catch (error) {
            console.error('Error in road detection:', error);
            updateStatus(`Error in road detection: ${error.message}`);
        } finally {
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        }
    };

    const button = document.querySelector('button[onclick="detectRoadsFromOSM()"]');
    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Detecting...', execute);
    }
    return execute();
}

// Process road detection in chunks to prevent UI freezing
async function processRoadDetectionInChunks(parcels, osmGeoJSON) {
    const CHUNK_SIZE = 20;
    const totalParcels = parcels.length;
    let processedParcels = 0;
    let foundRoads = 0;

    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    for (let i = 0; i < totalParcels; i += CHUNK_SIZE) {
        const chunk = parcels.slice(i, i + CHUNK_SIZE);

        // Process this chunk
        for (const parcel of chunk) {
            try {
                foundRoads += await detectIfParcelIsRoad(parcel, osmGeoJSON) ? 1 : 0;
            } catch (error) {
                console.error(`Failed to process parcel:`, error);
                // Continue with next parcel rather than failing the entire process
            }
            processedParcels++;

            // Update progress
            const progress = Math.round((processedParcels / totalParcels) * 100);
            if (progressFill) {
                progressFill.style.width = `${progress}%`;
            }
            if (progressText) {
                progressText.textContent = `Analyzing parcels: ${processedParcels}/${totalParcels} (${progress}%)`;
            }
        }

        // Allow UI update before continuing to next chunk
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return foundRoads;
}

// Detect if a specific parcel is a road and assign road name
async function detectIfParcelIsRoad(parcel, osmGeoJSON) {
    try {
        if (!parcel || !parcel.geometry || !parcel.properties) {
            return false;
        }

        const parcelId = resolveParcelId(parcel);
        const parcelGeoJSON = parcel;

        // Skip shape analysis and use only OSM data for detection
        let isRoad = false;
        let bestRoadConfidence = 0;

        // Buffer the parcel to check for intersections (using Turf.js)
        let parcelBuffer;
        try {
            // Ensure the parcel GeoJSON is valid for buffering
            if (!parcelGeoJSON || !parcelGeoJSON.geometry || !parcelGeoJSON.geometry.coordinates ||
                parcelGeoJSON.geometry.coordinates.length === 0) {
                console.warn(`Skipping invalid parcel ${parcelId} - invalid geometry`);
                return false;
            }

            // Create a smaller buffer to be more precise (reduced from 5m to 2m)
            parcelBuffer = turf.buffer(parcelGeoJSON, 2, { units: 'meters' });

            // Verify buffer was created successfully
            if (!parcelBuffer || !parcelBuffer.geometry) {
                console.warn(`Failed to create buffer for parcel ${parcelId}`);
                return false;
            }
        } catch (error) {
            console.warn(`Error buffering parcel ${parcelId}:`, error);
            return false;
        }

        // Check intersections with OSM roads
        let maxOverlap = 0;
        for (const roadFeature of osmGeoJSON.features) {
            try {
                // Skip invalid road features
                if (!roadFeature || !roadFeature.geometry || !roadFeature.geometry.coordinates ||
                    roadFeature.geometry.coordinates.length < 2) {
                    continue;
                }

                // Create buffered road
                let bufferedRoad;
                try {
                    // Use a fixed small buffer size for more precision
                    bufferedRoad = turf.buffer(roadFeature, 3, { units: 'meters' });
                    if (!bufferedRoad || !bufferedRoad.geometry) {
                        continue; // Skip if buffer creation failed
                    }
                } catch (bufferError) {
                    console.warn(`Error buffering road ${roadFeature.properties?.id}:`, bufferError);
                    continue; // Skip this road and continue with others
                }

                // Calculate intersection with validation
                let intersection;
                try {
                    intersection = turf.intersect(parcelBuffer, bufferedRoad);
                } catch (intersectError) {
                    console.warn(`Error calculating intersection between parcel ${parcelId} and road:`, intersectError);
                    continue; // Skip this road and continue with others
                }

                if (intersection) {
                    // Calculate overlap ratio (more strict threshold)
                    const intersectionArea = turf.area(intersection);
                    const parcelArea = turf.area(parcelGeoJSON);
                    // Calculate the portion of the parcel covered by the buffered road.
                    const overlapRatioToParcel = intersectionArea / parcelArea;
                    const overlapRatio = overlapRatioToParcel;

                    if (overlapRatio > maxOverlap) {
                        maxOverlap = overlapRatio;
                        bestRoadConfidence = overlapRatio;
                    }

                    // Only consider it a road if there's SIGNIFICANT overlap (increased threshold)
                    if (overlapRatio > 0.5) {  // Increased from 0.3 to 0.5 for stricter matching
                        isRoad = true;
                    }
                }
            } catch (err) {
                // Skip errors in individual road comparisons
                console.warn(`Error comparing parcel ${parcelId} with road:`, err);
            }
        }

        // Save the result only if it's a road with good confidence
        if (isRoad && bestRoadConfidence > 0.5) {  // Increased confidence threshold from 0.3 to 0.5
            markRoadFeature(parcelGeoJSON);
        }

        return isRoad;
    } catch (error) {
        console.error('Error detecting if parcel is road:', error);
        return false;
    }
}

// Update styles for all parcels based on road detection
function updateParcelStyles() {
    const services = roadDetectionServices();
    if (!services) return;

    services.fabric.list().forEach(feature => {
        const parcelId = resolveParcelId(feature);
        if (!parcelId) return;
        const layer = services.presenter.getLayer(parcelId);
        if (!layer) return;
        const isRoad = feature.properties?.isRoad === true || isMarkedRoadFeature(feature);

        // Road parcels get no name labels — we care where roads are and how big, not what
        // they are called. Any tooltip a previous build bound is taken off here.
        const boundTooltip = layer.getTooltip?.();
        if (boundTooltip?.options?.className === 'road-name-tooltip') {
            layer.unbindTooltip();
        }
        const style = typeof window.getParcelBaseStyle === 'function'
            ? window.getParcelBaseStyle(parcelId, layer, { isRoad })
            : (isRoad ? roadStyle : normalStyle);
        layer.setStyle(style);
    });
}

// New: Iterate OSM lines first and mark intersecting parcels
async function detectRoadsByOSMLinesFirst(parcels, osmGeoJSON) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    // Build the prefilter from authoritative features, never from Leaflet's projection.
    const parcelEntries = parcels.map(feature => ({
        feature,
        bounds: roadDetectionFeatureBounds(feature)
    })).filter(entry => entry.bounds);

    const marked = new Set();
    let processed = 0;
    const total = (osmGeoJSON.features || []).length;

    for (const roadFeature of (osmGeoJSON.features || [])) {
        processed++;
        try {
            if (!roadFeature || !roadFeature.geometry || !roadFeature.geometry.coordinates) continue;

            // Buffer OSM line to a narrow corridor (3m) to intersect with parcels
            let bufferedRoad;
            try {
                bufferedRoad = turf.buffer(roadFeature, 3, { units: 'meters' });
                if (!bufferedRoad || !bufferedRoad.geometry) continue;
            } catch (_) { continue; }

            // Rough prefilter: compute bbox of buffered road
            const roadBounds = roadDetectionFeatureBounds(bufferedRoad);
            if (!roadBounds) continue;

            // Check only parcels whose bounds intersect this bbox
            const candidates = parcelEntries.filter(entry => roadDetectionBoundsIntersect(roadBounds, entry.bounds));

            for (const pe of candidates) {
                const parcelGeoJSON = pe.feature;
                let parcelBuffer;
                try {
                    parcelBuffer = turf.buffer(parcelGeoJSON, 2, { units: 'meters' });
                } catch (_) { continue; }

                let intersection = null;
                try {
                    intersection = turf.intersect(parcelBuffer, bufferedRoad);
                } catch (_) { }
                if (!intersection) continue;

                const intersectionArea = turf.area(intersection);
                const parcelArea = turf.area(parcelGeoJSON);
                const overlapRatio = intersectionArea / parcelArea;
                if (overlapRatio > 0.5) {
                    const parcelId = resolveParcelId(pe.feature);
                    if (!parcelId) continue;
                    if (markRoadFeature(pe.feature)) marked.add(parcelId);
                }
            }
        } catch (_) { }

        // Progress UI
        const pct = Math.round((processed / total) * 100);
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `Analyzing OSM lines: ${processed}/${total} (${pct}%)`;
        await new Promise(r => setTimeout(r, 0));
    }

    return marked.size;
}

// Function to clear all detected roads
function clearDetectedRoads() {
    const status = document.getElementById('status');

    const services = roadDetectionServices();
    if (!services) {
        updateStatus('No parcels to clear.');
        return;
    }

    // Get count before clearing
    const roadCount = getRoadParcelCount();

    // Clear the roadParcels array
    clearAllRoadParcels();

    // Update presentation by authoritative parcel id; no map-layer enumeration is a domain read.
    services.fabric.list().forEach(feature => {
        const parcelId = resolveParcelId(feature);
        const layer = parcelId ? services.presenter.getLayer(parcelId) : null;
        if (!layer) return;
        // Remove road styling
        const style = typeof window.getParcelBaseStyle === 'function'
            ? window.getParcelBaseStyle(parcelId, layer, { isRoad: feature.properties?.isRoad === true })
            : normalStyle;
        layer.setStyle(style);

        // Remove tooltip
        if (layer.getTooltip()) {
            layer.unbindTooltip();
        }

    });

    // Remove any OSM road layer
    if (osmRoadLayer) {
        map.removeLayer(osmRoadLayer);
        osmRoadLayer = null;
    }

    if (gupRoadLayer) {
        map.removeLayer(gupRoadLayer);
        gupRoadLayer = null;
        window.gupRoadLayer = null;
    }

    const gupCheckbox = document.getElementById('showGUPRoadLines');
    if (gupCheckbox) {
        gupCheckbox.checked = false;
    }

    updateStatus(`Cleared ${roadCount} road parcels.`);
}

// Run all available detection strategies sequentially and restore a clear map view when done
// ---------------------------------------------------------------------------
// Curated road source (city-config `curatedRoads`): the backend serves the parcels the
// road_parcel_classification materialized view already marked as roads (Zagreb only for now).
// One bbox fetch replaces the whole client-side OSM/GUP/WFS detection for such cities, and it
// auto-runs in the background after every parcel ingest so roads appear without the sidebar.
// ---------------------------------------------------------------------------

let curatedRoadFetchInFlight = false;
let curatedRoadFetchTimer = null;

function curatedRoadsConfig() {
    try { return window.CityConfigManager?.getCuratedRoadsConfig?.() || null; } catch (_) { return null; }
}

async function fetchCuratedRoadParcels() {
    const config = curatedRoadsConfig();
    if (!config?.url || typeof map === 'undefined' || !map) return 0;
    if (curatedRoadFetchInFlight) return 0;
    curatedRoadFetchInFlight = true;
    try {
        const bounds = map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
        const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        const response = await fetch(`${base}${config.url}?bbox=${encodeURIComponent(bbox)}`);
        if (!response.ok) throw new Error(`curated road source responded ${response.status}`);
        const collection = await response.json();
        let added = 0;
        (collection.features || []).forEach(feature => {
            const parcelId = feature?.properties?.parcelId;
            if (!parcelId) return;
            if (!isRoadParcel(parcelId)) {
                addRoadParcel(String(parcelId));
                added += 1;
            }
        });
        if (added > 0) updateParcelStyles();
        console.log(`[${new Date().toISOString()}] [curated-roads] ${collection.features?.length || 0} road parcels in view, ${added} newly marked`);
        return added;
    } finally {
        curatedRoadFetchInFlight = false;
    }
}

// Auto-run: parcels land in bursts per moveend, so debounce like the buildings viewport fetch.
function scheduleCuratedRoadRefresh() {
    if (!curatedRoadsConfig()) return;
    if (curatedRoadFetchTimer) clearTimeout(curatedRoadFetchTimer);
    curatedRoadFetchTimer = setTimeout(() => {
        curatedRoadFetchTimer = null;
        fetchCuratedRoadParcels().catch(error => console.error('[curated-roads] background fetch failed', error));
    }, 800);
}
window.addEventListener('parcelDataLoaded', scheduleCuratedRoadRefresh);
window.fetchCuratedRoadParcels = fetchCuratedRoadParcels;

async function detectExistingRoads() {
    const controlButton = document.getElementById('detectExistingRoadsButton');
    const originalLabel = controlButton ? controlButton.textContent : null;

    const sidebarDisableMessage = 'Detecting existing roads...';

    if (typeof window.setSidebarDisabled === 'function') {
        try { window.setSidebarDisabled(true, sidebarDisableMessage); } catch (_) { }
    }

    if (controlButton) {
        controlButton.disabled = true;
        controlButton.textContent = 'Detecting...';
    }

    try {
        // A curated source is authoritative: use it INSTEAD of the three client-side detectors.
        if (curatedRoadsConfig()?.url) {
            updateStatus('Loading existing roads from the curated source...');
            const added = await fetchCuratedRoadParcels();
            updateStatus(`Existing roads loaded — ${added} parcels newly marked as roads.`);
            return;
        }

        updateStatus('Detecting existing roads using all available sources...');

        await detectRoadsFromOSM();
        await detectRoadsFromGUP();
        await detectRoadsFromWFS();

        const osmCheckbox = document.getElementById('showOSMRoadLines');
        if (osmCheckbox) {
            osmCheckbox.checked = false;
            try { toggleOSMRoadLines(); } catch (_) {
                if (window.osmRoadLayer && map.hasLayer(window.osmRoadLayer)) {
                    map.removeLayer(window.osmRoadLayer);
                }
            }
        }

        const wfsCheckbox = document.getElementById('showWFSPolygons');
        if (wfsCheckbox) {
            wfsCheckbox.checked = false;
            try { toggleWFSPolygons(); } catch (_) {
                if (wfsRoadUseLayer && map.hasLayer(wfsRoadUseLayer)) {
                    map.removeLayer(wfsRoadUseLayer);
                }
            }
        } else if (wfsRoadUseLayer && map.hasLayer(wfsRoadUseLayer)) {
            map.removeLayer(wfsRoadUseLayer);
        }

        const gupCheckbox = document.getElementById('showGUPRoadLines');
        if (gupCheckbox) {
            gupCheckbox.checked = false;
            try { toggleGUPRoadLines(); } catch (_) {
                if (gupRoadLayer && map.hasLayer(gupRoadLayer)) {
                    map.removeLayer(gupRoadLayer);
                }
            }
        } else if (gupRoadLayer && map.hasLayer(gupRoadLayer)) {
            map.removeLayer(gupRoadLayer);
        }

    } catch (error) {
        console.error('Error detecting existing roads:', error);
        updateStatus('Error detecting existing roads using all sources.');
    } finally {
        if (typeof window.setSidebarDisabled === 'function') {
            try { window.setSidebarDisabled(false); } catch (_) { }
        }
        if (controlButton) {
            controlButton.textContent = originalLabel || 'Detect Existing Roads';
            controlButton.disabled = false;
        }
    }
}

window.detectExistingRoads = detectExistingRoads;
window.drawGUPRoads = drawGUPRoads;
window.detectRoadsFromGUP = detectRoadsFromGUP;
window.toggleGUPRoadLines = toggleGUPRoadLines;

// Function to draw OSM roads without parcel analysis
async function drawOSMRoads() {
    const status = document.getElementById('status');
    updateStatus('Fetching OSM road data...');

    try {
        // Fetch OSM road data
        const osmData = await fetchOSMRoads();
        if (!osmData) {
            updateStatus('Failed to fetch OSM road data.');
            return;
        }

        // Convert to GeoJSON
        const osmGeoJSON = osmToGeoJSON(osmData);

        // Display the OSM roads on the map
        displayOSMRoads(osmGeoJSON);

        // Ensure the checkbox is checked if we just drew the lines
        const cb = document.getElementById('showOSMRoadLines');
        if (cb) cb.checked = true;

        updateStatus(`Displayed ${osmGeoJSON.features.length} roads from OpenStreetMap`);
    } catch (error) {
        console.error('Error drawing OSM roads:', error);
        updateStatus(`Error drawing OSM roads: ${error.message}`);
    }
}
