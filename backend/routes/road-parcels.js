// Serve classified road parcels as GeoJSON, clipped to a viewport bbox.
// Accepts WGS84 (EPSG:4326) bbox for easy integration with Leaflet maps.

import { POSTGIS_SRID } from '../utils/helpers.js';

function parseWgs84Bbox(raw) {
    if (!raw) return null;
    const parts = String(raw).split(',').map(v => Number(v.trim()));
    if (parts.length !== 4) return null;
    if (parts.some(v => !Number.isFinite(v))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return parts;
}

export function setupRoadParcelsRoute(app, pool) {
    app.get('/road-parcels', async (req, res) => {
        const bbox = parseWgs84Bbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: 'bbox required. Expected minLng,minLat,maxLng,maxLat in WGS84.' });
        }

        const client = await pool.connect();
        try {
            const sql = `
                WITH envelope AS (
                    SELECT ST_Transform(
                        ST_MakeEnvelope($1, $2, $3, $4, 4326),
                        ${POSTGIS_SRID}
                    ) AS geom
                )
                SELECT ST_AsGeoJSON(
                    ST_Transform(
                        ST_Intersection(rpc.geom, e.geom),
                        4326
                    )
                )::json AS geometry
                FROM road_parcel_classification rpc, envelope e
                WHERE rpc.classification = 'road'
                  AND rpc.geom IS NOT NULL
                  AND rpc.geom && e.geom
            `;

            const { rows } = await client.query(sql, bbox);
            const features = rows
                .filter(r => r.geometry)
                .map(r => ({
                    type: 'Feature',
                    properties: {},
                    geometry: r.geometry,
                }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /road-parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client.release();
        }
    });

    // Govt plan polygons clipped to viewport, for the report viewer.
    app.get('/govt-plan', async (req, res) => {
        const bbox = parseWgs84Bbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: 'bbox required. Expected minLng,minLat,maxLng,maxLat in WGS84.' });
        }

        const client = await pool.connect();
        try {
            const sql = `
                WITH envelope AS (
                    SELECT ST_Transform(
                        ST_MakeEnvelope($1, $2, $3, $4, 4326),
                        ${POSTGIS_SRID}
                    ) AS geom
                )
                SELECT ST_AsGeoJSON(
                    ST_Transform(
                        ST_Intersection(ST_MakeValid(pr.geom), e.geom),
                        4326
                    )
                )::json AS geometry
                FROM planned_road pr, envelope e
                WHERE pr.geom IS NOT NULL
                  AND pr.geom && e.geom
            `;

            const { rows } = await client.query(sql, bbox);
            const features = rows
                .filter(r => r.geometry)
                .map(r => ({
                    type: 'Feature',
                    properties: {},
                    geometry: r.geometry,
                }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /govt-plan:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client.release();
        }
    });
}
