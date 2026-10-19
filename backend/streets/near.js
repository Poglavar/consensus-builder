// Street centrelines near a site, for choosing which edge of a drawn site faces a street (the
// default frontage of plots: PARCEL-OPTIONAL.md phase 7a). Two sources, one answer shape:
//   - osm_road (shared geodata): every Croatian road, already ingested, index-backed in EPSG:4326;
//   - Overpass, cell-cached through the same proxy as the OSM buildings reference layer, for places
//     osm_road does not reach (the explore cities).
// Whether osm_road reaches a bbox is read from the table's own extent, not from a city list (the
// estimated extent runs a little past the border, where osm_road simply has fewer streets).
// Features: LineString, properties { osm_id, name, highway, source }.
import { createOverpassCellSource } from '../buildings/osm-reference.js';

// Ways a plot can front: roads people live on or reach a door from. Footways, paths, cycleways,
// motorways and their links are not frontage; a service road is only when it is named.
const FRONTAGE_HIGHWAYS = Object.freeze([
    'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian'
]);
const STREET_FEATURE_CAP = 4000;
// A frontage lookup is a site plus a margin; anything wider is a misuse of the endpoint.
const MAX_SPAN_DEG = 0.05;
const EXTENT_TTL_MS = 10 * 60 * 1000;

let osmRoadExtent = null;
let osmRoadExtentAt = 0;

// The Overpass QL for frontage streets inside one cell (bbox order south,west,north,east).
function buildStreetQuery(bbox) {
    const [w, s, e, n] = bbox;
    const box = `(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(way["highway"~"^(${FRONTAGE_HIGHWAYS.join('|')})$"]${box};way["highway"="service"]["name"]${box};);out geom;`;
}

// Overpass `out geom` ways -> LineString features. Pure, for tests.
function overpassStreetsToGeoJSON(elements, cap = STREET_FEATURE_CAP) {
    const features = [];
    let truncated = false;
    for (const el of (Array.isArray(elements) ? elements : [])) {
        if (!el || el.type !== 'way' || !el.tags || !el.tags.highway || !Array.isArray(el.geometry)) continue;
        if (features.length >= cap) { truncated = true; break; }
        const coordinates = el.geometry
            .filter(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat))
            .map(p => [p.lon, p.lat]);
        if (coordinates.length < 2) continue;
        features.push({
            type: 'Feature',
            id: `w${el.id}`,
            geometry: { type: 'LineString', coordinates },
            properties: { osm_id: `w${el.id}`, name: el.tags.name || null, highway: el.tags.highway, source: 'overpass' }
        });
    }
    return { type: 'FeatureCollection', features, truncated };
}

const fetchOverpassStreets = createOverpassCellSource({
    label: 'streets',
    buildQuery: buildStreetQuery,
    convert: overpassStreetsToGeoJSON,
    featureCap: STREET_FEATURE_CAP
});

async function osmRoadExtentOf(pool) {
    if (osmRoadExtentAt + EXTENT_TTL_MS > Date.now()) return osmRoadExtent;
    // The planner's estimate (milliseconds, from the column statistics; slightly generous at the
    // border) — the exact ST_Extent scans the whole table (seconds) and is only the fallback for a
    // table without statistics.
    const { rows } = await pool.query(`
        SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n
        FROM (SELECT COALESCE(
            ST_EstimatedExtent('public', 'osm_road', 'geom'),
            (SELECT ST_Extent(geom) FROM osm_road WHERE current AND geom IS NOT NULL)
        ) AS e) x
    `);
    const row = rows && rows[0];
    osmRoadExtent = row && [row.w, row.s, row.e, row.n].every(v => Number.isFinite(Number(v)))
        ? [Number(row.w), Number(row.s), Number(row.e), Number(row.n)]
        : null;
    osmRoadExtentAt = Date.now();
    return osmRoadExtent;
}

const contains = (outer, inner) => !!(outer && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]);

/**
 * Frontage streets inside a WGS84 bbox [w, s, e, n].
 * @returns {Promise<{type, features, source: 'osm_road'|'overpass', truncated, partial}>}
 * Throws with .status 400 for a bad bbox, and Overpass's .status/.retryAfter when it cannot answer.
 */
async function streetsNear(pool, bbox, options = {}) {
    const [w, s, e, n] = bbox;
    if (bbox.length !== 4 || ![w, s, e, n].every(Number.isFinite) || e <= w || n <= s || (e - w) > MAX_SPAN_DEG || (n - s) > MAX_SPAN_DEG) {
        const err = new Error(`Invalid bbox: expected minLon,minLat,maxLon,maxLat (EPSG:4326) spanning at most ${MAX_SPAN_DEG} degrees.`);
        err.status = 400;
        throw err;
    }
    if (contains(await osmRoadExtentOf(pool), bbox)) {
        const { rows } = await pool.query(`
            SELECT ST_AsGeoJSON(r.geom)::json AS geometry, r.osm_id, r.name, r.highway_type
            FROM osm_road r
            WHERE r.current AND r.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
              AND (r.highway_type = ANY($5) OR (r.highway_type = 'service' AND r.name IS NOT NULL))
            LIMIT ${STREET_FEATURE_CAP + 1}
        `, [w, s, e, n, FRONTAGE_HIGHWAYS]);
        const truncated = rows.length > STREET_FEATURE_CAP;
        const features = rows.slice(0, STREET_FEATURE_CAP).map(row => ({
            type: 'Feature',
            geometry: row.geometry,
            properties: { osm_id: String(row.osm_id), name: row.name || null, highway: row.highway_type, source: 'osm_road' }
        }));
        return { type: 'FeatureCollection', features, source: 'osm_road', truncated, partial: false };
    }
    const fc = await (options.fetchOverpass || fetchOverpassStreets)(bbox);
    return { ...fc, source: 'overpass' };
}

// Test hook: forget the cached osm_road extent.
function resetStreetsNearCache() {
    osmRoadExtent = null;
    osmRoadExtentAt = 0;
}

export { FRONTAGE_HIGHWAYS, buildStreetQuery, overpassStreetsToGeoJSON, streetsNear, resetStreetsNearCache };
