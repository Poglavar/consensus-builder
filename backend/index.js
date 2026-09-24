import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { embeddableStatic } from './utils/embeddable-static.js';
import { uploadStaticHeaders } from './utils/upload-static-headers.js';
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
import { setupAgentProposalsRoute } from './routes/agent-proposals.js';
import { setupAgentPledgesRoute } from './routes/agent-pledges.js';
import { setupAgentActivityRoute } from './routes/agent-activity.js';
import { setupAgentDiscoveryRoute } from './routes/agent-discovery.js';
import { setupWellKnownRoutes } from './routes/well-known.js';
import { setupAgentOracleFactsRoute } from './routes/agent-oracle-facts.js';
import { setupLandEventsRoute } from './routes/land-events.js';
import { setupHackathonProofRoute } from './routes/hackathon-proof.js';
import { setupHackathonCasesRoute } from './routes/hackathon-cases.js';
import { setupHackathonOperationsRoute } from './routes/hackathon-operations.js';
import { setupTransactionsRoute } from './routes/transactions.js';
import { isAgentPath } from './utils/x402-payment.js';
import { setupRoadCorridorRoute } from './routes/road-corridor.js';
import { setupReparcellizationRoute } from './routes/reparcellization.js';
import { setupGeoRoute } from './routes/geo.js';
import { setupCityStatsRoute } from './routes/city-stats.js';
import { setupAreaMonitorsRoute } from './routes/area-monitors.js';
import { setupEnsRoute } from './routes/ens.js';
import { setupEnsPlansRoute } from './routes/ens-plans.js';
import { setupCantonRoute } from './routes/canton.js';
import { setupAiSceneRoute } from './routes/ai-scene.js';
import { forwardAsyncErrors } from './utils/async-routes.js';

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

// /parcels/under is exempt from the WRITE budget (it is a read; a fabric replay asks once per applied
// formation — see RATE_LIMIT_EXEMPT_POST_PATHS below), but it is an expensive PostGIS read over a
// body of up to 15 MB, so it gets its own, much larger, budget instead of none at all.
export const PARCELS_UNDER_RATE_LIMIT = 3000;

// Canton is off unless explicitly enabled: its OAuth client is currently rejected (invalid_grant)
// and every /canton/* request failed. Disabled means the routes are not registered at all, so
// nothing can reach the token endpoint. The code stays intact for re-enabling.
export function isCantonEnabled(env = process.env) {
    return String(env.CANTON_ENABLED || '').trim().toLowerCase() === 'true';
}

export function createApp({
    env = process.env,
    pool: providedPool,
    writeRateLimit = WRITE_RATE_LIMIT,
    parcelsUnderRateLimit = PARCELS_UNDER_RATE_LIMIT
} = {}) {
    // Before ANY route or middleware is registered: every async handler's rejection goes to the
    // error handler below instead of becoming an unhandled rejection that exits the process.
    const app = forwardAsyncErrors(express());
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
        // /agent/* is for headless agents: payment (x402) is their authentication, they send no Origin.
        if (isAgentPath(req.path)) return next();

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
    const parcelsUnderRateLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: parcelsUnderRateLimit,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' }
    });
    app.use((req, res, next) => {
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.method === 'POST' && req.path === '/parcels/under') {
                return parcelsUnderRateLimiter(req, res, next);
            }
            // /agent/* pays per request, so the payment is the limiter (design decision, not an oversight).
            if (req.method === 'POST' && (RATE_LIMIT_EXEMPT_POST_PATHS.has(req.path) || isAgentPath(req.path))) {
                return next();
            }
            return writeRateLimiter(req, res, next);
        }
        next();
    });
    // Served files are embedded by other origins (the frontend host, dev ports, crawlers); helmet's
    // same-origin resource policy blocked every cross-origin <img> of them. See utils/embeddable-static.js.
    // uploadStaticHeaders: nosniff everywhere, and non-image/model/JSON files only as downloads.
    const uploadsRoot = path.resolve('uploads');
    app.use('/uploads', embeddableStatic, uploadStaticHeaders, express.static(uploadsRoot));
    app.use('/metadata', embeddableStatic, uploadStaticHeaders, express.static(path.join(uploadsRoot, 'metadata')));
    app.use('/images', embeddableStatic, uploadStaticHeaders, express.static(path.join(uploadsRoot, 'images')));

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
    setupWellKnownRoutes(app, { env }); // /.well-known/x402, llms.txt, openapi.json, robots.txt; must precede docs (/agents.json aliases /docs/agents.json)
    setupDocsRoute(app, activePool);
    setupIpfsRoute(app);
    setupWalrusRoute(app);
    setupAssetsRoute(app);
    setupFileStorageRoutes(app);
    setupAdsRoute(app, activePool);
    setupRoadParcelsRoute(app, activePool);
    setupProposalsRoute(app, activePool);
    setupAgentProposalsRoute(app, activePool, { env }); // paid x402 front door to the same create handler
    setupAgentPledgesRoute(app, { env }); // read-only view; pledge writes go directly to Solana
    setupAgentActivityRoute(app, activePool); // shared live activity source for human/agent explorer UI
    setupAgentDiscoveryRoute(app, { env }); // hosted Bazaar listing proof; credentials remain server-side
    setupAgentOracleFactsRoute(app, activePool, { env }); // paid, discoverable recipe-bound oracle facts
    setupLandEventsRoute(app, activePool); // deterministic proposal lifecycle events + recipe declarations
    setupHackathonProofRoute(app, { env }); // public hackathon scope plus redacted prospective resolver status
    setupHackathonCasesRoute(app, activePool, { env }); // one data-derived proposal → support/forecast/evidence graph
    setupHackathonOperationsRoute(app, activePool, { env }); // redacted scheduled-job outcomes and freshness
    setupTransactionsRoute(app, activePool); // devnet transaction explorer, derived from the chain
    setupRoadCorridorRoute(app, activePool);
    setupReparcellizationRoute(app);
    setupGeoRoute(app);
    setupCityStatsRoute(app, activePool);
    setupAreaMonitorsRoute(app, activePool);
    setupEnsRoute(app, activePool);
    setupEnsPlansRoute(app, activePool);
    if (isCantonEnabled(env)) {
        setupCantonRoute(app); // Canton chain option — no DB pool needed (talks to Ledger API)
    } else {
        console.log(`[${new Date().toISOString()}] Canton disabled (CANTON_ENABLED is not 'true'); /canton/* routes not registered.`);
    }
    setupAiSceneRoute(app, activePool); // AI photorealistic scene render + shared-render persistence (ai_scene)

    // Global error handler — catches errors thrown or rejected by routes/middleware (async ones
    // arrive here via forwardAsyncErrors). A 4xx that says it is safe to expose (HttpError, or a
    // body-parser error such as malformed JSON / 413) keeps its status and message; anything else
    // is logged in full and answered as a generic 500.
    app.use((err, req, res, next) => {
        const status = Number(err?.status || err?.statusCode);
        const isClientError = Number.isInteger(status) && status >= 400 && status < 500;
        if (!isClientError) {
            console.error(`[${new Date().toISOString()}] Unhandled error in ${req.method} ${req.originalUrl || req.url}:`, err);
        }
        // Headers already out: Express's default handler aborts the connection, which is the only
        // honest thing left to do with a half-sent response.
        if (res.headersSent) return next(err);
        if (isClientError) {
            return res.status(status).json({ error: err.expose !== false && err.message ? err.message : 'Bad request' });
        }
        res.status(500).json({ error: 'Internal server error' });
    });

    return { app, pool: activePool };
}

// Last line of defence for a promise nobody awaited (a fire-and-forget outside any request). Route
// handlers no longer produce these — forwardAsyncErrors sends their rejections to the error
// handler — so anything logged here is a real bug to fix: it is logged loudly, with a timestamp and
// the full stack, and counted. The process stays up: one stray rejection must not take every
// in-flight request down with it (Node's default since v15 is to exit).
let unhandledRejectionCount = 0;
export function installUnhandledRejectionLogger(target = process) {
    if (target.__cbUnhandledRejectionLogger) return;
    target.__cbUnhandledRejectionLogger = true;
    target.on('unhandledRejection', (reason) => {
        unhandledRejectionCount += 1;
        const detail = reason instanceof Error ? (reason.stack || reason.message) : reason;
        console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION #${unhandledRejectionCount}:`, detail);
    });
}

export function startServer({ env = process.env, pool } = {}) {
    installUnhandledRejectionLogger();
    const port = env.API_PORT || 3000;
    const { app, pool: activePool } = createApp({ env, pool });
    const server = app.listen(port, () => {
        console.log(`Backend listening on port ${port}`);
    });

    // PM2's zero-downtime reload waits for the old worker to stop accepting new
    // connections. Keep the database pool alive until existing HTTP requests
    // drain, then release it before the worker exits.
    server.gracefulShutdown = async () => {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        if (typeof activePool?.end === 'function') {
            await activePool.end();
        }
    };

    return server;
}
