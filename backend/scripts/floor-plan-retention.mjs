#!/usr/bin/env node
// Audit eligible completed source compaction; --apply marks bytes discarded then prunes files.
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { compactSources } from '../floor-plans/compact-sources.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export async function runRetentionCli(argv = process.argv.slice(2), { clientFactory = options => new pg.Client(options), output = value => console.log(JSON.stringify(value, null, 2)) } = {}) {
    const has = flag => argv.includes(flag);
    const option = flag => argv[argv.indexOf(flag) + 1];
    if (has('--help')) {
        output({ usage: 'node backend/scripts/floor-plan-retention.mjs [--apply] [--limit 1..100000]',
            default: 'read-only audit; --apply is required to discard source bytes' });
        return 0;
    }
    const limit = has('--limit') ? Number(option('--limit')) : 50000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('--limit must be an integer from 1 to 100000.');
    const connectionString = process.env.DATABASE_URL;
    const client = clientFactory(connectionString ? { connectionString, ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}) } : undefined);
    await client.connect();
    try {
        const result = await compactSources(client, { apply: has('--apply'), limit, log: value => console.error(JSON.stringify(value)) });
        output(result);
        return result.sourceReadErrors ? 2 : 0;
    } finally { await client.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    runRetentionCli().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}
