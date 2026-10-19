// One logged, incremental top-up of the transaction store (consensus.solana_transaction), shared by
// scripts/sync-transactions.mjs and the land-event oracle job so both run the exact same sync with
// the same defaults, RPC chunk spacing and log lines. Pool, connection and sync are injectable.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { buildAddressBook, watchedAddresses } from './address-book.js';
import { createRpcMethodCounter } from './rpc-method-counts.js';
import {
    syncTransactions,
    countTransactions,
    DEFAULT_SIGNATURE_SCAN_LIMIT,
    FETCH_CHUNK_SPACING_MS,
    JOB_RPC_RETRY_DELAYS
} from './tx-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRANSACTION_SYNC_CLUSTER = 'devnet';
export const PERSONAS_FILE = path.join(__dirname, '..', 'agents', 'personas.json');

export const timestampedLog = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const TRANSACTION_SYNC_LOCK_KEY = 1_954_635_591;

/** Throws when personas.json is unreadable: a sync that silently drops persona wallets is incomplete. */
export function readPersonasFile(file = PERSONAS_FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Scan the watched addresses, fetch what the store is missing and store it, logging progress.
 * Never throws on an RPC failure (that comes back as `error`, see syncTransactions); throws on a
 * database or personas-file failure.
 *
 * @returns {Promise<{scanned:number, newSignatures:number, fetched:number, failed:number, error:string|null,
 *   storeBefore:number, storeAfter:number, durationMs:number}>}
 */
export async function runTransactionSync(options = {}) {
    const log = options.log || timestampedLog;
    if (!options.pool || typeof options.pool.connect !== 'function') {
        throw new Error('transaction sync requires a PostgreSQL pool with connect() for its advisory lock');
    }
    const lockClient = await options.pool.connect();
    let locked = false;
    let releaseError;
    try {
        const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [TRANSACTION_SYNC_LOCK_KEY]);
        locked = rows[0]?.locked === true;
        if (!locked) {
            log('SKIPPED — another transaction-store sync is already running');
            return { skipped: true, status: 'skipped', error: null, failed: 0, rpcCounts: {} };
        }
        // All sync SQL uses the checked-out session too. Besides keeping the lock and writes on one
        // connection, this avoids exhausting a pool configured with max: 1.
        return await runTransactionSyncLocked({ ...options, pool: lockClient });
    } finally {
        if (locked) {
            try {
                await lockClient.query('SELECT pg_advisory_unlock($1)', [TRANSACTION_SYNC_LOCK_KEY]);
            } catch (error) {
                releaseError = error;
                log(`FAILED — could not release transaction sync lock: ${error.stack || error.message}`);
            }
        }
        lockClient.release(releaseError);
    }
}

async function runTransactionSyncLocked({
    pool,
    connection,
    env = process.env,
    personas = readPersonasFile(),
    limit = DEFAULT_SIGNATURE_SCAN_LIMIT,
    spacing = FETCH_CHUNK_SPACING_MS,
    dryRun = false,
    cluster = TRANSACTION_SYNC_CLUSTER,
    retryDelays = JOB_RPC_RETRY_DELAYS,
    jobName = 'transaction-sync',
    rpcCounter = createRpcMethodCounter(),
    log = timestampedLog,
    sync = syncTransactions,
    count = countTransactions
} = {}) {
    const book = buildAddressBook({ env, personas });
    const watched = watchedAddresses(book);
    const runId = randomUUID();
    const startedAt = new Date();
    await pool.query(`
        INSERT INTO consensus.transaction_sync_run (run_id, job_name, started_at, status, dry_run)
        VALUES ($1, $2, $3, 'running', $4)
    `, [runId, jobName, startedAt, dryRun]);
    const started = Date.now();
    let result = { scanned: 0, newSignatures: 0, fetched: 0, failed: 0, error: null, errorStack: null };
    let before = null;
    let after = null;
    try {
        before = await count(pool, cluster);
        log(`store holds ${before} ${cluster} transactions; scanning ${watched.length} watched addresses (limit ${limit}, chunk spacing ${spacing}ms)${dryRun ? ' — DRY RUN, nothing will be fetched or written' : ''}`);

        result = await sync({
            pool,
            connection,
            watched,
            limit,
            cluster,
            retryDelays,
            chunkSpacingMs: spacing,
            dryRun,
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

        after = await count(pool, cluster);
        const status = result.error || result.failed > 0 ? 'failed' : 'completed';
        const rpcCounts = rpcCounter.snapshot();
        const completedAt = new Date();
        const error = result.error || (result.failed > 0 ? `${result.failed} signature(s) could not be fetched` : null);
        await pool.query(`
            UPDATE consensus.transaction_sync_run
               SET completed_at = $2, updated_at = now(), status = $3, scanned = $4, new_signatures = $5,
                   fetched = $6, failed = $7, error = $8, error_stack = $9, rpc_counts = $10::jsonb
             WHERE run_id = $1
        `, [runId, completedAt, status, result.scanned || 0, result.newSignatures || 0,
            result.fetched || 0, result.failed || 0, error, result.errorStack || null, JSON.stringify(rpcCounts)]);

        const durationMs = Date.now() - started;
        log(`scanned ${result.scanned} signatures · ${result.newSignatures} not in the store · fetched ${result.fetched} · failed ${result.failed}`);
        log(`RPC methods: ${JSON.stringify(rpcCounts)}`);
        log(`store now holds ${after} transactions (+${after - before}) in ${(durationMs / 1000).toFixed(1)}s`);
        if (status === 'failed') log(`FAILED — ${error}${result.errorStack ? `\n${result.errorStack}` : ''}`);
        return { ...result, runId, jobName, status, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), rpcCounts, storeBefore: before, storeAfter: after, durationMs };
    } catch (error) {
        const completedAt = new Date();
        const rpcCounts = rpcCounter.snapshot();
        try {
            await pool.query(`
                UPDATE consensus.transaction_sync_run
                   SET completed_at = $2, updated_at = now(), status = 'failed', scanned = $3, new_signatures = $4,
                       fetched = $5, failed = $6, error = $7, error_stack = $8, rpc_counts = $9::jsonb
                 WHERE run_id = $1
            `, [runId, completedAt, result.scanned || 0, result.newSignatures || 0,
                result.fetched || 0, result.failed || 0, error.message, error.stack || null, JSON.stringify(rpcCounts)]);
        } catch (recordError) {
            log(`FAILED — could not persist sync failure status: ${recordError.stack || recordError.message}`);
        }
        log(`FAILED — ${error.stack || error.message}`);
        throw error;
    }
}
