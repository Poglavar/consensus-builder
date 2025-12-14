import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import path from 'path';

// Import route modules
import { setupHealthRoute } from './routes/health.js';
import { setupObjectRoute } from './routes/objects.js';
import { setupParcelsRoute } from './routes/parcels.js';
import { setupParcelBaRoute } from './routes/parcel-ba.js';
import { setupParcelBgRoute } from './routes/parcel-bg.js';
import { setupBuildingsRoute } from './routes/buildings.js';
import { setupPlannedRoadRoute } from './routes/planned-roads.js';
import { setupStreetsRoute } from './routes/streets.js';
import { setupUrbanRulesRoute } from './routes/urban-rules.js';
import { setupLandUsesRoute } from './routes/land-uses.js';
import { setupDocsRoute } from './routes/docs.js';
import { setupIpfsRoute } from './routes/ipfs.js';
import { setupAssetsRoute } from './routes/assets.js';
import { setupFileStorageRoutes } from './routes/file-storage.js';
import { setupAdsRoute } from './routes/ads.js';
import { setupProposalsRoute } from './routes/proposals.js';

const { Pool } = pkg;

const app = express();
const PORT = process.env.API_PORT || 3000;

// Dev-only CORS: nginx adds headers in prod; enable here only when explicitly allowed
const isProduction = process.env.NODE_ENV === 'production';
const enableDevCors = process.env.ENABLE_DEV_CORS === 'true' || (!isProduction && process.env.ENABLE_DEV_CORS !== 'false');
if (enableDevCors) {
    const allowlist = (process.env.CORS_ALLOWLIST || 'http://localhost:8080,http://127.0.0.1:8080')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

    const corsOptions = {
        origin(origin, callback) {
            if (!origin) return callback(null, true); // allow non-browser clients
            const allowed = allowlist.includes(origin);
            callback(null, allowed);
        },
        credentials: true
    };

    app.use(cors(corsOptions));
    console.log(`Dev CORS enabled for origins: ${allowlist.join(', ')}`);
}

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
const uploadsRoot = path.resolve('uploads');
app.use('/uploads', express.static(uploadsRoot));
app.use('/metadata', express.static(path.join(uploadsRoot, 'metadata')));
app.use('/images', express.static(path.join(uploadsRoot, 'images')));

// Database connection
const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
});

// Setup routes
setupHealthRoute(app);
setupObjectRoute(app, pool);
setupParcelsRoute(app, pool);
setupParcelBaRoute(app, pool);
setupParcelBgRoute(app, pool);
setupBuildingsRoute(app, pool);
setupPlannedRoadRoute(app, pool);
setupStreetsRoute(app, pool);
setupUrbanRulesRoute(app, pool);
setupLandUsesRoute(app, pool);
setupDocsRoute(app, pool);
setupIpfsRoute(app);
setupAssetsRoute(app);
setupFileStorageRoutes(app);
setupAdsRoute(app, pool);
setupProposalsRoute(app, pool);

app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});