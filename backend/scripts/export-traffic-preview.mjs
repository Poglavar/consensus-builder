#!/usr/bin/env node
// Offline test-fixture export. The published simulator reads the traffic API.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import pg from 'pg';
import { loadTrafficNetwork, DEFAULT_BBOX } from '../traffic/network-source.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
if (!args.get('--topology-root')) throw new Error('Pass --topology-root with the saved-junction pipeline.');
const root = resolve(args.get('--topology-root'));
const output = resolve(args.get('--output') || fileURLToPath(new URL('../test/fixtures/traffic-network.json.gz', import.meta.url)));
dotenv.config({ path: args.get('--env-file') || resolve(root, 'backend/.env'), quiet: true });
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.platform === 'darwin' && process.env.PGHOST === 'db' ? 'localhost' : process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER,
    password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
    connectionTimeoutMillis: 10000, statement_timeout: 60000,
    options: '-c default_transaction_read_only=on'
});
try {
    const data = await loadTrafficNetwork({ pool, topologyRoot: root,
        roadsApi: args.get('--roads-api') || 'http://localhost:3001/api',
        city: args.get('--city') || 'zagreb',
        bbox: args.has('--bbox') ? args.get('--bbox').split(',').map(Number) : [...DEFAULT_BBOX] });
    await mkdir(dirname(output), { recursive: true });
    const json = JSON.stringify(data, (_key, value) => typeof value === 'number' ? Math.round(value * 1e7) / 1e7 : value) + '\n';
    await writeFile(output, gzipSync(json));
    console.log(JSON.stringify(data.source.counts, null, 2));
} finally { await pool.end(); }
