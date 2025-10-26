// GET /land-uses/?coordinates=x,y
// Returns land use data for the given coordinates
// Supports both WGS84 (lon,lat) and HTRS96/TM (EPSG:3765) coordinates
export function setupLandUsesRoute(app, pool) {
    app.get('/land-uses', async (req, res) => {
        try {
            const coordinates = String(req.query.coordinates || '').trim();

            // Validate that coordinates parameter is provided
            if (!coordinates) {
                return res.status(400).json({ error: 'Missing required parameter: coordinates. Expected x,y format.' });
            }

            // Parse coordinates
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

            let sql, params;

            if (isWGS84) {
                // Transform from WGS84 (EPSG:4326) to HTRS96/TM (EPSG:3765)
                sql = `
                    SELECT 
                        coalesce(oznaka, 'IS') as oznaka,
                        namjena, 
                        skupna_namjena, 
                        naziv_plana, 
                        godina_zadnje_izmjene, 
                        ST_AsGeoJSON(geom)::json AS geometry
                    FROM planned_land_use 
                    WHERE 1=1
                    AND city_id = 1 -- Zagreb
                    AND razina_plana = 'Generalni urbanistički plan Zagreba'
                    AND ST_Contains(geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765))
                `;
            } else {
                // Use coordinates as-is (already in EPSG:3765)
                sql = `
                    SELECT 
                        coalesce(oznaka, 'IS') as oznaka,
                        namjena, 
                        skupna_namjena, 
                        naziv_plana, 
                        godina_zadnje_izmjene, 
                        ST_AsGeoJSON(geom)::json AS geometry
                    FROM planned_land_use 
                    WHERE 1=1
                    AND city_id = 1 -- Zagreb
                    AND razina_plana = 'Generalni urbanistički plan Zagreba'
                    AND oznaka is null
                    AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 3765))
                `;
            }
            params = [x, y];

            const { rows } = await pool.query(sql, params);

            // Build GeoJSON FeatureCollection
            const features = rows.map(r => ({
                type: 'Feature',
                properties: {
                    oznaka: r.oznaka,
                    namjena: r.namjena,
                    skupna_namjena: r.skupna_namjena,
                    naziv_plana: r.naziv_plana,
                    godina_zadnje_izmjene: r.godina_zadnje_izmjene
                },
                geometry: r.geometry
            }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /land-uses:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
