// OSM buildings reference layer. A purely visual third survey for the "Which buildings to show?"
// chooser: the community-mapped footprints that back the OSM/MapTiler basemap, so they overlay the
// tiles the user sees with zero drift (unlike GDI photogrammetry or DGU cadastre). Reference only —
// never cut, tunnelled or demolished against; it feeds nothing but the map.
//
// Live via Overpass (no DB, no ingestion), proxied here so we can cache by viewport box and keep the
// endpoint/config server-side. Global by construction: works for every city, including the ones with
// no bespoke building source at all.

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const FEATURE_CAP = 8000;          // above the densest zoom-17..19 viewport; only binds pathologically
const MAX_SPAN_DEG = 0.06;         // ~6.6 km — a safety valve; the frontend zoom-gates to small boxes
const FETCH_TIMEOUT_MS = 25000;

// Coarse in-memory cache keyed by the snapped viewport box, so panning back and forth or a burst of
// moveend events doesn't hammer Overpass. Bounded to avoid unbounded growth.
const cache = new Map();

function cacheNow() { return Date.now(); }

// One OSM element's tags → a metre height when the mapper recorded one, else null. `height` is
// metres directly; `building:levels` is storeys (~3 m each). Reference only, so a missing height is
// fine — nothing extrudes it; we pass it through for anyone who wants it.
function osmHeightMeters(tags) {
    if (!tags) return null;
    const h = parseFloat(tags.height);
    if (Number.isFinite(h) && h > 0) return h;
    const levels = parseFloat(tags['building:levels']);
    if (Number.isFinite(levels) && levels > 0) return levels * 3;
    return null;
}

// A ring of Overpass {lat,lon} points → a closed GeoJSON linear ring [[lon,lat],...]. Returns null
// for a degenerate ring (fewer than 3 distinct points).
function ringFromGeometry(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 3) return null;
    const ring = [];
    for (const p of geometry) {
        if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
        ring.push([p.lon, p.lat]);
    }
    if (ring.length < 3) return null;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    return ring;
}

// Overpass `out geom;` elements → a GeoJSON FeatureCollection of building footprints. Pure and
// side-effect-free so it is unit-testable without the network. Ways become Polygons; multipolygon
// relations become MultiPolygons from their OUTER rings (inner courtyards are ignored — acceptable
// for a visual reference overlay). Caps the feature count and reports whether it truncated.
function overpassElementsToGeoJSON(elements, cap = FEATURE_CAP) {
    const features = [];
    let truncated = false;
    for (const el of (Array.isArray(elements) ? elements : [])) {
        if (!el || !el.tags || el.tags.building === undefined) continue;
        if (features.length >= cap) { truncated = true; break; }

        let geometry = null;
        if (el.type === 'way') {
            const ring = ringFromGeometry(el.geometry);
            if (ring) geometry = { type: 'Polygon', coordinates: [ring] };
        } else if (el.type === 'relation') {
            const polygons = [];
            for (const member of (el.members || [])) {
                if (!member || member.type !== 'way' || member.role === 'inner') continue;
                const ring = ringFromGeometry(member.geometry);
                if (ring) polygons.push([ring]);
            }
            if (polygons.length) geometry = { type: 'MultiPolygon', coordinates: polygons };
        }
        if (!geometry) continue;

        features.push({
            type: 'Feature',
            id: `${el.type[0]}${el.id}`,               // e.g. 'w123456' / 'r7890' — the OSM element id
            geometry,
            properties: {
                osm_id: `${el.type[0]}${el.id}`,
                height_m: osmHeightMeters(el.tags),
                name: el.tags.name || null
            }
        });
    }
    return { type: 'FeatureCollection', features, truncated };
}

// The Overpass QL for every building (ways + multipolygon relations) inside a WGS84 box. Overpass
// bbox order is (south,west,north,east).
function buildOverpassQuery(bbox) {
    const [w, s, e, n] = bbox;
    const box = `(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(way["building"]${box};relation["building"]["type"="multipolygon"]${box};);out geom;`;
}

// Fetch building footprints inside a WGS84 bbox [minLon, minLat, maxLon, maxLat] from Overpass, with
// a short viewport-box cache. Throws on a network/HTTP failure (the route maps that to 502); returns
// a GeoJSON FeatureCollection with a `truncated` flag otherwise.
async function fetchOsmBuildings(bbox, options = {}) {
    const [w, s, e, n] = bbox;
    if (![w, s, e, n].every(Number.isFinite)) {
        const err = new Error('Invalid bbox');
        err.status = 400;
        throw err;
    }
    if ((e - w) > MAX_SPAN_DEG || (n - s) > MAX_SPAN_DEG || e <= w || n <= s) {
        const err = new Error('bbox too large or malformed for the OSM reference layer');
        err.status = 400;
        throw err;
    }

    const key = bbox.map(v => v.toFixed(4)).join(',');
    const cached = cache.get(key);
    if (cached && (cached.at + CACHE_TTL_MS) > cacheNow()) {
        return { ...cached.fc, cached: true };
    }

    const overpassUrl = options.overpassUrl || process.env.OVERPASS_URL || DEFAULT_OVERPASS_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let json;
    try {
        const resp = await fetch(overpassUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}`,
            signal: controller.signal
        });
        if (!resp.ok) {
            const err = new Error(`Overpass HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
            err.status = 502;
            throw err;
        }
        json = await resp.json();
    } finally {
        clearTimeout(timer);
    }

    const fc = overpassElementsToGeoJSON(json && json.elements, FEATURE_CAP);
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { at: cacheNow(), fc });
    return fc;
}

export { overpassElementsToGeoJSON, buildOverpassQuery, osmHeightMeters, fetchOsmBuildings };
