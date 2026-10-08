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
        // Mirrors handleProposalRouteFromUrl (js/proposals/core.js): numeric id,
        // comma-separated ids, a named-plan slug, or its grain-score view. All of them load their own
        // ground via the share flow, so the boot viewport parcel fetch must stay
        // suppressed. Before the slug/comma forms were covered, opening a named
        // plan link fetched the DEFAULT city's viewport parcels (Manhattan)
        // while a Zagreb plan was loading.
        if (/^\/proposals\/[0-9,]+\/?$/i.test(path)) return true;
        if (/^\/proposals\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/?$/i.test(path)) return true;
        if (/^\/plans\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/score\/?$/i.test(path)) return true;
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
// buildingLayer draws the GDI footprints — the WORKING SET (object_id), the same objects the 3D
// meshes and the carve use. dguBuildingLayer draws the DGU cadastre (zgrada_id) as a pure visual
// reference. osmBuildingLayer draws the OSM footprints behind the basemap — a third visual
// reference that lines up with the tiles the user sees. They are independent: any of them can be on
// at once, which is how you SEE the surveys disagree. NONE is ever read by detection — that reads
// buildingFeaturePool (the DATA), so no checkbox can change what a corridor cuts.
let buildingLayer = null;
// Indexes for LOCAL outcome updates. Applying one park/road changes a handful of surveyed
// buildings; it must not discard and recreate every loaded footprint in the city.
let buildingFeatureById = new Map();
let buildingRenderedLayersById = new Map();
let renderedBuildingOutcomeSignatures = new Map();
let renderedBuildingFeatureSignatures = new Map();
let dguBuildingLayer = null;
let osmBuildingLayer = null;
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
const parcelSourceAttribution = CURRENT_CITY_CONFIG?.parcels?.attribution;
if (parcelSourceAttribution) map.attributionControl.addAttribution(parcelSourceAttribution);

const INITIAL_VIEW = CITY_MAP_CONFIG?.initialView || null;
const hasDefaultCenter = Array.isArray(CITY_MAP_CONFIG?.defaultCenter) && CITY_MAP_CONFIG.defaultCenter.length === 2;

// `?at=lat,lon,zoom` (the world view, the search box's "Open in <city>"): open the city at that
// view instead of its default. Read once and stripped from the URL, so a reload does not jump back.
// A proposal link frames its own proposal, so it ignores `at`. Invalid values are ignored.
const AT_VIEW = (() => {
    let raw = null;
    try { raw = new URLSearchParams(window.location.search || '').get('at'); } catch (_) { return null; }
    if (raw === null) return null;
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('at');
        window.history.replaceState(window.history.state, '', url.toString());
    } catch (error) {
        console.warn(`[${new Date().toISOString()}] [map-core] could not strip ?at= from the URL`, error);
    }
    const view = window.WorldEntryModel ? window.WorldEntryModel.parseAt(raw) : null;
    if (!view) console.warn(`[${new Date().toISOString()}] [map-core] ignoring invalid ?at=${raw}`);
    return view;
})();

if (AT_VIEW && !IS_PROPOSAL_DEEP_LINK) {
    map.setView([AT_VIEW.lat, AT_VIEW.lon], Number.isFinite(AT_VIEW.zoom) ? AT_VIEW.zoom : resolveInitialZoom());
} else if (IS_PROPOSAL_DEEP_LINK) {
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

// Add scale control. Bottom-RIGHT, above the shell's bottom button row (css/map.css places it); the
// lower left belongs to the 2D/3D mode strip. It hides while a docked panel covers that corner.
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

// EPSG:3857 inverse from Web Mercator metres (not Leaflet CRS pixel coords — unproject() uses scale at z0).
function tryWebMercatorMetersToLatLng(easting, northing) {
    try {
        const R = 6378137;
        if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
        const lon = (easting / R) * (180 / Math.PI);
        const lat = (2 * Math.atan(Math.exp(northing / R)) - Math.PI / 2) * (180 / Math.PI);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return [lat, lon];
    } catch (_) {
        return null;
    }
}

// Convert the city's METRIC working coordinates (metres) to WGS84.
//
// Named for Croatia's HTRS96/TM because Zagreb came first, but the projection is per-city and, since
// the metric split, no longer the city's *dataset* CRS: New York's parcels arrive in degrees while its
// geometry works in UTM 18N metres. Everything that offsets, buffers, measures or unions in "metres"
// goes through this pair. See city-config.js `metricCrs`.
//
// If the input already looks like WGS84 (lng/lat range), return it directly.
function htrs96ToWGS84(easting, northing) {
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
        console.error('Invalid city dataset coordinates:', easting, northing);
        return DEFAULT_FALLBACK_LATLNG;
    }
    // Detect coordinates already in WGS84 — projected CRS values are far larger
    if (Math.abs(easting) <= 180 && Math.abs(northing) <= 90) {
        return [northing, easting];
    }
    const bounds = CURRENT_CITY_CONFIG?.projection?.datasetBounds;
    if (bounds) {
        const outOfBounds = easting < bounds.minX || easting > bounds.maxX || northing < bounds.minY || northing > bounds.maxY;
        if (outOfBounds) {
            const merc = tryWebMercatorMetersToLatLng(easting, northing);
            if (merc) {
                return merc;
            }
            if (typeof window !== 'undefined' && window.__DEBUG_COORD_TRANSFORM__) {
                // Throttle to prevent console flooding when corrupted geometries hit this path
                // (e.g. legacy turf.buffer-on-HTRS96 output before the road-drawing.js fix).
                window._outOfBoundsWarnCount = window._outOfBoundsWarnCount || 0;
                if (window._outOfBoundsWarnCount < 20) {
                    console.warn(`Dataset coordinates outside configured bounds: ${easting} ${northing}`);
                    window._outOfBoundsWarnCount++;
                    if (window._outOfBoundsWarnCount === 20) {
                        console.warn('Dataset coordinates outside bounds warning threshold reached. Silencing further warnings.');
                    }
                }
            }
            return DEFAULT_FALLBACK_LATLNG;
        }
    }
    try {
        const converter = MapCityConfigManager
            ? (MapCityConfigManager.metricToLatLng || MapCityConfigManager.datasetToLatLng)
            : null;
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

// Convert WGS84 coordinates to the city's METRIC working coordinates (metres). See htrs96ToWGS84.
function wgs84ToHTRS96(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.error('Invalid WGS84 coordinates:', lat, lon);
        return DEFAULT_FALLBACK_DATASET;
    }
    try {
        const converter = MapCityConfigManager
            ? (MapCityConfigManager.latLngToMetric || MapCityConfigManager.latLngToDataset)
            : null;
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

// The DATASET pair, distinct from the metric pair above since the split.
//
// Parcels arrive in the city's dataset CRS, and the grid cache buckets them by `gridSize` expressed in
// *that* CRS's units (metres for Zagreb, degrees for New York). Feeding those consumers metric metres
// made a New York grid cell 1/0.005 ≈ 200× too small, so a single viewport asked for ~10^8 cells and
// the Set that collects them threw "maximum size exceeded" before any parcel was fetched. Anything that
// touches parcel storage coordinates or grid cells uses this pair; anything that measures uses the
// metric one.
function datasetToWgs84(easting, northing) {
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) return DEFAULT_FALLBACK_LATLNG;
    if (Math.abs(easting) <= 180 && Math.abs(northing) <= 90) return [northing, easting];
    try {
        const converter = MapCityConfigManager ? MapCityConfigManager.datasetToLatLng : null;
        const [lat, lon] = converter ? converter(easting, northing) : [northing, easting];
        return (Number.isFinite(lat) && Number.isFinite(lon)) ? [lat, lon] : DEFAULT_FALLBACK_LATLNG;
    } catch (_) {
        return DEFAULT_FALLBACK_LATLNG;
    }
}

function wgs84ToDataset(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DEFAULT_FALLBACK_DATASET;
    try {
        const converter = MapCityConfigManager ? MapCityConfigManager.latLngToDataset : null;
        const [easting, northing] = converter ? converter(lat, lon) : [lon, lat];
        return (Number.isFinite(easting) && Number.isFinite(northing)) ? [easting, northing] : DEFAULT_FALLBACK_DATASET;
    } catch (_) {
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

// Areas already fetched into the footprint pool. Corridor tools consult this to load buildings
// along the DRAWN geometry — the pool otherwise only covers viewports the user happened to view,
// and buildings never loaded can never be detected, prompted for, or demolished.
const buildingFetchCoverage = [];

function boundsCoveredByBuildingFetch(bounds) {
    try {
        return buildingFetchCoverage.some(rect => rect.contains(bounds));
    } catch (_) {
        return false;
    }
}

// Ensure footprints exist for `bounds` (an L.LatLngBounds or anything L.latLngBounds accepts).
// Fetches with generous padding so neighbouring corridor edges reuse one fetch.
async function ensureBuildingFootprintsForBounds(rawBounds) {
    if (!rawBounds) return;
    try {
        const config = (typeof CityConfigManager !== 'undefined') ? CityConfigManager.getCurrentCityConfig?.() : null;
        if (config?.buildings?.source === 'none') return;
    } catch (_) { }
    let bounds = null;
    try { bounds = L.latLngBounds(rawBounds); } catch (_) { return; }
    if (!bounds || !bounds.isValid()) return;
    if (boundsCoveredByBuildingFetch(bounds)) return;
    await fetchBuildings(bounds.pad(0.5));
}
window.ensureBuildingFootprintsForBounds = ensureBuildingFootprintsForBounds;

// The city whose existing stock is served by its own provider rather than by the GDI bbox layer.
// Null for Zagreb (GDI) and for cities that have declared they have no buildings at all.
function footprintProviderCity() {
    try {
        const manager = (typeof CityConfigManager !== 'undefined') ? CityConfigManager : null;
        if (!manager || typeof manager.getCurrentCityId !== 'function') return null;
        const config = manager.getCurrentCityConfig ? manager.getCurrentCityConfig() : null;
        const source = (config && config.buildings) ? config.buildings.source : null;
        if (!source || source === 'none' || source === 'gdi') return null;
        return manager.getCurrentCityId() || null;
    } catch (_) { return null; }
}

// The GDI bbox layer: EPSG:3765 out of the backend, so it is declared and converted.
async function loadGdiFootprints(req) {
    const response = await fetch(req.url);
    if (!response.ok) throw new Error('Failed to fetch building data');
    const data = await response.json();
    const converted = typeof convertGeoJSON === 'function' ? convertGeoJSON(data, { sourceSrid: 3765 }) : data;
    return { features: (converted && converted.features) || [], truncated: data && data.truncated === true };
}

// The per-city provider: the same POST /buildings/footprints the urban-rule editor reads, already
// in WGS84. Its ids land on `properties.id`, which is exactly what corridor-tunnel's building
// identity accepts for the non-Zagreb sources — so a road cuts, tunnels under and demolishes these
// the same way it does GDI objects.
async function loadProviderFootprints(bounds, city) {
    const base = (typeof getBackendBase === 'function') ? getBackendBase() : '';
    const west = bounds.getWest(), south = bounds.getSouth(), east = bounds.getEast(), north = bounds.getNorth();
    const geometry = {
        type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    };
    const response = await fetch(`${base}/buildings/footprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry, city, source: CityConfigManager.getBuildingSourceId?.() })
    });
    if (!response.ok) throw new Error('Failed to fetch building footprints');
    const payload = await response.json();
    // A city with no footprint capability is not an error and not worth a status line about zero.
    if (!payload || payload.supported === false) return null;
    // The upstream failed outright (OSM throttling, a user's source down): an empty answer here is
    // not "no buildings", and must not be merged or claimed as covered.
    if (payload.unavailable) throw Object.assign(new Error('Building source unavailable'), { unavailable: true, retryAfter: payload.retryAfter ?? null });
    const features = (payload.footprints || [])
        .filter(entry => entry && entry.geometry)
        .map(entry => ({
            type: 'Feature',
            properties: {
                id: entry.id,
                height_m: (typeof entry.height_m === 'number' && Number.isFinite(entry.height_m)) ? entry.height_m : null,
                floors: (typeof entry.floors === 'number' && Number.isFinite(entry.floors)) ? entry.floors : null,
                source: payload.source || null
            },
            geometry: entry.geometry
        }));
    return { features, truncated: payload.truncated === true };
}

// A building load whose upstream failed (throttled OpenStreetMap, a person's own source down): said in
// the building banner, with Retry and the source chooser, never silently. Viewport loads then wait
// out the upstream's own retry time instead of asking again on every pan.
let buildingsRetryAt = 0;
// `fromOsm` marks a failure of the OpenStreetMap reference layer, which is OSM whatever the city uses.
function reportBuildingsUnavailable(retryAfter, retry, fromOsm = false) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) buildingsRetryAt = Date.now() + seconds * 1000;
    console.warn(`[${new Date().toISOString()}] [buildings] building data unavailable${seconds > 0 ? `; retry in ${seconds}s` : ''}`);
    const settings = window.ParcelSourceSettings;
    if (!settings || typeof settings.reportFailure !== 'function') return;
    const manager = window.CityConfigManager;
    let origin = 'other';
    try {
        if (fromOsm) origin = 'osm';
        else if (manager?.getBuildingSourceId?.()) origin = 'custom';
        else if (manager?.getCurrentCityConfig?.()?.buildings?.source === 'osm') origin = 'osm';
    } catch (_) { /* the generic wording is still true */ }
    settings.reportFailure(window, settings.buildingFailureMessage(window, { retryAfter: seconds > 0 ? seconds : null, origin }), 'building', retry);
}
window.reportBuildingsUnavailable = reportBuildingsUnavailable;
function clearBuildingsUnavailable() {
    buildingsRetryAt = 0;
    window.ParcelSourceSettings?.clearFailure?.(window, 'building');
}
window.clearBuildingsUnavailable = clearBuildingsUnavailable;

// Fetch buildings from data source. With `boundsOverride` (L.LatLngBounds) the fetch targets that
// area regardless of zoom — used by corridor tools to cover drawn geometry; without it, the
// current viewport is fetched (zoom-gated so a city-wide view never requests everything).
//
// `announce` is what the user ASKED FOR, and only that talks. Ticking the reference layer on is a
// request to see buildings and says so; a demolition scan preloading the ground under a proposal is
// not, and on a reload of a big plan it fired once per proposal — which is why the status log filled
// with "Fetching buildings..." on a Ctrl+R with the layer switched off. The pool is still filled
// either way: what a road demolishes must never depend on a display toggle, and the LAYER already
// respects it (rebuildBuildingLayerFromPool only adds it to the map when the box is checked).
async function fetchBuildings(boundsOverride = null, options = {}) {
    const announce = options && options.announce === true;
    // Zoom-gated at the BOTTOM only: below 17 the viewport is a whole city and the request is
    // enormous. There is no ceiling — zooming in asks for LESS, and a ceiling of 19 meant that road
    // editing (which now zooms to 22) silently stopped loading buildings, so ticking the box did
    // nothing and the profiler measured against whatever had loaded before.
    if (!boundsOverride) {
        try {
            const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
            if (!isFinite(z) || z < 17) {
                return;
            }
        } catch (_) { /* noop */ }
    }
    // Decide whether there is anything to ask for BEFORE announcing it. This used to say "Fetching
    // buildings..." first and then discover the city has no GDI dataset — so a reload replaying a
    // hundred corridors wrote two lines per corridor about a fetch that never happened.
    let bounds = null;
    let bbox = null;
    try {
        bounds = boundsOverride || map.getBounds();
        bbox = getBboxFromBounds(bounds);
    } catch (_) { return; }
    const builder = (typeof buildBuildingRequestParams === 'function') ? buildBuildingRequestParams : null;
    const req = builder ? builder(bbox, 'gdi') : null;
    // GDI is the Zagreb survey. Everywhere else the existing stock comes from the city's own
    // provider (Overture for Šibenik/Split/Belgrade, Socrata for NYC), served by the same
    // POST /buildings/footprints the urban-rule editor reads. There is no WFS fallback — the WFS
    // serves the CADASTRE, which is a different survey and must never enter this pool.
    const providerCity = req ? null : footprintProviderCity();
    if (!req && !providerCity) return;
    // Inside the upstream's back-off a viewport pan asks for nothing; a tool covering its own
    // geometry still asks (the backend answers from its cache or says unavailable at once).
    if (!boundsOverride && Date.now() < buildingsRetryAt) return;

    // "Buildings" here are the SURVEYED ones — the existing-building reference layer for the current
    // viewport, nothing to do with proposals. Said plainly, because these two lines sit in the same
    // status log as the proposal applies and "Loaded 0 buildings" next to "Applied building ..."
    // reads like a proposal produced nothing.
    if (announce && typeof updateStatus === 'function') {
        updateStatus('Fetching existing buildings...');
    }

    try {
        const loaded = req
            ? await loadGdiFootprints(req)
            : await loadProviderFootprints(bounds, providerCity);
        if (!loaded) return;
        const data = { truncated: loaded.truncated };
        const convertedData = { type: 'FeatureCollection', features: loaded.features };

        // MERGE with what's already loaded instead of replacing it: the fetch covers only the
        // requested bbox (cap-limited), so replacing left a single-viewport patch and panning
        // "lost" buildings. Dedupe by object_id. Same identity as demolition records use
        // (corridor-tunnel.js) — the two MUST agree, or click-time decisions stop matching
        // the pool.
        const buildingKeyOf = (feature) => {
            if (typeof window.corridorBuildingKey === 'function') return window.corridorBuildingKey(feature);
            const props = feature?.properties || {};
            const direct = props.object_id ?? props.objectId ?? props.OBJECT_ID ?? props.id ?? feature?.id;
            if (direct !== undefined && direct !== null && String(direct)) return String(direct);
            try { return JSON.stringify(feature?.geometry?.coordinates?.[0]?.[0] || feature?.geometry?.coordinates || ''); } catch (error) {
                console.error('[fetchBuildings] building has no id and unserializable geometry — dedup disabled for it', error);
                return Math.random().toString(36);
            }
        };
        // Merge onto the POOL, not onto the layer: the layer is a filtered, visibility-dependent
        // VIEW of the pool (demolished buildings are dropped from it), so rebuilding the pool from
        // it would quietly delete every demolished building from the working set.
        const mergedById = new Map();
        (Array.isArray(window.buildingFeaturePool) ? window.buildingFeaturePool : []).forEach(feature => {
            if (feature?.geometry) mergedById.set(buildingKeyOf(feature), feature);
        });
        (convertedData?.features || []).forEach(feature => {
            if (feature?.geometry) mergedById.set(buildingKeyOf(feature), feature);
        });
        let mergedFeatures = Array.from(mergedById.values());
        const BUILDING_POOL_CAP = 12000;
        if (mergedFeatures.length > BUILDING_POOL_CAP) {
            // Keep the newest fetches: drop from the front (oldest insertions first in Map order).
            mergedFeatures = mergedFeatures.slice(mergedFeatures.length - BUILDING_POOL_CAP);
            // Coverage describes what is PRESENT in the pool, not merely what was fetched once.
            // Evicting features while retaining their old coverage made later corridor scans skip
            // the refetch and then conclude that the evicted buildings did not exist.
            buildingFetchCoverage.length = 0;
        }
        // The full pool survives demolition filtering, so unapplying the road brings them back.
        window.buildingFeaturePool = mergedFeatures;
        // A fetch that hit the cap was TRUNCATED — it must not claim its bbox as covered, or the
        // corridor preload would trust a hole-riddled area and a building that never loaded would
        // never be detected and so never be demolished. The backend says so explicitly.
        try {
            if (!data?.truncated) {
                buildingFetchCoverage.push(L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast()));
            } else {
                console.warn('[fetchBuildings] response truncated — bbox not fully covered', bbox);
            }
        } catch (_) { }
        rebuildBuildingLayerFromPool();

        // Notify other modules (e.g., 3D) that buildings layer has updated
        try { window.buildingLayer = buildingLayer; } catch (_) { }
        try { window.dispatchEvent(new CustomEvent('buildingsLayerUpdated')); } catch (_) { }

        clearBuildingsUnavailable();
        if (announce && typeof updateStatus === 'function') {
            const surveyed = loaded.features.length;
            updateStatus(surveyed
                ? `Loaded ${surveyed} existing buildings`
                : 'No existing buildings surveyed here');
        }
    } catch (error) {
        // A failure is always worth saying, asked for or not: a silent one leaves a road cutting
        // against a pool that never loaded.
        console.error('Error fetching building data:', error);
        if (typeof updateStatus === 'function') {
            updateStatus('Error fetching building data. Please try again.');
        }
        reportBuildingsUnavailable(error && error.retryAfter, () => {
            buildingsRetryAt = 0;
            fetchBuildings(boundsOverride, { announce: true });
        });
    }
}

// The DGU CADASTRE reference layer — what is REGISTERED, as opposed to the GDI footprints above,
// which are what is actually THERE. Purely visual: it feeds nothing, is never detected against and
// is never cut. Overlaying it on the GDI layer is how the two surveys' disagreement becomes visible.
async function fetchDguBuildings(boundsOverride = null) {
    // Bottom-gated only, like the GDI fetch above: a ceiling would blank the layer exactly where
    // the work is closest.
    if (!boundsOverride) {
        try {
            const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
            if (!isFinite(z) || z < 17) return;
        } catch (_) { /* noop */ }
    }
    try {
        const bounds = boundsOverride || map.getBounds();
        const builder = (typeof buildBuildingRequestParams === 'function') ? buildBuildingRequestParams : null;
        const req = builder ? builder(getBboxFromBounds(bounds), 'dgu') : null;
        if (!req) return;

        const response = await fetch(req.url);
        if (!response.ok) throw new Error('Failed to fetch DGU building data');
        const data = await response.json();
        const converted = typeof convertGeoJSON === 'function' ? convertGeoJSON(data, { sourceSrid: 3765 }) : data;

        if (dguBuildingLayer) {
            try { map.removeLayer(dguBuildingLayer); } catch (_) { }
        }
        dguBuildingLayer = L.geoJSON({ type: 'FeatureCollection', features: (converted?.features || []) }, {
            // Reference only: it must never intercept clicks meant for the parcels beneath it.
            interactive: false,
            style: window.BuildingLayersDialog?.style || { color: '#7c3aed', opacity: 0.55, weight: 1, fillColor: '#7c3aed', fillOpacity: 0.12 }
        });
        const checkbox = document.getElementById('showBuildingsDgu');
        if (!checkbox || checkbox.checked) dguBuildingLayer.addTo(map);
        try { window.dguBuildingLayer = dguBuildingLayer; } catch (_) { }
    } catch (error) {
        console.error('Error fetching DGU building data:', error);
    }
}
window.fetchDguBuildings = fetchDguBuildings;

function hideDguBuildingLayer() {
    if (dguBuildingLayer) {
        try { map.removeLayer(dguBuildingLayer); } catch (_) { }
    }
}
window.hideDguBuildingLayer = hideDguBuildingLayer;

// The OSM buildings reference layer — the community footprints behind the basemap, so its outlines
// coincide with the tiles the user sees (GDI/DGU come from other surveys and drift from them). Live
// via Overpass through our backend (cached by viewport box), and like DGU it is purely visual: it
// feeds nothing, is never detected against and is never cut. The bbox is WGS84 straight off the map
// bounds — no HTRS96 conversion, unlike the GDI/DGU fetches.
// When the backend says Overpass is throttling us it also says for how long. Asking again inside
// that window is what turned a slow layer into a dead one, so the fetch simply does not run — and it
// says so ONCE, not once per pan.
let osmBuildingsRetryAt = 0;

// While the upstream is rate-limited nothing new can load, but a layer already fetched is still
// worth showing: unticking and re-ticking the box used to leave the map empty for the back-off.
function showFetchedOsmBuildingLayer() {
    const checkbox = document.getElementById('showBuildingsOsm');
    if (osmBuildingLayer && (!checkbox || checkbox.checked) && !map.hasLayer(osmBuildingLayer)) {
        osmBuildingLayer.addTo(map);
    }
}

async function fetchOsmBuildings(boundsOverride = null) {
    if (Date.now() < osmBuildingsRetryAt) {
        showFetchedOsmBuildingLayer();
        return;
    }
    // Bottom-gated only, like the GDI fetch above: a ceiling would blank the layer exactly where
    // the work is closest.
    if (!boundsOverride) {
        try {
            const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
            if (!isFinite(z) || z < 17) return;
        } catch (_) { /* noop */ }
    }
    try {
        const bounds = boundsOverride || map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
        const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        // The city decides whether this can be served from the staged Overture rows in shared
        // geodata (instant) or has to go out to Overpass (rate-limited).
        const cityId = (window.CityConfigManager && typeof window.CityConfigManager.getCurrentCityId === 'function')
            ? window.CityConfigManager.getCurrentCityId()
            : '';
        const url = `${base.replace(/\/$/, '')}/buildings/osm?bbox=${encodeURIComponent(bbox)}`
            + (cityId ? `&city=${encodeURIComponent(cityId)}` : '');

        const response = await fetch(url);
        if (response.status === 503) {
            const body = await response.json().catch(() => ({}));
            const seconds = Number(body.retryAfter) > 0 ? Number(body.retryAfter) : 60;
            osmBuildingsRetryAt = Date.now() + seconds * 1000;
            console.warn(`[buildings] OSM reference is rate-limited upstream; not asking again for ${seconds}s`);
            showFetchedOsmBuildingLayer();
            reportBuildingsUnavailable(seconds, () => { osmBuildingsRetryAt = 0; fetchOsmBuildings(boundsOverride); }, true);
            return;
        }
        if (!response.ok) throw new Error(`Failed to fetch OSM building data (HTTP ${response.status})`);
        const data = await response.json();

        if (osmBuildingLayer) {
            try { map.removeLayer(osmBuildingLayer); } catch (_) { }
        }
        osmBuildingLayer = L.geoJSON({ type: 'FeatureCollection', features: (data?.features || []) }, {
            // Reference only: it must never intercept clicks meant for the parcels beneath it.
            interactive: false,
            style: window.BuildingLayersDialog?.style || { color: '#7c3aed', opacity: 0.55, weight: 1, fillColor: '#7c3aed', fillOpacity: 0.12 }
        });
        const checkbox = document.getElementById('showBuildingsOsm');
        if (!checkbox || checkbox.checked) osmBuildingLayer.addTo(map);
        try { window.osmBuildingLayer = osmBuildingLayer; } catch (_) { }
        clearBuildingsUnavailable();
    } catch (error) {
        console.error('Error fetching OSM building data:', error);
        reportBuildingsUnavailable(null, () => fetchOsmBuildings(boundsOverride), true);
    }
}
window.fetchOsmBuildings = fetchOsmBuildings;

function hideOsmBuildingLayer() {
    if (osmBuildingLayer) {
        try { map.removeLayer(osmBuildingLayer); } catch (_) { }
    }
}
window.hideOsmBuildingLayer = hideOsmBuildingLayer;

function buildingPoolFeatureKey(feature) {
    if (typeof window.corridorBuildingKey === 'function') return window.corridorBuildingKey(feature);
    const props = feature?.properties || {};
    const direct = props.object_id ?? props.objectId ?? props.OBJECT_ID ?? props.id ?? feature?.id;
    return (direct !== undefined && direct !== null) ? String(direct) : '';
}

function currentBuildingOutcomeState() {
    const demolishedById = new Map();
    collectDemolishedBuildingRecords().forEach(record => {
        if (record && record.id) demolishedById.set(String(record.id), record);
    });
    const tunnelledIds = (typeof window.collectTunnelledBuildingIds === 'function')
        ? window.collectTunnelledBuildingIds() : new Set();
    return {
        demolishedById,
        tunnelledIds,
        affectedIds: new Set([...demolishedById.keys(), ...tunnelledIds])
    };
}

function buildingOutcomeSignatures(state) {
    const signatures = new Map();
    state.affectedIds.forEach(id => {
        const record = state.demolishedById.get(id);
        if (!record) {
            signatures.set(id, 'tunnelled');
            return;
        }
        try {
            signatures.set(id, JSON.stringify([
                record.remainder ? 'cut' : 'destroyed',
                record.geometry || null,
                record.demolishedPart || null,
                record.remainder || null
            ]));
        } catch (_) {
            signatures.set(id, record.remainder ? 'cut' : 'destroyed');
        }
    });
    return signatures;
}

function buildingFeatureWithOutcome(feature, state) {
    const id = buildingPoolFeatureKey(feature);
    const record = state.demolishedById.get(id);
    const classify = (typeof window.classifyBuildingOutcome === 'function') ? window.classifyBuildingOutcome : null;
    const outcome = classify
        ? classify(id, state)
        : (record ? (record.remainder ? 'cut' : 'destroyed') : (state.tunnelledIds.has(id) ? 'tunnelled' : null));
    const geometry = (record && record.remainder) ? record.remainder : feature.geometry;
    return { ...feature, geometry, properties: { ...(feature.properties || {}), __outcome: outcome } };
}

function reconcileBuildingFeatureEntries(previousSignatures, features, getId, prepareFeature, signatureOf) {
    const nextSignatures = new Map();
    const nextFeatures = new Map();
    const changed = [];
    for (const source of features) {
        const id = getId(source);
        if (!id || !source?.geometry) continue;
        const feature = prepareFeature(source);
        const signature = signatureOf(feature);
        nextSignatures.set(id, signature);
        nextFeatures.set(id, source);
        if (previousSignatures.get(id) !== signature) changed.push({ id, feature });
    }
    const removed = [];
    previousSignatures.forEach((_signature, id) => {
        if (!nextSignatures.has(id)) removed.push(id);
    });
    return { nextSignatures, nextFeatures, changed, removed };
}

function stableBuildingFeatureSignature(feature, style = null) {
    // Hash the canonical JSON walk in place: retaining serialized copies of up to 12k building
    // geometries doubled a large part of the pool just to avoid repainting unchanged features.
    let first = 2166136261;
    let second = 0x9e3779b9;
    const write = text => {
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619) >>> 0;
            second = Math.imul(second ^ code, 2246822519) >>> 0;
        }
    };
    const visit = value => {
        if (Array.isArray(value)) {
            write('[');
            value.forEach((entry, index) => { if (index) write(','); visit(entry); });
            write(']');
        } else if (value && typeof value === 'object') {
            write('{');
            const keys = Object.keys(value).filter(key => {
                const type = typeof value[key];
                return type !== 'undefined' && type !== 'function' && type !== 'symbol';
            }).sort();
            keys.forEach((key, index) => {
                if (index) write(',');
                write(JSON.stringify(key));
                write(':');
                visit(value[key]);
            });
            write('}');
        } else {
            const encoded = JSON.stringify(value);
            write(encoded === undefined ? 'null' : encoded);
        }
    };
    visit({ feature, style });
    return `${first.toString(16).padStart(8, '0')}:${second.toString(16).padStart(8, '0')}`;
}

function buildingStyleForFeature(feature) {
    return (typeof window.buildingOutcomeStyle === 'function')
        ? window.buildingOutcomeStyle(feature?.properties?.__outcome)
        : (window.BuildingLayersDialog?.style || { color: '#7c3aed', opacity: 0.55, weight: 1, fillColor: '#7c3aed', fillOpacity: 0.12 });
}

function applyBuildingFeatureLayerChanges(layerGroup, layersById, changes) {
    changes.removed.concat(changes.changed.map(entry => entry.id)).forEach(id => {
        (layersById.get(id) || []).forEach(layer => layerGroup.removeLayer(layer));
        layersById.delete(id);
    });
    changes.changed.forEach(entry => layerGroup.addData(entry.feature));
}

function buildingLayerOptions() {
    return {
        // Context only: existing buildings must never intercept clicks meant for the parcels
        // beneath them (they are inspectable in 3D, not in 2D).
        interactive: false,
        style: buildingStyleForFeature,
        onEachFeature: (feature, layer) => {
            const id = buildingPoolFeatureKey(feature);
            if (!id) return;
            const layers = buildingRenderedLayersById.get(id) || [];
            layers.push(layer);
            buildingRenderedLayersById.set(id, layers);
        }
    };
}

// Rebuild the visible 2D GDI building layer from the pooled features. This is appropriate when a
// footprint FETCH changes the pool. Proposal application uses refreshBuildingOutcomesFromRecords
// below, which replaces only the buildings whose demolition/tunnel outcome changed.
//
// This is a VIEW of the pool, never the other way round. The pool is the working set and stays
// complete; only how each building is DRAWN is decided here. The persistent outcome colour scheme:
// destroyed = dashed red outline (kept visible so the road reads through), cut = orange remainder,
// tunnelled = yellow, untouched = blue (see buildingOutcomeStyle in corridor-tunnel.js).
function rebuildBuildingLayerFromPool() {
    const pool = Array.isArray(window.buildingFeaturePool) ? window.buildingFeaturePool : [];
    const state = currentBuildingOutcomeState();
    const changes = reconcileBuildingFeatureEntries(
        renderedBuildingFeatureSignatures,
        pool,
        buildingPoolFeatureKey,
        feature => buildingFeatureWithOutcome(feature, state),
        feature => stableBuildingFeatureSignature(feature, buildingStyleForFeature(feature))
    );
    // The Layers-sheet checkbox is the source of truth for visibility. Deciding from "was the old
    // layer on the map" broke the show-buildings toggle: the corridor preload fills the pool and
    // rebuilds the layer OFF-map while the box is unticked, and the next tick inherited hidden.
    const checkbox = document.getElementById('showBuildings');
    const shouldShow = checkbox ? checkbox.checked : (buildingLayer ? map.hasLayer(buildingLayer) : true);
    if (!buildingLayer) {
        buildingLayer = L.geoJSON(null, buildingLayerOptions());
        buildingRenderedLayersById = new Map();
    }
    applyBuildingFeatureLayerChanges(buildingLayer, buildingRenderedLayersById, changes);
    buildingFeatureById = changes.nextFeatures;
    renderedBuildingFeatureSignatures = changes.nextSignatures;
    renderedBuildingOutcomeSignatures = buildingOutcomeSignatures(state);
    if (shouldShow && !map.hasLayer(buildingLayer)) buildingLayer.addTo(map);
    else if (!shouldShow && map.hasLayer(buildingLayer)) map.removeLayer(buildingLayer);
    try { window.buildingLayer = buildingLayer; } catch (_) { }
}
window.rebuildBuildingLayerFromPool = rebuildBuildingLayerFromPool;

// A proposal only changes outcome records for buildings under its own geometry. Compare the ids
// represented before and after the mutation, then replace those Leaflet features in place. The
// untouched thousands never leave the layer and never pay GeoJSON parsing/styling again.
function refreshBuildingOutcomesFromRecords() {
    const state = currentBuildingOutcomeState();
    const nextSignatures = buildingOutcomeSignatures(state);
    const changedIds = new Set();
    renderedBuildingOutcomeSignatures.forEach((signature, id) => {
        if (nextSignatures.get(id) !== signature) changedIds.add(id);
    });
    nextSignatures.forEach((signature, id) => {
        if (renderedBuildingOutcomeSignatures.get(id) !== signature) changedIds.add(id);
    });
    renderedBuildingOutcomeSignatures = nextSignatures;
    if (!buildingLayer || !changedIds.size) return;

    changedIds.forEach(id => {
        const oldLayers = buildingRenderedLayersById.get(id) || [];
        oldLayers.forEach(layer => {
            try { buildingLayer.removeLayer(layer); } catch (_) { }
        });
        buildingRenderedLayersById.delete(id);

        const source = buildingFeatureById.get(id);
        if (!source?.geometry) {
            renderedBuildingFeatureSignatures.delete(id);
            return;
        }
        const effective = buildingFeatureWithOutcome(source, state);
        try { buildingLayer.addData(effective); } catch (error) {
            console.error('[map-core] local building outcome refresh failed', id, error);
            return;
        }
        renderedBuildingFeatureSignatures.set(id, stableBuildingFeatureSignature(effective, buildingStyleForFeature(effective)));
    });
    try { window.buildingLayer = buildingLayer; } catch (_) { }
}
window.refreshBuildingOutcomesFromRecords = refreshBuildingOutcomesFromRecords;

// Function to update the total spent display
function updateTotalSpentDisplay() {
    const totalSpentElement = document.getElementById('total-spent-value');
    if (totalSpentElement) {
        // Amount then code in the city's display currency, whole units.
        const code = (MapCityConfigManager && MapCityConfigManager.getCurrentCityConfig?.()?.currency?.code) || 'EUR';
        totalSpentElement.textContent = CbFormat.formatMoney(TOTAL_SPENT, code, { maxFractionDigits: 0 });
    }
}

let buildingFollowTimer = null;

// Set up map event handlers
function setupMapEventHandlers() {
    // Map movement handlers
    map.on('moveend', () => {
        if (!isMapMoving) return;
        if (typeof ParcelFetchController !== 'undefined' && ParcelFetchController && typeof ParcelFetchController.handleMoveEnd === 'function') {
            ParcelFetchController.handleMoveEnd(map, {
                parcelFetchConfig,
                resolveParcelLayer,
                isZoomWithinParcelRange
            });
        }

        // Every building survey that is switched ON follows the map. Only OSM did before, so
        // panning with GDI or DGU ticked showed whatever had been fetched when the box was ticked
        // and nothing more — a toggle that looked broken because its layer never grew. Each fetch is
        // zoom-gated and cached (per bbox for GDI/DGU, per grid cell for OSM), so a pan is cheap and
        // a repeat view is free.
        const followMap = [
            ['showBuildings', typeof fetchBuildings === 'function' ? fetchBuildings : null],
            ['showBuildingsDgu', typeof fetchDguBuildings === 'function' ? fetchDguBuildings : null],
            ['showBuildingsOsm', typeof fetchOsmBuildings === 'function' ? fetchOsmBuildings : null]
        ];
        // After the same pause as parcels: a pan is a burst of moveends, and each fetch may go out to
        // a rate-limited upstream (public Overpass rations requests per machine).
        if (buildingFollowTimer) clearTimeout(buildingFollowTimer);
        const debounceMs = (parcelFetchConfig && typeof parcelFetchConfig.getDebounce === 'function') ? parcelFetchConfig.getDebounce() : 500;
        buildingFollowTimer = setTimeout(() => {
            buildingFollowTimer = null;
            followMap.forEach(([id, fetcher]) => {
                const box = document.getElementById(id);
                if (box && box.checked && fetcher) fetcher();
            });
        }, debounceMs);

        isMapMoving = false;
    });

    // Add handlers for map movement start
    map.on('movestart', () => {
        isMapMoving = true;
    });

    // Add event listener for zoom
    map.on('zoomend', () => {
        // No cadastre in the explore city: only a chosen session plan has parcel layers to show or hide.
        if (MapCityConfigManager && typeof MapCityConfigManager.hasParcelData === 'function'
            && !MapCityConfigManager.hasParcelData()
            && !window.ParcelGroundFallback?.activeSource?.(MapCityConfigManager.getCurrentCityId())) return;
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
            // Hide both reference layers as well when below allowed zoom. This is DISPLAY only —
            // the pool keeps its buildings, so a corridor still cuts what it crosses.
            if (typeof window.buildingLayer !== 'undefined' && window.buildingLayer && map.hasLayer(window.buildingLayer)) {
                try { map.removeLayer(window.buildingLayer); } catch (_) { }
            }
            hideDguBuildingLayer();
            hideOsmBuildingLayer();
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
        const selected = window.currentlyHighlightedProposal;
        if (selected && typeof isProposalApplied === 'function' && !isProposalApplied(selected)
            && !window.sharePlanMode && !window.__mapEditLock?.isHeld()
            && !(typeof isParcelDrawingModeActive === 'function' && isParcelDrawingModeActive())) {
            hideProposalDetailsPanel(true);
        }
    });
}

// Initialize map core functionality
// App boot readiness. Resolves once every classic script has run (window `load`) AND
// initializeMapCore() has finished (index.html defers it behind PersistentStorage.ready). URL route
// handlers wait on this instead of fixed 100–1500 ms sleeps after `load`. A boot that never
// completes is reported loudly after APP_BOOT_WATCHDOG_MS rather than waited on silently.
(function installAppBootReadiness() {
    const APP_BOOT_WATCHDOG_MS = 30000;
    let markReady = null;
    const mapCoreReady = new Promise(resolve => { markReady = resolve; });
    const windowLoaded = document.readyState === 'complete'
        ? Promise.resolve()
        : new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    const booted = Promise.all([windowLoaded, mapCoreReady]).then(() => undefined);
    let reported = false;
    const watchdog = setTimeout(() => {
        reported = true;
        console.error(`[${new Date().toISOString()}] [map-core] App boot did not complete within ${APP_BOOT_WATCHDOG_MS} ms (load: ${document.readyState}, map core ready: ${!!window.__mapCoreReady}); URL routes are still waiting.`);
    }, APP_BOOT_WATCHDOG_MS);
    booted.then(() => {
        clearTimeout(watchdog);
        if (reported) console.info(`[${new Date().toISOString()}] [map-core] App boot completed late.`);
        window.dispatchEvent(new Event('appBooted'));
    });
    window.__markMapCoreReady = () => {
        window.__mapCoreReady = true;
        markReady();
    };
    window.whenAppBooted = () => booted;
})();

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

    // Initial load only if within zoom range and not in proposal deep-link mode. A place with no
    // cadastre offers the fallback choices without making a register request.
    const shouldSkipInitialFetch = typeof window !== 'undefined' && window.skipParcelFetchUntilProposalLoaded;
    if (!shouldSkipInitialFetch && typeof fetchParcelDataReported === 'function') {
        const within = isZoomWithinParcelRange();
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
        if (within) {
            fetchParcelDataReported(undefined, 'initial map load');
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

    window.__markMapCoreReady();
}

// Update map dimensions display
function updateMapDimensions() {
    const dimensionsText = document.getElementById('map-dimensions-text');
    if (!dimensionsText) return;

    try {
        const mapSize = map.getSize();
        dimensionsText.textContent = `${mapSize.x} × ${mapSize.y} px`;
    } catch (err) {
        console.warn('Failed to update map dimensions:', err);
    }
}

// Update dimensions on map events
map.on('resize', updateMapDimensions);
map.on('moveend', updateMapDimensions);

// Initial update
setTimeout(updateMapDimensions, 100);


// Hook up base map selector once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    if (BasemapManager) {
        BasemapManager.initBasemapSelector(map);
    }
});

// Make functions globally available
window.htrs96ToWGS84 = htrs96ToWGS84;
window.wgs84ToHTRS96 = wgs84ToHTRS96;
window.datasetToWgs84 = datasetToWgs84;
window.wgs84ToDataset = wgs84ToDataset;
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
