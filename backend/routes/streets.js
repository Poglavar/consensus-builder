// GET /streets — the Zagreb street register (EPSG:3765 bbox); GET /streets/near — frontage street
// centrelines around a site (WGS84 bbox), from osm_road in Croatia and Overpass elsewhere.
import { parseBboxParam, POSTGIS_SRID } from '../utils/helpers.js';
import { streetsNear } from '../streets/near.js';

export function setupStreetsRoute(app, pool) {
    // GET /streets/near?bbox=minLon,minLat,maxLon,maxLat (EPSG:4326, a site plus a margin).
    // { type: 'FeatureCollection', features, source: 'osm_road'|'overpass', truncated, partial }.
    // 503 + Retry-After while Overpass is throttling us, like /buildings/osm.
    app.get('/streets/near', async (req, res) => {
        const bbox = String(req.query.bbox || '').trim().split(',').map(Number);
        try {
            res.json(await streetsNear(pool, bbox));
        } catch (err) {
            const status = err && err.status ? err.status : 500;
            if (status === 503) {
                const retryAfter = Number(err.retryAfter) > 0 ? Math.ceil(err.retryAfter) : 60;
                res.set('Retry-After', String(retryAfter));
                return res.status(503).json({ error: 'Street data is rate-limited upstream.', retryAfter });
            }
            if (status >= 500) console.error(`[${new Date().toISOString()}] Error in /streets/near:`, err);
            res.status(status).json({ error: status === 400 ? err.message : 'Failed to fetch streets.' });
        }
    });

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
