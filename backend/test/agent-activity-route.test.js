import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
    chainEvents, controllerOf, proposalAccountIndex, proposalEvents, runDetail, runEvents,
    setupAgentActivityRoute
} from '../routes/agent-activity.js';

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
    it('projects confirmed chain actions from an unfamiliar wallet as human activity', () => {
        const proposalAccount = '11111111111111111111111111111111';
        const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
        const index = proposalAccountIndex([{ proposal_id: 'public-proposal', proposal_account: proposalAccount }]);
        const [event] = chainEvents([{ raw: {}, created_at: '2026-09-22T08:00:01Z' }], {
            book: { entryFor: () => null },
            proposalIdsByAccount: index,
            decode: () => ({
                signature: 'donation-tx', slot: 42, time: '2026-09-22T08:00:00Z', status: 'success',
                feePayer: { address: wallet, label: null },
                instructions: [{
                    index: 0, inner: false,
                    program: { name: 'proposal_pledge', address: 'support-program' },
                    action: 'donate', args: { amount: '50000' },
                    accounts: [
                        { role: 'proposal', address: proposalAccount },
                        { role: 'donor', address: wallet, signer: true }
                    ]
                }]
            })
        });
        expect(event).toMatchObject({
            source: 'live', actor: { id: wallet, kind: 'human', controller: 'human', wallet },
            action: { type: 'donate', proposalId: 'public-proposal', amount: '0.05' },
            entity: { type: 'proposal', id: 'public-proposal' }, transaction: 'donation-tx',
            provenance: { source: 'solana_transaction', slot: 42, instruction: 'donate' }
        });
    });

    it('projects facilitator-paid treasury transfers as neutral x402 activity', () => {
        const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
        const book = { feePayer: 'facilitator', treasury: 'treasury', entryFor: () => null };
        const [event] = chainEvents([{ raw: {} }], {
            book,
            decode: () => ({
                signature: 'paid-tx', slot: 43, time: '2026-09-22T09:21:00Z', status: 'success',
                feePayer: { address: 'facilitator' }, instructions: [], summary: 'x402 settlement',
                amounts: [{
                    kind: 'token', amount: '0.01', symbol: 'USDC',
                    from: { owner: { address: wallet, label: null } },
                    to: { owner: { address: 'treasury' } }
                }]
            })
        });
        expect(event).toMatchObject({
            actor: { id: wallet, kind: 'human' },
            action: { type: 'x402Payment', amount: '0.01', asset: 'USDC' },
            transaction: 'paid-tx'
        });
    });

    it('projects runner checkpoints into the shared activity schema', () => {
        const events = runEvents(row);
        expect(events).toHaveLength(4);
        expect(events.map(event => event.action.type)).toEqual(['run_status', 'create', 'publish', 'stake']);
        expect(events[1]).toMatchObject({ source: 'live', actor: { kind: 'agent', controller: 'llm' }, entity: { type: 'proposal', id: 'agent-p1' }, transaction: 'mint-tx', model: 'claude-opus-5', modelCostUsd: 0.0054, batchId: 'msgbatch-1' });
        expect(events[1]).toMatchObject({ rationale: null });
    });

    it('keeps run rationale and exact cost evidence in an explicit drill-down shape', () => {
        const detail = runDetail(row, [{
            item: 'c1', provider: 'anthropic', model: 'claude-opus-5', batch_id: 'msgbatch-1',
            input_tokens: 120, output_tokens: 45, cache_read_tokens: 0, cache_creation_tokens: 0,
            usd: '0.005400', created_at: '2026-09-20T08:03:00Z'
        }]);
        expect(detail).toMatchObject({ id: row.run_id, role: 'proposer', model: 'claude-opus-5', modelCostUsd: 0.0054, costs: [{ usd: 0.0054, inputTokens: 120 }] });
        expect(detail.picks[0]).toMatchObject({ proposalId: 'agent-p1', name: 'Courtyard homes' });
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

    it('preserves an algorithmic controller without inventing model provenance', () => {
        const algorithmic = {
            ...row,
            summary: {
                controller: 'algorithm', pickCostUsd: 0,
                decisionResult: { controller: 'algorithm', costUsd: 0 },
                picks: []
            }
        };
        const [event] = runEvents(algorithmic);
        expect(event.actor.controller).toBe('algorithm');
        expect(event.model).toBeNull();
        expect(runDetail(algorithmic, [])).toMatchObject({ controller: 'algorithm', model: null, costs: [] });
    });

    it('recognises legacy LLM runs from their immutable batch/cost evidence', () => {
        const legacy = { batchId: 'msgbatch-legacy', pickCostUsd: 0.0054 };
        expect(controllerOf(legacy)).toBe('llm');
        expect(runDetail({ ...row, summary: legacy }, [{ model: 'claude-opus-5', batch_id: 'msgbatch-legacy', usd: '0.0054' }]))
            .toMatchObject({ controller: 'llm', model: 'claude-opus-5', batchId: 'msgbatch-legacy' });
    });

    it('serves a run with its events and immutable cost-ledger rows', async () => {
        const pool = {
            query: async (sql) => {
                if (sql.includes('consensus.agent_run')) return { rows: [row] };
                return { rows: [{ item: 'c1', provider: 'anthropic', model: 'claude-opus-5', batch_id: 'b1', input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, usd: '0.01', created_at: '2026-09-20T08:03:00Z' }] };
            }
        };
        const app = express();
        setupAgentActivityRoute(app, pool);
        const response = await request(app).get(`/agent/runs/${row.run_id}`);
        expect(response.status).toBe(200);
        expect(response.body.run).toMatchObject({ id: row.run_id, costs: [{ usd: 0.01 }] });
        expect(response.body.events).toHaveLength(4);
    });

    it('lists recent runs and filters after inferring legacy controller provenance', async () => {
        const algorithmic = {
            ...row,
            run_id: '2026-09-21-supporter-01',
            persona: 'supporter-01',
            summary: { role: 'supporter', controller: 'algorithm', wallet: 'wallet-2', outcome: 'completed', support: { type: 'pledge' } }
        };
        const pool = { query: async () => ({ rows: [algorithmic, row] }) };
        const app = express();
        setupAgentActivityRoute(app, pool);

        const response = await request(app).get('/agent/runs?controller=algorithm&limit=10');

        expect(response.status).toBe(200);
        expect(response.body.count).toBe(1);
        expect(response.body.runs[0]).toMatchObject({
            id: '2026-09-21-supporter-01', role: 'supporter', controller: 'algorithm',
            wallet: 'wallet-2', modelCostUsd: 0, support: { type: 'pledge' }
        });
    });

    it('rejects unknown controller filters on the run index', async () => {
        const app = express();
        setupAgentActivityRoute(app, { query: async () => ({ rows: [] }) });
        const response = await request(app).get('/agent/runs?controller=magic');
        expect(response.status).toBe(400);
    });
});
