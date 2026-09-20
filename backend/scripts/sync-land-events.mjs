#!/usr/bin/env node
// Restartable proposal-lifecycle oracle materializer. It reads stored Solana transactions, polls
// known proposal accounts, and inserts each immutable terminal event at most once.

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import pg from 'pg';
import { Connection } from '@solana/web3.js';
import { syncProposalLifecycleEvents } from '../oracle/proposal-lifecycle.js';

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

try {
    const result = await syncProposalLifecycleEvents({
        pool,
        connection,
        dryRun: args.has('--dry-run'),
        onProgress: progress => console.log(`[${new Date().toISOString()}] ${progress.phase} ${progress.done}/${progress.total}`)
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.missingEvidence.length) process.exitCode = 1;
} catch (error) {
    console.error(`[${new Date().toISOString()}] land-event sync failed: ${error.stack || error.message}`);
    process.exitCode = 1;
} finally {
    await pool.end();
}
