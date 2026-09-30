// Unit tests for the land-oracle job body: the transaction store is topped up BEFORE the terminal
// proposal scan, a failed top-up never skips the scan but fails the run, and both sets of counters
// reach the log and the result JSON. Sync steps are stubs; no RPC or PostgreSQL.

import { describe, expect, it } from 'vitest';
import { runLandEventJob, transactionSyncProblem } from '../oracle/land-event-job.js';

const LIFECYCLE = Object.freeze({
    scanned: 3, invalidAccounts: [], terminal: 1, events: [{ proposalAccount: 'P1' }],
    inserted: 1, reconciled: 1, missingEvidence: [], dryRun: false
});

const CONSENT = Object.freeze({
    records: 0, acceptanceEvents: 0, verdictEvents: 0, events: [], inserted: 0, members: 0,
    missingEvidence: [], invalidRecords: [], dryRun: false
});

function harness({ txResult, txThrows, lifecycle = LIFECYCLE, lifecycleThrows, consent = CONSENT, consentThrows } = {}) {
    const calls = [];
    const lines = [];
    return {
        calls,
        lines,
        options: {
            pool: {},
            connection: {},
            log: line => lines.push(line),
            transactionSync: async (options) => {
                calls.push('transactions');
                expect(options.pool).toBeDefined();
                expect(options.connection).toBeDefined();
                if (txThrows) throw new Error(txThrows);
                return txResult ?? { scanned: 12, newSignatures: 2, fetched: 2, failed: 0, error: null };
            },
            syncLifecycle: async ({ dryRun }) => {
                calls.push('lifecycle');
                if (lifecycleThrows) throw new Error(lifecycleThrows);
                return { ...lifecycle, dryRun };
            },
            syncConsent: async ({ dryRun, pool, connection }) => {
                calls.push('consent');
                expect(pool).toBeDefined();
                expect(connection).toBeDefined();
                if (consentThrows) throw new Error(consentThrows);
                return { ...consent, dryRun };
            }
        }
    };
}

describe('runLandEventJob', () => {
    it('syncs transactions before scanning terminal proposals, in live and dry-run', async () => {
        for (const dryRun of [false, true]) {
            const h = harness();
            const job = await runLandEventJob({ ...h.options, dryRun });
            expect(h.calls).toEqual(['transactions', 'lifecycle', 'consent']);
            expect(job.exitCode).toBe(0);
            expect(job.error).toBeNull();
            expect(job.result.dryRun).toBe(dryRun);
        }
    });

    it('keeps the lifecycle result shape and adds transaction-sync counters', async () => {
        const h = harness();
        const job = await runLandEventJob(h.options);
        expect(job.result).toMatchObject({ scanned: 3, terminal: 1, inserted: 1, reconciled: 1, missingEvidence: [] });
        expect(job.result.transactionSync).toEqual({ scanned: 12, newSignatures: 2, fetched: 2, failed: 0, error: null, skipped: false });
    });

    it('logs the transaction-sync counters before the land-event counters', async () => {
        const h = harness();
        await runLandEventJob(h.options);
        const txLine = h.lines.findIndex(line => line.startsWith('transaction sync: scanned 12 · new 2 · fetched 2 · failed 0'));
        const landLine = h.lines.findIndex(line => line.startsWith('land events: scanned 3 · terminal 1 · events 1 · inserted 1 · reconciled 1 · missingEvidence 0'));
        expect(txLine).toBeGreaterThanOrEqual(0);
        expect(landLine).toBeGreaterThan(txLine);
    });

    it('still scans when the transaction sync reports an RPC error, but fails the run', async () => {
        const h = harness({ txResult: { scanned: 4, newSignatures: 3, fetched: 0, failed: 0, error: '429 Too Many Requests' } });
        const job = await runLandEventJob(h.options);
        expect(h.calls).toEqual(['transactions', 'lifecycle', 'consent']);
        expect(job.result.inserted).toBe(1);
        expect(job.result.transactionSync.error).toBe('429 Too Many Requests');
        expect(job.error.message).toMatch(/transaction sync incomplete: 429/);
        expect(job.exitCode).toBe(1);
        expect(h.lines.some(line => line.includes('ERROR 429 Too Many Requests'))).toBe(true);
    });

    it('still scans when the transaction sync throws, and records the cause', async () => {
        const h = harness({ txThrows: 'connection refused' });
        const job = await runLandEventJob(h.options);
        expect(h.calls).toEqual(['transactions', 'lifecycle', 'consent']);
        expect(job.result.transactionSync).toMatchObject({ error: 'connection refused', fetched: 0, skipped: false });
        expect(job.exitCode).toBe(1);
    });

    it('fails the run on unfetchable signatures (per-item failures)', async () => {
        const h = harness({ txResult: { scanned: 5, newSignatures: 2, fetched: 1, failed: 1, error: null } });
        const job = await runLandEventJob(h.options);
        expect(job.exitCode).toBe(1);
        expect(job.error.message).toMatch(/1 signature\(s\) could not be fetched/);
    });

    it('fails on missing evidence even when the transaction sync succeeded', async () => {
        const h = harness({ lifecycle: { ...LIFECYCLE, missingEvidence: ['P9'] } });
        const job = await runLandEventJob(h.options);
        expect(job.exitCode).toBe(1);
        expect(job.error).toBeNull();
        expect(job.result.missingEvidence).toEqual(['P9']);
    });

    it('returns the lifecycle failure without a result', async () => {
        const h = harness({ lifecycleThrows: 'db down' });
        const job = await runLandEventJob(h.options);
        expect(job.result).toBeNull();
        expect(job.error.message).toBe('db down');
        expect(job.exitCode).toBe(1);
        expect(job.transactionSync.fetched).toBe(2);
    });

    it('can skip the transaction sync explicitly', async () => {
        const h = harness();
        const job = await runLandEventJob({ ...h.options, syncTransactionsFirst: false });
        expect(h.calls).toEqual(['lifecycle', 'consent']);
        expect(job.result.transactionSync.skipped).toBe(true);
        expect(job.exitCode).toBe(0);
    });
});

describe('runLandEventJob: lens-model v2 consent evidence', () => {
    it('is a clean no-op step while the v2 program has no acceptance records', async () => {
        const h = harness();
        const job = await runLandEventJob(h.options);
        expect(job.exitCode).toBe(0);
        expect(job.result.consent).toMatchObject({ records: 0, inserted: 0, members: 0 });
        expect(h.lines.some(line => line.startsWith('consent evidence: records 0 · acceptance events 0 · verdict events 0 · inserted 0'))).toBe(true);
    });

    it('reports consent counters and fails the run on unmatched or undecodable records', async () => {
        const counted = harness({ consent: { ...CONSENT, records: 2, acceptanceEvents: 2, verdictEvents: 1, inserted: 3, members: 1 } });
        const ok = await runLandEventJob(counted.options);
        expect(ok.exitCode).toBe(0);
        expect(ok.result.consent).toMatchObject({ records: 2, inserted: 3, members: 1 });

        const missing = await runLandEventJob(harness({ consent: { ...CONSENT, records: 1, missingEvidence: ['R1'] } }).options);
        expect(missing.exitCode).toBe(1);
        const invalid = await runLandEventJob(harness({ consent: { ...CONSENT, invalidRecords: ['R2'] } }).options);
        expect(invalid.exitCode).toBe(1);
    });

    it('keeps the lifecycle result when the consent step throws, and fails the run', async () => {
        const h = harness({ consentThrows: 'getProgramAccounts 429' });
        const job = await runLandEventJob(h.options);
        expect(job.result.inserted).toBe(1);
        expect(job.result.consent).toBeNull();
        expect(job.error.message).toMatch(/consent evidence sync failed: getProgramAccounts 429/);
        expect(job.exitCode).toBe(1);
    });
});

describe('transactionSyncProblem', () => {
    it('is null for a clean or skipped sync', () => {
        expect(transactionSyncProblem({ failed: 0, error: null, skipped: false })).toBeNull();
        expect(transactionSyncProblem({ failed: 3, error: 'x', skipped: true })).toBeNull();
    });
});
