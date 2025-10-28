import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import pkg from 'pg';

// Import route modules
import { setupHealthRoute } from './routes/health.js';
import { setupObjectRoute } from './routes/objects.js';
import { setupParcelsRoute } from './routes/parcels.js';
import { setupBuildingsRoute } from './routes/buildings.js';
import { setupPlannedRoadRoute } from './routes/planned-roads.js';
import { setupStreetsRoute } from './routes/streets.js';
import { setupUrbanRulesRoute } from './routes/urban-rules.js';
import { setupLandUsesRoute } from './routes/land-uses.js';
import { setupDocsRoute } from './routes/docs.js';

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

// Setup routes
setupHealthRoute(app);
setupObjectRoute(app, pool);
setupParcelsRoute(app, pool);
setupBuildingsRoute(app, pool);
setupPlannedRoadRoute(app, pool);
setupStreetsRoute(app, pool);
setupUrbanRulesRoute(app, pool);
setupLandUsesRoute(app, pool);
setupDocsRoute(app, pool);

app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});