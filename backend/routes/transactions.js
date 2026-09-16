// Devnet transaction explorer for the agent stack. Everything is derived from the chain — there is
// no bookkeeping table the app writes as it acts — but the chain is MIRRORED locally in
// consensus.solana_transaction (DDL: transactions-ddl.sql) instead of being re-scanned per request:
// the public devnet RPC rate-limits a single page load that refetches eight watched addresses.
//
// So a request runs an incremental sync at most every 30 s (scan signatures, fetch only the ones
// the table has never seen, store the raw response) and then reads and decodes from the table. The
// store is also the history: the owner wants every transaction this system ever made, not the last
// page the RPC was willing to serve.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection } from '@solana/web3.js';
import { buildAddressBook, legendAddresses, watchedAddresses } from '../solana/address-book.js';
import { loadIdls, decodeParsedTransaction } from '../solana/tx-decoder.js';
import {
    syncTransactions,
    readTransactions,
    countTransactions,
    withRpcRetry,
    isRateLimited,
    DEFAULT_SIGNATURE_SCAN_LIMIT,
    FETCH_CHUNK_SPACING_MS
} from '../solana/tx-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLUSTER = 'devnet';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
// A page refresh must not re-scan eight addresses on the public devnet RPC. This now gates the
// SYNC, not the response: the store is read fresh on every request either way.
const SYNC_TTL_MS = 30 * 1000;

export const EXPLORER_LINKS = Object.freeze({
    tx: `https://explorer.solana.com/tx/{sig}?cluster=${CLUSTER}`,
    address: `https://explorer.solana.com/address/{addr}?cluster=${CLUSTER}`,
    solscanTx: `https://solscan.io/tx/{sig}?cluster=${CLUSTER}`,
    solscanAddress: `https://solscan.io/account/{addr}?cluster=${CLUSTER}`
});

const EMPTY_SYNC = Object.freeze({ at: null, scanned: 0, newSignatures: 0, fetched: 0, failed: 0, error: null });

export { withRpcRetry, isRateLimited };

function readPersonas() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'personas.json'), 'utf8'));
    } catch (error) {
        console.error(`[${new Date().toISOString()}] transactions: could not read personas.json — ${error.message}`);
        return { personas: [] };
    }
}

function parseLimit(raw) {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
    return Math.min(value, MAX_LIMIT);
}

export function setupTransactionsRoute(app, pool, {
    env = process.env,
    connection,
    rpcRetryDelays,
    chunkSpacingMs = FETCH_CHUNK_SPACING_MS,
    syncTtlMs = SYNC_TTL_MS,
    scanLimit = DEFAULT_SIGNATURE_SCAN_LIMIT
} = {}) {
    const book = buildAddressBook({ env, personas: readPersonas() });
    const watched = watchedAddresses(book);
    const idls = loadIdls(path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl'));
    const rpc = connection || new Connection(env.SOLANA_RPC_URL || DEFAULT_RPC_URL, 'confirmed');

    let lastSyncAt = 0;
    let lastSync = EMPTY_SYNC;
    let inFlight = null;

    const legend = legendAddresses(book);
    const watchedList = () => legend.map((address) => {
        const { label, kind } = book.labelFor(address);
        return { address, label, kind };
    });

    // Returns whether a sync actually ran, so the response can say `cached`.
    async function runSync({ force = false } = {}) {
        if (!force && lastSyncAt && Date.now() - lastSyncAt < syncTtlMs) return false;
        // Two requests arriving together must not both hammer the RPC.
        if (inFlight) {
            await inFlight;
            return true;
        }
        inFlight = syncTransactions({
            pool,
            connection: rpc,
            watched,
            limit: scanLimit,
            cluster: CLUSTER,
            retryDelays: rpcRetryDelays,
            chunkSpacingMs
        });
        try {
            const result = await inFlight;
            lastSyncAt = Date.now();
            lastSync = { at: new Date(lastSyncAt).toISOString(), ...result };
            if (result.error) {
                console.error(`[${new Date().toISOString()}] transactions: sync incomplete — ${result.error} (stored ${result.fetched} of ${result.newSignatures} new)`);
            }
            return true;
        } finally {
            inFlight = null;
        }
    }

    app.get('/transactions/watched', (req, res) => {
        res.json({ cluster: CLUSTER, explorer: EXPLORER_LINKS, watched: watchedList() });
    });

    app.get('/transactions', async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const address = typeof req.query.address === 'string' && req.query.address.trim() ? req.query.address.trim() : null;
        const skipSync = req.query.sync === '0' || req.query.sync === 'false';

        let ranSync = false;
        try {
            if (!skipSync) ranSync = await runSync();

            const rows = await readTransactions(pool, { limit, address, cluster: CLUSTER });
            const transactions = rows
                .map((row) => decodeParsedTransaction(row.raw, { book, idls }))
                .filter(Boolean);
            const stored = await countTransactions(pool, CLUSTER);

            res.json({
                cluster: CLUSTER,
                fetchedAt: new Date().toISOString(),
                cached: !ranSync,
                explorer: EXPLORER_LINKS,
                watched: watchedList(),
                count: transactions.length,
                transactions,
                sync: lastSync,
                stored
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] transactions: store unavailable — ${error.message}`);
            res.status(502).json({ error: `Transaction store unavailable: ${error.message}` });
        }
    });

    // The page's Refresh button: sync now, ignoring the TTL.
    app.post('/transactions/sync', async (req, res) => {
        try {
            await runSync({ force: true });
            res.json({ cluster: CLUSTER, sync: lastSync, stored: await countTransactions(pool, CLUSTER) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] transactions: forced sync failed — ${error.message}`);
            res.status(502).json({ error: `Transaction store unavailable: ${error.message}` });
        }
    });
}
