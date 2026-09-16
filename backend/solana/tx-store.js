// The store behind the transaction explorer: an incremental mirror of every devnet transaction this
// system has made, in consensus.solana_transaction (DDL: routes/transactions-ddl.sql).
//
// Why a store at all: the public devnet RPC rate-limits a single page load that re-scans eight
// watched addresses and refetches their transactions. Signature scans are cheap, fetching parsed
// transactions is not — so a sync scans, subtracts what the table already holds, and fetches only
// the difference. The table is therefore also the checkpoint: a sync killed by a rate limit loses
// nothing it had already written, and a rerun picks up exactly what is still missing.
//
// Everything here takes its pool and connection as arguments, so it is unit-testable with stubs.

import { PublicKey } from '@solana/web3.js';
import { toAddress } from './tx-decoder.js';

export const TRANSACTION_TABLE = 'consensus.solana_transaction';

export const DEFAULT_SIGNATURE_SCAN_LIMIT = 50;
// The public devnet RPC counts every signature in a getParsedTransactions batch against its
// per-method window, so the misses are fetched as small chunks with a pause between them.
export const FETCH_CHUNK_SIZE = 5;
export const FETCH_CHUNK_SPACING_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRateLimited(error) {
    return /too many requests|429/i.test(String(error?.message ?? error));
}

// Back off and retry a rate limit a few times; anything else is thrown straight through.
export async function withRpcRetry(call, delays = [1500, 3000, 6000]) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await call();
        } catch (error) {
            if (!isRateLimited(error) || attempt >= delays.length) throw error;
            await sleep(delays[attempt]);
        }
    }
}

export function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * Every address a transaction touches: the message's account keys plus the owners behind its token
 * accounts. The owners matter because "show me agent densifier-01's transactions" means its wallet,
 * which for an SPL transfer appears nowhere in the account keys — only as the token account's owner.
 */
export function extractTouchedAddresses(rpcTx) {
    const found = new Set();
    for (const key of rpcTx?.transaction?.message?.accountKeys || []) {
        const address = toAddress(key && typeof key === 'object' && 'pubkey' in key ? key.pubkey : key);
        if (address) found.add(address);
    }
    const balances = [...(rpcTx?.meta?.preTokenBalances || []), ...(rpcTx?.meta?.postTokenBalances || [])];
    for (const balance of balances) {
        const owner = toAddress(balance?.owner);
        if (owner) found.add(owner);
    }
    return [...found].sort();
}

/** Signatures out of `signatures` that the table does not hold yet, in the order given. */
export async function findMissingSignatures(pool, signatures) {
    if (!signatures.length) return [];
    const { rows } = await pool.query(
        `SELECT signature FROM ${TRANSACTION_TABLE} WHERE signature = ANY($1)`,
        [signatures]
    );
    const known = new Set(rows.map((row) => row.signature));
    return signatures.filter((signature) => !known.has(signature));
}

/**
 * Insert a batch of fetched transactions. Existing signatures are left alone — `raw` is the chain's
 * own record and never changes, so a re-sync must not rewrite rows (or bump updated_at) for free.
 */
export async function storeTransactions(pool, records, cluster = 'devnet') {
    if (!records.length) return 0;
    const values = [];
    const params = [];
    records.forEach((record, i) => {
        const base = i * 7;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`);
        params.push(
            record.signature,
            record.slot ?? null,
            record.blockTime ?? null,
            cluster,
            JSON.stringify(record.raw),
            record.touchedAddresses ?? [],
            record.firstSeenWatched ?? []
        );
    });
    const { rowCount } = await pool.query(
        `INSERT INTO ${TRANSACTION_TABLE}
             (signature, slot, block_time, cluster, raw, touched_addresses, first_seen_watched)
         VALUES ${values.join(', ')}
         ON CONFLICT (signature) DO NOTHING`,
        params
    );
    return rowCount ?? 0;
}

export async function countTransactions(pool, cluster = 'devnet') {
    const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ${TRANSACTION_TABLE} WHERE cluster = $1`, [cluster]);
    return rows[0]?.total ?? 0;
}

/** Newest first. `address` filters on touched_addresses, which is what the GIN index is for. */
export async function readTransactions(pool, { limit = 25, address = null, cluster = 'devnet' } = {}) {
    const params = [cluster];
    let where = 'cluster = $1';
    if (address) {
        params.push(address);
        where += ` AND $${params.length} = ANY(touched_addresses)`;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT signature, slot, block_time, raw
           FROM ${TRANSACTION_TABLE}
          WHERE ${where}
          ORDER BY block_time DESC NULLS LAST, slot DESC
          LIMIT $${params.length}`,
        params
    );
    return rows;
}

/**
 * One incremental sync: scan the watched addresses, subtract what is stored, fetch and store only
 * the difference.
 *
 * Never throws on an RPC failure — whatever was fetched before the failure is already committed and
 * the cause comes back as `error`, so the page keeps serving the store instead of going dark.
 *
 * @returns {Promise<{scanned:number, newSignatures:number, fetched:number, failed:number, error:string|null}>}
 *   `scanned` counts distinct signatures seen across all address scans, `failed` counts signatures
 *   the RPC returned nothing for.
 */
export async function syncTransactions({
    pool,
    connection,
    watched = [],
    limit = DEFAULT_SIGNATURE_SCAN_LIMIT,
    cluster = 'devnet',
    retryDelays,
    chunkSpacingMs = FETCH_CHUNK_SPACING_MS,
    chunkSize = FETCH_CHUNK_SIZE,
    dryRun = false,
    onProgress = () => { }
} = {}) {
    const result = { scanned: 0, newSignatures: 0, fetched: 0, failed: 0, error: null };
    // signature -> { slot, blockTime, watchedBy: Set }
    const seen = new Map();

    try {
        for (let i = 0; i < watched.length; i += 1) {
            const address = watched[i];
            const rows = await withRpcRetry(
                () => connection.getSignaturesForAddress(new PublicKey(address), { limit }),
                retryDelays
            ) || [];
            for (const row of rows) {
                if (!row?.signature) continue;
                const entry = seen.get(row.signature) || { slot: row.slot ?? null, blockTime: row.blockTime ?? null, watchedBy: new Set() };
                entry.watchedBy.add(address);
                seen.set(row.signature, entry);
            }
            onProgress({ phase: 'scan', done: i + 1, total: watched.length, address, signatures: seen.size });
        }
    } catch (error) {
        // A rate limit partway through the scan is not a reason to drop the addresses that DID
        // answer: signature scans are the cheap half, and whatever they surfaced is still worth
        // fetching. The failure is reported, and the next run rescans from scratch anyway.
        result.error = error.message;
    }

    result.scanned = seen.size;

    const missing = await findMissingSignatures(pool, [...seen.keys()]);
    result.newSignatures = missing.length;
    // Nothing new means no getParsedTransactions call at all — the expensive method is only ever
    // reached by a signature the table has never seen.
    if (!missing.length || dryRun) {
        onProgress({ phase: 'fetch', done: 0, total: dryRun ? missing.length : 0, dryRun });
        return result;
    }

    const groups = chunk(missing, chunkSize);
    for (let i = 0; i < groups.length; i += 1) {
        try {
            if (i > 0 && chunkSpacingMs > 0) await sleep(chunkSpacingMs);
            const fetched = await withRpcRetry(
                () => connection.getParsedTransactions(groups[i], { maxSupportedTransactionVersion: 0 }),
                retryDelays
            ) || [];

            const records = [];
            groups[i].forEach((signature, index) => {
                const raw = fetched[index];
                if (!raw) {
                    result.failed += 1;
                    return;
                }
                const entry = seen.get(signature);
                records.push({
                    signature,
                    slot: raw.slot ?? entry?.slot ?? null,
                    blockTime: raw.blockTime ?? entry?.blockTime ?? null,
                    raw,
                    touchedAddresses: extractTouchedAddresses(raw),
                    firstSeenWatched: entry ? [...entry.watchedBy] : []
                });
            });

            await storeTransactions(pool, records, cluster);
            result.fetched += records.length;
            onProgress({ phase: 'fetch', done: Math.min((i + 1) * chunkSize, missing.length), total: missing.length, stored: result.fetched });
        } catch (error) {
            // Chunks already stored stay stored; the caller reports the cause and serves the store.
            // A scan error already recorded stays — it is the earlier, more root cause of the two.
            result.error = result.error || error.message;
            break;
        }
    }

    return result;
}
