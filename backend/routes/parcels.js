// GET /parcels?bbox=minX,minY,maxX,maxY OR ?coordinates=x,y OR ?parcel_number=broj_cestice
// Supports both WGS84 (lon,lat) and HTRS96/TM (EPSG:3765) coordinates
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_CESTICE
export function setupParcelsRoute(app, pool) {
    app.get('/parcels', async (req, res) => {
        try {
            const bbox = String(req.query.bbox || '').trim();
            const coordinates = String(req.query.coordinates || '').trim();
            const parcelNumber = String(req.query.parcel_number || '').trim();

            // Validate that at least one parameter is provided
            if (!bbox && !coordinates && !parcelNumber) {
                return res.status(400).json({ error: 'Missing required parameter. Provide either bbox, coordinates, or parcel_number.' });
            }

            // Validate that only one parameter is provided
            const paramCount = [bbox, coordinates, parcelNumber].filter(p => p).length;
            if (paramCount > 1) {
                return res.status(400).json({ error: 'Provide only one parameter: bbox, coordinates, or parcel_number.' });
            }

            let sql, params;

            if (bbox) {
                // Handle bbox parameter
                const parts = bbox.split(',').map(n => Number(n));
                if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
                    return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

                sql = `
                    SELECT
                        CESTICA_ID,
                        BROJ_CESTICE,
                        ST_AsGeoJSON(geom)::json AS geometry,
                        ST_Area(geom) AS calculated_area
                    FROM parcel
                    WHERE 1=1
                    AND current=true
                    AND geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                    AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                    LIMIT 2000
                `;
                params = [minX, minY, maxX, maxY];
            } else if (coordinates) {
                // Handle coordinates parameter
                const parts = coordinates.split(',').map(n => Number(n));
                if (parts.length !== 2 || parts.some(v => !isFinite(v))) {
                    return res.status(400).json({ error: 'Invalid coordinates. Expected x,y format.' });
                }
                const [x, y] = parts;

                // Detect coordinate system based on value ranges
                // WGS84: longitude -180 to 180, latitude -90 to 90
                // EPSG:3765 (HTRS96/TM): x ~400000-800000, y ~4000000-5000000
                const isWGS84 = (x >= -180 && x <= 180 && y >= -90 && y <= 90);
                const isHTRS96 = (x >= 300000 && x <= 900000 && y >= 4000000 && y <= 5500000);

                if (!isWGS84 && !isHTRS96) {
                    return res.status(400).json({
                        error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
                    });
                }

                if (isWGS84) {
                    // Transform from WGS84 (EPSG:4326) to HTRS96/TM (EPSG:3765)
                    sql = `
                        SELECT
                            CESTICA_ID,
                            BROJ_CESTICE,
                            ST_AsGeoJSON(geom)::json AS geometry,
                            ST_Area(geom) AS calculated_area
                        FROM parcel
                        WHERE 1=1
                        AND current=true
                        AND ST_Contains(geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765))
                        LIMIT 1
                    `;
                } else {
                    // Use coordinates as-is (already in EPSG:3765)
                    sql = `
                        SELECT
                            CESTICA_ID,
                            BROJ_CESTICE,
                            ST_AsGeoJSON(geom)::json AS geometry,
                            ST_Area(geom) AS calculated_area
                        FROM parcel
                        WHERE 1=1
                        AND current=true
                        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 3765))
                        LIMIT 1
                    `;
                }
                params = [x, y];
            } else if (parcelNumber) {
                // Handle parcel_number parameter - search by broj_cestice
                sql = `
                    SELECT
                        p.CESTICA_ID,
                        p.BROJ_CESTICE,
                        ST_AsGeoJSON(p.geom)::json AS geometry,
                        ST_Area(p.geom) AS calculated_area,
                        cm.naziv AS cadastral_municipality_name,
                        cm.maticni_broj AS cadastral_municipality_id
                    FROM parcel p
                    LEFT JOIN cadastral_municipality cm ON p.maticni_broj_ko = cm.maticni_broj
                    WHERE p.BROJ_CESTICE = $1
                    AND p.current = true
                    AND cm.grad_opcina = 'ZAGREB'
                    ORDER BY p.CESTICA_ID
                `;
                params = [parcelNumber];
            }

            const { rows } = await pool.query(sql, params);

            // Build GeoJSON FeatureCollection with expected property names
            const features = rows.map(r => ({
                type: 'Feature',
                properties: {
                    CESTICA_ID: String((r.cestica_id ?? r.cesticaid ?? r.cestica) || ''),
                    BROJ_CESTICE: String((r.broj_cestice ?? r.brojcestice) || ''),
                    calculatedArea: Number(r.calculated_area) || undefined,
                    // Include cadastral municipality info if available
                    ...(r.cadastral_municipality_name && {
                        cadastralMunicipality: {
                            id: r.cadastral_municipality_id,
                            name: r.cadastral_municipality_name
                        }
                    })
                },
                geometry: r.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
