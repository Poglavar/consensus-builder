// One logged, incremental top-up of the transaction store (consensus.solana_transaction), shared by
// scripts/sync-transactions.mjs and the land-event oracle job so both run the exact same sync with
// the same defaults, RPC chunk spacing and log lines. Pool, connection and sync are injectable.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAddressBook, watchedAddresses } from './address-book.js';
import {
    syncTransactions,
    countTransactions,
    DEFAULT_SIGNATURE_SCAN_LIMIT,
    FETCH_CHUNK_SPACING_MS
} from './tx-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRANSACTION_SYNC_CLUSTER = 'devnet';
export const PERSONAS_FILE = path.join(__dirname, '..', 'agents', 'personas.json');

export const timestampedLog = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

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
export async function runTransactionSync({
    pool,
    connection,
    env = process.env,
    personas = readPersonasFile(),
    limit = DEFAULT_SIGNATURE_SCAN_LIMIT,
    spacing = FETCH_CHUNK_SPACING_MS,
    dryRun = false,
    cluster = TRANSACTION_SYNC_CLUSTER,
    retryDelays,
    log = timestampedLog,
    sync = syncTransactions,
    count = countTransactions
} = {}) {
    const book = buildAddressBook({ env, personas });
    const watched = watchedAddresses(book);

    const before = await count(pool, cluster);
    log(`store holds ${before} ${cluster} transactions; scanning ${watched.length} watched addresses (limit ${limit}, chunk spacing ${spacing}ms)${dryRun ? ' — DRY RUN, nothing will be fetched or written' : ''}`);

    const started = Date.now();
    const result = await sync({
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

    const after = await count(pool, cluster);
    const durationMs = Date.now() - started;
    log(`scanned ${result.scanned} signatures · ${result.newSignatures} not in the store · fetched ${result.fetched} · failed ${result.failed}`);
    log(`store now holds ${after} transactions (+${after - before}) in ${(durationMs / 1000).toFixed(1)}s`);
    return { ...result, storeBefore: before, storeAfter: after, durationMs };
}
