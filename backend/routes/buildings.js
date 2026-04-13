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

    // POST /buildings/near - Buildings within `buffer_meters` of a GeoJSON geometry (WGS84).
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, buffer_meters?: number }
    // Returns a GeoJSON FeatureCollection (EPSG:4326) from building_footprint,
    // with a computed `height` property derived from metadata.Z_Max - metadata.Z_Min.
    app.post('/buildings/near', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 100;

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 5000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..5000).' });
            }

            const sql = `
                WITH shape AS (
                    SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS geom
                )
                SELECT
                    bf.object_id,
                    bf.source,
                    bf.metadata,
                    ST_AsGeoJSON(ST_Transform(bf.geom, 4326))::json AS geometry,
                    NULLIF(
                        COALESCE((bf.metadata->>'Z_Max')::float, 0) - COALESCE((bf.metadata->>'Z_Min')::float, 0),
                        0
                    ) AS height
                FROM building_footprint bf, shape s
                WHERE ST_DWithin(bf.geom, s.geom, $2)
                LIMIT 5000
            `;

            const { rows } = await pool.query(sql, [JSON.stringify(geometry), bufferMeters]);

            const features = rows.map(row => ({
                type: 'Feature',
                properties: {
                    object_id: row.object_id,
                    source: row.source,
                    height: row.height,
                    metadata: row.metadata
                },
                geometry: row.geometry
            }));

            res.json({ type: 'FeatureCollection', features, count: features.length });
        } catch (err) {
            console.error('Error in POST /buildings/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
