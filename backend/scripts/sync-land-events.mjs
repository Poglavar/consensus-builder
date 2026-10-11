#!/usr/bin/env node
// Restartable proposal-lifecycle oracle materializer. It first tops up the stored Solana
// transactions (the same incremental sync as scripts/sync-transactions.mjs), then polls known
// proposal accounts, inserts each immutable terminal event at most once, and reconciles the
// proposal API's lifecycle from that verified event.

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import pg from 'pg';
import { createRpcConnection } from '../solana/rpc.js';
import { createRpcMethodCounter } from '../solana/rpc-method-counts.js';
import { runLandEventJob } from '../oracle/land-event-job.js';
import { buildLandOracleRunStats, landOracleStatsPath, writeRunStatsAtomic } from '../operations/run-stats.js';

function usage(code = 0) {
    console.log([
        'Usage: node scripts/sync-land-events.mjs (--dry-run | --live) [--skip-transaction-sync]',
        '',
        '  --dry-run                Scan terminal proposals and report events; insert nothing.',
        '  --live                   Insert terminal events and reconcile proposal lifecycles.',
        '  --skip-transaction-sync  Do not top up consensus.solana_transaction first.',
        '',
        'By default the run first performs the incremental transaction sync (as',
        'scripts/sync-transactions.mjs --run), which WRITES newly seen transactions to',
        'consensus.solana_transaction even with --dry-run. The land-event dry run itself writes nothing.',
        'Exit code 1 when the transaction sync is incomplete, evidence is missing, or the scan fails.'
    ].join('\n'));
    process.exit(code);
}

const argv = process.argv.slice(2);
const args = new Set(argv);
if (args.has('--help')) usage(0);
const known = new Set(['--dry-run', '--live', '--skip-transaction-sync']);
if (args.size !== argv.length || [...args].some(arg => !known.has(arg)) || (args.has('--dry-run') === args.has('--live'))) usage(2);
const dryRun = args.has('--dry-run');

function required(value, label) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error(`${label} is required`);
    return text;
}

const RPC_URL = required(process.env.SOLANA_RPC_URL, 'SOLANA_RPC_URL');
const PROGRAM_ACCOUNTS_RPC_URL = required(process.env.SOLANA_PROGRAM_ACCOUNTS_RPC_URL, 'SOLANA_PROGRAM_ACCOUNTS_RPC_URL');

const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
});
// General reads and writes use SOLANA_RPC_URL; createRpcConnection sends only getProgramAccounts
// to SOLANA_PROGRAM_ACCOUNTS_RPC_URL after verifying that both endpoints are on the same cluster.
const rpcCounter = createRpcMethodCounter();
const connection = createRpcConnection(RPC_URL, 'confirmed', {
    programAccountsEndpoint: PROGRAM_ACCOUNTS_RPC_URL,
    onRpcRequest: rpcCounter.onRequest
});
console.log(`[${new Date().toISOString()}] RPC ${new URL(RPC_URL).host}`);
const startedAt = new Date().toISOString();
let job = { result: null, error: null, exitCode: 1, transactionSync: null };

try {
    job = await runLandEventJob({
        pool,
        connection,
        rpcCounter,
        dryRun,
        syncTransactionsFirst: !args.has('--skip-transaction-sync')
    });
    if (job.result) console.log(JSON.stringify(job.result, null, 2));
    if (job.error && job.result) console.error(`[${new Date().toISOString()}] land-event run FAILED: ${job.error.message}`);
    process.exitCode = job.exitCode;
} catch (error) {
    job = { ...job, error };
    console.error(`[${new Date().toISOString()}] land-event sync failed: ${error.stack || error.message}`);
    process.exitCode = 1;
} finally {
    await pool.end();
    const stats = {
        ...buildLandOracleRunStats({
            startedAt,
            endedAt: new Date().toISOString(),
            result: job.result,
            error: job.error,
            dryRun
        }),
        transactionSync: job.transactionSync
    };
    try {
        writeRunStatsAtomic(landOracleStatsPath(process.env), stats);
    } catch (statsError) {
        console.error(`[${new Date().toISOString()}] land-event run-stats write failed: ${statsError.stack || statsError.message}`);
        process.exitCode = 1;
    }
}
