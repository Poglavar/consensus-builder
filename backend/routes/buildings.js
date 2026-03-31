// GET /buildings/tables - Check what tables exist
export function setupBuildingsRoute(app, pool) {
    // GET /buildings?bbox=minX,minY,maxX,maxY  (HTRS96/TM EPSG:3765)
    // GET /buildings?cestica_id=ID - Get buildings mostly contained within a parcel
    // Respond with GeoJSON FeatureCollection compatible with OSS DKP_ZGRADE

    // GET /buildings/?cestica_id= - Get buildings mostly contained within a parcel
    app.get('/buildings', async (req, res) => {
        try {
            const cesticaId = req.query.cestica_id;
            const bbox = String(req.query.bbox || '').trim();
            const parts = bbox.split(',').map(n => Number(n));

            if (bbox && (parts.length !== 4 || parts.some(v => !isFinite(v)))) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }

            if (cesticaId) {
                // Query for buildings mostly contained within a specific parcel
                const sql = `
                    SELECT 
                        bf.*,
                        ST_AsGeoJSON(bf.geom)::json AS geometry,
                        ST_Area(bf.geom) AS footprint_area,
                        ST_Area(ST_Intersection(p.geom, bf.geom)) AS intersection_area,
                        CASE 
                            WHEN ST_Area(bf.geom) > 0 THEN ST_Area(ST_Intersection(p.geom, bf.geom)) / ST_Area(bf.geom)
                            ELSE 0 
                        END AS containment_ratio,
                        p.CESTICA_ID,
                        p.BROJ_CESTICE
                    FROM building_footprint bf
                    CROSS JOIN parcel p
                    WHERE p.CESTICA_ID = $1
                    AND ST_Intersects(p.geom, bf.geom)
                    AND ST_Area(ST_Intersection(p.geom, bf.geom)) / ST_Area(bf.geom) >= 0.9
                    ORDER BY containment_ratio DESC
                `;

                const { rows } = await pool.query(sql, [cesticaId]);

                const features = rows.map(row => ({
                    type: 'Feature',
                    properties: {
                        ...row,
                        footprint_area: row.footprint_area,
                        containment_ratio: row.containment_ratio,
                        cestica_id: row.CESTICA_ID,
                        broj_cestice: row.BROJ_CESTICE
                    },
                    geometry: row.geometry
                }));

                res.json({
                    type: 'FeatureCollection',
                    features,
                    cestica_id: cesticaId,
                    count: features.length
                });
            } else {
                // Original bbox query for backward compatibility
                if (!bbox) {
                    return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

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
            }
        } catch (err) {
            console.error('Error in /buildings:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
