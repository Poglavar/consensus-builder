import { parseBboxParam, POSTGIS_SRID } from '../utils/helpers.js';

export function setupStreetsRoute(app, pool) {
    app.get('/streets', async (req, res) => {
        try {
            const bboxParts = parseBboxParam(req.query.bbox);
            const hasBbox = Array.isArray(bboxParts);

            if (req.query.bbox && !hasBbox) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }

            let sql = `
                SELECT
                    ST_AsGeoJSON(ST_Transform(s.geom, 4326))::json AS geometry,
                    (to_jsonb(s) - 'geom') AS properties
                FROM street s
                WHERE s.geom IS NOT NULL
            `;

            const params = [];
            if (hasBbox) {
                sql += ` AND s.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})`;
                params.push(bboxParts[0], bboxParts[1], bboxParts[2], bboxParts[3]);
            }

            sql += '\n            LIMIT 5000\n        ';

            const { rows } = await pool.query(sql, params);
            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /streets:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
