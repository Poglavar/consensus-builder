import { geoJsonToEsriRings, computeBoundsFromRings, queryFeatureService, transformCoordinates, ARCGIS_BASE_URL } from '../utils/helpers.js';

// GET /object?geometry=<geometry>
// Get object geometry from ArcGIS API and database
export function setupObjectRoute(app, pool) {
    app.get('/objects', async (req, res) => {
        try {
            const geometryParam = req.query.geometry;
            if (!geometryParam) {
                return res.status(400).json({ error: 'Missing required parameter: geometry' });
            }

            let geometry;
            try {
                geometry = JSON.parse(geometryParam);
            } catch (error) {
                return res.status(400).json({ error: 'Invalid geometry parameter. Must be valid JSON.' });
            }

            // Detect coordinate system from geometry
            let needsTransformation = false;
            let sourceSRID = 4326; // Default to WGS84

            // Check if geometry has CRS information
            if (geometry.crs && geometry.crs.properties && geometry.crs.properties.name) {
                const crsName = geometry.crs.properties.name;
                if (crsName.includes('3765')) {
                    sourceSRID = 3765;
                    needsTransformation = true;
                }
            } else {
                // Fallback: detect by coordinate ranges
                const coords = geometry.coordinates;
                if (coords && coords.length > 0) {
                    const firstCoord = coords[0][0][0]; // Get first coordinate
                    const [x, y] = firstCoord;

                    // Check if coordinates are in HTRS96/TM range
                    if (x >= 300000 && x <= 900000 && y >= 4000000 && y <= 5500000) {
                        sourceSRID = 3765;
                        needsTransformation = true;
                    }
                }
            }

            // Convert geometry to Esri format for ArcGIS API
            let rings = geoJsonToEsriRings(geometry);
            if (!rings.length) {
                return res.status(400).json({ error: 'Invalid geometry format. Expected Polygon or MultiPolygon.' });
            }

            const bounds = computeBoundsFromRings(rings);
            if (!bounds) {
                return res.status(400).json({ error: 'Could not compute bounds from geometry.' });
            }

            // Create Esri geometry object with appropriate spatial reference
            const esriGeometry = {
                rings: rings,
                spatialReference: { wkid: needsTransformation ? sourceSRID : 4326 }
            };

            // Query ArcGIS API to get object_id with tolerance options
            let features = [];

            // Try different spatial relationships with increasing tolerance
            const spatialRelations = [
                { spatialRel: 'esriSpatialRelIntersects', tolerance: 1.0 },
                { spatialRel: 'esriSpatialRelIntersects', tolerance: 5.0 },
                { spatialRel: 'esriSpatialRelWithin', tolerance: 1.0 },
                { spatialRel: 'esriSpatialRelContains', tolerance: 1.0 }
            ];

            for (const options of spatialRelations) {
                try {
                    features = await queryFeatureService(esriGeometry, ARCGIS_BASE_URL, options);
                    if (features.length > 0) {
                        break; // Found results, stop trying
                    }
                } catch (error) {
                    console.warn(`Spatial relation ${options.spatialRel} failed:`, error.message);
                    continue; // Try next option
                }
            }

            if (!features.length) {
                return res.status(404).json({ error: 'No objects found for the given geometry with any spatial relationship.' });
            }

            // Get object_ids from the features
            const objectIds = features.map(feature => feature.attributes?.OBJECTID).filter(id => id !== undefined);

            if (!objectIds.length) {
                return res.status(404).json({ error: 'No valid object IDs found.' });
            }

            // Query building_3d table for the object_ids
            const placeholders = objectIds.map((_, index) => `$${index + 1}`).join(',');
            const sql = `
                SELECT 
                    object_id,
                    ST_AsGeoJSON(shape)::json AS geometry,
                    (to_jsonb(b3d) - 'shape') AS properties
                FROM building_3d b3d
                WHERE object_id IN (${placeholders})
            `;

            const { rows } = await pool.query(sql, objectIds);

            if (!rows.length) {
                return res.status(404).json({ error: 'No building data found for the object IDs.' });
            }

            // Return the building shapes as GeoJSON features
            const features_result = rows.map(row => ({
                type: 'Feature',
                properties: {
                    object_id: row.object_id,
                    ...row.properties
                },
                geometry: row.geometry
            }));

            res.json({
                type: 'FeatureCollection',
                features: features_result
            });

        } catch (err) {
            console.error('Error in /object:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
