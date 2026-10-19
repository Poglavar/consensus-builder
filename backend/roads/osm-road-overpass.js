// Existing streets from OpenStreetMap for a bbox the `osm_road` table does not cover: every
// `highway` way with its tags, fetched through the shared Overpass cell source (osm-reference.js:
// the paid Tracestrack instance first when its key is set, then the public server; per-cell cache,
// throttle and cool-off). Output is the /osm-road feature shape, so the frontend cannot tell an
// ingested row from a live way. Keeps the browser free of any Overpass credential.
import { createOverpassCellSource } from '../buildings/osm-reference.js';

const ROAD_FEATURE_CAP = 8000;     // matches /osm-road's own cap
export const ROAD_MAX_SPAN_DEG = 0.06;  // ≈ 6 km; a wider box is a city, not a scene

export function buildRoadQuery(bbox, { railways = false } = {}) {
    const [w, s, e, n] = bbox;
    const box = `(${s},${w},${n},${e})`;
    return railways
        ? `[out:json][timeout:25];(way["highway"]${box};way["railway"]${box};);out geom;`
        : `[out:json][timeout:25];way["highway"]${box};out geom;`;
}

function widthMetres(tags) {
    const raw = tags && tags.width != null ? String(tags.width).trim().replace(',', '.') : '';
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|meter|metres|meters)?$/i);
    const n = match ? Number(match[1]) : NaN;
    return Number.isFinite(n) && n > 0 && n < 200 ? n : null;
}

// Overpass `out geom` elements → /osm-road features ({ features, truncated }). Railway ways are kept
// only when asked for (the 2D road tools); the 3D life layer walks streets alone.
export function overpassRoadsToFeatures(elements, cap = ROAD_FEATURE_CAP, { railways = false } = {}) {
    const features = [];
    let truncated = false;
    for (const el of (Array.isArray(elements) ? elements : [])) {
        if (!el || el.type !== 'way' || !el.tags || !Array.isArray(el.geometry)) continue;
        if (!el.tags.highway && !(railways && el.tags.railway)) continue;
        if (features.length >= cap) { truncated = true; break; }
        const coordinates = el.geometry
            .filter(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat))
            .map(p => [p.lon, p.lat]);
        if (coordinates.length < 2) continue;
        features.push({
            type: 'Feature',
            // The cell source merges cells by feature id; a way crossing two cells must appear once.
            id: `w${el.id}`,
            geometry: { type: 'LineString', coordinates },
            properties: {
                osm_id: el.id,
                highway_type: el.tags.highway || null,
                railway_type: el.tags.railway || null,
                name: el.tags.name || null,
                width_meters: widthMetres(el.tags),
                city: null,
                tags: el.tags,
                // Shared node ids are how OSM says two ways connect; the road tools rebuild topology from them.
                osm_node_ids: Array.isArray(el.nodes) ? el.nodes : null,
                source: 'overpass'
            }
        });
    }
    return { type: 'FeatureCollection', features, truncated };
}

export function roadsBboxTooLarge(bbox) {
    const [w, s, e, n] = bbox;
    return !(e > w && n > s) || (e - w) > ROAD_MAX_SPAN_DEG || (n - s) > ROAD_MAX_SPAN_DEG;
}

// A box wider than a scene, cut down around its centre to just inside ROAD_MAX_SPAN_DEG (so rounding
// cannot push it over the cell source's own limit); null for a degenerate box.
export function clipRoadsBbox(bbox) {
    const [w, s, e, n] = bbox.map(Number);
    if (!(e > w && n > s)) return null;
    const cx = (w + e) / 2, cy = (s + n) / 2, half = ROAD_MAX_SPAN_DEG * 0.99 / 2;
    const halfX = Math.min((e - w) / 2, half), halfY = Math.min((n - s) / 2, half);
    return [cx - halfX, cy - halfY, cx + halfX, cy + halfY];
}

export const fetchOverpassRoads = createOverpassCellSource({
    label: 'roads',
    buildQuery: buildRoadQuery,
    convert: overpassRoadsToFeatures,
    featureCap: ROAD_FEATURE_CAP
});

// Streets and railways, for /osm-road?railways=1. Its own cell cache: a cell answered without rails
// must not satisfy a request that wants them.
export const fetchOverpassRoadsAndRailways = createOverpassCellSource({
    label: 'roads+railways',
    buildQuery: bbox => buildRoadQuery(bbox, { railways: true }),
    convert: (elements, cap) => overpassRoadsToFeatures(elements, cap, { railways: true }),
    featureCap: ROAD_FEATURE_CAP
});
