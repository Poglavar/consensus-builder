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
        if (/^\/designs\/?$/.test(path) && new URLSearchParams(window.location.search).has('draft')) return true;
        // Mirrors handleProposalRouteFromUrl (js/proposals/core.js): a design link
        // (/designs/<cid>[,<cid>…]), agreement (/agreements/<cid>) or named plan (/plans/<cid>). They load their own
        // ground, so the boot viewport parcel fetch must stay suppressed: a link left out
        // fetched the DEFAULT city's viewport parcels (Manhattan) while a Zagreb one was loading.
        if (/^\/(designs|agreements|plans)\/[^/]+\/?$/.test(path)) return true;
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
const GLOBAL_PARCEL_ZOOM_RANGE = { min: 15, max: Infinity };
// Buildings load and show from zoom 17, two steps closer than parcels (the city's parcelZoomRange,
// 15 by default): a view at 15 holds 16 times the ground of one at 17.
const BUILDING_MIN_ZOOM = 17;
const DEFAULT_FALLBACK_LATLNG = CURRENT_CITY_CONFIG?.projection?.fallbackLatLng || [45.815, 15.982];
const DEFAULT_FALLBACK_DATASET = CURRENT_CITY_CONFIG?.projection?.fallbackDataset || [458900, 5074000];

// Global constants
let TOTAL_SPENT = 0; // Total amount spent on roads, in the city's currency (city-money.js)

// Global map variables
// buildingLayer draws the buildings of the sources in use (source-list.js), each cell from one
// source — the WORKING SET the carve and the corridor tools read through buildingFeaturePool.
// outlineBuildingLayer draws the sources a person outlines for comparison (Zagreb's DGU cadastre,
// OpenStreetMap): purely visual, never detected against or cut, with the buildings only that source
// has drawn apart. No checkbox changes what a corridor cuts: detection reads the pool, not a layer.
let buildingLayer = null;
// Indexes for LOCAL outcome updates. Applying one park/road changes a handful of surveyed
// buildings; it must not discard and recreate every loaded footprint in the city.
let buildingFeatureById = new Map();
let buildingRenderedLayersById = new Map();
let renderedBuildingOutcomeSignatures = new Map();
let renderedBuildingFeatureSignatures = new Map();
let outlineBuildingLayer = null;
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
    // Zoom is continuous: wheel, trackpad and pinch move by what the input moved
    // (js/map-wheel-zoom.js), not rounded to a step. Keys and double-click still move whole
    // levels (zoomDelta 1).
    zoomSnap: 0,
    zoomControl: false,
    attributionControl: false // MapCredits keeps provider credits compact; details live in Information.
});

const INITIAL_VIEW = CITY_MAP_CONFIG?.initialView || null;
const hasDefaultCenter = Array.isArray(CITY_MAP_CONFIG?.defaultCenter) && CITY_MAP_CONFIG.defaultCenter.length === 2;

// `?at=lat,lon,zoom` (the world view, the search box's "Open in <city>", and the address itself,
// which follows every move — see below): open the city at that view instead of its default. A
// proposal link frames its own proposal, so it ignores `at`. Invalid values are ignored.
const AT_VIEW = (() => {
    let raw = null;
    try { raw = new URLSearchParams(window.location.search || '').get('at'); } catch (_) { return null; }
    if (raw === null) return null;
    const view = window.WorldEntryModel ? window.WorldEntryModel.parseAt(raw) : null;
    if (!view) console.warn(`[${new Date().toISOString()}] [map-core] ignoring invalid ?at=${raw}`);
    return view;
})();

// The address follows the map: every move writes the view as ?at= (replaceState: no history
// entries), so a reload, a copied link or a second tab opens where the map is. It used to be read
// once and stripped, and in-place moves (search, globe, panning) wrote nothing, so a reload or a
// shared address showed the city's default or another tab's explore spot.
// A boot that took its city from ?at= or ?city= alone drops ?city= with the first write: from then
// on the address is a plain location (location-first.md), and a stale label can't contradict it.
let dropCityParam = !!(window.CityConfigManager?.getBootEntry?.()?.dropCityParam);
map.on('moveend', () => {
    // The hidden Leaflet map is a data anchor in 3D; its camera owns the live address instead.
    if (window.__mapModeState && window.__mapModeState.desired !== '2d') return;
    if (window.BrowserWorkspace && window.BrowserWorkspace.status !== 'ready') return;
    if (!window.WorldEntryModel) return;
    // Under the first-visit globe the map is parked on the default city, which nobody chose:
    // written here, a reload would read it as a location link and skip the globe.
    if (window.WorldEntry?.ownsBoot?.()) return;
    // A design, plan or preview link parks the map on the city's default until its route arrives
    // (IS_PROPOSAL_DEEP_LINK, released in proposals/core.js): written, that spot would replace the
    // link's own ?at=, and a reload would land there instead of on what the link opens.
    if (window.skipParcelFetchUntilProposalLoaded) return;
    try {
        const center = map.getCenter();
        const next = window.WorldEntryModel.addressWithView(window.location.href, { lat: center.lat, lon: center.lng, zoom: map.getZoom() }, { dropCity: dropCityParam });
        dropCityParam = false;
        if (next) window.history.replaceState(window.history.state, '', next);
    } catch (error) {
        console.warn(`[${new Date().toISOString()}] [map-core] could not keep the view in the address`, error);
    }
});

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
window.MapCredits.install(map);

// Add scale control. Bottom-RIGHT, above the shell's bottom button row (css/map.css places it); the
// lower left belongs to the 2D/3D mode strip. It hides while a docked panel covers that corner.
L.control.scale({
    metric: true,
    imperial: false,
    position: 'bottomright'
}).addTo(map);

// The zoom range 2D shows parcels in (and buildings, from 17), for code outside this script.
window.parcelZoomRange = () => ({ min: parcelFetchZoomMin, max: parcelFetchZoomMax });

function isZoomWithinParcelRange() {
    if (parcelFetchZoomMin === null) return true;
    const z = map.getZoom();
    if (parcelFetchZoomMax === null || parcelFetchZoomMax === Infinity) {
        return z >= parcelFetchZoomMin;
    }
    return z >= parcelFetchZoomMin && z <= parcelFetchZoomMax;
}

// Metres are never the active city's: everything measured or built in metres works in an explicit
// frame on its own geometry (metric-frame.js, projections.md §2). The old city-wide pair
// (wgs84ToHTRS96 / htrs96ToWGS84) made a 19 m street in Zagreb 13.65 m wide whenever New York was
// the active city, and is gone.

// The DATASET pair: the city's parcel CRS, for dataset I/O only (grid cells, stored coordinates).
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

// A view's bounding box in a NAMED dataset CRS (projections.md §4), for services that only take their
// own CRS (the Croatian WFS and GDI/DGU surveys take EPSG:3765): every edge densified before the
// transform, so the envelope covers the whole view where the CRS bends meridians. Throws when the CRS
// is not defined — never falls back to anything.
function bboxInCrs(bounds, crs) {
    if (typeof proj4 === 'undefined' || !proj4.defs(crs)) throw new Error(`bboxInCrs: ${crs} is not defined`);
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const steps = 16;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const take = (lng, lat) => {
        const [x, y] = proj4('EPSG:4326', crs, [lng, lat]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bboxInCrs: the view does not project into ${crs}`);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const lng = sw.lng + (ne.lng - sw.lng) * t;
        const lat = sw.lat + (ne.lat - sw.lat) * t;
        take(lng, sw.lat); take(lng, ne.lat); take(sw.lng, lat); take(ne.lng, lat);
    }
    return `${minX},${minY},${maxX},${maxY}`;
}

// A view as the WGS84 bbox our own API takes (`bbox=…&crs=EPSG:4326`, projections.md §4): longitudes
// wrapped to [-180, 180] (Leaflet's continuous world runs past them); a view across the antimeridian
// comes out west > east, and the server splits it.
function wgs84BboxParam(bounds) {
    const wrap = lng => ((((lng + 180) % 360) + 360) % 360) - 180;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const span = ne.lng - sw.lng;
    const west = span >= 360 ? -180 : wrap(sw.lng);
    const east = span >= 360 ? 180 : wrap(ne.lng);
    return `bbox=${[west, sw.lat, east, ne.lat].join(',')}&crs=EPSG:4326`;
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

// Ensure footprints exist for `bounds` (an L.LatLngBounds or anything L.latLngBounds accepts): the
// building cells under it, each from the city's sources (cached cells answer at once). Corridor tools
// load the buildings along DRAWN geometry this way — the pool otherwise only covers viewports the user
// happened to view, and a building never loaded can never be detected, prompted for, or demolished.
async function ensureBuildingFootprintsForBounds(rawBounds) {
    if (!rawBounds) return;
    let bounds = null;
    try { bounds = L.latLngBounds(rawBounds); } catch (_) { return; }
    if (!bounds || !bounds.isValid()) return;
    return fetchBuildingCells(bounds);
}
window.ensureBuildingFootprintsForBounds = ensureBuildingFootprintsForBounds;

// The pool by cell: each cell's buildings came from one source and are replaced whole when the cell
// is answered again (a stand-in giving way to the city's own survey once it is back). Keyed like every
// other building consumer (corridorBuildingKey: `<source>:<id>`).
const buildingPoolByKey = new Map();
const buildingPoolCells = new Map();
let buildingReconcileGeneration = 0;
const dirtyBuildingIds = new Set();
let dirtyBuildingFrame = null;
const BUILDING_POOL_CAP = 12000;
window.buildingFeaturePool = [];

function poolFeatureOf(item, source) {
    const { geometry, ...properties } = item;
    return { type: 'Feature', properties: { ...properties, source }, geometry };
}

function publishBuildingPool() {
    window.buildingFeaturePool = Array.from(buildingPoolByKey.values());
    // Readers that place things on existing buildings (planning designations given as points) redo it.
    window.dispatchEvent(new CustomEvent('buildingPoolUpdated'));
}

// Pool buildings within this many degrees of a cell are layered with its answer (~50 m): a building
// filed in the next cell can still lie over this one's.
const POOL_LAYER_MARGIN_DEG = 0.0005;

// One cell's answer into the pool. Buildings of several sources (stand-ins meeting over a cell line,
// or a city's merged sources) are layered in list order: one lying mostly under a building of an
// earlier source is left out, here or already in the pool (building-cells.js layeredOut).
function mergeCellIntoPool(cell, result, sources) {
    const changedIds = new Set();
    const previous = buildingPoolCells.get(cell.key);
    if (previous) previous.keys.forEach(key => { buildingPoolByKey.delete(key); changedIds.add(key); });
    let features = result.items.filter(item => item && item.geometry && item.id != null).map(item => poolFeatureOf(item, item.source || result.source));
    if (window.turf && window.BuildingCells?.layeredOut) {
        const [w, s, e, n] = cell.bbox;
        const near = [];
        buildingPoolByKey.forEach((feature, key) => {
            const [fw, fs, fe, fn] = window.turf.bbox(feature);
            if (fw < e + POOL_LAYER_MARGIN_DEG && fe > w - POOL_LAYER_MARGIN_DEG && fs < n + POOL_LAYER_MARGIN_DEG && fn > s - POOL_LAYER_MARGIN_DEG) {
                near.push({ key, source: feature.properties?.source, geometry: feature.geometry, pooled: true });
            }
        });
        const keyed = features.map(feature => ({ key: buildingPoolFeatureKey(feature), source: feature.properties.source, geometry: feature.geometry, feature }));
        if (new Set([...near, ...keyed].map(entry => entry.source)).size > 1) {
            const out = window.BuildingCells.layeredOut([...near, ...keyed], sources, window.turf);
            // A pooled building of a later source now lying under this cell's earlier one gives way.
            near.forEach(entry => { if (out.has(entry.key)) { buildingPoolByKey.delete(entry.key); changedIds.add(entry.key); } });
            features = keyed.filter(entry => !out.has(entry.key)).map(entry => entry.feature);
        }
    }
    const keys = new Set();
    features.forEach(feature => {
        const key = buildingPoolFeatureKey(feature);
        keys.add(key);
        buildingPoolByKey.set(key, feature);
        changedIds.add(key);
    });
    const [w, s, e, n] = cell.bbox;
    buildingPoolCells.set(cell.key, { source: result.source, items: result.items, keys, centre: [(w + e) / 2, (s + n) / 2] });
    evictFarBuildingCells(changedIds);
    publishBuildingPool();
    return changedIds;
}

// Over the cap, whole cells go, farthest from the view first; the cell loader is asked again for them.
function evictFarBuildingCells(changedIds = new Set()) {
    if (buildingPoolByKey.size <= BUILDING_POOL_CAP) return;
    let centre = null;
    try { const c = map.getCenter(); centre = [c.lng, c.lat]; } catch (_) { return; }
    const far = [...buildingPoolCells.entries()]
        .map(([key, cell]) => ({ key, cell, distance: Math.hypot(cell.centre[0] - centre[0], cell.centre[1] - centre[1]) }))
        .sort((a, b) => b.distance - a.distance);
    for (const { key, cell } of far) {
        if (buildingPoolByKey.size <= BUILDING_POOL_CAP) break;
        cell.keys.forEach(id => { buildingPoolByKey.delete(id); changedIds.add(id); });
        buildingPoolCells.delete(key);
    }
}

function clearBuildingPool() {
    buildingReconcileGeneration += 1;
    dirtyBuildingIds.clear();
    if (dirtyBuildingFrame) { cancelAnimationFrame(dirtyBuildingFrame); dirtyBuildingFrame = null; }
    buildingPoolByKey.clear();
    buildingPoolCells.clear();
    publishBuildingPool();
}
function scheduleBuildingRepaint() {
    if (!dirtyBuildingIds.size || dirtyBuildingFrame !== null) return;
    dirtyBuildingFrame = requestAnimationFrame(() => {
        dirtyBuildingFrame = null;
        rebuildBuildingLayerFromPool(dirtyBuildingIds);
    });
}

// The building cells covering a box, nearest its centre first, and the sources in use there.
function buildingCellsFor(box) {
    const cellsApi = window.BuildingCells;
    const manager = window.CityConfigManager;
    if (!cellsApi || !manager) return { cells: [], sources: [] };
    const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const cells = cellsApi.cellsCovering({ box, centre, gridSize: Number(manager.getParcelGridSize?.()),
        toDataset: wgs84ToDataset, toLatLng: (easting, northing) => manager.datasetToLatLng(easting, northing) });
    const sources = window.SourceList.inUse(manager.getBuildingSources(centre[1], centre[0]));
    return { cells, sources, combine: manager.getBuildingCombine?.(centre[1], centre[0]) || 'first',
        list: manager.getBuildingSources(centre[1], centre[0]) };
}
window.buildingCellsFor = buildingCellsFor;

// The building cells under `bounds`, each from the city's ordered sources and merged into the pool as
// it lands, nearest first. The cell loader keeps each source's back-off and cache; a failed source
// never stops another layer.
async function fetchBuildingCells(bounds, { announce = false } = {}) {
    const loader = window.BuildingCellLoader;
    if (!loader) return;
    const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const { cells, sources, combine } = buildingCellsFor(box);
    if (!cells.length || !sources.length) return;
    if (announce && typeof updateStatus === 'function') updateStatus('Fetching existing buildings...');
    buildingFetchesInFlight += 1;
    window.PlanningLoading?.set('existing', 'map', true);
    let landed = 0;
    const generation = buildingReconcileGeneration;
    try {
        const summary = await loader.load({ kind: 'footprints', sources, combine, cells, onCell: (cell, result) => {
            if (result.failed || generation !== buildingReconcileGeneration) return;
            landed += result.items.length;
            const known = buildingPoolCells.get(cell.key);
            // A cached answer already in the pool changes nothing.
            if (known && known.source === result.source && known.items === result.items) return;
            const changed = mergeCellIntoPool(cell, result, sources);
            changed.forEach(id => dirtyBuildingIds.add(id));
            scheduleBuildingRepaint();
        } });
        try { window.buildingLayer = buildingLayer; } catch (_) { }
        try { window.dispatchEvent(new CustomEvent('buildingsLayerUpdated')); } catch (_) { }
        if (summary.failed) {
            reportBuildingsUnavailable(summary.retryAfter, () => {
                loader.retry();
                fetchBuildingCells(bounds, { announce: true });
            }, sources[0], summary.status);
        } else clearBuildingsUnavailable();
        if (announce && typeof updateStatus === 'function') {
            const standIn = summary.standIn ? ` (${summary.standIn} of ${summary.total} areas from a stand-in source)` : '';
            updateStatus(landed || summary.cached ? `Loaded existing buildings in ${summary.loaded} of ${summary.total} areas${standIn}`
                : 'No existing buildings surveyed here');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error(`[${new Date().toISOString()}] [buildings] cell load failed`, error);
    } finally {
        buildingFetchesInFlight -= 1;
        if (!buildingFetchesInFlight) window.PlanningLoading?.set('existing', 'map', false);
    }
}

// A building load whose upstream failed (throttled OpenStreetMap, a person's own source down): said in
// the building banner, with Retry and the source chooser, never silently. Each source keeps its own
// back-off in the cell loader, so one source's failure never pauses another.
// `source` is the id of the source that failed (the first in use for the view).
function reportBuildingsUnavailable(retryAfter, retry, source = null, status = null) {
    const seconds = Number(retryAfter);
    console.warn(`[${new Date().toISOString()}] [buildings] building data unavailable${seconds > 0 ? `; retry in ${seconds}s` : ''}`);
    const settings = window.ParcelSourceSettings;
    if (!settings || typeof settings.reportFailure !== 'function') return;
    const origin = source === 'osm' ? 'osm' : window.SourceList?.isUrlSource(source) ? 'custom' : 'other';
    settings.reportFailure(window, settings.buildingFailureMessage(window, { retryAfter: seconds > 0 ? seconds : null, origin, status }), 'building', retry);
}
window.reportBuildingsUnavailable = reportBuildingsUnavailable;
function clearBuildingsUnavailable() {
    window.ParcelSourceSettings?.clearFailure?.(window, 'building');
}
window.clearBuildingsUnavailable = clearBuildingsUnavailable;

// Fetch the existing buildings of the view (or of `boundsOverride`, an L.LatLngBounds, regardless of
// zoom — used by corridor tools to cover drawn geometry). Zoom-gated at the BOTTOM only for the view:
// below 17 the viewport is a whole city. There is no ceiling: road editing zooms to 22.
//
// `announce` is what the user ASKED FOR, and only that talks. A demolition scan or a corridor
// preload is not, and on a reload of a big plan it would fire once per proposal. The pool is filled
// either way: what a road demolishes must never depend on a display toggle, and the LAYER already
// respects the Built appearance when it draws those footprints.
// Fetches still running, for the Built arc around the Buildings and massing button (planning/loading.js).
let buildingFetchesInFlight = 0;
async function fetchBuildings(boundsOverride = null, options = {}) {
    const announce = options && options.announce === true;
    if (!boundsOverride) {
        try {
            const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
            if (!isFinite(z) || z < BUILDING_MIN_ZOOM) return;
        } catch (_) { /* noop */ }
    }
    let bounds = null;
    try { bounds = boundsOverride || map.getBounds(); } catch (_) { return; }
    return fetchBuildingCells(bounds, { announce });
}
window.fetchBuildings = fetchBuildings;

// The sources a person outlines for comparison (source-list.js `outline`), each loaded alone through
// the cells — no stand-ins — and drawn as reference outlines. A building the shown buildings cover by
// at most half its area is one only that source has, drawn apart and counted.
let outlineBuildingsByKey = new Map();
let drawnOutlineSources = '';
async function fetchOutlineBuildings(boundsOverride = null) {
    const loader = window.BuildingCellLoader;
    if (!boundsOverride) {
        try {
            const z = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
            if (!isFinite(z) || z < BUILDING_MIN_ZOOM) return;
        } catch (_) { return; }
    }
    if (!loader) return;
    let bounds = null;
    try { bounds = boundsOverride || map.getBounds(); } catch (_) { return; }
    const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const { cells, list } = buildingCellsFor(box);
    const outlined = window.SourceList.outlined(list);
    if (!outlined.length) { drawOutlineBuildings(); return; }
    await Promise.all(outlined.map(async entry => {
        const summary = await loader.load({ kind: 'footprints', sources: [entry.id], cells, onCell: (_cell, result) => {
            if (result.failed) return;
            result.items.filter(item => item && item.geometry && item.id != null).forEach(item => {
                const feature = poolFeatureOf(item, entry.id);
                outlineBuildingsByKey.set(buildingPoolFeatureKey(feature), feature);
            });
        } });
        if (summary.failed) {
            reportBuildingsUnavailable(summary.retryAfter, () => { loader.retry(); fetchOutlineBuildings(boundsOverride); }, entry.id, summary.status);
        }
    }));
    drawOutlineBuildings();
}
window.fetchOutlineBuildings = fetchOutlineBuildings;

// The observed-building palette lives in tokens.css: a faint survey fill with a contrasting outline,
// and the "only in" variant for an outlined source's building the shown buildings lack.
function observedBuildingStyle(variant = '') {
    const palette = getComputedStyle(document.documentElement);
    const token = (name, fallbackName = name) => (palette.getPropertyValue(`--cb-observed-building${variant}-${name}`)
        || palette.getPropertyValue(`--cb-observed-building-${fallbackName}`)).trim();
    return { color: token('stroke'), opacity: Number(token('stroke-opacity')), weight: Number(token('stroke-width')),
        fillColor: token('fill'), fillOpacity: Number(token('fill-opacity')) };
}
window.observedBuildingStyle = observedBuildingStyle;

// The outlined sources' buildings in view, the "only in" ones marked; their count per source is said
// in the status line.
function drawOutlineBuildings() {
    const manager = window.CityConfigManager;
    const outlinedIds = new Set(window.SourceList.outlined(manager?.getBuildingSources?.() || []).map(entry => entry.id));
    [...outlineBuildingsByKey.keys()].forEach(key => {
        if (!outlinedIds.has(outlineBuildingsByKey.get(key).properties.source)) outlineBuildingsByKey.delete(key);
    });
    if (outlineBuildingLayer) {
        try { map.removeLayer(outlineBuildingLayer); } catch (_) { }
        outlineBuildingLayer = null;
    }
    window.outlineBuildingLayer = null;
    // The profiler measures against what is drawn: say when the outlined sources on the map change.
    const drawnNow = [...outlinedIds].sort().join('+');
    if (drawnNow !== drawnOutlineSources) {
        drawnOutlineSources = drawnNow;
        try { document.dispatchEvent(new CustomEvent('building-layers-changed')); } catch (_) { }
    }
    if (!outlineBuildingsByKey.size) return;
    let view = null;
    try { view = map.getBounds().pad(0.2); } catch (_) { return; }
    const inView = [...outlineBuildingsByKey.entries()].filter(([, feature]) => {
        try { return view.intersects(L.geoJSON(feature).getBounds()); } catch (_) { return false; }
    });
    const shown = (window.buildingFeaturePool || []).map(feature => ({ geometry: feature.geometry }));
    const covered = window.turf ? window.BuildingCells.coveredKeys(inView.map(([key, feature]) => ({ key, geometry: feature.geometry })), shown, window.turf)
        : new Set(inView.map(([key]) => key));
    const onlyIn = new Map();
    const features = inView.map(([key, feature]) => {
        const only = !covered.has(key);
        if (only) onlyIn.set(feature.properties.source, (onlyIn.get(feature.properties.source) || 0) + 1);
        return { ...feature, properties: { ...feature.properties, __onlyIn: only } };
    });
    if (!map.getPane('observedReferences')) map.createPane('observedReferences');
    outlineBuildingLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
        // Reference only: it must never intercept clicks meant for the parcels beneath it.
        pane: 'observedReferences', interactive: false,
        style: feature => observedBuildingStyle(feature.properties.__onlyIn ? '-only' : '')
    });
    outlineBuildingLayer.addTo(map);
    window.outlineBuildingLayer = outlineBuildingLayer;
    const names = new Map((manager?.getBuildingSources?.() || []).map(entry => [entry.id, entry.name]));
    onlyIn.forEach((count, source) => {
        if (typeof updateStatus === 'function') updateStatus(`${count} buildings in view only in ${names.get(source) || source}`);
    });
}

// Existing buildings drawn on the map whose footprint covers a point, with what demolishes them
// (the click stack's Built section). Footprints come from the rendered layers, so only what the
// person can see is reported.
function buildingsAt(latlng) {
    if (!latlng || !window.turf) return [];
    const point = window.turf.point([latlng.lng, latlng.lat]);
    const hits = [];
    buildingRenderedLayersById.forEach((layers, id) => {
        const layer = layers[0], feature = buildingFeatureById.get(id);
        if (!feature?.geometry || typeof layer?.getBounds !== 'function' || !layer.getBounds().contains(latlng)) return;
        if (!window.turf.booleanPointInPolygon(point, feature)) return;
        hits.push({ id, feature });
    });
    if (!hits.length) return hits;
    const outcomes = currentBuildingOutcomeState();
    return hits.map(hit => ({ ...hit, demolition: outcomes.demolishedById.get(hit.id) || null,
        tunnelled: outcomes.tunnelledIds.has(hit.id) }));
}
window.buildingsAt = buildingsAt;

// Existing buildings drawn on the map that stand on a parcel: more than a sliver (1 m²) of their
// footprint lies inside it, so a neighbour that only touches the boundary is left out. The click
// stack lists them for a click on the parcel's open ground.
function buildingsOn(parcel) {
    if (!parcel?.geometry || !window.turf) return [];
    const [west, south, east, north] = window.turf.bbox(parcel);
    const hits = [];
    buildingRenderedLayersById.forEach((layers, id) => {
        const layer = layers[0], feature = buildingFeatureById.get(id);
        const bounds = typeof layer?.getBounds === 'function' ? layer.getBounds() : null;
        if (!feature?.geometry || !bounds || bounds.getWest() > east || bounds.getEast() < west
            || bounds.getSouth() > north || bounds.getNorth() < south) return;
        try {
            const inside = window.turf.intersect(feature, parcel);
            if (inside && window.turf.area(inside) > 1) hits.push({ id, feature });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [buildingsOn] building ${id} could not be intersected with the parcel`, error);
        }
    });
    if (!hits.length) return hits;
    const outcomes = currentBuildingOutcomeState();
    return hits.map(hit => ({ ...hit, demolition: outcomes.demolishedById.get(hit.id) || null,
        tunnelled: outcomes.tunnelledIds.has(hit.id) }));
}
window.buildingsOn = buildingsOn;

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

function buildingOutcomeSignature(state, id) {
    const record = state.demolishedById.get(id);
    if (!record) return 'tunnelled';
    const kind = record.extended ? 'extended' : record.remainder ? 'cut' : 'destroyed';
    return JSON.stringify([kind, record.geometry || null, record.demolishedPart || null, record.remainder || null]);
}

function buildingOutcomeSignatures(state) {
    return new Map(Array.from(state.affectedIds, id => [id, buildingOutcomeSignature(state, id)]));
}

function buildingFeatureWithOutcome(feature, state) {
    const id = buildingPoolFeatureKey(feature);
    const record = state.demolishedById.get(id);
    const classify = (typeof window.classifyBuildingOutcome === 'function') ? window.classifyBuildingOutcome : null;
    const outcome = classify
        ? classify(id, state)
        : (record ? (record.extended ? 'extended' : record.remainder ? 'cut' : 'destroyed') : (state.tunnelledIds.has(id) ? 'tunnelled' : null));
    const geometry = window.PlanningScene.builtGeometry(feature.geometry, record, window.PlanningViews?.getState()?.existingScope);
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
        nextFeatures.set(id, source);
        if (!feature?.geometry) continue;
        const signature = signatureOf(feature);
        nextSignatures.set(id, signature);
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
    const base = (typeof window.buildingOutcomeStyle === 'function')
        ? window.buildingOutcomeStyle(feature?.properties?.__outcome)
        : observedBuildingStyle();
    // Highlight by use (building-use-highlight.js) colours a building by its storeys' uses.
    const highlight = window.BuildingUseHighlight;
    if (!highlight?.isActive()) return base;
    const props = feature?.properties || {};
    return highlight.style2d(base, highlight.storeysOf(props, { floors: props.floors, heightM: props.height_m }));
}
// A changed highlight restyles every building: their signatures include the style.
window.BuildingUseHighlight?.onChange(() => { if (buildingLayer) rebuildBuildingLayerFromPool(); });

function applyBuildingFeatureLayerChanges(layerGroup, layersById, changes) {
    changes.removed.concat(changes.changed.map(entry => entry.id)).forEach(id => {
        (layersById.get(id) || []).forEach(layer => layerGroup.removeLayer(layer));
        layersById.delete(id);
    });
    changes.changed.forEach(entry => layerGroup.addData(entry.feature));
}

function buildingLayerOptions() {
    if (!map.getPane('observedBuildings')) map.createPane('observedBuildings');
    return {
        pane: 'observedBuildings',
        // The shared inspector handles observed buildings in either view. Edit tools still
        // own pointer events while their map lock is held.
        interactive: true,
        style: buildingStyleForFeature,
        onEachFeature: (feature, layer) => {
            const id = buildingPoolFeatureKey(feature);
            if (!id) return;
            const layers = buildingRenderedLayersById.get(id) || [];
            layers.push(layer);
            buildingRenderedLayersById.set(id, layers);
            // A building click is a map click like any other: the click stack collects everything
            // under the point (click-stack.md), the building being one of its sections.
            layer.on('click', event => {
                if (window.roadDrawingMode || window.__mapEditLock?.isHeld()) return;
                L.DomEvent.stopPropagation(event);
                window.ClickStack.handleClick(event.latlng);
            });
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
function rebuildBuildingLayerFromPool(dirtyIds = null) {
    const state = currentBuildingOutcomeState();
    // Corridor preloads and late network responses may fill the pool with Built switched off.
    const shouldShow = window.PlanningViews?.isBuiltVisible() && map.getZoom() >= BUILDING_MIN_ZOOM;
    if (!buildingLayer) {
        buildingLayer = L.geoJSON(null, buildingLayerOptions());
        buildingRenderedLayersById = new Map();
    }
    if (shouldShow && !map.hasLayer(buildingLayer)) buildingLayer.addTo(map);
    else if (!shouldShow && map.hasLayer(buildingLayer)) map.removeLayer(buildingLayer);
    window.buildingLayer = buildingLayer;
    if (dirtyIds) {
        const started = performance.now();
        for (const id of dirtyIds) {
            dirtyIds.delete(id);
            const source = buildingPoolByKey.get(id);
            if (source) buildingFeatureById.set(id, source);
            else buildingFeatureById.delete(id);
            if (source && state.affectedIds.has(id)) renderedBuildingOutcomeSignatures.set(id, buildingOutcomeSignature(state, id));
            else renderedBuildingOutcomeSignatures.delete(id);
            const effective = source && buildingFeatureWithOutcome(source, state);
            const signature = effective?.geometry ? stableBuildingFeatureSignature(effective, buildingStyleForFeature(effective)) : null;
            if (signature !== (renderedBuildingFeatureSignatures.get(id) ?? null)) {
                for (const layer of buildingRenderedLayersById.get(id) || []) buildingLayer.removeLayer(layer);
                buildingRenderedLayersById.delete(id);
                if (signature === null) renderedBuildingFeatureSignatures.delete(id);
                else {
                    buildingLayer.addData(effective);
                    renderedBuildingFeatureSignatures.set(id, signature);
                }
            }
            if (performance.now() - started >= 8) break;
        }
        if (dirtyIds.size) scheduleBuildingRepaint();
        return;
    }
    dirtyBuildingIds.clear();
    const pool = Array.isArray(window.buildingFeaturePool) ? window.buildingFeaturePool : [];
    const changes = reconcileBuildingFeatureEntries(
        renderedBuildingFeatureSignatures,
        pool,
        buildingPoolFeatureKey,
        feature => buildingFeatureWithOutcome(feature, state),
        feature => stableBuildingFeatureSignature(feature, buildingStyleForFeature(feature))
    );
    applyBuildingFeatureLayerChanges(buildingLayer, buildingRenderedLayersById, changes);
    buildingFeatureById = changes.nextFeatures;
    renderedBuildingFeatureSignatures = changes.nextSignatures;
    renderedBuildingOutcomeSignatures = buildingOutcomeSignatures(state);
}
window.rebuildBuildingLayerFromPool = rebuildBuildingLayerFromPool;

// A plan change: derive its demolitions again (demolition-index.js, which announces
// `demolitionsChanged` when they moved) and redraw with what is known now.
function refreshBuildingOutcomesFromRecords() {
    window.DemolitionIndex?.refresh();
    redrawBuildingOutcomes();
}
window.refreshBuildingOutcomesFromRecords = refreshBuildingOutcomesFromRecords;

// A plan only changes the outcome of buildings under its own geometry. Compare the ids represented
// before and after, then replace those Leaflet features in place. The untouched thousands never leave
// the layer and never pay GeoJSON parsing/styling again.
function redrawBuildingOutcomes() {
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
        if (!effective.geometry) { renderedBuildingFeatureSignatures.delete(id); return; }
        try { buildingLayer.addData(effective); } catch (error) {
            console.error('[map-core] local building outcome refresh failed', id, error);
            return;
        }
        renderedBuildingFeatureSignatures.set(id, stableBuildingFeatureSignature(effective, buildingStyleForFeature(effective)));
    });
    try { window.buildingLayer = buildingLayer; } catch (_) { }
}
window.addEventListener('demolitionsChanged', () => {
    redrawBuildingOutcomes();
    drawOutlineBuildings();
});

// A new source list: the pool and the outlines are the new sources' (their cells are keyed by the
// list, so nothing of the old one answers), and the demolitions are derived again over them.
window.addEventListener('sourceListChanged', event => {
    if (event.detail?.concept !== 'buildings') return;
    clearBuildingPool();
    outlineBuildingsByKey = new Map();
    rebuildBuildingLayerFromPool();
    drawOutlineBuildings();
    if (window.PlanningViews?.isBuiltVisible() && isTwoDimensionalViewportActive()) fetchBuildings(null, { announce: true });
    fetchOutlineBuildings();
});

// Function to update the total spent display
function updateTotalSpentDisplay() {
    const totalSpentElement = document.getElementById('total-spent-value');
    if (totalSpentElement) {
        // Amount then code in the city's currency, whole units.
        totalSpentElement.textContent = CbFormat.formatMoney(TOTAL_SPENT, window.CityMoney.currentCurrency(), { maxFractionDigits: 0 });
    }
}

let buildingFollowTimer = null;

function isTwoDimensionalViewportActive() {
    const mode = window.__mapModeState;
    if (mode && (mode.pending || mode.desired !== '2d')) return false;
    return typeof window.isThreeModeActive !== 'function' || !window.isThreeModeActive();
}

// Showing Built can reuse an already loaded layer even when every requested cell is cached.
function syncBuiltLayerVisibility() {
    const shown = window.PlanningViews?.isBuiltVisible();
    if (buildingLayer && map.hasLayer(buildingLayer) && !shown) map.removeLayer(buildingLayer);
    if (!shown || !isTwoDimensionalViewportActive()) return;
    if (map.getZoom() < BUILDING_MIN_ZOOM) { window.announceBuildingZoomGate?.(); return; }
    if (buildingLayer && !map.hasLayer(buildingLayer)) buildingLayer.addTo(map);
    fetchBuildings(null, { announce: true });
}
window.syncBuiltLayerVisibility = syncBuiltLayerVisibility;
window.addEventListener('mapmodechange', event => {
    if (event.detail?.desired === '2d' && !event.detail.pending) syncBuiltLayerVisibility();
});

// Set up map event handlers
function setupMapEventHandlers() {
    // Map movement handlers
    const handleMoveEnd = () => {
        if (!isTwoDimensionalViewportActive()) return;
        if (!isMapMoving) return;
        if (typeof ParcelFetchController !== 'undefined' && ParcelFetchController && typeof ParcelFetchController.handleMoveEnd === 'function') {
            ParcelFetchController.handleMoveEnd(map, { parcelFetchConfig });
        }

        // The buildings and the outlined sources follow the map. Each load is zoom-gated and goes by
        // cell, and a loaded cell answers from the cell loader's cache, so a pan is cheap and a repeat
        // view is free.
        // After the same pause as parcels: a pan is a burst of moveends, and each fetch may go out to
        // a rate-limited upstream (public Overpass rations requests per machine).
        if (buildingFollowTimer) clearTimeout(buildingFollowTimer);
        const debounceMs = (parcelFetchConfig && typeof parcelFetchConfig.getDebounce === 'function') ? parcelFetchConfig.getDebounce() : 500;
        buildingFollowTimer = setTimeout(() => {
            buildingFollowTimer = null;
            if (!isTwoDimensionalViewportActive()) return;
            if (window.PlanningViews?.isBuiltVisible()) fetchBuildings();
            fetchOutlineBuildings();
        }, debounceMs);

        isMapMoving = false;
    };
    map.on('moveend', handleMoveEnd);

    // Add handlers for map movement start
    map.on('movestart', () => {
        if (!isTwoDimensionalViewportActive()) return;
        isMapMoving = true;
    });

    // Add event listener for zoom
    const handleZoomEnd = () => {
        if (!isTwoDimensionalViewportActive()) return;
        // No cadastre in the explore city: only a chosen session plan has parcel layers to show or hide.
        if (MapCityConfigManager && typeof MapCityConfigManager.hasParcelData === 'function'
            && !MapCityConfigManager.hasParcelData()
            && !window.ParcelGroundFallback?.activeSource?.(MapCityConfigManager.getCurrentCityId())) return;
        const within = isZoomWithinParcelRange();
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
        // Hide the buildings and the outlined sources below their own zoom. This is DISPLAY only — the
        // pool keeps its buildings, so a corridor still cuts what it crosses.
        if (!(map.getZoom() >= BUILDING_MIN_ZOOM)) {
            [window.buildingLayer, outlineBuildingLayer].forEach(layer => {
                if (layer && map.hasLayer(layer)) {
                    try { map.removeLayer(layer); } catch (_) { }
                }
            });
        } else if (buildingLayer && !map.hasLayer(buildingLayer) && window.PlanningViews?.isBuiltVisible()) {
            // Back at building zoom the layer returns by itself: cells already loaded answer from the
            // cache without a rebuild, so nothing else would add it. (The outlines redraw on every move.)
            buildingLayer.addTo(map);
        }
        const parcelsVisible = window.ParcelsUIVisibility?.syncParcelLayerVisibility?.();
        if (!within && window.ParcelPresenter?.isEnabled?.() !== false) {
            if (typeof updateStatus === 'function') updateStatus('Parcels disabled at this zoom');
        } else if (parcelsVisible) {
            // The zoomed-out notice would otherwise stay up until the first cell of a slow
            // register answers, telling a visitor who already zoomed in to zoom in.
            const floating = document.getElementById('floating-status-text');
            const disabledText = window.i18n?.t?.('status.messages.parcels_disabled_at_this_zoom');
            if (typeof updateStatus === 'function' && floating
                && [disabledText, 'Parcels disabled at this zoom'].includes(floating.textContent)) {
                const key = 'status.messages.loading_parcels', text = window.i18n?.t?.(key);
                updateStatus(text && text !== key ? text : 'Loading parcels…', { transient: true });
            }
        }
    };
    map.on('zoomend', handleZoomEnd);

    window.addEventListener('mapmodechange', event => {
        const mode = event.detail || window.__mapModeState;
        if (mode?.desired !== '2d' || mode.pending) {
            if (buildingFollowTimer) clearTimeout(buildingFollowTimer);
            buildingFollowTimer = null;
            if (typeof window.buildingsTimeout !== 'undefined') {
                clearTimeout(window.buildingsTimeout);
                window.buildingsTimeout = null;
            }
            if (typeof window.parcelsTimeout !== 'undefined') {
                clearTimeout(window.parcelsTimeout);
                window.parcelsTimeout = null;
            }
            window.cancelParcelViewportFetch?.();
            return;
        }
        // The Leaflet viewport is parked while model/photo is active. Reapply its zoom visibility
        // and fetch the current view when it becomes the active map again.
        handleZoomEnd();
        isMapMoving = true;
        handleMoveEnd();
    });

    // Add map click handler to close visualization and panels
    map.on('click', () => {
        if (!isTwoDimensionalViewportActive()) return;
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }
        const selected = window.currentlyHighlightedProposal;
        if (selected && typeof isProposalApplied === 'function' && !isProposalApplied(selected)
            && !window.MapPick?.active() && !window.__mapEditLock?.isHeld()
            && !(typeof isParcelDrawingModeActive === 'function' && isParcelDrawingModeActive())) {
            hideProposalDetailsPanel(true);
        }
    });
}

// Initialize map core functionality
// App boot readiness. Resolves once every classic script has run and the page's stylesheets have
// applied AND initializeMapCore() has finished (index.html defers it behind PersistentStorage.ready).
// index.html writes its scripts with document.write, so all of them have run by DOMContentLoaded;
// its stylesheets are appended by a script, so they are awaited here. Not window `load`: that also
// waits for every image, basemap tiles included, and one tile a tile server never answered held
// every URL route, the model view's among them (reproduced 2026-11-21 with one stalled
// OpenStreetMap tile). URL route handlers wait on this instead of fixed sleeps. A boot that never
// completes is reported loudly after APP_BOOT_WATCHDOG_MS rather than waited on silently.
(function installAppBootReadiness() {
    const APP_BOOT_WATCHDOG_MS = 30000;
    let markReady = null;
    const mapCoreReady = new Promise(resolve => { markReady = resolve; });
    const domReady = document.readyState !== 'loading'
        ? Promise.resolve()
        : new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    // A stylesheet that already failed has no sheet and fires nothing more: its resource entry says
    // it is finished.
    const pendingStyles = () => [...document.querySelectorAll('link[rel="stylesheet"]')]
        .filter(link => !link.sheet && !performance.getEntriesByName(link.href).length);
    const stylesApplied = domReady.then(() => Promise.all(pendingStyles().map(link => new Promise(resolve => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
    }))));
    const booted = Promise.all([stylesApplied, mapCoreReady]).then(() => undefined);
    let reported = false;
    const watchdog = setTimeout(() => {
        if (window.BrowserWorkspace && window.BrowserWorkspace.status !== 'ready') return;
        reported = true;
        const styles = pendingStyles().map(link => link.getAttribute('href'));
        console.error(`[${new Date().toISOString()}] [map-core] App boot did not complete within ${APP_BOOT_WATCHDOG_MS} ms (document: ${document.readyState}, stylesheets pending: ${styles.length ? styles.join(', ') : 'none'}, map core ready: ${!!window.__mapCoreReady}); URL routes are still waiting.`);
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
    // Map core (and therefore PersistentStorage) ready, without waiting for window `load` and its
    // basemap tiles. The boot replay starts here (proposal-manager.js startBootReplayWhenReady).
    window.whenMapCoreReady = () => mapCoreReady;
})();

function initializeMapCore() {
    // Set up event handlers
    setupMapEventHandlers();
    window.PointParcelMap?.install(window);

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
    const within = isZoomWithinParcelRange();
    window.updateParcelsCheckboxByZoom?.(within);
    const parcelsVisible = window.ParcelsUIVisibility?.syncParcelLayerVisibility?.();
    if (!shouldSkipInitialFetch && parcelsVisible && isTwoDimensionalViewportActive()) {
        window.fetchParcelDataReported?.(undefined, 'initial map load', { viewport: true });
    } else if (!shouldSkipInitialFetch && !within && window.ParcelPresenter?.isEnabled?.() !== false) {
        updateStatus('Parcels disabled at this zoom');
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
window.datasetToWgs84 = datasetToWgs84;
window.wgs84ToDataset = wgs84ToDataset;
window.bboxInCrs = bboxInCrs;
window.wgs84BboxParam = wgs84BboxParam;
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
