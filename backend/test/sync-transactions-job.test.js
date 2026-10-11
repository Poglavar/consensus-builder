// Unit tests for the shared transaction-sync job used by scripts/sync-transactions.mjs and the
// land-event oracle: it passes the CLI defaults (limit, RPC chunk spacing) to syncTransactions,
// and logs and returns the counters. syncTransactions and the store count are stubs.

import { describe, expect, it } from 'vitest';
import { runTransactionSync } from '../solana/transaction-sync-job.js';
import { createRpcMethodCounter } from '../solana/rpc-method-counts.js';
import { DEFAULT_SIGNATURE_SCAN_LIMIT, FETCH_CHUNK_SPACING_MS, JOB_RPC_RETRY_DELAYS } from '../solana/tx-store.js';

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';

function stubs(result = { scanned: 7, newSignatures: 2, fetched: 2, failed: 0, error: null }, lockAvailable = true) {
    const seen = {};
    const counts = [10, 12];
    const lines = [];
    const runs = new Map();
    const dbQueries = [];
    let lockClientCheckedOut = false;
    const executeQuery = async (sql, params) => {
        dbQueries.push({ sql, params });
        if (sql.includes('INSERT INTO consensus.transaction_sync_run')) {
            runs.set(params[0], { run_id: params[0], job_name: params[1], started_at: params[2], status: 'running', dry_run: params[3] });
        } else if (sql.includes('UPDATE consensus.transaction_sync_run')) {
            const row = runs.get(params[0]);
            if (row) Object.assign(row, sql.includes("status = 'failed'")
                ? { completed_at: params[1], status: 'failed', scanned: params[2], new_signatures: params[3], fetched: params[4], failed: params[5] }
                : { completed_at: params[1], status: params[2], scanned: params[3], new_signatures: params[4], fetched: params[5], failed: params[6] });
        }
        return { rows: [], rowCount: 1 };
    };
    const pool = { async query(sql, params) {
        if (lockClientCheckedOut) throw new Error('pool max: 1 exhausted while lock client is checked out');
        return executeQuery(sql, params);
    }, async connect() {
        lockClientCheckedOut = true;
        return {
            async query(sql, params) {
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: lockAvailable }] };
                if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
                return executeQuery(sql, params);
            },
            release(error) { lockClientCheckedOut = false; seen.lockReleasedWithError = error || null; }
        };
    } };
    return {
        seen,
        lines,
        runs,
        dbQueries,
        options: {
            pool,
            connection: {},
            env: { X402_PAY_TO: TREASURY },
            personas: { personas: [] },
            log: line => lines.push(line),
            count: async () => counts.shift(),
            sync: async (options) => {
                Object.assign(seen, options);
                options.onProgress({ phase: 'fetch', done: 2, total: 2, stored: 2 });
                return result;
            }
        }
    };
}

describe('runTransactionSync', () => {
    it('uses the CLI defaults: scan limit, chunk spacing, writes (not a dry run)', async () => {
        const s = stubs();
        await runTransactionSync(s.options);
        expect(s.seen.limit).toBe(DEFAULT_SIGNATURE_SCAN_LIMIT);
        expect(s.seen.chunkSpacingMs).toBe(FETCH_CHUNK_SPACING_MS);
        expect(s.seen.dryRun).toBe(false);
        expect(s.seen.cluster).toBe('devnet');
        expect(Array.isArray(s.seen.watched)).toBe(true);
    });

    it('skips without creating a run or issuing RPC when another sync holds the advisory lock', async () => {
        const s = stubs(undefined, false);
        let syncCalled = false;
        s.options.sync = async () => { syncCalled = true; };

        const result = await runTransactionSync(s.options);

        expect(result).toMatchObject({ skipped: true, status: 'skipped' });
        expect(syncCalled).toBe(false);
        expect(s.dbQueries).toHaveLength(0);
        expect(s.runs.size).toBe(0);
        expect(s.lines[0]).toContain('SKIPPED');
    });

    it('waits out a throttle with the long job backoff, not the API route\'s short one', async () => {
        // 2026-10-10: the nightly oracle gave up after ~10 s of retries and failed the whole run.
        const s = stubs();
        await runTransactionSync(s.options);
        expect(s.seen.retryDelays).toBe(JOB_RPC_RETRY_DELAYS);
        expect(JOB_RPC_RETRY_DELAYS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60000);
    });

    it('passes overrides through', async () => {
        const s = stubs();
        await runTransactionSync({ ...s.options, limit: 25, spacing: 5000, dryRun: true });
        expect(s.seen).toMatchObject({ limit: 25, chunkSpacingMs: 5000, dryRun: true });
    });

    it('returns and logs the counters with the store growth', async () => {
        const s = stubs();
        const result = await runTransactionSync(s.options);
        expect(result).toMatchObject({ scanned: 7, newSignatures: 2, fetched: 2, failed: 0, error: null, storeBefore: 10, storeAfter: 12 });
        expect(result.status).toBe('completed');
        expect(result.rpcCounts).toEqual({});
        expect(s.dbQueries).toHaveLength(2);
        expect([...s.runs.values()][0]).toMatchObject({ status: 'completed', scanned: 7, new_signatures: 2, fetched: 2, failed: 0 });
        expect(s.lines).toContain('scanned 7 signatures · 2 not in the store · fetched 2 · failed 0');
        expect(s.lines).toContain('RPC methods: {}');
        expect(s.lines.some(line => line.startsWith('store now holds 12 transactions (+2)'))).toBe(true);
    });

    it('records a completed zero-change run as fresh and a failed attempt separately', async () => {
        const s = stubs({ scanned: 1, newSignatures: 0, fetched: 0, failed: 0, error: null });
        const result = await runTransactionSync(s.options);
        expect(result.status).toBe('completed');
        expect(result.newSignatures).toBe(0);
        expect([...s.runs.values()][0].status).toBe('completed');
    });

    it('counts individual JSON-RPC batch members and preserves RPC failure stacks', async () => {
        const s = stubs({ scanned: 1, newSignatures: 1, fetched: 0, failed: 0, error: '429', errorStack: 'Error: 429\n    at fake' });
        const rpcCounter = createRpcMethodCounter();
        s.options.rpcCounter = rpcCounter;
        s.options.sync = async () => {
            rpcCounter.onRequest([{ method: 'getSignaturesForAddress' }]);
            rpcCounter.onRequest([{ method: 'getTransaction' }, { method: 'getTransaction' }, { method: 'getMultipleAccounts' }]);
            return { scanned: 1, newSignatures: 1, fetched: 0, failed: 0, error: '429', errorStack: 'Error: 429\n    at fake' };
        };
        const result = await runTransactionSync(s.options);
        expect(result.rpcCounts).toEqual({ getSignaturesForAddress: 1, getTransaction: 2, getMultipleAccounts: 1 });
        expect(result.status).toBe('failed');
        expect(result.errorStack).toContain('at fake');
        expect([...s.runs.values()][0].status).toBe('failed');
    });
});
