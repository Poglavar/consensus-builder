#!/usr/bin/env node
// Backfills finished recognition jobs into the shared LLM ledger (agents/lib/llm-cost).
//
// Recognition recorded its usage only in lane_topology_job until the ledger was wired in, so the
// junctions solved before that are invisible to `llm-cost` — including the whole of the first
// Claude batch, which is the only record of roughly $37 of metered-equivalent work.
//
// Idempotent by artifact: a job already in the ledger is identified by its jobId in the row's meta,
// so a second run adds nothing. Append-only ledgers cannot be de-duplicated afterwards, which makes
// re-running safely the only way this is usable at all.
//
//   node backend/scripts/ledger-backfill.js            # report what would be written
//   node backend/scripts/ledger-backfill.js --apply
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const require = createRequire(import.meta.url);

const USAGE = `
Backfill finished recognition jobs into the shared LLM cost ledger.

  --apply        Write to the ledger (default is a dry run).
  --limit N      Only the N most recent eligible jobs.
`;

function parseArgs(argv) {
    const args = { apply: false, limit: null };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--apply') args.apply = true;
        else if (argv[index] === '--limit') { index += 1; args.limit = Number(argv[index]); }
        else if (argv[index] === '--help' || argv[index] === '-h') args.help = true;
        else throw new Error(`Unknown argument "${argv[index]}".`);
    }
    return args;
}

function loadLedger() {
    try {
        return require('../../../agents/lib/llm-cost/index.cjs');
    } catch (error) {
        throw new Error(`shared cost ledger not available (${error.message}); `
            + 'this script only makes sense beside an agents/ checkout.');
    }
}

// Which jobs the ledger already holds. Reading the whole file is fine — it is one line per run and
// a few thousand lines at most — and it is the only way to keep a second run from double-counting.
function alreadyLedgered(ledgerPath) {
    const seen = new Set();
    let text = '';
    try {
        text = readFileSync(ledgerPath, 'utf8');
    } catch (_) {
        return seen;
    }
    text.split('\n').filter(Boolean).forEach(line => {
        try {
            const row = JSON.parse(line);
            if (row.jobId !== undefined && row.jobId !== null) seen.add(Number(row.jobId));
        } catch (_) {
            // A malformed line is not a reason to re-bill every job.
        }
    });
    return seen;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    const ledger = loadLedger();
    const seen = alreadyLedgered(ledger.LEDGER);

    const pool = new pg.Pool({
        host: process.env.PGHOST === 'db' ? 'localhost' : process.env.PGHOST,
        port: process.env.PGPORT,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });
    const { rows } = await pool.query(
        `SELECT id, provider, model, usage, city, selected_bbox, prompt_version, finished_at
           FROM public.lane_topology_job
          WHERE usage IS NOT NULL
          ORDER BY id DESC
          ${args.limit ? `LIMIT ${Number(args.limit)}` : ''}`
    );
    await pool.end();

    const pending = rows.filter(row => !seen.has(Number(row.id)));
    console.log(`${rows.length} jobs with recorded usage · ${rows.length - pending.length} already `
        + `in the ledger · ${pending.length} to write`);
    if (!pending.length) return 0;

    let output = 0;
    let equivalent = 0;
    pending.forEach(row => {
        output += Number(row.usage.outputTokens) || 0;
        equivalent += Number(row.usage.equivalentUsd) || 0;
        if (!args.apply) return;
        ledger.recordSubscriptionRun({
            repo: 'consensus-builder',
            script: 'lane-topology-recognition',
            model: row.model || row.provider,
            usage: row.usage,
            equivalentUsd: row.usage.equivalentUsd,
            meta: {
                provider: row.provider,
                jobId: Number(row.id),
                city: row.city ?? null,
                bbox: row.selected_bbox ?? null,
                promptVersion: row.prompt_version ?? null,
                backfilled: true,
                // The ledger stamps `ts` at write time, which for a backfill is today rather than
                // when the tokens were actually spent. Keep the real one alongside.
                ran_at: row.finished_at ? new Date(row.finished_at).toISOString() : null
            }
        });
    });
    console.log(`${args.apply ? 'wrote' : 'would write'} ${pending.length} runs · `
        + `${output.toLocaleString('en')} output tokens · `
        + `$${equivalent.toFixed(2)} metered-equivalent (billed to a subscription, not charged)`);
    if (!args.apply) console.log('dry run — pass --apply to write');
    return 0;
}

main().then(code => process.exit(code)).catch(error => {
    console.error(`fatal: ${error.message}`);
    process.exit(1);
});
