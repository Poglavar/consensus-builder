import express from 'express';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;
const POSTGIS_SRID = 3765;

app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    host: process.env.PGHOST || 'db',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'consensus',
    password: process.env.PGPASSWORD || 'consensus',
    database: process.env.PGDATABASE || 'consensus',
});

function parseBboxParam(raw) {
    if (!raw) return null;
    const parts = String(raw).split(',').map(v => Number(v.trim()));
    if (parts.length !== 4) return null;
    if (parts.some(v => !Number.isFinite(v))) return null;
    const [minX, minY, maxX, maxY] = parts;
    if (minX >= maxX || minY >= maxY) return null;
    return parts;
}

async function getExistingRoadUnion(client, bboxParts) {
    const hasBbox = Array.isArray(bboxParts) && bboxParts.length === 4;
    const params = hasBbox ? [...bboxParts] : [];
    const filterClause = (alias) => hasBbox
        ? ` AND ${alias}.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})`
        : '';

    const candidates = [
        {
            alias: 'r',
            sql: (alias) => `SELECT ST_AsBinary(ST_UnaryUnion(${alias}.geom)) AS geom
                             FROM road ${alias}
                             WHERE ${alias}.geom IS NOT NULL${filterClause(alias)}`
        },
        {
            alias: 'p',
            sql: (alias) => `SELECT ST_AsBinary(ST_UnaryUnion(${alias}.geom)) AS geom
                             FROM parcel ${alias}
                             WHERE ${alias}.current = true
                               AND COALESCE(${alias}.is_road, false) = true${filterClause(alias)}`
        },
        {
            alias: 'p',
            sql: (alias) => `SELECT ST_AsBinary(ST_UnaryUnion(${alias}.geom)) AS geom
                             FROM parcel ${alias}
                             WHERE ${alias}.current = true
                               AND LOWER(COALESCE(${alias}.category, '')) LIKE '%road%'${filterClause(alias)}`
        },
        {
            alias: 'p',
            sql: (alias) => `SELECT ST_AsBinary(ST_UnaryUnion(${alias}.geom)) AS geom
                             FROM parcel ${alias}
                             WHERE ${alias}.current = true
                               AND LOWER(COALESCE(${alias}.land_use, '')) LIKE '%road%'${filterClause(alias)}`
        }
    ];

    for (const candidate of candidates) {
        try {
            const sql = candidate.sql(candidate.alias);
            const { rows } = await client.query(sql, params);
            const geom = rows?.[0]?.geom || null;
            if (geom) {
                return geom;
            }
        } catch (err) {
            // Ignore undefined table or column errors, surface others
            if (err?.code === '42P01' || err?.code === '42703') {
                continue;
            }
            throw err;
        }
    }
    return null;
}

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// GET /parcels?bbox=minX,minY,maxX,maxY  (HTRS96/TM EPSG:3765)
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_CESTICE
app.get('/parcels', async (req, res) => {
    try {
        const bbox = String(req.query.bbox || '').trim();
        const parts = bbox.split(',').map(n => Number(n));
        if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
        }
        const [minX, minY, maxX, maxY] = parts;

        // Query parcels intersecting bbox from parcels table
        // Assumptions: table name "parcels" with a geometry column "geom" in EPSG:3765 and essential props
        // Must return properties compatible with DKP_CESTICE: CESTICA_ID, BROJ_CESTICE at minimum
        const sql = `
            SELECT
                CESTICA_ID,
                BROJ_CESTICE,
                ST_AsGeoJSON(geom)::json AS geometry,
                ST_Area(geom) AS calculated_area
            FROM parcel
            WHERE 1=1
            AND current=true
            AND geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
            AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
            LIMIT 2000
        `;

        const { rows } = await pool.query(sql, [minX, minY, maxX, maxY]);

        // Build GeoJSON FeatureCollection with expected property names
        const features = rows.map(r => ({
            type: 'Feature',
            properties: {
                CESTICA_ID: String((r.cestica_id ?? r.cesticaid ?? r.cestica) || ''),
                BROJ_CESTICE: String((r.broj_cestice ?? r.brojcestice) || ''),
                calculatedArea: Number(r.calculated_area) || undefined
            },
            geometry: r.geometry
        }));

        res.json({ type: 'FeatureCollection', features });
    } catch (err) {
        console.error('Error in /parcels:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /buildings?bbox=minX,minY,maxX,maxY  (HTRS96/TM EPSG:3765)
// Respond with GeoJSON FeatureCollection compatible with OSS DKP_ZGRADE
app.get('/buildings', async (req, res) => {
    try {
        const bbox = String(req.query.bbox || '').trim();
        const parts = bbox.split(',').map(n => Number(n));
        if (parts.length !== 4 || parts.some(v => !isFinite(v))) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
        }
        const [minX, minY, maxX, maxY] = parts;

        // Query buildings intersecting bbox from building table
        // Assumptions: table name "building" with a geometry column "geom" in EPSG:3765
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

        const features = rows.map(r => ({
            type: 'Feature',
            properties: r.properties || {},
            geometry: r.geometry
        }));

        res.json({ type: 'FeatureCollection', features });
    } catch (err) {
        console.error('Error in /buildings:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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

app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});


