import { parseBboxParam, getExistingRoadUnion, POSTGIS_SRID, MAX_VIEW_BBOX_KM2 } from '../utils/helpers.js';

// Hard ceiling on features per response. The bbox cap bounds the area; this bounds the payload
// when that area is dense. `truncated: true` tells the caller the list is not the whole answer.
export const MAX_PLANNED_ROAD_FEATURES = 5000;

export function setupPlannedRoadRoute(app, pool) {
    app.get('/planned-road', async (req, res) => {
        // A bbox is required: the frontend always sends its map view, and without one this unioned
        // every road parcel in the city on an anonymous GET while holding a pooled client.
        const bboxParts = parseBboxParam(typeof req.query.bbox === 'string' ? req.query.bbox : '');
        if (!bboxParts) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
        }
        const areaKm2 = ((bboxParts[2] - bboxParts[0]) * (bboxParts[3] - bboxParts[1])) / 1e6;
        if (areaKm2 > MAX_VIEW_BBOX_KM2) {
            return res.status(400).json({ error: `bbox too large (${Math.round(areaKm2)} km², max ${MAX_VIEW_BBOX_KM2} km²). Zoom in.` });
        }

        let client;
        try {
            client = await pool.connect();
            const existingRoadUnion = await getExistingRoadUnion(client, bboxParts);

            const sql = `
                WITH envelope AS (
                    SELECT CASE WHEN $5::boolean THEN ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}) END AS geom
                ),
                existing_roads AS (
                    SELECT CASE
                        WHEN $6::bytea IS NULL THEN NULL::geometry
                        ELSE ST_SetSRID(ST_GeomFromWKB($6::bytea), ${POSTGIS_SRID})
                    END AS geom
                ),
                planned AS (
                    SELECT
                        pr.plan_id,
                        pr.road_id,
                        pr.road_ext_id,
                        pr.details,
                        pr.geom_hash,
                        pr.date_added,
                        pr.source,
                        CASE
                            WHEN $5::boolean THEN ST_Intersection(ST_MakeValid(pr.geom), (SELECT geom FROM envelope))
                            ELSE ST_MakeValid(pr.geom)
                        END AS geom
                    FROM planned_road pr
                    WHERE pr.geom IS NOT NULL
                      AND (NOT $5::boolean OR pr.geom && (SELECT geom FROM envelope))
                ),
                prepared AS (
                    SELECT
                        plan_id,
                        road_id,
                        road_ext_id,
                        details,
                        geom_hash,
                        date_added,
                        source,
                        CASE
                            WHEN (SELECT geom FROM existing_roads) IS NULL THEN geom
                            ELSE ST_MakeValid(ST_Difference(geom, (SELECT geom FROM existing_roads)))
                        END AS geom
                    FROM planned
                ),
                exploded AS (
                    SELECT
                        plan_id,
                        road_id,
                        road_ext_id,
                        details,
                        geom_hash,
                        date_added,
                        source,
                        (ST_Dump(geom)).geom AS geom
                    FROM prepared
                ),
                filtered AS (
                    SELECT
                        plan_id,
                        road_id,
                        road_ext_id,
                        details,
                        geom_hash,
                        date_added,
                        source,
                        geom
                    FROM exploded
                    WHERE geom IS NOT NULL
                      AND NOT ST_IsEmpty(geom)
                      AND GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
                )
                SELECT
                    jsonb_build_object(
                        'plan_id', plan_id,
                        'road_id', road_id,
                        'road_ext_id', road_ext_id,
                        'details', details,
                        'geom_hash', geom_hash,
                        'date_added', date_added,
                        'source', source
                    ) AS props,
                    ST_AsGeoJSON(geom)::json AS geometry
                FROM filtered
                LIMIT $7;
            `;

            const params = [
                bboxParts[0],
                bboxParts[1],
                bboxParts[2],
                bboxParts[3],
                true,
                existingRoadUnion,
                MAX_PLANNED_ROAD_FEATURES + 1
            ];

            const { rows: fetchedRows } = await client.query(sql, params);
            const truncated = fetchedRows.length > MAX_PLANNED_ROAD_FEATURES;
            const rows = truncated ? fetchedRows.slice(0, MAX_PLANNED_ROAD_FEATURES) : fetchedRows;
            const features = rows
                .map(row => {
                    if (!row || !row.geometry) return null;
                    const props = (row.props && typeof row.props === 'object' && !Array.isArray(row.props)) ? { ...row.props } : {};
                    props.planStatus = props.planStatus || 'planned';
                    props.source = props.source || 'government_plan';
                    props.displayColor = props.displayColor || '#ffd54f';
                    props.strokeColor = props.strokeColor || '#c98a00';
                    props.strokeWeight = props.strokeWeight || 2;
                    props.fillOpacity = props.fillOpacity ?? 0.35;
                    props.display = props.display || 'planned_road';
                    return {
                        type: 'Feature',
                        properties: props,
                        geometry: row.geometry
                    };
                })
                .filter(Boolean);

            res.json({ type: 'FeatureCollection', features, truncated });
        } catch (err) {
            console.error('Error in /planned-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client?.release();
        }
    });
}
