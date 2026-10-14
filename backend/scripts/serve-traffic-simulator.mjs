#!/usr/bin/env node
// Standalone, read-only traffic API and same-origin frontend for local review or reverse-proxy hosting.
import express from 'express';
import dotenv from 'dotenv';
import pg from 'pg';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTrafficSimulatorRoute } from '../routes/traffic-simulator.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function createTrafficSimulatorApp({ pool, env, trafficDir = resolve(project, 'frontend/traffic'), assetsDir = resolve(trafficDir, 'assets') }) {
    const app = express(), api = express.Router();
    app.disable('x-powered-by');
    app.enable('strict routing');
    setupTrafficSimulatorRoute(api, pool, { env });
    app.use('/api', api);
    const headers = res => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    };
    for (const base of ['/traffic', '/promet/simulator']) {
        app.get(base, (_req, res) => res.redirect(302, `${base}/`));
        app.use(`${base}/data`, (_req, res) => res.sendStatus(404));
        app.use(`${base}/assets`, express.static(assetsDir, { setHeaders: headers }));
        app.use(`${base}/`, express.static(trafficDir, { setHeaders: headers }));
    }
    app.use((_req, res) => res.status(404).type('text').send('Stranica nije pronađena.'));
    return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = new Map();
    for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
    dotenv.config({ path: args.get('--env-file') || resolve(project, 'backend/.env'), quiet: true });
    const env = { ...process.env,
        TRAFFIC_TOPOLOGY_ROOT: args.get('--topology-root') || process.env.TRAFFIC_TOPOLOGY_ROOT || resolve(project, 'topology'),
        TRAFFIC_ROADS_API: args.get('--roads-api') || process.env.TRAFFIC_ROADS_API };
    if (!env.TRAFFIC_ROADS_API) throw new Error('Set TRAFFIC_ROADS_API or pass --roads-api.');
    const pool = new pg.Pool({
        connectionString: env.DATABASE_URL,
        host: process.platform === 'darwin' && env.PGHOST === 'db' ? 'localhost' : env.PGHOST,
        port: Number(env.PGPORT) || 5432, user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE,
        connectionTimeoutMillis: 10000, statement_timeout: 60000,
        options: '-c default_transaction_read_only=on'
    });
    const port = Number(args.get('--port') || env.TRAFFIC_PORT || 8192);
    const app = createTrafficSimulatorApp({ pool, env,
        trafficDir: args.get('--traffic-dir') || resolve(project, 'frontend/traffic'),
        assetsDir: args.get('--assets-dir') || resolve(project, 'frontend/traffic/assets') });
    const server = app.listen(port, '127.0.0.1', () => console.log(`Simulator prometa: http://localhost:${port}/promet/simulator/`));
    const stop = () => server.close(() => pool.end().finally(() => process.exit(0)));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
