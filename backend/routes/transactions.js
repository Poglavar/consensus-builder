// The explorer reads only the durable transaction mirror. The scheduled/CLI worker owns all chain
// synchronization so page loads never consume RPC quota.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAddressBook, legendAddresses } from '../solana/address-book.js';
import { loadIdls, decodeParsedTransaction } from '../solana/tx-decoder.js';
import { readTransactions, countTransactions, withRpcRetry, isRateLimited } from '../solana/tx-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLUSTER = 'devnet';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export const EXPLORER_LINKS = Object.freeze({
    tx: `https://explorer.solana.com/tx/{sig}?cluster=${CLUSTER}`,
    address: `https://explorer.solana.com/address/{addr}?cluster=${CLUSTER}`,
    solscanTx: `https://solscan.io/tx/{sig}?cluster=${CLUSTER}`,
    solscanAddress: `https://solscan.io/account/{addr}?cluster=${CLUSTER}`
});

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
    now = () => new Date()
} = {}) {
    const book = buildAddressBook({ env, personas: readPersonas() });
    const idls = loadIdls(path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl'));

    const legend = legendAddresses(book);
    const watchedList = () => legend.map((address) => {
        const { label, kind } = book.labelFor(address);
        return { address, label, kind };
    });

    app.get('/transactions/watched', (req, res) => {
        res.json({ cluster: CLUSTER, explorer: EXPLORER_LINKS, watched: watchedList() });
    });

    app.get('/transactions', async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const address = typeof req.query.address === 'string' && req.query.address.trim() ? req.query.address.trim() : null;
        try {
            // Three independent pool reads (the page, the stored count, the latest sync run): asked
            // together, not one after another.
            const [rows, stored, syncRun] = await Promise.all([
                readTransactions(pool, { limit, address, cluster: CLUSTER }),
                countTransactions(pool, CLUSTER),
                latestTransactionSync(pool)
            ]);
            const transactions = rows
                .map((row) => decodeParsedTransaction(row.raw, { book, idls }))
                .filter(Boolean);

            res.json({
                cluster: CLUSTER,
                fetchedAt: now().toISOString(),
                cached: false,
                source: 'database',
                explorer: EXPLORER_LINKS,
                watched: watchedList(),
                count: transactions.length,
                transactions,
                sync: syncRun,
                stored
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] transactions: store unavailable — ${error.message}`);
            res.status(502).json({ error: `Transaction store unavailable: ${error.message}` });
        }
    });

    // Compatibility endpoint for older clients. Refresh now means re-read the DB; only the
    // scheduled worker or explicit CLI job performs an RPC sync.
    app.post('/transactions/sync', async (req, res) => {
        try {
            res.json({ cluster: CLUSTER, sync: await latestTransactionSync(pool), stored: await countTransactions(pool, CLUSTER), source: 'database' });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] transactions: store unavailable — ${error.message}`);
            res.status(502).json({ error: `Transaction store unavailable: ${error.message}` });
        }
    });

}

async function latestTransactionSync(pool) {
    const { rows } = await pool.query(`
        SELECT last_run.run_id, last_run.job_name, last_run.status, last_run.started_at, last_run.completed_at,
               last_run.scanned, last_run.new_signatures, last_run.fetched, last_run.failed,
               last_run.error, last_run.rpc_counts,
               last_success.completed_at AS last_success_at
          FROM (
              SELECT * FROM consensus.transaction_sync_run
               WHERE job_name IN ('transaction-sync', 'land-oracle') AND dry_run = FALSE
               ORDER BY started_at DESC LIMIT 1
          ) AS last_run
          LEFT JOIN LATERAL (
              SELECT completed_at FROM consensus.transaction_sync_run
               WHERE job_name IN ('transaction-sync', 'land-oracle') AND status = 'completed' AND dry_run = FALSE
               ORDER BY completed_at DESC LIMIT 1
          ) AS last_success ON TRUE
    `);
    const run = rows[0];
    if (!run) return null;
    return {
        jobName: run.job_name,
        at: run.completed_at ? new Date(run.completed_at).toISOString() : null,
        status: run.status,
        startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
        lastSuccessAt: run.last_success_at ? new Date(run.last_success_at).toISOString() : null,
        scanned: run.scanned,
        newSignatures: run.new_signatures,
        fetched: run.fetched,
        failed: run.failed,
        error: run.error,
        rpcCounts: run.rpc_counts || {}
    };
}
