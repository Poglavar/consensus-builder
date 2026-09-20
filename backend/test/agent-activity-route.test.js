import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { proposalEvents, runEvents, setupAgentActivityRoute } from '../routes/agent-activity.js';

const row = {
    run_id: '2026-09-20-densifier-01', persona: 'densifier-01', status: 'done', stage: 'staked',
    started_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-20T08:05:00Z',
    summary: {
        model: 'claude-opus-5', pickCostUsd: 0.0054, batchId: 'msgbatch-1',
        picks: [{ candidateId: 'c1', proposalId: 'agent-p1', name: 'Courtyard homes' }],
        mints: { c1: { signature: 'mint-tx' } },
        posts: { c1: { tx: 'pay-tx' } },
        stakes: { c1: { stakeSignature: 'stake-tx' } }
    }
};

describe('agent activity', () => {
    it('projects runner checkpoints into the shared activity schema', () => {
        const events = runEvents(row);
        expect(events).toHaveLength(4);
        expect(events.map(event => event.action.type)).toEqual(['run_status', 'create', 'publish', 'stake']);
        expect(events[1]).toMatchObject({ source: 'live', actor: { kind: 'agent', controller: 'llm' }, entity: { type: 'proposal', id: 'agent-p1' }, transaction: 'mint-tx', model: 'claude-opus-5', modelCostUsd: 0.0054, batchId: 'msgbatch-1' });
    });

    it('serves bounded recent activity', async () => {
        const calls = [];
        const pool = {
            query: async (sql, params) => {
                calls.push({ sql, params });
                return { rows: sql.includes('consensus.agent_run') ? [row] : [] };
            }
        };
        const app = express();
        setupAgentActivityRoute(app, pool);
        const response = await request(app).get('/agent/activity?limit=999');
        expect(response.status).toBe(200);
        expect(response.body.count).toBe(4);
        expect(calls[0].params).toEqual([250]);
        expect(calls[1].params).toEqual([250]);
    });

    it('projects already-published x402 agent proposals into live activity', () => {
        const [event] = proposalEvents({
            proposal_id: 'agent-park-1', display_name: 'Pocket park',
            created_at: '2026-09-19T17:38:38Z', updated_at: '2026-09-19T17:38:39Z',
            agent: {
                persona: 'park-agent', wallet: 'wallet-1', run_id: 'run-1',
                paid: { tx: 'settlement-tx' }
            }
        });
        expect(event).toMatchObject({
            source: 'live', actor: { id: 'wallet-1', name: 'park-agent', kind: 'agent', controller: 'llm' },
            action: { type: 'publish', proposalId: 'agent-park-1' },
            entity: { type: 'proposal', id: 'agent-park-1' }, transaction: 'settlement-tx', runId: 'run-1'
        });
    });
});
