import express from 'express';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;

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
            WHERE geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
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

app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});


