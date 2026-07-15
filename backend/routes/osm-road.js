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
                sql += ` AND r.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})`;
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
