// GET /buildings?bbox=minX,minY,maxX,maxY  (HTRS96/TM EPSG:3765)
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_ZGRADE
export function setupBuildingsRoute(app, pool) {
    app.get('/buildings', async (req, res) => {
        try {
            const bbox = String(req.query.bbox || '').trim();
            const parts = bbox.split(',').map(n => Number(n));
            if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }
            const [minX, minY, maxX, maxY] = parts;

            // Query buildings intersecting bbox from building table
            // Assumptions: table name "building" with a geometry column "geom" in EPSG:3765
            const sql = `
                SELECT
                    ST_AsGeoJSON(b.geom)::json AS geometry,
                    (to_jsonb(b) - 'geom') AS properties
                FROM building b
                WHERE b.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                AND ST_Intersects(b.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                LIMIT 2000
            `;

            const { rows } = await pool.query(sql, [minX, minY, maxX, maxY]);

            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /buildings:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
