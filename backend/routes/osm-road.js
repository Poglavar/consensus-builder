// GET /osm-road?bbox=minX,minY,maxX,maxY (EPSG:3765) — existing-road CENTRELINES from the osm_road
// table (true OSM linestrings, with tags/width/highway_type/city), for drawing a read-only reference
// layer and, later, snapping new roads onto them.
//
// osm_road stores the native OSM geometry in `geom` (EPSG:4326) and a GENERATED, indexed `geom_3765`
// for Croatian-TM spatial ops. Both dev and prod carry this schema (dev was realigned to prod on
// 2026-07-15). We filter with geom_3765 (the incoming bbox is 3765, index-backed) and output geom
// (already 4326, ready for GeoJSON) — the heavy buffered columns are never returned.
//
// `?rail=1` additionally returns the STREET-RUNNING TRAMWAYS, which have no highway_type at all and
// are therefore invisible to the default query — 463 ways in Zagreb, i.e. every tram median in the
// city. Opt-in rather than default, because the reference layer and the road snapping both read this
// endpoint and a tram reservation is not something a new road should snap onto. Heavy rail
// (`railway_type='rail'`, 1173 ways) is never included: a railway line is not a street.
import { parseBboxParam, POSTGIS_SRID } from '../utils/helpers.js';

const MAX_FEATURES = 8000;
// The railway classes that run in a street and so form part of its cross-section.
const STREET_RAILWAYS = ['tram', 'light_rail'];

export function setupOsmRoadRoute(app, pool) {
    app.get('/osm-road', async (req, res) => {
        try {
            const bboxParts = parseBboxParam(req.query.bbox);
            const hasBbox = Array.isArray(bboxParts);

            if (req.query.bbox && !hasBbox) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }

            const withRail = ['1', 'true', 'yes'].includes(String(req.query.rail || '').toLowerCase());

            const params = [];
            let sql = `
                SELECT
                    ST_AsGeoJSON(r.geom)::json AS geometry,
                    jsonb_build_object(
                        'osm_id', r.osm_id,
                        'highway_type', r.highway_type,
                        'railway_type', r.railway_type,
                        'name', r.name,
                        'width_meters', r.width_meters,
                        'city', r.city,
                        'tags', r.tags,
                        'source', 'osm_road'
                    ) AS properties
                FROM osm_road r
                WHERE r.current AND r.geom_3765 IS NOT NULL
            `;

            if (withRail) {
                params.push(STREET_RAILWAYS);
                sql += ` AND (r.highway_type IS NOT NULL OR r.railway_type = ANY($${params.length}))`;
            } else {
                sql += ' AND r.highway_type IS NOT NULL';
            }

            if (hasBbox) {
                // Index-backed bbox test in the geom's Croatian-TM SRID (matches the incoming bbox).
                const [minX, minY, maxX, maxY] = bboxParts;
                params.push(minX, minY, maxX, maxY);
                sql += ` AND r.geom_3765 && ST_MakeEnvelope($${params.length - 3},$${params.length - 2},`
                    + `$${params.length - 1},$${params.length}, ${POSTGIS_SRID})`;
            }

            sql += `\n            LIMIT ${MAX_FEATURES}\n        `;

            const { rows } = await pool.query(sql, params);
            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            // A truncated answer is a SILENT one unless somebody says so: the ways that fell off the
            // end are indistinguishable from ways OSM does not have, and a caller reconstructing a
            // cross-section from them would report "no OSM way describes this street" for a street
            // that has one. Flagged in the body AND in the log, since the two have different readers.
            const truncated = features.length >= MAX_FEATURES;
            if (truncated) {
                console.warn(`/osm-road: hit the ${MAX_FEATURES}-way limit for bbox=${req.query.bbox || 'all'}`
                    + '; the answer is incomplete');
            }

            res.json({ type: 'FeatureCollection', features, truncated, limit: MAX_FEATURES });
        } catch (err) {
            console.error('Error in /osm-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
