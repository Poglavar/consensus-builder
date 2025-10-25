import { parseBboxParam, getExistingRoadUnion, POSTGIS_SRID } from '../utils/helpers.js';

export function setupPlannedRoadRoute(app, pool) {
    app.get('/planned-road', async (req, res) => {
        const bboxParts = parseBboxParam(req.query.bbox);
        if (req.query.bbox && !bboxParts) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
        }

        const hasBbox = Array.isArray(bboxParts);
        const bboxParams = hasBbox ? bboxParts : [0, 0, 0, 0];

        const client = await pool.connect();
        try {
            const existingRoadUnion = await getExistingRoadUnion(client, bboxParts);

            const sql = `
                WITH envelope AS (
                    SELECT CASE WHEN $5::boolean THEN ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}) END AS geom
                ),
                planned AS (
                    SELECT
                        (to_jsonb(pr) - 'geom') AS props,
                        ST_MakeValid(pr.geom) AS geom
                    FROM planned_road pr
                    WHERE pr.geom IS NOT NULL
                      AND (NOT $5::boolean OR pr.geom && (SELECT geom FROM envelope))
                ),
                prepared AS (
                    SELECT
                        props,
                        CASE
                            WHEN $6::bytea IS NULL THEN geom
                            ELSE ST_MakeValid(ST_Difference(geom, ST_SetSRID(ST_GeomFromWKB($6::bytea), ${POSTGIS_SRID})))
                        END AS geom
                    FROM planned
                ),
                exploded AS (
                    SELECT
                        props,
                        (ST_Dump(geom)).geom AS geom
                    FROM prepared
                ),
                filtered AS (
                    SELECT
                        props,
                        geom
                    FROM exploded
                    WHERE geom IS NOT NULL
                      AND NOT ST_IsEmpty(geom)
                      AND GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
                )
                SELECT
                    props,
                    ST_AsGeoJSON(geom)::json AS geometry
                FROM filtered;
            `;

            const params = [
                bboxParams[0],
                bboxParams[1],
                bboxParams[2],
                bboxParams[3],
                hasBbox,
                existingRoadUnion
            ];

            const { rows } = await client.query(sql, params);
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

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
            console.error('Error in /planned-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client.release();
        }
    });
}
