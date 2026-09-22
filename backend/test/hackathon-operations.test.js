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
