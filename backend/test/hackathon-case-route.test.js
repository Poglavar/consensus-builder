import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildHackathonCase, parcelSetIdentity } from '../hackathon/case-model.js';
import { setupHackathonCasesRoute } from '../routes/hackathon-cases.js';
import { createRouteApp } from './helpers/create-route-app.js';

const proposal = {
    id: 42,
    proposalId: 'golden-case',
    city: 'zagreb',
    name: 'Three-parcel courtyard',
    author: 'wallet-owner',
    lifecycleStatus: 'Active',
    createdAt: '2026-09-22T08:00:00Z',
    cadastreParcelIds: ['HR-1-3', 'HR-1-1', 'HR-1-2'],
    onchain: { proposalId: '11111111111111111111111111111111', transactionHash: 'create-tx' },
    agent: { persona: 'planner-01', controller: 'algorithm' }
};

describe('hackathon canonical case', () => {
    it('gives an unordered parcel declaration one deterministic set identity', () => {
        const first = parcelSetIdentity(proposal);
        const replay = parcelSetIdentity({ ...proposal, cadastreParcelIds: [...proposal.cadastreParcelIds].reverse() });
        expect(first).toMatchObject({ parcelCount: 3, parcelIds: ['HR-1-1', 'HR-1-2', 'HR-1-3'] });
        expect(first.setHash).toBe(replay.setHash);
    });

    it('models support, forecast and owner decision as parallel branches without inventing completion', () => {
        const result = buildHackathonCase({
            proposal,
            activity: [{
                id: 'stake-1', actor: { id: 'agent-1', kind: 'agent' }, action: { type: 'stake', side: 'yes' },
                transaction: 'stake-tx'
            }],
            support: {
                state: 'available', donations: null,
                pledges: { book: 'pledge-book', activeUsdc: '0.10', fulfilledUsdc: '0' }
            },
            market: { state: 'available', exists: true, account: 'market', yesUsdc: '0.25', noUsdc: '0', resolved: false },
            oracleEvents: [], generatedAt: '2026-09-22T09:00:00Z'
        });
        expect(result.state).toBe('early');
        expect(result.parcelSet.parcelCount).toBe(3);
        expect(result.stages.map(item => [item.id, item.state])).toEqual([
            ['proposal', 'complete'], ['support', 'partial'], ['forecast', 'partial'], ['decision', 'pending'],
            ['evidence', 'pending'], ['resolution', 'pending'], ['settlement', 'blocked']
        ]);
        expect(result.relationships).toEqual(expect.arrayContaining([
            { from: 'proposal', to: 'support', kind: 'can_progress_in_parallel' },
            { from: 'proposal', to: 'forecast', kind: 'can_progress_in_parallel' }
        ]));
    });

    it('serves a data-derived aggregate and keeps failed optional readers explicit', async () => {
        const app = createRouteApp((expressApp) => setupHackathonCasesRoute(expressApp, {}, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', PUBLIC_SITE_BASE_URL: 'https://site.example.test' },
            proposalReader: async (_pool, id) => id === proposal.proposalId ? proposal : null,
            activityReader: async () => [{
                id: 'create', actor: { id: 'planner-01', kind: 'agent', controller: 'algorithm' },
                action: { type: 'create' }, entity: { type: 'proposal', id: proposal.proposalId }, transaction: 'create-tx'
            }],
            oracleReader: async () => [],
            supportReader: async () => { throw new Error('rpc support timeout'); },
            marketReader: async () => ({ state: 'available', exists: true, account: 'market', yesUsdc: '0.25', noUsdc: '0.10', resolved: false }),
            connection: {}
        }));
        const response = await request(app).get('/hackathon/cases/golden-case');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: 'golden-case', state: 'in_progress', parcelSet: { parcelCount: 3 },
            proposal: { account: '11111111111111111111111111111111' },
            links: {
                self: 'https://api.example.test/hackathon/cases/golden-case',
                map: 'https://site.example.test/proposals/golden-case'
            }
        });
        expect(response.body.stages.find(item => item.id === 'support')).toMatchObject({ state: 'unavailable', detail: 'rpc support timeout' });
        expect(response.body.stages.find(item => item.id === 'forecast')).toMatchObject({ state: 'complete' });
    });

    it('keeps historical donation and pledge proof complete after refund and void', () => {
        const result = buildHackathonCase({
            proposal: { ...proposal, lifecycleStatus: 'Cancelled' },
            activity: [
                { actor: { id: 'supporter' }, action: { type: 'pledge', amount: '0.10' }, transaction: 'pledge' },
                { actor: { id: 'supporter' }, action: { type: 'voidPledge' }, transaction: 'void' },
                { actor: { id: 'supporter' }, action: { type: 'claim' }, transaction: 'claim' }
            ],
            support: {
                state: 'available',
                donations: { totalUsdc: '0.05', donationCount: '1', refundedUsdc: '0.05' },
                pledges: { activeUsdc: '0', fulfilledUsdc: '0', revokedUsdc: '0', pledgeCount: '1' }
            },
            market: { state: 'available', exists: true, account: 'market', yesUsdc: '0.01', noUsdc: '0.01', resolved: true, outcome: 'NO' },
            oracleEvents: [{ eventType: 'proposal_lifecycle', outcome: 'cancelled', source: { transaction: 'cancel' } }]
        });
        expect(result.stages.find(item => item.id === 'support')).toMatchObject({
            state: 'complete', detail: expect.stringContaining('later voided')
        });
        expect(result.progress).toEqual({ complete: 7, total: 7 });
        expect(result.state).toBe('complete');
    });

    it('returns 404 when the requested proposal does not exist', async () => {
        const app = createRouteApp((expressApp) => setupHackathonCasesRoute(expressApp, {}, {
            proposalReader: async () => null
        }));
        const response = await request(app).get('/hackathon/cases/missing');
        expect(response.status).toBe(404);
    });
});
