import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
    ACTIVITY_SCAN_WINDOW, activityFilters, chainEvents, controllerOf, matchesActivityFilters, proposalAccountIndex,
    proposalEvents, runDetail, runEvents, setupAgentActivityRoute
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
    it('serves only public, confirmed recent events in newest-first order with real proposal links', async () => {
        const proposalAccount = '11111111111111111111111111111111';
        const proposalRows = [
            { proposal_id: 'p1', city: 'zagreb', display_name: 'Pocket park', created_at: '2026-09-21T10:00:00Z',
                proposal_data: { geometry: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.92, 45.8], [15.92, 45.82], [15.9, 45.8]]] } } }
        ];
        const calls = [];
        const pool = { query: async (sql, params = []) => {
            calls.push({ sql, params });
            if (sql.includes('proposal_account')) return { rows: [{ ...proposalRows[0], proposal_account: proposalAccount }] };
            if (sql.includes('FROM proposal')) return { rows: proposalRows };
            if (sql.includes('consensus.land_event')) return { rows: [{
                event_id: 'verified-execution', subject_id: proposalAccount, outcome: 'executed',
                source_observed_at: '2026-09-21T12:00:00Z', transaction_signature: 'execute-tx'
            }] };
            return { rows: [{ raw: { signature: 'accepted-tx' }, signature: 'accepted-tx' }] };
        } };
        const decode = raw => ({
            signature: raw.signature || 'failed-tx', status: raw.failed ? 'failed' : 'success',
            time: raw.failed ? '2026-09-21T14:00:00Z' : '2026-09-21T13:00:00Z',
            feePayer: { address: 'wallet-1' }, instructions: [{
                index: 0, inner: false, program: { name: 'proposal_market', address: 'market-program' },
                action: 'accept_proposal', accounts: [{ role: 'proposal', address: proposalAccount }]
            }]
        });
        const app = express();
        setupAgentActivityRoute(app, pool, { book: { entryFor: () => null }, idls: {}, decode });

        const response = await request(app).get('/activity/recent?limit=999');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.body.source).toBe('live');
        expect(response.body.events.map(event => event.action.type)).toEqual(['accept', 'execute', 'create']);
        expect(response.body.events[0]).toMatchObject({
            action: { proposalId: 'p1' }, entity: { type: 'proposal', id: 'p1' },
            proposalName: 'Pocket park', cityId: 'zagreb', transaction: 'accepted-tx',
            location: { lat: 45.81, lon: 15.91 }
        });
        expect(response.body.events[1].location).toEqual({ lat: 45.81, lon: 15.91 });
        expect(response.body.events[2].location).toEqual({ lat: 45.81, lon: 15.91 });
        expect(response.body.events[1]).toMatchObject({
            id: 'verified-execution', action: { type: 'execute', proposalId: 'p1' },
            provenance: { source: 'verified_proposal_lifecycle' }
        });
        expect(calls.find(call => call.sql.includes('FROM proposal') && call.sql.includes('created_at')).params).toEqual([30]);
        expect(calls.find(call => call.sql.includes('consensus.land_event')).sql).toMatch(/event_type = 'proposal_lifecycle' AND outcome = 'executed'/);
    });

    it('uses valid stored bounds when geometry is absent and omits unusable locations', async () => {
        const proposals = [
            { proposal_id: 'bounded', city: 'zagreb', display_name: 'Bounds proposal', bounds: { west: 15.9, south: 45.8, east: 15.92, north: 45.82 } },
            { proposal_id: 'unknown', city: 'nowhere', display_name: 'No coordinates', proposal_data: { geometry: { type: 'Point', coordinates: [181, 95] } }, bounds: [-200, -100, 200, 100] }
        ];
        const pool = { query: async sql => {
            if (sql.includes('FROM proposal')) return { rows: proposals };
            return { rows: [] };
        } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });
        const response = await request(app).get('/activity/recent?limit=10');
        expect(response.status).toBe(200);
        expect(response.body.events.find(event => event.entity.id === 'bounded').location).toEqual({ lat: 45.81, lon: 15.91 });
        expect(response.body.events.find(event => event.entity.id === 'unknown')).not.toHaveProperty('location');
    });

    it('finds coordinates in structure, road, and reparcellization proposal bodies without spreading vertices', async () => {
        const polygon = (west, south, east, north) => ({
            type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        });
        const proposals = [
            { proposal_id: 'structure', proposal_data: { structureProposal: { geometry: polygon(15.9, 45.8, 15.92, 45.82) } } },
            { proposal_id: 'road', proposal_data: { roadProposal: { definition: { features: {
                type: 'FeatureCollection', features: [{ type: 'Feature', geometry: polygon(16, 46, 16.02, 46.02) }]
            } } } } },
            { proposal_id: 'reparcel', proposal_data: { reparcellization: { polygons: [
                { geometry: polygon(16.1, 46.1, 16.12, 46.12) }
            ] } } },
            { proposal_id: 'many', proposal_data: { geometry: { type: 'LineString', coordinates:
                Array.from({ length: 200000 }, (_, i) => [15 + i / 1e7, 45 + i / 1e7]) } } }
        ];
        const pool = { query: async sql => sql.includes('FROM proposal') ? { rows: proposals } : { rows: [] } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/activity/recent?limit=10');

        expect(response.status).toBe(200);
        const location = id => response.body.events.find(event => event.entity.id === id)?.location;
        expect(location('structure')).toEqual({ lat: 45.81, lon: 15.91 });
        expect(location('road').lat).toBeCloseTo(46.01, 10);
        expect(location('road').lon).toBeCloseTo(16.01, 10);
        expect(location('reparcel').lat).toBeCloseTo(46.11, 10);
        expect(location('reparcel').lon).toBeCloseTo(16.11, 10);
        expect(location('many').lat).toBeCloseTo(45.00999995, 10);
        expect(location('many').lon).toBeCloseTo(15.00999995, 10);
    });

    it('defaults the public activity limit to twelve and omits failed, fake, and unmapped chain actions', async () => {
        const proposalAccount = '11111111111111111111111111111111';
        const calls = [];
        const pool = { query: async (sql, params = []) => {
            calls.push({ sql, params });
            if (sql.includes('proposal_account')) return { rows: [{ proposal_id: 'p1', proposal_account: proposalAccount, city: 'zagreb', display_name: 'Park' }] };
            if (sql.includes('FROM proposal')) return { rows: [] };
            if (sql.includes('consensus.land_event')) return { rows: [] };
            return { rows: [{ raw: { status: 'failed' }, signature: 'failed' }, { raw: { status: 'success' }, signature: 'unmapped' }] };
        } };
        const decode = raw => ({ signature: raw.status || 'unmapped', status: raw.status || 'success', time: '2026-09-21T13:00:00Z', instructions: [{
            inner: false, program: { name: 'proposal_market' }, action: 'create_market',
            accounts: [{ role: 'proposal', address: 'not-a-public-proposal' }]
        }] });
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode });
        const response = await request(app).get('/activity/recent');
        expect(response.status).toBe(200);
        expect(response.body.events).toEqual([]);
        expect(calls.find(call => call.sql.includes('created_at')).params).toEqual([12]);
        expect(calls.find(call => call.sql.includes('consensus.solana_transaction')).params).toEqual([48]);
    });

    it('includes ordinary creation and verified execution events in the scoped activity explorer', async () => {
        const proposalAccount = '11111111111111111111111111111111';
        const pool = { query: async (sql) => {
            if (sql.includes('consensus.agent_run')) return { rows: [] };
            if (sql.includes('agent_payment_id IS NOT NULL')) return { rows: [] };
            if (sql.includes('proposal_account')) return { rows: [{
                proposal_id: 'p1', proposal_account: proposalAccount, city: 'zagreb', display_name: 'Pocket park'
            }] };
            if (sql.includes('consensus.land_event')) return { rows: [{
                event_id: 'verified-execution', subject_id: proposalAccount, outcome: 'executed',
                source_observed_at: '2026-09-21T12:00:00Z', transaction_signature: 'execute-tx'
            }] };
            if (sql.includes('FROM proposal')) return { rows: [{
                proposal_id: 'p1', city: 'zagreb', display_name: 'Pocket park', created_at: '2026-09-21T10:00:00Z'
            }] };
            return { rows: [] };
        } };
        const app = express();
        setupAgentActivityRoute(app, pool, { book: {}, idls: {}, decode: () => null });

        const response = await request(app).get('/agent/activity?proposal=p1');

        expect(response.status).toBe(200);
        expect(response.body.events.map(event => event.action.type)).toEqual(['create', 'execute']);
        expect(response.body.events.every(event => event.entity.id === 'p1')).toBe(true);
    });

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

    it('fills a run persona wallet from the address book, including its own recorded activities', () => {
        const book = { entries: [{ kind: 'wallet', persona: 'densifier-01', address: 'persona-wallet' }] };
        const events = runEvents({
            ...row,
            summary: {
                controller: 'algorithm',
                activities: [
                    { action: { type: 'create' }, actor: { id: 'densifier-01', name: 'densifier-01', controller: 'algorithm' } },
                    { action: { type: 'accept' }, actor: { id: 'other-persona', name: 'other-persona', controller: 'algorithm' } }
                ]
            }
        }, book);
        expect(events[0].actor.wallet).toBe('persona-wallet');
        expect(events[1].actor).not.toHaveProperty('wallet');
        expect(runDetail(row, [], book).wallet).toBe('persona-wallet');
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

    it('filters by actor, action, proposal and run over a wider bounded window', async () => {
        const calls = [];
        const pool = {
            query: async (sql, params) => {
                calls.push({ sql, params });
                return { rows: sql.includes('consensus.agent_run') ? [row] : [] };
            }
        };
        const app = express();
        setupAgentActivityRoute(app, pool);
        const all = (await request(app).get('/agent/activity')).body.events;
        const stakes = await request(app).get('/agent/activity?action=stake&proposal=agent-p1&run=2026-09-20-densifier-01');
        expect(stakes.status).toBe(200);
        expect(stakes.body.events.length).toBeGreaterThan(0);
        expect(stakes.body.events.length).toBeLessThan(all.length);
        expect(stakes.body.events.every(event => event.action.type === 'stake')).toBe(true);
        expect(stakes.body).toMatchObject({ filters: { action: 'stake', proposal: 'agent-p1' }, scanWindow: ACTIVITY_SCAN_WINDOW });
        expect(calls.at(-2).params).toEqual([ACTIVITY_SCAN_WINDOW]);
        expect((await request(app).get('/agent/activity?proposal=other')).body.count).toBe(0);
        expect((await request(app).get('/agent/activity?source=simulation')).body.count).toBe(0);
    });

    it('matches actors by id, wallet or name and ignores empty filters', () => {
        const event = { source: 'live', actor: { id: 'a1', wallet: 'w1', name: 'Mira' }, action: { type: 'pledge', proposalId: 'p1' }, runId: 'r1' };
        for (const actor of ['a1', 'w1', 'Mira']) expect(matchesActivityFilters(event, { actor })).toBe(true);
        expect(matchesActivityFilters(event, { actor: 'x' })).toBe(false);
        expect(matchesActivityFilters(event, { proposal: 'p1' })).toBe(true);
        expect(activityFilters({ actor: '  ', action: ' stake ', unknown: 'x' })).toEqual({ action: 'stake' });
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
