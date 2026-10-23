// The OSM buildings reference layer, served from shared geodata instead of live Overpass.
//
// Overture's buildings theme includes OpenStreetMap sourced rows with their element ids preserved
// in `osm_id`. These rows provide a fast staged source when matching footprints cover the requested
// bbox. They are not assumed to be a complete OSM survey: an empty bbox result falls through to the
// live Overpass path. Microsoft ML footprints in the same table are deliberately excluded.

// Rows above this and the request did not cover its bbox; the caller is told (`truncated`), exactly
// as the Overpass path does.
const STAGED_FEATURE_CAP = 8000;

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
            measured_height_m: Number.isFinite(height) && height > 0 ? height : null,
            levels: Number.isFinite(floors) && floors > 0 ? floors : null,
            building: row.class || row.subtype || null,
            name: (row.names && (row.names.primary || row.names.common?.local)) || null
        }
    };
}

// Building footprints inside a WGS84 bbox from the staged table. City is only a duplicate-row
// preference; the bbox is the geographic scope. Returns null when no staged geometry matches, so
// the caller can fall back to Overpass.
async function fetchStagedOsmBuildings(pool, bbox, city) {
    if (!pool || !city) return null;

    const [w, s, e, n] = bbox;
    const { rows } = await pool.query(
        `SELECT DISTINCT ON (osm_id)
                osm_id, names, height, num_floors, class, subtype,
                ST_AsGeoJSON(geom)::json AS geometry
           FROM overture_building_footprint
          WHERE osm_id IS NOT NULL
            AND geom IS NOT NULL
            AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
          ORDER BY osm_id, (city = $5) DESC NULLS LAST
          LIMIT ${STAGED_FEATURE_CAP + 1}`,
        [w, s, e, n, String(city)]
    );
    if (!rows.length) return null;
    const truncated = rows.length > STAGED_FEATURE_CAP;
    return {
        type: 'FeatureCollection',
        features: rows.slice(0, STAGED_FEATURE_CAP).filter(row => row.geometry).map(stagedRowToFeature),
        truncated,
        source: 'staged'
    };
}

export { fetchStagedOsmBuildings, stagedRowToFeature, STAGED_FEATURE_CAP };
