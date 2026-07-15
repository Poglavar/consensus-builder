// GET /osm-road?bbox=minX,minY,maxX,maxY (EPSG:3765) — existing-road CENTRELINES from the osm_road
// table (true OSM linestrings, with tags/width/highway_type), for drawing a read-only reference layer
// and, later, snapping new roads onto them. Viewport-scoped via the GiST index (WHERE current); the
// heavy geom_buffered column is deliberately NOT returned.
import { parseBboxParam, POSTGIS_SRID } from '../utils/helpers.js';

const MAX_FEATURES = 8000;

export function setupOsmRoadRoute(app, pool) {
    app.get('/osm-road', async (req, res) => {
        try {
            const bboxParts = parseBboxParam(req.query.bbox);
            const hasBbox = Array.isArray(bboxParts);

            if (req.query.bbox && !hasBbox) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }

            let sql = `
                SELECT
                    ST_AsGeoJSON(ST_Transform(r.geom, 4326))::json AS geometry,
                    jsonb_build_object(
                        'osm_id', r.osm_id,
                        'highway_type', r.highway_type,
                        'railway_type', r.railway_type,
                        'name', r.name,
                        'width_meters', r.width_meters,
                        'tags', r.tags,
                        'source', 'osm_road'
                    ) AS properties
                FROM osm_road r
                WHERE r.current AND r.geom IS NOT NULL AND r.highway_type IS NOT NULL
            `;

            const params = [];
            if (hasBbox) {
                // The incoming bbox is EPSG:3765 (POSTGIS_SRID), but osm_road.geom is stored in a
                // DIFFERENT SRID depending on the environment — 3765 on the dev DB, 4326 on prod. So the
                // envelope is transformed into whatever SRID the table actually uses (read once from the
                // data), keeping the && index-usable in the geom's native SRID instead of matching nothing.
                sql += ` AND r.geom && ST_Transform(
                    ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}),
                    (SELECT ST_SRID(geom) FROM osm_road WHERE current AND geom IS NOT NULL LIMIT 1)
                )`;
                params.push(bboxParts[0], bboxParts[1], bboxParts[2], bboxParts[3]);
            }

            sql += `\n            LIMIT ${MAX_FEATURES}\n        `;

            const { rows } = await pool.query(sql, params);
            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            res.json({ type: 'FeatureCollection', features, truncated: features.length >= MAX_FEATURES });
        } catch (err) {
            console.error('Error in /osm-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
