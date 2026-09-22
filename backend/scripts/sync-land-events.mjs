#!/usr/bin/env node
// Restartable proposal-lifecycle oracle materializer. It reads stored Solana transactions, polls
// known proposal accounts, inserts each immutable terminal event at most once, and reconciles the
// proposal API's lifecycle from that verified event.

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import pg from 'pg';
import { Connection } from '@solana/web3.js';
import { syncProposalLifecycleEvents } from '../oracle/proposal-lifecycle.js';
import { buildLandOracleRunStats, landOracleStatsPath, writeRunStatsAtomic } from '../operations/run-stats.js';

function usage(code = 0) {
    console.log('Usage: node scripts/sync-land-events.mjs (--dry-run | --live)');
    process.exit(code);
}

const args = new Set(process.argv.slice(2));
if (args.has('--help')) usage(0);
if (args.size !== 1 || (args.has('--dry-run') === args.has('--live'))) usage(2);

const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
});
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const startedAt = new Date().toISOString();
let syncResult = null;
let syncError = null;

try {
    syncResult = await syncProposalLifecycleEvents({
        pool,
        connection,
        dryRun: args.has('--dry-run'),
        onProgress: progress => console.log(`[${new Date().toISOString()}] ${progress.phase} ${progress.done}/${progress.total}`)
    });
    console.log(JSON.stringify(syncResult, null, 2));
    if (syncResult.missingEvidence.length) process.exitCode = 1;
} catch (error) {
    syncError = error;
    console.error(`[${new Date().toISOString()}] land-event sync failed: ${error.stack || error.message}`);
    process.exitCode = 1;
} finally {
    await pool.end();
    const stats = buildLandOracleRunStats({
        startedAt,
        endedAt: new Date().toISOString(),
        result: syncResult,
        error: syncError,
        dryRun: args.has('--dry-run')
    });
    try {
        writeRunStatsAtomic(landOracleStatsPath(process.env), stats);
    } catch (statsError) {
        console.error(`[${new Date().toISOString()}] land-event run-stats write failed: ${statsError.stack || statsError.message}`);
        process.exitCode = 1;
    }
}
