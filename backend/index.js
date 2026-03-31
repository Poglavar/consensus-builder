import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

// Import route modules
import { setupHealthRoute } from './routes/health.js';
import { setupObjectRoute } from './routes/objects.js';
import { setupParcelsRoute } from './routes/parcels.js';
import { setupParcelBaRoute } from './routes/parcel-ba.js';
import { setupParcelBgRoute } from './routes/parcel-bg.js';
import { setupParcelLjRoute } from './routes/parcel-lj.js';
import { setupParcelCoRoute } from './routes/parcel-co.js';
import { setupParcelNycRoute } from './routes/parcel-nyc.js';
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
import { setupGeoRoute } from './routes/geo.js';
import { setupOssProxyRoute } from './routes/oss-proxy.js';

const { Pool } = pkg;

const app = express();
const PORT = process.env.API_PORT || 3000;
const isDevEnv = (process.env.ENVIRONMENT || '').toLowerCase() === 'dev';
const requestContext = new AsyncLocalStorage();

// If running behind nginx (or any reverse proxy), this makes Express respect X-Forwarded-* for req.ip/req.protocol.
// Configure explicitly via TRUST_PROXY, otherwise default to enabled in production deployments.
const trustProxyEnv = (process.env.TRUST_PROXY || '').toString().trim().toLowerCase();
const trustProxy = trustProxyEnv === 'true' || trustProxyEnv === '1' || (process.env.NODE_ENV === 'production' && trustProxyEnv !== 'false');
if (trustProxy) {
    // "1" = trust first proxy hop (typical: nginx -> node)
    app.set('trust proxy', 1);
}

// Dev-only CORS: nginx adds headers in prod; enable here only when explicitly allowed
const isProduction = process.env.NODE_ENV === 'production';
const enableDevCors = process.env.ENABLE_DEV_CORS === 'true' || (!isProduction && process.env.ENABLE_DEV_CORS !== 'false');
if (enableDevCors) {
    const explicitAllowlist = process.env.CORS_ALLOWLIST
        ? process.env.CORS_ALLOWLIST.split(',').map(origin => origin.trim()).filter(Boolean)
        : [];

    const corsOptions = {
        origin(origin, callback) {
            if (!origin) return callback(null, true); // allow non-browser clients

            // If explicit allowlist is provided, use it
            if (explicitAllowlist.length > 0) {
                const allowed = explicitAllowlist.includes(origin);
                return callback(null, allowed);
            }

            // Otherwise, in development, allow all localhost origins (any port)
            const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:\d+)?$/.test(origin);
            callback(null, isLocalhost);
        },
        credentials: true
    };

    app.use(cors(corsOptions));
    if (explicitAllowlist.length > 0) {
        console.log(`Dev CORS enabled for origins: ${explicitAllowlist.join(', ')}`);
    } else {
        console.log('Dev CORS enabled for all localhost origins (any port)');
    }
}

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
const uploadsRoot = path.resolve('uploads');
app.use('/uploads', express.static(uploadsRoot));
app.use('/metadata', express.static(path.join(uploadsRoot, 'metadata')));
app.use('/images', express.static(path.join(uploadsRoot, 'images')));

// Dev-only request context for SQL logging on GET endpoints
app.use((req, res, next) => {
    if (!isDevEnv || req.method !== 'GET') {
        return next();
    }
    const label = `${req.method} ${req.originalUrl || req.url}`;
    requestContext.run({ shouldLogSql: true, requestLabel: label }, () => next());
});

// Database connection
const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
});

const MAX_FORMATTED_VALUE_LENGTH = 256;
const MAX_ARRAY_ITEMS = 20;

const truncate = (str, max = MAX_FORMATTED_VALUE_LENGTH) => {
    if (!str || str.length <= max) return str;
    return `${str.slice(0, max)}…[truncated ${str.length - max} chars]`;
};

const formatValueForSql = (value) => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString()}'`;
    if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'`;
    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ITEMS) {
            return `[array len=${value.length}]`;
        }
        return `ARRAY[${value.map(formatValueForSql).join(', ')}]`;
    }
    if (typeof value === 'object') {
        const json = JSON.stringify(value);
        return `'${truncate(json).replace(/'/g, "''")}'`;
    }
    return `'${truncate(String(value)).replace(/'/g, "''")}'`;
};

const formatSqlWithValues = (text, values = []) => {
    if (!text || !Array.isArray(values) || values.length === 0) return text;
    const substituted = text.replace(/\$(\d+)/g, (_, idx) => {
        const valueIndex = Number(idx) - 1;
        if (valueIndex < 0 || valueIndex >= values.length) return `$${idx}`;
        return formatValueForSql(values[valueIndex]);
    });
    const maxSqlLength = 8000;
    if (substituted.length > maxSqlLength) {
        const truncated = truncate(substituted, maxSqlLength);
        return `${truncated} [sql truncated ${substituted.length - maxSqlLength} chars]`;
    }
    return substituted;
};

const normalizeQueryInput = (queryConfig, params) => {
    if (queryConfig && typeof queryConfig === 'object' && 'text' in queryConfig) {
        const inferredValues = Array.isArray(params) ? params : [];
        return { text: queryConfig.text, values: queryConfig.values ?? inferredValues };
    }
    if (typeof queryConfig === 'string') {
        return { text: queryConfig, values: Array.isArray(params) ? params : [] };
    }
    return { text: undefined, values: [] };
};

const runQueryWithLogging = async (executor, ...args) => {
    const [queryConfig, params] = args;
    const store = requestContext.getStore();
    const loggingEnabled = isDevEnv && store?.shouldLogSql;
    const { text, values } = normalizeQueryInput(queryConfig, params);
    const startedAt = loggingEnabled ? process.hrtime.bigint() : null;

    try {
        const result = await executor(...args);
        if (loggingEnabled && text) {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const formattedSql = formatSqlWithValues(text, values);
            const label = store?.requestLabel || 'GET';
            console.log(`[SQL][${label}][${durationMs.toFixed(1)} ms] ${formattedSql}`);
        }
        return result;
    } catch (error) {
        if (loggingEnabled && text) {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const formattedSql = formatSqlWithValues(text, values);
            const label = store?.requestLabel || 'GET';
            console.error(`[SQL][${label}][${durationMs.toFixed(1)} ms][error=${error?.code || error?.message}] ${formattedSql}`);
        }
        throw error;
    }
};

const patchClientQuery = (client) => {
    if (!client) return client;
    if (client.__sqlLoggingPatched) return client;
    const originalClientQuery = client.query.bind(client);
    client.query = (...queryArgs) => runQueryWithLogging(originalClientQuery, ...queryArgs);
    client.__sqlLoggingPatched = true;
    return client;
};

const originalPoolQuery = pool.query.bind(pool);
pool.query = (...args) => runQueryWithLogging(originalPoolQuery, ...args);

const originalConnect = pool.connect.bind(pool);
pool.connect = (...args) => {
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === 'function') {
        const cb = maybeCallback;
        const rest = args.slice(0, -1);
        return originalConnect(...rest, (err, client, release) => {
            patchClientQuery(client);
            cb(err, client, release);
        });
    }

    return originalConnect(...args).then(client => patchClientQuery(client));
};

// Setup routes
setupHealthRoute(app);
setupObjectRoute(app, pool);
setupParcelsRoute(app, pool);
setupParcelBaRoute(app, pool);
setupParcelBgRoute(app, pool);
setupParcelLjRoute(app, pool);
setupParcelCoRoute(app, pool);
setupParcelNycRoute(app, pool);
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
setupGeoRoute(app);
setupOssProxyRoute(app);

app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});