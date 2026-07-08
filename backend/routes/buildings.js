// GET /buildings/tables - Check what tables exist
import { createBuildingProviders } from '../buildings/index.js';

export function setupBuildingsRoute(app, pool) {
    // Per-city 3D building source registry (Zagreb mesh table, NYC live footprints, …).
    const buildingProviders = createBuildingProviders(pool);
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

    // POST /buildings/near - Full 3D building meshes within `buffer_meters` of a GeoJSON point/geometry.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, buffer_meters?: number, city?: string }
    //
    // Source is per-city via the building-provider registry (see backend/buildings/): Zagreb
    // serves pre-built LOD2 meshes from `building_3d`, NYC extrudes live footprint sources, etc.
    // Whatever the source, every provider yields the same flat-face shape in EPSG:4326 with Z in
    // metres. `city` is the CityConfigManager city id; omitting it defaults to Zagreb.
    //
    // Response shape:
    //   {
    //     buildings: [
    //       { object_id, z_min, z_max, faces: [<GeoJSON Polygon with 3D coords>, ...] },
    //       ...
    //     ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    //
    // The client is expected to triangulate each face and lift it back into 3D.
    app.post('/buildings/near', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            const city = typeof body.city === 'string' ? body.city : undefined;

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            const provider = buildingProviders.resolve(city);
            if (!provider) {
                return res.status(400).json({ error: `No 3D building source for city '${city}'.` });
            }

            const result = await provider.near(geometry, bufferMeters);
            res.json({ buildings: result.buildings, count: result.count, source: result.source });
        } catch (err) {
            console.error('Error in POST /buildings/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/footprints - 2D footprints (+ known heights) of existing buildings mostly
    // inside a GeoJSON polygon. Backs the urban-rule "based on existing buildings" mode.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, city?: string }
    //
    // Footprints are an OPTIONAL per-city provider capability: a provider that implements
    // `footprints(geometry)` supports it, everything else reports `supported: false` (the
    // frontend hides/reverts the mode). Unknown cities resolve to no provider on purpose —
    // the Zagreb fallback used by /buildings/near would falsely claim support here.
    //
    // Response shape:
    //   {
    //     supported: true|false,
    //     footprints: [ { id, geometry: <GeoJSON Polygon/MultiPolygon>, height_m|null, floors|null }, ... ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    app.post('/buildings/footprints', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const city = typeof body.city === 'string' ? body.city : undefined;

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }

            const provider = buildingProviders.resolveExact(city);
            if (!provider || typeof provider.footprints !== 'function') {
                return res.json({ supported: false, footprints: [], count: 0, source: null });
            }

            const result = await provider.footprints(geometry);
            res.json({ supported: true, footprints: result.footprints, count: result.count, source: result.source });
        } catch (err) {
            console.error('Error in POST /buildings/footprints:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
