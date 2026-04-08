import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import { setupRoadParcelsRoute } from './routes/road-parcels.js';
import { setupProposalsRoute } from './routes/proposals.js';
import { setupGeoRoute } from './routes/geo.js';
import { setupCityStatsRoute } from './routes/city-stats.js';
import { setupAreaMonitorsRoute } from './routes/area-monitors.js';

const { Pool } = pkg;

function createPool(env = process.env) {
    return new Pool({
        host: env.PGHOST,
        port: Number(env.PGPORT),
        user: env.PGUSER,
        password: env.PGPASSWORD,
        database: env.PGDATABASE,
    });
}

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

const createQueryLogger = ({ requestContext, isDevEnv }) => async (executor, ...args) => {
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

const patchClientQuery = (client, runQueryWithLogging) => {
    if (!client) return client;
    if (client.__sqlLoggingPatched) return client;
    const originalClientQuery = client.query.bind(client);
    client.query = (...queryArgs) => runQueryWithLogging(originalClientQuery, ...queryArgs);
    client.__sqlLoggingPatched = true;
    return client;
};

function attachSqlLogging(pool, runQueryWithLogging) {
    if (!pool || typeof pool.query !== 'function' || pool.__sqlLoggingPatched) {
        return pool;
    }

    const originalPoolQuery = pool.query.bind(pool);
    pool.query = (...args) => runQueryWithLogging(originalPoolQuery, ...args);

    if (typeof pool.connect === 'function') {
        const originalConnect = pool.connect.bind(pool);
        pool.connect = (...args) => {
            const maybeCallback = args[args.length - 1];
            if (typeof maybeCallback === 'function') {
                const cb = maybeCallback;
                const rest = args.slice(0, -1);
                return originalConnect(...rest, (err, client, release) => {
                    patchClientQuery(client, runQueryWithLogging);
                    cb(err, client, release);
                });
            }

            return originalConnect(...args).then(client => patchClientQuery(client, runQueryWithLogging));
        };
    }

    pool.__sqlLoggingPatched = true;
    return pool;
}

export function createApp({ env = process.env, pool: providedPool } = {}) {
    const app = express();
    const requestContext = new AsyncLocalStorage();
    const isDevEnv = (env.ENVIRONMENT || '').toLowerCase() === 'dev';
    const activePool = attachSqlLogging(
        providedPool || createPool(env),
        createQueryLogger({ requestContext, isDevEnv })
    );

    const trustProxyEnv = (env.TRUST_PROXY || '').toString().trim().toLowerCase();
    const trustProxy = trustProxyEnv === 'true' || trustProxyEnv === '1' || (env.NODE_ENV === 'production' && trustProxyEnv !== 'false');
    if (trustProxy) {
        app.set('trust proxy', 1);
    }

    const isProduction = env.NODE_ENV === 'production';
    const enableDevCors = env.ENABLE_DEV_CORS === 'true' || (!isProduction && env.ENABLE_DEV_CORS !== 'false');
    if (enableDevCors) {
        const explicitAllowlist = env.CORS_ALLOWLIST
            ? env.CORS_ALLOWLIST.split(',').map(origin => origin.trim()).filter(Boolean)
            : [];

        const corsOptions = {
            origin(origin, callback) {
                if (!origin) return callback(null, true);

                if (explicitAllowlist.length > 0) {
                    const allowed = explicitAllowlist.includes(origin);
                    return callback(null, allowed);
                }

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

    app.use(helmet());

    // Origin check on write requests — rejects POST/PUT/PATCH from unknown origins
    const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS
        ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
        : [
            'https://urbangametheory.xyz',
            'https://www.urbangametheory.xyz',
            'https://zagreb.lol',
            'https://www.zagreb.lol'
        ];
    const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    app.use((req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

        const origin = req.get('origin') || req.get('referer');
        if (!origin) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        let originHost;
        try { originHost = new URL(origin).origin; } catch { originHost = origin; }

        const allowed = ALLOWED_ORIGINS.includes(originHost)
            || (!isProduction && localhostPattern.test(originHost));

        if (!allowed) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    });
    app.use(express.json({ limit: '15mb' }));
    app.use(express.urlencoded({ limit: '15mb', extended: true }));

    // Rate limit POST/PUT/PATCH routes — protects against abuse on write endpoints
    const writeRateLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 50,                   // 50 write requests per 15 min per IP
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' }
    });
    app.use((req, res, next) => {
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            return writeRateLimiter(req, res, next);
        }
        next();
    });
    const uploadsRoot = path.resolve('uploads');
    app.use('/uploads', express.static(uploadsRoot));
    app.use('/metadata', express.static(path.join(uploadsRoot, 'metadata')));
    app.use('/images', express.static(path.join(uploadsRoot, 'images')));

    app.use((req, res, next) => {
        if (!isDevEnv || req.method !== 'GET') {
            return next();
        }
        const label = `${req.method} ${req.originalUrl || req.url}`;
        requestContext.run({ shouldLogSql: true, requestLabel: label }, () => next());
    });

    app.locals.pool = activePool;
    app.locals.requestContext = requestContext;

    setupHealthRoute(app);
    setupObjectRoute(app, activePool);
    setupParcelsRoute(app, activePool);
    setupParcelBaRoute(app, activePool);
    setupParcelBgRoute(app, activePool);
    setupParcelLjRoute(app, activePool);
    setupParcelCoRoute(app, activePool);
    setupParcelNycRoute(app, activePool);
    setupBuildingsRoute(app, activePool);
    setupPlannedRoadRoute(app, activePool);
    setupStreetsRoute(app, activePool);
    setupUrbanRulesRoute(app, activePool);
    setupLandUsesRoute(app, activePool);
    setupDocsRoute(app, activePool);
    setupIpfsRoute(app);
    setupAssetsRoute(app);
    setupFileStorageRoutes(app);
    setupAdsRoute(app, activePool);
    setupRoadParcelsRoute(app, activePool);
    setupProposalsRoute(app, activePool);
    setupGeoRoute(app);
    setupCityStatsRoute(app, activePool);
    setupAreaMonitorsRoute(app, activePool);

    // Global error handler — catches unhandled errors from routes/middleware
    app.use((err, _req, res, _next) => {
        console.error('Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    return { app, pool: activePool };
}

export function startServer({ env = process.env, pool } = {}) {
    const port = env.API_PORT || 3000;
    const { app } = createApp({ env, pool });
    return app.listen(port, () => {
        console.log(`Backend listening on port ${port}`);
    });
}
