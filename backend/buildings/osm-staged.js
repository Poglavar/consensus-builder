// The OSM buildings reference layer, served from shared geodata instead of live Overpass.
//
// We already stage Overture Maps in `overture_building_footprint` (Zagreb + Split), and Overture's
// buildings theme is mostly OSM: 191k of Zagreb's 191k+53k rows carry OpenStreetMap as their source,
// with the OSM element id preserved in `osm_id`. Filtering to those rows IS the OSM survey — the
// same footprints Overpass would return, minus the rate limit, the latency and the outage. The
// Microsoft ML footprints in the same table are a different survey and are deliberately excluded:
// this layer's whole purpose is to be the community map, not a blend of everything available.
//
// Overpass stays as the fallback for cities we have not ingested (see osm-reference.js), so the
// endpoint keeps working everywhere while being instant where it matters.

// Rows above this and the request did not cover its bbox; the caller is told (`truncated`), exactly
// as the Overpass path does.
const STAGED_FEATURE_CAP = 8000;

// Which cities are ingested, cached per process: a lookup per viewport pan would be silly, and the
// answer only changes when someone runs an ingest.
let stagedCities = null;
let stagedCitiesAt = 0;
const CITY_CACHE_TTL_MS = 10 * 60 * 1000;

async function stagedOsmCities(pool) {
    if (stagedCities && (stagedCitiesAt + CITY_CACHE_TTL_MS) > Date.now()) return stagedCities;
    const { rows } = await pool.query(
        `SELECT DISTINCT city FROM overture_building_footprint WHERE osm_id IS NOT NULL`
    );
    stagedCities = new Set(rows.map(row => String(row.city)));
    stagedCitiesAt = Date.now();
    return stagedCities;
}

// One staged row → the same Feature shape the Overpass path produces, so the frontend cannot tell
// which path served it. `id` stays the OSM element id (w… / r…) for exactly that reason.
function stagedRowToFeature(row) {
    const height = Number(row.height);
    const floors = Number(row.num_floors);
    return {
        type: 'Feature',
        id: row.osm_id,
        geometry: row.geometry,
        properties: {
            osm_id: row.osm_id,
            height_m: Number.isFinite(height) && height > 0
                ? height
                : (Number.isFinite(floors) && floors > 0 ? floors * 3 : null),
            name: (row.names && (row.names.primary || row.names.common?.local)) || null
        }
    };
}

// Building footprints inside a WGS84 bbox from the staged table. Returns null when this city has
// nothing ingested, which is the caller's signal to fall back to Overpass.
async function fetchStagedOsmBuildings(pool, bbox, city) {
    if (!pool || !city) return null;
    const cities = await stagedOsmCities(pool);
    if (!cities.has(String(city))) return null;

    const [w, s, e, n] = bbox;
    const { rows } = await pool.query(
        `SELECT osm_id, names, height, num_floors, ST_AsGeoJSON(geom)::json AS geometry
           FROM overture_building_footprint
          WHERE city = $5
            AND osm_id IS NOT NULL
            AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
          LIMIT ${STAGED_FEATURE_CAP + 1}`,
        [w, s, e, n, String(city)]
    );
    const truncated = rows.length > STAGED_FEATURE_CAP;
    return {
        type: 'FeatureCollection',
        features: rows.slice(0, STAGED_FEATURE_CAP).filter(row => row.geometry).map(stagedRowToFeature),
        truncated,
        source: 'staged'
    };
}

export { fetchStagedOsmBuildings, stagedRowToFeature, stagedOsmCities, STAGED_FEATURE_CAP };
