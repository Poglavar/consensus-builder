// OSM buildings reference layer. A purely visual third survey for the "Which buildings to show?"
// chooser: the community-mapped footprints that back the OSM/MapTiler basemap, so they overlay the
// tiles the user sees with zero drift (unlike GDI photogrammetry or DGU cadastre). Reference only —
// never cut, tunnelled or demolished against; it feeds nothing but the map.
//
// Live via Overpass (no DB, no ingestion), proxied here so we can cache and keep the endpoint/config
// server-side. Global by construction: works for every city, including the ones with no bespoke
// building source at all.
//
// The cache is keyed by a fixed GRID CELL, never by the viewport. Keying on the viewport looked like
// a cache and was not one: the frontend refetches on every moveend, and a pan of a few metres minted
// a new key every time, so all but the first request went to Overpass. Public Overpass answered that
// with 429 and 504 (each surfacing as a 502 here), and the reference layer simply stopped drawing.
// Snapped cells mean panning inside a cell is free, and a pan across one costs a single fetch.

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Buildings do not move; the only reason to expire at all is to pick up mapping edits eventually.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 400;
// ~0.005 deg is ~550 m north-south, ~390 m east-west at Zagreb's latitude: a zoom-17..19 viewport
// covers one to four of them, so a session spent working one street re-uses the same cells.
const OSM_CELL_DEG = 0.005;
// After Overpass throttles us, stop asking for a while. Hammering a rate limiter is how a slow
// layer becomes a dead one.
const THROTTLE_COOLOFF_MS = 60 * 1000;
const FEATURE_CAP = 8000;          // above the densest zoom-17..19 viewport; only binds pathologically
const MAX_SPAN_DEG = 0.06;         // ~6.6 km — a safety valve; the frontend zoom-gates to small boxes
const FETCH_TIMEOUT_MS = 25000;

// In-memory cache, one entry per grid cell. Bounded to avoid unbounded growth.
const cache = new Map();
// One in-flight request per cell: a viewport spanning four cells, fired twice by two moveend events,
// must be four Overpass calls and not eight.
const inFlight = new Map();
let throttledUntil = 0;

function cacheNow() { return Date.now(); }

// The fixed grid cells covering a bbox — the unit everything is fetched and cached in. Pure, so the
// snapping (which is what makes the cache work at all) is testable without the network.
function osmCellsForBbox(bbox, cellDeg = OSM_CELL_DEG) {
    const [w, s, e, n] = bbox;
    const size = Number(cellDeg) > 0 ? Number(cellDeg) : OSM_CELL_DEG;
    const snap = value => Math.floor(value / size) * size;
    const round = value => Math.round(value * 1e6) / 1e6; // keys must be exact, not float noise
    const cells = [];
    for (let x = snap(w); x < e; x += size) {
        for (let y = snap(s); y < n; y += size) {
            cells.push({
                key: `${round(x)},${round(y)}`,
                bbox: [round(x), round(y), round(x + size), round(y + size)]
            });
        }
    }
    return cells;
}

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

// Fetch ONE grid cell from Overpass, with the in-flight guard. Throws with .status on failure.
async function fetchOsmCell(cell, options) {
    const cached = cache.get(cell.key);
    if (cached && (cached.at + CACHE_TTL_MS) > cacheNow()) return cached.fc;
    if (inFlight.has(cell.key)) return inFlight.get(cell.key);

    const overpassUrl = options.overpassUrl || process.env.OVERPASS_URL || DEFAULT_OVERPASS_URL;
    const request = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let json;
        try {
            const resp = await fetch(overpassUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // OSM's Overpass usage policy REQUIRES a descriptive User-Agent; requests without
                    // one are rejected with HTTP 406. Node's fetch sends none, so set it explicitly.
                    'User-Agent': 'consensus-builder/1.0 (+https://urbangametheory.xyz)'
                },
                body: `data=${encodeURIComponent(buildOverpassQuery(cell.bbox))}`,
                signal: controller.signal
            });
            if (!resp.ok) {
                // 429 (too many requests) and 504 (the query queue timed out) both mean the same
                // thing to us: back off. Anything else is a genuine upstream failure.
                if (resp.status === 429 || resp.status === 504) throttledUntil = cacheNow() + THROTTLE_COOLOFF_MS;
                const err = new Error(`Overpass HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
                err.status = (resp.status === 429 || resp.status === 504) ? 503 : 502;
                throw err;
            }
            json = await resp.json();
        } finally {
            clearTimeout(timer);
        }
        const fc = overpassElementsToGeoJSON(json && json.elements, FEATURE_CAP);
        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
        cache.set(cell.key, { at: cacheNow(), fc });
        return fc;
    })();

    inFlight.set(cell.key, request);
    try {
        return await request;
    } finally {
        inFlight.delete(cell.key);
    }
}

// Fetch building footprints inside a WGS84 bbox [minLon, minLat, maxLon, maxLat], cell by cell.
// Returns a GeoJSON FeatureCollection; `truncated` when a cell hit the feature cap, `partial` when
// some cell could not be fetched but others were already cached. Throws (with .status and
// .retryAfter) only when nothing at all could be served.
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

    const cells = osmCellsForBbox(bbox, options.cellDeg);
    const cooling = throttledUntil > cacheNow();
    const features = [];
    const seen = new Set();
    let truncated = false;
    let partial = false;
    let failure = null;

    for (const cell of cells) {
        const cached = cache.get(cell.key);
        const fresh = cached && (cached.at + CACHE_TTL_MS) > cacheNow();
        // While cooling off, serve what is already held and ask Overpass for nothing.
        if (!fresh && cooling) { partial = true; continue; }
        let fc = fresh ? cached.fc : null;
        if (!fc) {
            try {
                fc = await fetchOsmCell(cell, options);
            } catch (err) {
                failure = err;
                partial = true;
                continue;
            }
        }
        if (fc.truncated) truncated = true;
        // A building on a cell boundary comes back in both cells.
        for (const feature of fc.features) {
            if (seen.has(feature.id)) continue;
            seen.add(feature.id);
            features.push(feature);
        }
    }

    if (!features.length && (failure || cooling)) {
        const err = failure || new Error('Overpass is rate-limiting us; backing off');
        err.status = err.status || 503;
        if (throttledUntil > cacheNow()) err.retryAfter = Math.ceil((throttledUntil - cacheNow()) / 1000);
        throw err;
    }
    return { type: 'FeatureCollection', features, truncated, partial };
}

export { overpassElementsToGeoJSON, buildOverpassQuery, osmHeightMeters, osmCellsForBbox, fetchOsmBuildings };
