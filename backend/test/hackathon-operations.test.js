import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildLandOracleRunStats } from '../operations/run-stats.js';
import { buildPublicOperationsStatus } from '../operations/public-status.js';
import { setupHackathonOperationsRoute } from '../routes/hackathon-operations.js';
import { createRouteApp } from './helpers/create-route-app.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');

function rows() {
    return [{
        run_id: '2026-09-22-supporter-01', persona: 'supporter-01', status: 'done', stage: 'supported',
        finished_at: '2026-09-22T02:16:00Z', updated_at: '2026-09-22T02:16:00Z',
        summary: { role: 'supporter', outcome: 'completed', support: { signature: 'support-tx' } }
    }, {
        run_id: '2026-09-22-densifier-01', persona: 'densifier-01', status: 'done', stage: 'staked',
        finished_at: '2026-09-22T02:05:00Z', updated_at: '2026-09-22T02:05:00Z',
        summary: { controller: 'algorithm', outcome: 'completed', posts: { first: { signature: 'proposal-tx' } } }
    }];
}

describe('public hackathon operations status', () => {
    it('treats a successful zero-work land-oracle run as healthy outcome evidence', () => {
        const landOracle = buildLandOracleRunStats({
            startedAt: '2026-09-22T02:30:00Z', endedAt: '2026-09-22T02:30:02Z',
            result: { scanned: 4, terminal: 0, events: [], inserted: 0, reconciled: 0, missingEvidence: [], invalidAccounts: [] }
        });
        const status = buildPublicOperationsStatus({
            runs: rows(), landOracle, now: NOW,
            prospective: { resolver: { cadence: 'hourly at minute 45', lastRun: {
                status: 'completed', phase: 'awaiting_evidence', endedAt: '2026-09-22T11:45:03Z'
            } } }
        });
        expect(status.status).toBe('healthy');
        expect(status.jobs.find(job => job.role === 'supporter')).toMatchObject({
            status: 'completed', lastRun: { transaction: 'support-tx' }, freshness: { state: 'fresh' }
        });
        expect(status.jobs.find(job => job.role === 'land-oracle')).toMatchObject({
            status: 'completed', lastRun: { verdict: 'success', counters: { events: 0, missingEvidence: 0 } }
        });
    });

    it('marks persistent missing evidence as a failed oracle run', () => {
        const stats = buildLandOracleRunStats({
            startedAt: '2026-09-22T02:30:00Z', endedAt: '2026-09-22T02:31:00Z',
            result: { missingEvidence: ['proposal'], events: [] }
        });
        expect(stats).toMatchObject({
            runStatus: 'failed', verdict: 'failure', counters: { missingEvidence: 1 }
        });
    });

    it('serves only the redacted aggregate returned by the operations reader', async () => {
        const operationsReader = vi.fn(async () => ({ version: 1, status: 'healthy', jobs: [] }));
        const app = createRouteApp(setupHackathonOperationsRoute, { query: vi.fn() }, {
            env: {}, now: () => NOW,
            statusReader: vi.fn(() => ({ state: 'awaiting_evidence' })), operationsReader
        });
        const response = await request(app).get('/hackathon/operations.json');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ version: 1, status: 'healthy', jobs: [] });
        expect(operationsReader).toHaveBeenCalledWith(expect.objectContaining({ now: NOW }));
    });
});

describe('supporter no-op days in the public operations status', () => {
    it('reports a run that found its support already on-chain as completed without a transaction', () => {
        const runs = rows().map(row => row.persona === 'supporter-01'
            ? { ...row, stage: 'selected', summary: { role: 'supporter', outcome: 'already-supported', support: { replayed: true, signature: null } } }
            : row);
        const landOracle = buildLandOracleRunStats({
            startedAt: '2026-09-22T02:30:00Z', endedAt: '2026-09-22T02:30:02Z',
            result: { scanned: 4, terminal: 0, events: [], inserted: 0, reconciled: 0, missingEvidence: [], invalidAccounts: [] }
        });
        const status = buildPublicOperationsStatus({
            runs, landOracle, now: NOW,
            prospective: { resolver: { cadence: 'hourly at minute 45', lastRun: {
                status: 'completed', phase: 'awaiting_evidence', endedAt: '2026-09-22T11:45:03Z'
            } } }
        });
        expect(status.jobs.find(job => job.role === 'supporter')).toMatchObject({
            status: 'completed', lastRun: { outcome: 'already-supported', transaction: null }
        });
        expect(status.status).toBe('healthy');
    });
});

describe('optional society roles in the public operations status', () => {
    const healthyInputs = () => ({
        landOracle: buildLandOracleRunStats({
            startedAt: '2026-09-22T02:30:00Z', endedAt: '2026-09-22T02:30:02Z',
            result: { scanned: 4, terminal: 0, events: [], inserted: 0, reconciled: 0, missingEvidence: [], invalidAccounts: [] }
        }),
        now: NOW,
        prospective: { resolver: { cadence: 'hourly at minute 45', lastRun: {
            status: 'completed', phase: 'awaiting_evidence', endedAt: '2026-09-22T11:45:03Z'
        } } }
    });
    const societyRow = (runId, role, { status = 'done', outcome = 'completed', at = '2026-09-22T02:21:00Z', execution = { stakeSignature: 'no-tx' }, turn = null } = {}) => ({
        run_id: runId, persona: role === 'contrarian' ? 'preservationist-01' : 'speculator-01', status, stage: 'acted',
        finished_at: status === 'running' ? null : at, updated_at: at,
        summary: { role, outcome, turn, society: { acted: outcome === 'completed', execution } }
    });

    it('lists absent roles as not configured without touching jobs or the overall status', () => {
        const status = buildPublicOperationsStatus({ runs: rows(), ...healthyInputs() });
        expect(status.status).toBe('healthy');
        expect(status.jobs.map(job => job.role)).toEqual(['proposer', 'supporter', 'land-oracle', 'prospective-resolver']);
        expect(status.optionalJobs).toEqual([
            expect.objectContaining({ role: 'contrarian', schedule: 'every 2 hours at minute 20 UTC', configured: false, status: 'not-configured', lastRun: null }),
            expect.objectContaining({ role: 'speculator', schedule: 'every 3 hours at minute 40 UTC', configured: false, status: 'not-configured', lastRun: null })
        ]);
    });

    it('takes the newest finished turn as the outcome and never mistakes a society row for the proposer', () => {
        const runs = [
            societyRow('2026-09-22-preservationist-01-t3', 'contrarian', { status: 'running', at: '2026-09-22T02:23:00Z', turn: 3 }),
            societyRow('2026-09-22-preservationist-01-t2', 'contrarian', { outcome: 'cap-reached', execution: {}, at: '2026-09-22T02:22:00Z', turn: 2 }),
            societyRow('2026-09-22-preservationist-01-t1', 'contrarian', { at: '2026-09-22T02:21:00Z', turn: 1 }),
            societyRow('2026-09-22-speculator-01', 'speculator', { execution: { signature: 'pledge-tx' }, at: '2026-09-22T02:26:00Z' }),
            ...rows()
        ];
        const status = buildPublicOperationsStatus({ runs, ...healthyInputs() });
        expect(status.status).toBe('healthy');
        expect(status.jobs.find(job => job.role === 'proposer').lastRun.persona).toBe('densifier-01');
        expect(status.optionalJobs.find(job => job.role === 'contrarian')).toMatchObject({
            configured: true, status: 'completed', lastRun: { id: '2026-09-22-preservationist-01-t2', outcome: 'cap-reached', turn: 2, transaction: null }
        });
        expect(status.optionalJobs.find(job => job.role === 'speculator')).toMatchObject({
            configured: true, status: 'completed', lastRun: { transaction: 'pledge-tx' }
        });
    });

    it('flags a recent failed society run, but treats a long-stopped role as inactive rather than attention', () => {
        const failed = buildPublicOperationsStatus({ runs: [societyRow('2026-09-22-speculator-01', 'speculator', { status: 'failed', outcome: 'failed' }), ...rows()], ...healthyInputs() });
        expect(failed.status).toBe('attention');
        expect(failed.optionalJobs.find(job => job.role === 'speculator')).toMatchObject({ configured: true, status: 'failed' });
        const stopped = buildPublicOperationsStatus({ runs: [...rows(), societyRow('2026-09-10-speculator-01', 'speculator', { status: 'failed', outcome: 'failed', at: '2026-09-10T02:26:00Z' })], ...healthyInputs() });
        expect(stopped.status).toBe('healthy');
        expect(stopped.optionalJobs.find(job => job.role === 'speculator')).toMatchObject({ configured: false, status: 'inactive', freshness: { state: 'stale' } });
    });
});
