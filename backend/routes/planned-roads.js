// GET /planned-road: the government road plan in a map view, as the land it reserves for roads that
// is not road yet. Zagreb's GUP street widening reservations and new GUP streets, minus the existing
// road parcels; "Draw/Apply government road plan" (frontend/js/government-roads.js) reads it.
import { parseBboxParam, getExistingRoadUnion, POSTGIS_SRID, MAX_VIEW_BBOX_KM2 } from '../utils/helpers.js';

// Hard ceiling on features per response. The bbox cap bounds the area; this bounds the payload
// when that area is dense. `truncated: true` tells the caller the list is not the whole answer.
export const MAX_PLANNED_ROAD_FEATURES = 5000;
// Pieces left after subtracting existing road parcels that are smaller than this are slivers from
// the two sources' edges not lining up (18% of pieces, 0.1% of the area in central Zagreb), not plan.
export const MIN_PLAN_PIECE_M2 = 5;

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
                    SELECT ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}) AS geom
                ),
                existing_roads AS (
                    SELECT CASE
                        WHEN $5::bytea IS NULL THEN NULL::geometry
                        ELSE ST_SetSRID(ST_GeomFromWKB($5::bytea), ${POSTGIS_SRID})
                    END AS geom
                ),
                -- The GUP's road land in view (Zagreb GUP, PrometGUP layers 3-6 and 10, built into
                -- road_widening_segment by cadastre-data street-expansion-viewer/build-widening-data.js):
                -- widening: each measured street's reservation, the corridor between the drawn
                --   reservation lines where both sides are drawn, else the čl. 38 target profile
                --   around its axis (only where the street is narrower than the target);
                -- new_street: the stretches of the GUP street network with no measured street within
                --   30 m (streets the plan adds), as a corridor of the category's čl. 38 width.
                widening AS (
                    SELECT 'widening'::text AS kind, s.street_name AS label, s.regime, s.category, s.target_m,
                           ST_Transform(COALESCE(s.drawn_corridor_geom, s.outline_geom), ${POSTGIS_SRID}) AS geom
                    FROM road_widening_segment s
                    WHERE COALESCE(s.drawn_corridor_geom, s.outline_geom) && ST_Transform((SELECT geom FROM envelope), 4326)
                ),
                measured_zone AS (
                    SELECT ST_Union(ST_Buffer(ST_Transform(s.geom, ${POSTGIS_SRID}), 30, 'quad_segs=2')) AS geom
                    FROM road_widening_segment s
                    WHERE s.geom && ST_Transform(ST_Expand((SELECT geom FROM envelope), 100), 4326)
                ),
                new_streets AS (
                    SELECT 'new_street'::text AS kind, l.label, 'osnovna'::text AS regime, l.layer_name AS category, t.target_m,
                           ST_Buffer(
                               ST_Difference(
                                   ST_Intersection(l.geom, ST_Expand((SELECT geom FROM envelope), 50)),
                                   COALESCE((SELECT geom FROM measured_zone), ST_SetSRID('GEOMETRYCOLLECTION EMPTY'::geometry, ${POSTGIS_SRID}))
                               ),
                               t.target_m / 2, 'endcap=flat join=round'
                           ) AS geom
                    FROM gup_street_line l
                    JOIN (VALUES ('gradska_ulica', 18), ('glavna_gradska_ulica', 26), ('gradska_avenija', 40), ('gradska_autocesta', 80))
                        AS t(layer_name, target_m) USING (layer_name)
                    WHERE l.current AND l.geom && ST_Expand((SELECT geom FROM envelope), 50)
                ),
                planned AS (
                    SELECT kind, label, regime, category, target_m,
                           ST_Intersection(ST_MakeValid(geom), (SELECT geom FROM envelope)) AS geom
                    FROM (SELECT * FROM widening UNION ALL SELECT * FROM new_streets) gup
                    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
                ),
                prepared AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        CASE
                            WHEN (SELECT geom FROM existing_roads) IS NULL THEN geom
                            ELSE ST_MakeValid(ST_Difference(geom, (SELECT geom FROM existing_roads)))
                        END AS geom
                    FROM planned
                ),
                exploded AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        (ST_Dump(geom)).geom AS geom
                    FROM prepared
                ),
                filtered AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        geom
                    FROM exploded
                    WHERE geom IS NOT NULL
                      AND NOT ST_IsEmpty(geom)
                      AND GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
                      AND ST_Area(geom) >= ${MIN_PLAN_PIECE_M2}
                )
                SELECT
                    jsonb_build_object(
                        'kind', kind,
                        'label', label,
                        'regime', regime,
                        'category', category,
                        'target_m', target_m
                    ) AS props,
                    ST_AsGeoJSON(geom)::json AS geometry
                FROM filtered
                LIMIT $6;
            `;

            const params = [
                bboxParts[0],
                bboxParts[1],
                bboxParts[2],
                bboxParts[3],
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
