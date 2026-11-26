#!/usr/bin/env node
// CLI of agreement discovery (agreement-discovery.js): one pass lists the current agreement program's
// accounts and indexes and records the agreements the index was never told about, their content read
// from IPFS gateways and checked against the account's CID. Dry run unless --apply. Restartable and
// idempotent; failed accounts are retried after a growing wait kept in the retry-state file. Applied
// passes write the run-stats artifact (AGREEMENT_DISCOVERY_RUN_STATS) a monitor can read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPool } from '../db/connection.cjs';
import { AGREEMENT_CLUSTERS, createAgreementChain } from '../agreements/onchain.js';
import {
    agreementDiscoveryStatePath, agreementDiscoveryStatsPath, buildAgreementDiscoveryRunStats, readRunStats, writeRunStatsAtomic
} from '../operations/run-stats.js';
import { createGatewayReader } from '../storage/gateway-read.js';
import { createThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import {
    DEFAULT_MAX_FETCHES, DEFAULT_MAX_IMPORTS, agreementIndexer, retriesFromState, runAgreementDiscoveryJob, stateFromRetries
} from './agreement-discovery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = message => console.log(`[${new Date().toISOString()}] [agreement-discovery] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node oracle/agreement-discovery-job.mjs (--dry-run | --apply) [options]',
        '',
        '  --dry-run            List the accounts, read gateways and run every check; write nothing.',
        '  --apply              Index the agreements found and record their `onchain`; write the retry state',
        '                       and the run stats.',
        `  --max <n>            Accounts imported per pass at most (default ${DEFAULT_MAX_IMPORTS}); the rest wait.`,
        `  --max-fetches <n>    Gateway reads per pass at most (default ${DEFAULT_MAX_FETCHES}).`,
        `  --cluster <name>     ${Object.keys(AGREEMENT_CLUSTERS).join(' | ')} (default devnet).`,
        '  --help               This text.',
        '',
        'Env (backend/.env): DATABASE_URL, SOLANA_RPC_URL, SOLANA_PROGRAM_ACCOUNTS_RPC_URL (optional, for',
        'getProgramAccounts), SOLANA_RPC_MIN_INTERVAL_MS (pacing), IPFS_READ_GATEWAY or IPFS_DISCOVERY_GATEWAYS,',
        'AGREEMENT_DISCOVERY_RUN_STATS (default logs/agreement-discovery-stats.json),',
        'AGREEMENT_DISCOVERY_STATE (retry state, default logs/agreement-discovery-state.json).'
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
                'dry-run': { type: 'boolean' },
                apply: { type: 'boolean' },
                max: { type: 'string' },
                'max-fetches': { type: 'string' },
                cluster: { type: 'string', default: 'devnet' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (Boolean(values['dry-run']) === Boolean(values.apply)) {
        console.error('Give exactly one of --dry-run and --apply.');
        usage(2);
    }
    if (!AGREEMENT_CLUSTERS[values.cluster]) throw new Error(`unknown --cluster ${values.cluster}`);
    const whole = (raw, fallback, name) => {
        const value = raw === undefined ? fallback : Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a whole number of at least 0; got ${raw}`);
        return value;
    };
    return {
        apply: Boolean(values.apply),
        maxImports: whole(values.max, DEFAULT_MAX_IMPORTS, '--max'),
        maxFetches: whole(values['max-fetches'], DEFAULT_MAX_FETCHES, '--max-fetches'),
        cluster: values.cluster
    };
}

async function main() {
    const opts = options();
    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    const statePath = agreementDiscoveryStatePath(process.env);
    // A missing state file is a first run; an unreadable one is not silently forgotten.
    const state = fs.existsSync(statePath) ? readRunStats(statePath) : null;
    if (fs.existsSync(statePath) && !state) throw new Error(`the retry state ${statePath} is not readable JSON; move it aside to start over`);
    const retries = retriesFromState(state);

    const pool = createPool();
    pool.on('error', error => log(`idle pg client error: ${error.message}`));
    const thumbnailQueue = createThumbnailQueue();
    const reader = createGatewayReader();
    const chain = createAgreementChain({ cluster: opts.cluster });
    log(`${opts.apply ? 'APPLY' : 'DRY RUN'} on ${opts.cluster}, program ${chain.programId}; at most ${opts.maxImports} import(s) and ${opts.maxFetches} gateway read(s); gateways ${reader.gateways.map(base => new URL(base).host).join(', ')}; ${retries.size} account(s) in the retry state`);

    const startedAt = new Date().toISOString();
    let job;
    try {
        job = await runAgreementDiscoveryJob({
            pool, chain, apply: opts.apply, retries, maxImports: opts.maxImports, maxFetches: opts.maxFetches,
            index: agreementIndexer(pool, { thumbnailQueue }), readJson: reader.readJson, log
        });
        if (job.error) log(`pass FAILED: ${job.error.message}`);
        if (opts.apply) {
            if (job.result) writeRunStatsAtomic(statePath, stateFromRetries(retries));
            writeRunStatsAtomic(agreementDiscoveryStatsPath(process.env), buildAgreementDiscoveryRunStats({
                startedAt, endedAt: new Date().toISOString(), result: job.result, error: job.error, dryRun: false
            }));
            // Thumbnails of newly indexed agreements and designs render before the pool closes.
            await thumbnailQueue.onIdle();
        }
    } finally {
        await pool.end();
    }
    process.exitCode = job.exitCode;
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] [agreement-discovery] failed: ${error.stack || error.message}`);
    process.exit(1);
});
