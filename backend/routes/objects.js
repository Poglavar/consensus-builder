// GET /objects?geometry=<geometry>
// Get 3D building geometry using local PostGIS spatial query
// No external ArcGIS dependency - uses gdi_building_footprint for spatial lookup
// and gdi_building_3d for the actual 3D geometry (both keyed by the same object_id)
import { MAX_CELL_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';

// Full LOD2 shapes are heavy, so a lookup is bounded twice: by the extent of the query geometry and
// by a row ceiling (`truncated: true` in the response when it bites).
export const MAX_OBJECTS = 500;

function geometryExtent(geometry) {
    const rings = geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : geometry.coordinates;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
        for (const [x, y] of ring) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
}

function extentAreaKm2(extent, srid) {
    return srid === 4326
        ? wgs84BboxAreaKm2(extent.minX, extent.minY, extent.maxX, extent.maxY)
        : ((extent.maxX - extent.minX) * (extent.maxY - extent.minY)) / 1e6;
}

function isFinitePosition(position) {
    return Array.isArray(position)
        && position.length >= 2
        && Number.isFinite(position[0])
        && Number.isFinite(position[1]);
}

function isValidLinearRing(ring) {
    return Array.isArray(ring)
        && ring.length >= 4
        && ring.every(isFinitePosition);
}

function hasValidPolygonCoordinates(geometry) {
    return Array.isArray(geometry?.coordinates)
        && geometry.coordinates.length > 0
        && geometry.coordinates.every(isValidLinearRing);
}

function hasValidMultiPolygonCoordinates(geometry) {
    return Array.isArray(geometry?.coordinates)
        && geometry.coordinates.length > 0
        && geometry.coordinates.every(
            polygon => Array.isArray(polygon)
                && polygon.length > 0
                && polygon.every(isValidLinearRing)
        );
}

export function setupObjectRoute(app, pool) {
    app.get('/objects', async (req, res) => {
        try {
            const geometryParam = req.query.geometry;
            if (typeof geometryParam !== 'string' || !geometryParam) {
                return res.status(400).json({ error: 'Missing required parameter: geometry' });
            }

            let geometry;
            try {
                geometry = JSON.parse(geometryParam);
            } catch (error) {
                return res.status(400).json({ error: 'Invalid geometry parameter. Must be valid JSON.' });
            }

            // Validate geometry type
            if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
                return res.status(400).json({ error: 'Invalid geometry format. Expected Polygon or MultiPolygon.' });
            }

            const hasValidCoordinates = geometry.type === 'Polygon'
                ? hasValidPolygonCoordinates(geometry)
                : hasValidMultiPolygonCoordinates(geometry);

            if (!hasValidCoordinates) {
                return res.status(400).json({
                    error: 'Invalid geometry coordinates. Expected GeoJSON Polygon or MultiPolygon rings with numeric coordinates.'
                });
            }

            // Detect coordinate system from geometry
            let sourceSRID = 4326; // Default to WGS84

            // Check if geometry has CRS information
            if (geometry.crs && geometry.crs.properties && geometry.crs.properties.name) {
                const crsName = geometry.crs.properties.name;
                if (crsName.includes('3765')) {
                    sourceSRID = 3765;
                }
            } else {
                // Fallback: detect by coordinate ranges
                const coords = geometry.coordinates;
                if (coords && coords.length > 0) {
                    // Handle both Polygon and MultiPolygon
                    const firstRing = geometry.type === 'MultiPolygon' ? coords[0][0] : coords[0];
                    if (firstRing && firstRing.length > 0) {
                        const [x, y] = firstRing[0];
                        // Check if coordinates are in HTRS96/TM range
                        if (x >= 300000 && x <= 900000 && y >= 4000000 && y <= 5500000) {
                            sourceSRID = 3765;
                        }
                    }
                }
            }

            const areaKm2 = extentAreaKm2(geometryExtent(geometry), sourceSRID);
            if (!(areaKm2 <= MAX_CELL_BBOX_KM2)) {
                return res.status(400).json({ error: `Geometry extent too large (max ${MAX_CELL_BBOX_KM2} km²).` });
            }

            // Use local PostGIS spatial query instead of external ArcGIS API
            // Join gdi_building_footprint (spatial lookup) with gdi_building_3d (3D geometry)
            const sql = `
                SELECT DISTINCT
                    b3d.object_id,
                    ST_AsGeoJSON(b3d.shape)::jsonb AS geometry,
                    bf.metadata::jsonb AS properties
                FROM gdi_building_footprint bf
                JOIN gdi_building_3d b3d ON bf.object_id = b3d.object_id
                WHERE ST_Intersects(
                    bf.geom,
                    ST_Transform(
                        ST_SetSRID(ST_GeomFromGeoJSON($1), $2),
                        3765
                    )
                )
                LIMIT $3
            `;

            const { rows: fetched } = await pool.query(sql, [JSON.stringify(geometry), sourceSRID, MAX_OBJECTS + 1]);
            const truncated = fetched.length > MAX_OBJECTS;
            const rows = truncated ? fetched.slice(0, MAX_OBJECTS) : fetched;

            if (!rows.length) {
                return res.status(404).json({ error: 'No 3D objects found for the given geometry.' });
            }

            // Return the building shapes as GeoJSON features
            const features = rows.map(row => ({
                type: 'Feature',
                properties: {
                    object_id: row.object_id,
                    ...(row.properties || {})
                },
                geometry: row.geometry
            }));

            res.json({
                type: 'FeatureCollection',
                features,
                truncated
            });

        } catch (err) {
            console.error('Error in /objects:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
