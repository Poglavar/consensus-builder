#!/usr/bin/env node
// CLI of the agreement lifecycle oracle (agreement-lifecycle.js through land-event-job.js): reads the
// chain account of every minted agreement in the index, refreshes its `onchain` record and writes the
// land events of terminal agreements (`agreement_lifecycle`, and one `agreement_executed` per input
// parcel). Dry run unless --apply. --once runs one pass and exits; without it a pass runs every
// --interval seconds. Restartable and idempotent: every pass re-derives everything from the chain and
// the index, and nothing is written twice. Applied passes write the run-stats artifact
// (LAND_ORACLE_RUN_STATS) the operations page and the monitor read.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPool } from '../db/connection.cjs';
import { AGREEMENT_CLUSTERS, createAgreementChain } from '../agreements/onchain.js';
import { buildLandOracleRunStats, landOracleStatsPath, writeRunStatsAtomic } from '../operations/run-stats.js';
import { runLandEventJob, timestampedLog } from './land-event-job.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTERVAL_SECONDS = 600;

function usage(code = 0) {
    console.log([
        'Usage: node oracle/agreement-lifecycle-job.mjs (--once | --apply) [options]',
        '',
        '  --once              One pass, then exit (exit code 1 when the pass fails or finds a problem).',
        '  --apply             Write: refresh consensus.agreement.onchain and insert the land events.',
        '                      Without it the pass is a dry run that reads the chain and writes nothing.',
        `  --interval <s>      Seconds between passes when not --once (default ${DEFAULT_INTERVAL_SECONDS}).`,
        `  --cluster <name>    ${Object.keys(AGREEMENT_CLUSTERS).join(' | ')} (default devnet).`,
        '  --help              This text.',
        '',
        'Examples:',
        '  node oracle/agreement-lifecycle-job.mjs --once            # dry run: what would change',
        '  node oracle/agreement-lifecycle-job.mjs --once --apply    # one written pass (the PM2 cron job)',
        '',
        'Env (backend/.env): DATABASE_URL, SOLANA_RPC_URL (the cluster\'s RPC), SOLANA_RPC_MAX_ACCOUNTS,',
        'LAND_ORACLE_RUN_STATS (run-stats file, default logs/land-oracle-stats.json; written by --apply passes).'
    ].join('\n'));
    process.exit(code);
}

function options() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                once: { type: 'boolean' },
                apply: { type: 'boolean' },
                interval: { type: 'string' },
                cluster: { type: 'string', default: 'devnet' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (!values.once && !values.apply) usage(2);
    if (!AGREEMENT_CLUSTERS[values.cluster]) throw new Error(`unknown --cluster ${values.cluster}`);
    if (values.once && values.interval !== undefined) throw new Error('--interval is for repeated passes; drop --once or --interval');
    const interval = values.interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number(values.interval);
    if (!Number.isInteger(interval) || interval < 10) throw new Error(`--interval must be whole seconds, at least 10; got ${values.interval}`);
    return { once: Boolean(values.once), apply: Boolean(values.apply), interval, cluster: values.cluster };
}

async function main() {
    const opts = options();
    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    const pool = createPool();
    pool.on('error', error => timestampedLog(`idle pg client error: ${error.message}`));
    const chain = createAgreementChain({ cluster: opts.cluster });
    timestampedLog(`${opts.apply ? 'APPLY' : 'DRY RUN'} on ${opts.cluster}${opts.once ? ', one pass' : `, a pass every ${opts.interval}s`}`);

    async function pass() {
        const startedAt = new Date().toISOString();
        const job = await runLandEventJob({ pool, chain, apply: opts.apply });
        if (job.error) timestampedLog(`pass FAILED: ${job.error.message}`);
        if (opts.apply) {
            const stats = buildLandOracleRunStats({ startedAt, endedAt: new Date().toISOString(), result: job.result, error: job.error, dryRun: false });
            try {
                writeRunStatsAtomic(landOracleStatsPath(process.env), stats);
            } catch (error) {
                timestampedLog(`run-stats write failed: ${error.stack || error.message}`);
                return 1;
            }
        }
        return job.exitCode;
    }

    if (opts.once) {
        try {
            process.exitCode = await pass();
        } finally {
            await pool.end();
        }
        return;
    }

    // Repeated passes: the next starts `interval` seconds after the previous one ended, so passes never
    // overlap; SIGINT/SIGTERM stop between passes or cut the wait short.
    let stopping = false;
    let timer = null;
    let wake = null;
    const stop = signal => {
        timestampedLog(`${signal}: stopping after the current pass`);
        stopping = true;
        clearTimeout(timer);
        wake?.();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    while (!stopping) {
        const code = await pass();
        if (code) process.exitCode = code;
        if (stopping) break;
        await new Promise(resolve => {
            wake = resolve;
            timer = setTimeout(resolve, opts.interval * 1000);
        });
    }
    await pool.end();
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] [agreement-lifecycle] failed: ${error.stack || error.message}`);
    process.exit(1);
});
