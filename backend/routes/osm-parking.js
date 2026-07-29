// GET /osm-parking?bbox=minLon,minLat,maxLon,maxLat (EPSG:4326).
//
// Separately mapped `amenity=parking + parking=street_side` polygons, read from the versioned
// `parking.osm_parking` snapshot maintained by zagreb-parkiralista. Runtime map drawing must never
// depend on Overpass availability: refreshing OSM is an ingest job, serving it is an indexed DB read.
const MAX_FEATURES = 2000;
const MAX_SPAN_DEG = 0.06;

export function setupOsmParkingRoute(app, pool) {
    app.get('/osm-parking', async (req, res) => {
        const bbox = String(req.query.bbox || '').trim().split(',').map(Number);
        const [west, south, east, north] = bbox;
        if (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))
            || east <= west || north <= south
            || east - west > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG) {
            return res.status(400).json({
                error: 'Invalid or oversized bbox. Expected minLon,minLat,maxLon,maxLat in EPSG:4326.'
            });
        }
        try {
            const { rows } = await pool.query(`
                SELECT
                    p.osm_type || '/' || p.osm_id AS id,
                    ST_AsGeoJSON(p.geom)::json AS geometry,
                    jsonb_build_object(
                        'osm_id', p.osm_type || '/' || p.osm_id,
                        'amenity', 'parking',
                        'parking', p.parking,
                        'orientation', p.all_tags->>'orientation',
                        'capacity', p.capacity,
                        'access', p.access,
                        'source', 'parking.osm_parking'
                    ) AS properties
                FROM parking.osm_parking p
                WHERE p.current
                  AND p.date_missing IS NULL
                  AND p.parking = 'street_side'
                  AND GeometryType(p.geom) IN ('POLYGON', 'MULTIPOLYGON')
                  AND p.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
                LIMIT ${MAX_FEATURES}
            `, bbox);
            const features = rows.map(row => ({
                type: 'Feature',
                id: row.id,
                geometry: row.geometry,
                properties: row.properties || {}
            }));
            res.json({
                type: 'FeatureCollection',
                features,
                truncated: features.length >= MAX_FEATURES,
                limit: MAX_FEATURES
            });
        } catch (error) {
            console.error('[osm-parking] database query failed:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
