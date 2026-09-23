// Serve classified road parcels as GeoJSON, clipped to a viewport bbox.
// Accepts WGS84 (EPSG:4326) bbox for easy integration with Leaflet maps.

import { POSTGIS_SRID, MAX_VIEW_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';

// Row ceilings. The frontend asks with its map view (road parcels are auto-fetched after parcels
// load at z17+; the sidebar button can ask at any zoom), so the bbox cap bounds the area and these
// bound the payload. `truncated: true` in the response says the list is not complete.
export const MAX_ROAD_PARCEL_FEATURES = 20000;
export const MAX_GOVT_PLAN_FEATURES = 5000;

function parseWgs84Bbox(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = String(raw).split(',').map(v => Number(v.trim()));
    if (parts.length !== 4) return null;
    if (parts.some(v => !Number.isFinite(v))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return parts;
}

function bboxTooLarge(bbox) {
    const areaKm2 = wgs84BboxAreaKm2(...bbox);
    return areaKm2 > MAX_VIEW_BBOX_KM2
        ? `bbox too large (${Math.round(areaKm2)} km², max ${MAX_VIEW_BBOX_KM2} km²). Zoom in.`
        : null;
}

export function setupRoadParcelsRoute(app, pool) {
    app.get('/road-parcels', async (req, res) => {
        const bbox = parseWgs84Bbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: 'bbox required. Expected minLng,minLat,maxLng,maxLat in WGS84.' });
        }
        const bboxError = bboxTooLarge(bbox);
        if (bboxError) return res.status(400).json({ error: bboxError });

        let client;
        try {
            client = await pool.connect();
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
                )::json AS geometry,
                    'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
                    rpc.total_score AS score
                FROM road_parcel_classification rpc
                JOIN parcel p ON p.cestica_id = rpc.cestica_id AND p.current = true
                CROSS JOIN envelope e
                WHERE rpc.classification = 'road'
                  AND rpc.geom IS NOT NULL
                  AND rpc.geom && e.geom
                LIMIT $5
            `;

            const { rows: fetched } = await client.query(sql, [...bbox, MAX_ROAD_PARCEL_FEATURES + 1]);
            const truncated = fetched.length > MAX_ROAD_PARCEL_FEATURES;
            const rows = truncated ? fetched.slice(0, MAX_ROAD_PARCEL_FEATURES) : fetched;
            const features = rows
                .filter(r => r.geometry)
                .map(r => ({
                    type: 'Feature',
                    // parcelId matches the id the frontend's /parcels features carry, so the
                    // client can mark road parcels by id instead of geometry matching.
                    properties: { parcelId: r.parcel_id, score: r.score },
                    geometry: r.geometry,
                }));

            res.json({ type: 'FeatureCollection', features, truncated });
        } catch (err) {
            console.error('Error in /road-parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client?.release();
        }
    });

    // Govt plan polygons clipped to viewport, for the report viewer.
    app.get('/govt-plan', async (req, res) => {
        const bbox = parseWgs84Bbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: 'bbox required. Expected minLng,minLat,maxLng,maxLat in WGS84.' });
        }
        const bboxError = bboxTooLarge(bbox);
        if (bboxError) return res.status(400).json({ error: bboxError });

        let client;
        try {
            client = await pool.connect();
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
                LIMIT $5
            `;

            const { rows: fetched } = await client.query(sql, [...bbox, MAX_GOVT_PLAN_FEATURES + 1]);
            const truncated = fetched.length > MAX_GOVT_PLAN_FEATURES;
            const rows = truncated ? fetched.slice(0, MAX_GOVT_PLAN_FEATURES) : fetched;
            const features = rows
                .filter(r => r.geometry)
                .map(r => ({
                    type: 'Feature',
                    properties: {},
                    geometry: r.geometry,
                }));

            res.json({ type: 'FeatureCollection', features, truncated });
        } catch (err) {
            console.error('Error in /govt-plan:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client?.release();
        }
    });
}
