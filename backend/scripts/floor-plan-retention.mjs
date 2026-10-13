#!/usr/bin/env node
// Audit eligible completed source compaction; --apply marks bytes discarded then prunes files.
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { compactSources } from '../floor-plans/compact-sources.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export async function runRetentionCli(argv = process.argv.slice(2), {
    clientFactory = options => new pg.Client(options), compact = compactSources,
    output = value => console.log(JSON.stringify(value, null, 2)),
    log = value => console.error(JSON.stringify({ at: new Date().toISOString(), ...value })),
} = {}) {
    const has = flag => argv.includes(flag);
    const option = flag => argv[argv.indexOf(flag) + 1];
    if (has('--help')) {
        output({ usage: 'node backend/scripts/floor-plan-retention.mjs [--apply] [--limit 1..100000] [--until-complete]',
            default: 'read-only audit; --apply is required to discard source bytes',
            resume: '--apply --until-complete repeats committed batches; --limit controls each batch (default 250)' });
        return 0;
    }
    const repeat = has('--until-complete');
    if (repeat && !has('--apply')) throw new Error('--until-complete requires --apply; an audit does not remove completed candidates.');
    const limit = has('--limit') ? Number(option('--limit')) : repeat ? 250 : 50000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('--limit must be an integer from 1 to 100000.');
    const connectionString = process.env.DATABASE_URL;
    const client = clientFactory(connectionString ? { connectionString, ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}) } : undefined);
    await client.connect();
    try {
        // Each compact call verifies evidence, commits tombstones, then prunes. A restart selects
        // only retained candidates and unfinished file removals, so completed batches stay done.
        let totals = null, batches = 0;
        const counters = ['htmlSources', 'htmlBlobs', 'htmlBytes', 'envelopeSources', 'envelopeBlobs',
            'envelopeBytes', 'sourceReadErrors', 'filesDeleted', 'bytesDeleted'];
        do {
            const result = await compact(client, { apply: has('--apply'), limit, log });
            if (!repeat) { output(result); return result.sourceReadErrors ? 2 : 0; }
            batches++;
            const previous = totals;
            totals = { ...result, batches };
            for (const key of counters) totals[key] = (previous?.[key] || 0) + (result[key] || 0);
            log({ phase: 'source-retention-checkpoint', batch: batches, batchFilesDeleted: result.filesDeleted,
                filesDeleted: totals.filesDeleted, bytesDeleted: totals.bytesDeleted, sourceReadErrors: result.sourceReadErrors });
            if (result.sourceReadErrors || !(result.htmlBlobs || result.envelopeBlobs || result.filesDeleted)) break;
        } while (repeat);
        output(totals);
        return totals.sourceReadErrors ? 2 : 0;
    } finally { await client.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    runRetentionCli().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}
