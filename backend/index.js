import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { embeddableStatic } from './utils/embeddable-static.js';
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
import { setupDecorRoute } from './routes/decor.js';
import { setupPlannedRoadRoute } from './routes/planned-roads.js';
import { setupStreetsRoute } from './routes/streets.js';
import { setupOsmRoadRoute } from './routes/osm-road.js';
import { setupUrbanRulesRoute } from './routes/urban-rules.js';
import { setupLandUsesRoute } from './routes/land-uses.js';
import { setupDocsRoute } from './routes/docs.js';
import { setupIpfsRoute } from './routes/ipfs.js';
import { setupWalrusRoute } from './routes/walrus.js';
import { setupAssetsRoute } from './routes/assets.js';
import { setupFileStorageRoutes } from './routes/file-storage.js';
import { setupAdsRoute } from './routes/ads.js';
import { setupRoadParcelsRoute } from './routes/road-parcels.js';
import { setupProposalsRoute } from './routes/proposals.js';
import { setupRoadCorridorRoute } from './routes/road-corridor.js';
import { setupReparcellizationRoute } from './routes/reparcellization.js';
import { setupGeoRoute } from './routes/geo.js';
import { setupCityStatsRoute } from './routes/city-stats.js';
import { setupAreaMonitorsRoute } from './routes/area-monitors.js';
import { setupEnsRoute } from './routes/ens.js';
import { setupEnsPlansRoute } from './routes/ens-plans.js';
import { setupCantonRoute } from './routes/canton.js';
import { setupAiSceneRoute } from './routes/ai-scene.js';

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

// Write requests allowed per 15 minutes per IP.
//
// Uploading a plan is one POST per proposal — deliberately, so the author sees each one go rather
// than firing off a bundle they have not looked at. That makes this a limit on PLAN SIZE, not on
// abuse: a hundred roads is an ordinary afternoon's drawing, and being cut off halfway through
// uploading them is the tool getting in the way rather than protecting anything.
//
// Exported so the tests measure the real number instead of each keeping a copy of it — they had
// 50 hardcoded in two places, and both went red the moment this moved.
//
// Raised 100 → 600. A plan is hundreds of proposals and uploading it is one write each, so a
// hundred cut a real upload off a third of the way through and left it half-published. Six hundred
// in fifteen minutes is still far below what an attacker needs to be worth rate-limiting, and above
// what the largest plan here costs to publish in one go.
export const WRITE_RATE_LIMIT = 600;

export function createApp({
    env = process.env,
    pool: providedPool,
    writeRateLimit = WRITE_RATE_LIMIT
} = {}) {
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

    // The ENS CCIP-Read gateway (/ens/...) is a public, read-only, signed
    // endpoint — any origin may fetch it. Advertise permissive CORS so
    // browser-based resolvers (e.g. app.ens.domains, which does the gateway
    // fetch client-side) don't log CORS errors. Must run before the
    // allowlist CORS below so it also answers any preflight.
    app.use('/ens', cors({ origin: '*', methods: ['GET', 'OPTIONS'], credentials: false }));

    const isProduction = env.NODE_ENV === 'production';
    // USE_CORS_ALLOWLIST gates the explicit-allowlist CORS middleware. In
    // production it must be set to 'true' to enable CORS at all; in dev it
    // defaults to enabled unless explicitly set to 'false'.
    const useCorsAllowlist = env.USE_CORS_ALLOWLIST === 'true' || (!isProduction && env.USE_CORS_ALLOWLIST !== 'false');
    if (useCorsAllowlist) {
        const explicitAllowlist = env.CORS_ALLOWLIST
            ? env.CORS_ALLOWLIST.split(',').map(origin => origin.trim()).filter(Boolean)
            : [];

        const corsOptions = {
            origin(origin, callback) {
                if (!origin) return callback(null, true);

                const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:\d+)?$/.test(origin);
                if (isLocalhost) return callback(null, true);

                if (explicitAllowlist.length > 0) {
                    return callback(null, explicitAllowlist.includes(origin));
                }

                callback(null, false);
            },
            credentials: true
        };

        // Rate-limit headers are NOT on the CORS safe list, so a cross-origin page cannot read
        // them unless they are named here — and the app is served from a different port to the API.
        // Without this, `response.headers.get('RateLimit-Reset')` is null in the browser however
        // faithfully the server sets it, and the client can only say "wait a few minutes" because
        // it genuinely has no idea when. The header was there the whole time; nobody could see it.
        corsOptions.exposedHeaders = ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'];
        app.use(cors(corsOptions));
        if (explicitAllowlist.length > 0) {
            console.log(`CORS allowlist enabled for origins: ${explicitAllowlist.join(', ')}`);
        } else {
            console.log('CORS allowlist enabled for all localhost origins (any port)');
        }
    }

    app.use(helmet());

    // Resource Timing hides every size on a cross-origin response unless the server says
    // otherwise: transferSize, encodedBodySize and decodedBodySize all read 0. The app is served
    // from a different origin to this API, so the plan-load overlay's byte counter — which sums
    // resource entries — was counting nothing and honestly reporting "0.00 MB" while a plan open
    // pulled three thousand requests through it. Measured: 224 same-origin resources contributed
    // 2.99 MB; all 3,059 API responses contributed zero.
    //
    // This exposes only timing and transfer SIZES, never bodies or headers, and CORS still governs
    // who may read the responses themselves.
    app.use((req, res, next) => {
        res.setHeader('Timing-Allow-Origin', '*');
        next();
    });

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
        max: writeRateLimit,       // per IP
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' }
    });
    // Routes that use POST for body-size reasons but are read-only — skip the write limiter.
    //
    // /parcels/under is one of these and being counted as a write had a nasty shape: a fabric replay
    // asks it once per applied formation, so a plan of twenty roads spends twenty of the fifty-per-
    // fifteen-minutes budget EVERY time a road is finished. Four finishes exhausted it, and after
    // that the ground fetches 429'd, the fabric was not loaded, and the coverage gate refused
    // members with "could not re-apply and were set aside" — intermittently, on a rolling window
    // that healed itself after fifteen minutes, which is exactly how it was reported.
    //
    // /buildings/footprints is the same shape and was missed the first time round. Every building
    // proposal scans for the buildings it would demolish, and that scan fetches footprints — so a
    // batch that applies a hundred block rules spends a hundred of the budget, 429s partway through,
    // and the scan then finds NOTHING to demolish. Not an error the user sees: a block recorded as
    // demolishing nothing, which is a wrong answer wearing the shape of a right one.
    const RATE_LIMIT_EXEMPT_POST_PATHS = new Set([
        '/buildings/near',
        '/buildings/footprints',
        '/buildings/under',
        '/parcels/under',
        '/proposals/batch'
    ]);
    app.use((req, res, next) => {
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.method === 'POST' && RATE_LIMIT_EXEMPT_POST_PATHS.has(req.path)) {
                return next();
            }
            return writeRateLimiter(req, res, next);
        }
        next();
    });
    // Served files are embedded by other origins (the frontend host, dev ports, crawlers); helmet's
    // same-origin resource policy blocked every cross-origin <img> of them. See utils/embeddable-static.js.
    const uploadsRoot = path.resolve('uploads');
    app.use('/uploads', embeddableStatic, express.static(uploadsRoot));
    app.use('/metadata', embeddableStatic, express.static(path.join(uploadsRoot, 'metadata')));
    app.use('/images', embeddableStatic, express.static(path.join(uploadsRoot, 'images')));

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
    setupDecorRoute(app, activePool);
    setupPlannedRoadRoute(app, activePool);
    setupStreetsRoute(app, activePool);
    setupOsmRoadRoute(app, activePool);
    setupUrbanRulesRoute(app, activePool);
    setupLandUsesRoute(app, activePool);
    setupDocsRoute(app, activePool);
    setupIpfsRoute(app);
    setupWalrusRoute(app);
    setupAssetsRoute(app);
    setupFileStorageRoutes(app);
    setupAdsRoute(app, activePool);
    setupRoadParcelsRoute(app, activePool);
    setupProposalsRoute(app, activePool);
    setupRoadCorridorRoute(app, activePool);
    setupReparcellizationRoute(app);
    setupGeoRoute(app);
    setupCityStatsRoute(app, activePool);
    setupAreaMonitorsRoute(app, activePool);
    setupEnsRoute(app, activePool);
    setupEnsPlansRoute(app, activePool);
    setupCantonRoute(app); // Canton chain option — no DB pool needed (talks to Ledger API)
    setupAiSceneRoute(app, activePool); // AI photorealistic scene render + shared-render persistence (ai_scene)

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
