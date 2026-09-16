#!/usr/bin/env node
// Backfill / top up consensus.solana_transaction from devnet, outside a web request.
//
// The explorer syncs a little on every page load, but the initial history has to be pulled slowly:
// the public devnet RPC rate-limits hard, and a request cannot sit there backing off for minutes.
// This runs the same sync once, so the pull can be repeated until it catches up.
//
// Restartable by construction: the table IS the checkpoint. A run killed by a rate limit keeps every
// transaction it already stored, and the next run only fetches the signatures still missing. Nothing
// is ever refetched, so rerunning is cheap and safe.
//
//   PGHOST=localhost node scripts/sync-transactions.mjs --run
//   PGHOST=localhost node scripts/sync-transactions.mjs --run --limit 25
//   PGHOST=localhost node scripts/sync-transactions.mjs --dry-run
//
// The public devnet RPC throttles getParsedTransactions far harder than the 400 ms default assumes
// (measured 2026-09-16: ~one 5-signature chunk per run before a 429 the retries cannot outwait).
// Raise --spacing when backfilling a long history; the table is the checkpoint either way.

import pkg from 'pg';
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Connection } from '@solana/web3.js';
import { buildAddressBook, watchedAddresses } from '../solana/address-book.js';
import { syncTransactions, countTransactions, DEFAULT_SIGNATURE_SCAN_LIMIT, FETCH_CHUNK_SPACING_MS } from '../solana/tx-store.js';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLUSTER = 'devnet';

function usage() {
    console.log([
        'Backfill the devnet transaction store (consensus.solana_transaction).',
        '',
        '  --run                Perform the sync (scan, fetch what is missing, store it).',
        '  --dry-run            Scan and report how many signatures are missing; fetch nothing.',
        `  --limit N            Signatures to request per watched address  [${DEFAULT_SIGNATURE_SCAN_LIMIT}]`,
        `  --spacing MS         Pause between getParsedTransactions chunks   [${FETCH_CHUNK_SPACING_MS}]`,
        '  --help               Show this message.',
        '',
        'The table is the checkpoint: rerun after a rate limit and only the still-missing',
        'signatures are fetched. Connect to the local database with PGHOST=localhost.',
        '',
        '  PGHOST=localhost node scripts/sync-transactions.mjs --run --limit 25'
    ].join('\n'));
}

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function parseArgs(argv) {
    const args = { run: false, dryRun: false, limit: DEFAULT_SIGNATURE_SCAN_LIMIT, spacing: FETCH_CHUNK_SPACING_MS, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--run') args.run = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--limit') {
            const value = Number.parseInt(argv[++i], 10);
            if (!Number.isFinite(value) || value <= 0) throw new Error(`--limit needs a positive integer, got "${argv[i]}"`);
            args.limit = value;
        } else if (arg === '--spacing') {
            const value = Number.parseInt(argv[++i], 10);
            if (!Number.isFinite(value) || value < 0) throw new Error(`--spacing needs a non-negative integer, got "${argv[i]}"`);
            args.spacing = value;
        } else throw new Error(`unknown argument "${arg}"`);
    }
    return args;
}

async function main() {
    const argv = process.argv.slice(2);
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(`${error.message}\n`);
        usage();
        process.exitCode = 1;
        return;
    }

    if (!argv.length || args.help || (!args.run && !args.dryRun)) {
        usage();
        return;
    }

    const personas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'personas.json'), 'utf8'));
    const book = buildAddressBook({ env: process.env, personas });
    const watched = watchedAddresses(book);

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

    try {
        const before = await countTransactions(pool, CLUSTER);
        log(`store holds ${before} ${CLUSTER} transactions; scanning ${watched.length} watched addresses (limit ${args.limit}, chunk spacing ${args.spacing}ms)${args.dryRun ? ' — DRY RUN, nothing will be fetched or written' : ''}`);

        const started = Date.now();
        const result = await syncTransactions({
            pool,
            connection,
            watched,
            limit: args.limit,
            cluster: CLUSTER,
            chunkSpacingMs: args.spacing,
            dryRun: args.dryRun,
            onProgress: ({ phase, done, total, address, signatures, stored }) => {
                if (phase === 'scan') {
                    log(`  scan ${done}/${total} · ${book.labelFor(address).label || address} · ${signatures} signatures seen`);
                } else if (total > 0) {
                    const elapsed = (Date.now() - started) / 1000;
                    const rate = done > 0 ? elapsed / done : 0;
                    const eta = rate > 0 ? `· ETA ${Math.round(rate * (total - done))}s` : '';
                    log(`  fetch ${done}/${total} · stored ${stored ?? 0} ${eta}`);
                }
            }
        });

        const after = await countTransactions(pool, CLUSTER);
        log(`scanned ${result.scanned} signatures · ${result.newSignatures} not in the store · fetched ${result.fetched} · failed ${result.failed}`);
        log(`store now holds ${after} transactions (+${after - before}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        if (result.error) {
            log(`INCOMPLETE — ${result.error}`);
            log('Everything fetched before the failure is stored; rerun to pick up the rest.');
            process.exitCode = 1;
        } else if (args.dryRun) {
            log(`DRY RUN complete — ${result.newSignatures} signature(s) would be fetched.`);
        } else {
            log('Sync complete.');
        }
    } catch (error) {
        log(`FAILED — ${error.message}`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
