// Unit tests for the shared transaction-sync job used by scripts/sync-transactions.mjs and the
// land-event oracle: it passes the CLI defaults (limit, RPC chunk spacing) to syncTransactions,
// and logs and returns the counters. syncTransactions and the store count are stubs.

import { describe, expect, it } from 'vitest';
import { runTransactionSync } from '../solana/transaction-sync-job.js';
import { DEFAULT_SIGNATURE_SCAN_LIMIT, FETCH_CHUNK_SPACING_MS, JOB_RPC_RETRY_DELAYS } from '../solana/tx-store.js';

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';

function stubs(result = { scanned: 7, newSignatures: 2, fetched: 2, failed: 0, error: null }) {
    const seen = {};
    const counts = [10, 12];
    const lines = [];
    return {
        seen,
        lines,
        options: {
            pool: {},
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
        expect(s.lines).toContain('scanned 7 signatures · 2 not in the store · fetched 2 · failed 0');
        expect(s.lines.some(line => line.startsWith('store now holds 12 transactions (+2)'))).toBe(true);
    });

    it('returns an RPC error instead of throwing', async () => {
        const s = stubs({ scanned: 1, newSignatures: 1, fetched: 0, failed: 0, error: '429' });
        const result = await runTransactionSync(s.options);
        expect(result.error).toBe('429');
    });
});
