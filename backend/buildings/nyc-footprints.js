// NYC 3D building provider. Source: NYC Open Data "Building Footprints" (dataset 5zhs-2jue),
// a live Socrata feed of every building's footprint + roof height. We query the footprints
// near a point via Socrata's within_box geo-filter, convert the roof height (feet → metres)
// and extrude each footprint into the common face-mesh shape the renderer expects. No DB or
// ingestion: the city keeps this updated daily and we proxy it (cached briefly) on demand.

import { extrudeFootprint } from './extrude.js';

const SOCRATA_GEOJSON_URL = 'https://data.cityofnewyork.us/resource/5zhs-2jue.geojson';
const FEET_TO_METRES = 0.3048;
const FEATURE_CODE_BUILDING = 2100; // 2100 = Building; other codes are canopies, tanks, garages, etc.
// Cap sized above the densest 500m-radius query (a few thousand footprints in Midtown) so the
// radius, not the cap, is the real limiter; it only binds on pathological inputs. Paired with a
// distance $order so that if it ever does bind, it keeps the NEAREST buildings deterministically
// (without the order, Socrata's $limit returns an arbitrary subset that shuffles as the radius
// grows — buildings flicker in/out and the footprint reshapes).
const MAX_BUILDINGS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Coarse in-memory cache keyed by the snapped query box, so repeated fetches during a drag /
// camera nudge don't hammer Socrata. Bounded to avoid unbounded growth.
const cache = new Map();
const CACHE_MAX_ENTRIES = 200;

// Walk any GeoJSON geometry's coordinates to a [minLng, minLat, maxLng, maxLat] bbox.
function geometryBbox(geometry) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const visit = (node) => {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'number' && typeof node[1] === 'number') {
            if (node[0] < minLng) minLng = node[0];
            if (node[0] > maxLng) maxLng = node[0];
            if (node[1] < minLat) minLat = node[1];
            if (node[1] > maxLat) maxLat = node[1];
            return;
        }
        for (const child of node) visit(child);
    };
    visit(geometry && geometry.coordinates);
    if (!isFinite(minLng) || !isFinite(minLat)) return null;
    return [minLng, minLat, maxLng, maxLat];
}

// Distance in metres from a bbox centre to its corner — i.e. the radius of the smallest circle
// covering the whole query footprint. Added to the requested buffer so a proposal polygon is
// fully enclosed by the radius circle. (Equirectangular approximation; fine at city scale.)
function bboxCornerRadiusMeters(bbox) {
    const midLat = (bbox[1] + bbox[3]) / 2;
    const dLatM = ((bbox[3] - bbox[1]) / 2) * 111320;
    const dLngM = ((bbox[2] - bbox[0]) / 2) * 111320 * Math.max(0.1, Math.cos(midLat * Math.PI / 180));
    return Math.sqrt(dLatM * dLatM + dLngM * dLngM);
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

export function createNycProvider(env = process.env) {
    const appToken = env.SOCRATA_APP_TOKEN || env.NYC_OPEN_DATA_APP_TOKEN || null;

    async function near(geometry, bufferMeters) {
        const baseBbox = geometryBbox(geometry);
        if (!baseBbox) return { buildings: [], count: 0, source: 'nyc-footprints' };

        // True radius (not a bbox): a circle centred on the query geometry, sized to enclose the
        // geometry's own extent plus the requested buffer. Growing the buffer grows the circle, so
        // increasing the radius only ever adds farther buildings — the same monotonic, circular
        // behaviour as the Zagreb provider's ST_DWithin.
        const centerLng = (baseBbox[0] + baseBbox[2]) / 2;
        const centerLat = (baseBbox[1] + baseBbox[3]) / 2;
        const radiusM = bufferMeters + bboxCornerRadiusMeters(baseBbox);

        const cacheKey = [centerLng, centerLat].map(v => v.toFixed(5)).join(',') + ':' + Math.round(radiusM);
        const cached = cache.get(cacheKey);
        if (cached && (cached.at + CACHE_TTL_MS) > cacheNow()) {
            return { buildings: cached.buildings, count: cached.buildings.length, source: 'nyc-footprints', cached: true };
        }

        // within_circle(location, lat, lng, radiusMetres) keeps it a true radius. feature_code is
        // pushed into the filter so $limit counts real buildings, and $order by distance makes the
        // cap deterministic (nearest-first) instead of an arbitrary shuffling subset.
        const point = `POINT(${centerLng} ${centerLat})`;
        const where = `within_circle(the_geom, ${centerLat}, ${centerLng}, ${radiusM}) AND height_roof > 0 AND feature_code = ${FEATURE_CODE_BUILDING}`;
        const order = `distance_in_meters(the_geom, '${point}')`;
        const url = `${SOCRATA_GEOJSON_URL}?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(order)}&$limit=${MAX_BUILDINGS}`;
        const headers = appToken ? { 'X-App-Token': appToken } : {};

        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            throw new Error(`Socrata HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
        const fc = await resp.json();
        const features = (fc && Array.isArray(fc.features)) ? fc.features : [];

        const buildings = [];
        for (const f of features) {
            const props = f && f.properties ? f.properties : {};
            const heightM = num(props.height_roof) * FEET_TO_METRES;
            const rec = extrudeFootprint(props.bin || props.doitt_id || props.objectid, f.geometry, heightM);
            if (rec) buildings.push(rec);
        }

        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
        cache.set(cacheKey, { at: cacheNow(), buildings });

        return { buildings, count: buildings.length, source: 'nyc-footprints' };
    }

    return { near };
}

function cacheNow() { return Date.now(); }
