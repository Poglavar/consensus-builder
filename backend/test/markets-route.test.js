// API contract for GET /markets: the city filter, the shape, the per-city cache and BigInt-safe
// output. No test reaches a database or devnet: rows and market accounts are injected.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { rowToProposal, setupMarketsRoute } from '../routes/markets.js';

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';

function rows() {
    return [{
        id: 789, proposal_id: 'agent-densifier-01-2026-10-01-1', city: 'zagreb', title: 'Plan-led infill',
        goal: 'single', lifecycle_status: 'Active', created_at: new Date('2026-10-01T10:00:00Z'), expires_at: null,
        cadastre_parcel_ids: ['HR-335614-2311'], onchain_data: { chainId: 'solana-devnet', proposalId: ACCOUNT },
        author: 'densifier-01', agent: true, proposal_role: null, screenshot_url: null, site_name: 'Rudeš'
    }, {
        id: 790, proposal_id: 'local-rival', city: 'zagreb', title: 'Rival', goal: 'park', lifecycle_status: 'Active',
        created_at: new Date('2026-10-02T10:00:00Z'), expires_at: new Date('2026-12-31T00:00:00Z'),
        cadastre_parcel_ids: ['HR-335614-2311'], onchain_data: null, author: 'someone', agent: false,
        proposal_role: null, screenshot_url: null
    }];
}

function appFor({ pool, readMarkets, readProposalStatuses, now } = {}) {
    const app = express();
    setupMarketsRoute(app, pool || { query: vi.fn(async () => ({ rows: rows() })) }, {
        env: {}, readMarkets: readMarkets || (async () => new Map([[ACCOUNT, { address: 'MKT', market: { yesPool: 250000n, noPool: 0n, resolved: false, outcome: 0 } }]])),
        readProposalStatuses: readProposalStatuses || (async () => new Map([[ACCOUNT, 'Active']])),
        now: now || (() => new Date('2026-10-09T07:00:00Z'))
    });
    return app;
}

describe('GET /markets', () => {
    it('requires a city', async () => {
        const res = await request(appFor()).get('/markets');
        expect(res.status).toBe(400);
    });

    it('serves the city contests with each minted proposal market', async () => {
        const pool = { query: vi.fn(async () => ({ rows: rows() })) };
        const readMarkets = vi.fn(async (accounts) => {
            expect(accounts).toEqual([ACCOUNT]);
            return new Map([[ACCOUNT, { address: 'MKT', market: { yesPool: 250000n, noPool: 0n, resolved: false, outcome: 0 } }]]);
        });
        const res = await request(appFor({ pool, readMarkets })).get('/markets?city=zg');
        expect(res.status).toBe(200);
        expect(pool.query.mock.calls[0][1]).toEqual(['zagreb', 2000]);
        expect(res.body).toMatchObject({
            city: 'zagreb', cluster: 'devnet', stakeDecimals: 6,
            marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB',
            summary: { contests: 1, proposals: 2, markets: 1, openMarkets: 1, poolAtomic: '250000' }
        });
        const [contest] = res.body.contests;
        expect(contest.siteName).toBe('Rudeš');
        expect(contest.proposals.map(p => p.proposalId)).toEqual(['agent-densifier-01-2026-10-01-1', 'local-rival']);
        expect(contest.proposals[0]).toMatchObject({ id: 789, proposalAccount: ACCOUNT, agent: true, bettable: true, chainStatus: 'Active', market: { address: 'MKT', yesPool: '250000', noPool: '0' } });
        expect(contest.proposals[1]).toMatchObject({ id: 790, proposalAccount: null, market: null, expiresAt: '2026-12-31T00:00:00.000Z' });
    });

    it('caches a city for a short while and keys the cache per city', async () => {
        const pool = { query: vi.fn(async () => ({ rows: rows() })) };
        let clock = Date.parse('2026-10-09T07:00:00Z');
        const app = appFor({ pool, now: () => new Date(clock) });
        await request(app).get('/markets?city=zagreb');
        await request(app).get('/markets?city=zagreb');
        expect(pool.query).toHaveBeenCalledTimes(1);
        await request(app).get('/markets?city=sibenik');
        expect(pool.query).toHaveBeenCalledTimes(2);
        clock += 60_000;
        await request(app).get('/markets?city=zagreb');
        expect(pool.query).toHaveBeenCalledTimes(3);
        // Right after a confirmed transaction the sheet needs the chain's answer, not the cache's.
        await request(app).get('/markets?city=zagreb&fresh=1');
        expect(pool.query).toHaveBeenCalledTimes(4);
    });

    it('lets the proposal account, not the database word, decide whether a bet is open', async () => {
        const pool = { query: vi.fn(async () => ({ rows: rows().map(row => ({ ...row, lifecycle_status: 'Expired' })) })) };
        const stillActive = await request(appFor({ pool })).get('/markets?city=zagreb');
        expect(stillActive.body.contests[0].proposals[0]).toMatchObject({ lifecycleStatus: 'Expired', chainStatus: 'Active', bettable: true });
        const expiredOnChain = await request(appFor({ readProposalStatuses: async () => new Map([[ACCOUNT, 'Expired']]) })).get('/markets?city=zagreb');
        expect(expiredOnChain.body.contests[0].proposals[0]).toMatchObject({ lifecycleStatus: 'Active', chainStatus: 'Expired', bettable: false, canOpenMarket: false });
    });

    it('answers 502 when the chain read fails instead of serving half a payload', async () => {
        const res = await request(appFor({ readMarkets: async () => { throw new Error('rpc down'); } })).get('/markets?city=zagreb');
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/unavailable/);
    });

    it('maps a database row to the contest input shape', () => {
        expect(rowToProposal(rows()[0])).toMatchObject({
            id: 789, proposalId: 'agent-densifier-01-2026-10-01-1', createdAt: '2026-10-01T10:00:00.000Z',
            parcelIds: ['HR-335614-2311'], proposalAccount: ACCOUNT, agent: true
        });
    });
});
