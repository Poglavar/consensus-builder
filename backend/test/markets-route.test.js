// API contract for GET /markets: the city filter, the shape, the per-city cache and BigInt-safe
// output. No test reaches a database or devnet: rows and market accounts are injected.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { PROPOSAL_COLUMNS_SQL, rowToProposal, setupMarketsRoute } from '../routes/markets.js';

import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';

function rows() {
    return [{
        id: 789, proposal_id: 'agent-densifier-01-2026-10-01-1', city: 'zagreb', title: 'Plan-led infill',
        goal: 'single', lifecycle_status: 'Active', created_at: new Date('2026-10-01T10:00:00Z'), expires_at: null,
        cadastre_parcel_ids: ['HR-335614-2311'], onchain_data: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: ACCOUNT },
        author: 'densifier-01', agent: true, proposal_role: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null, site_name: 'Rudeš',
        binding: { parcelSource: { sourceId: 'hr-cadastre', snapshotId: null }, source: 'server:untrusted-label' }
    }, {
        id: 790, proposal_id: 'local-rival', city: 'zagreb', title: 'Rival', goal: 'park', lifecycle_status: 'Active',
        created_at: new Date('2026-10-02T10:00:00Z'), expires_at: new Date('2026-12-31T00:00:00Z'),
        cadastre_parcel_ids: ['HR-335614-2311'], onchain_data: null, author: 'someone', agent: false,
        proposal_role: null, screenshot_url: null,
        binding: { parcelSource: { sourceId: 'hr-cadastre', snapshotId: null } }
    }];
}

// A pool that answers the proposals query with `proposalRows`.
function poolFor(proposalRows = rows()) {
    return { query: vi.fn(async () => ({ rows: proposalRows })) };
}
const proposalQueries = pool => pool.query.mock.calls.length;

function appFor({ pool, readMarkets, readProposalStatuses, now } = {}) {
    const app = express();
    setupMarketsRoute(app, pool || poolFor(), {
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
        const pool = poolFor();
        let clock = Date.parse('2026-10-09T07:00:00Z');
        const app = appFor({ pool, now: () => new Date(clock) });
        await request(app).get('/markets?city=zagreb');
        await request(app).get('/markets?city=zagreb');
        expect(proposalQueries(pool)).toBe(1);
        await request(app).get('/markets?city=sibenik');
        expect(proposalQueries(pool)).toBe(2);
        clock += 60_000;
        await request(app).get('/markets?city=zagreb');
        expect(proposalQueries(pool)).toBe(3);
        // Right after a confirmed transaction the sheet needs the chain's answer, not the cache's.
        await request(app).get('/markets?city=zagreb&fresh=1');
        expect(proposalQueries(pool)).toBe(4);
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
            parcelIds: ['HR-335614-2311'], proposalAccount: ACCOUNT, agent: true, goal: 'single'
        });
        expect(rowToProposal(rows()[0]).parcelSource).toEqual({ sourceId: 'hr-cadastre', snapshotId: null });
        expect(PROPOSAL_COLUMNS_SQL).toMatch(/COALESCE\(binding, proposal_data->'binding'\) AS binding/);
    });

    it('does not infer parcel source from a display label or accept an unknown descriptor', () => {
        const [source] = rows();
        expect(rowToProposal({ ...source, binding: { source: 'server:hr-cadastre' } }).parcelSource).toBeNull();
        expect(rowToProposal({ ...source, binding: { parcelSource: { sourceId: 'unknown-provider', snapshotId: null } } }).parcelSource).toBeNull();
    });

    it('uses only a recognized authored goal, never the broad proposal type', () => {
        expect(PROPOSAL_COLUMNS_SQL).toMatch(/proposal_data->>'goal' AS goal/);
        expect(PROPOSAL_COLUMNS_SQL).not.toMatch(/COALESCE\(proposal_data->>'goal', type\)/);
        expect(rowToProposal({ ...rows()[0], goal: 'invented-goal' }).goal).toBeNull();
        expect(rowToProposal({ ...rows()[0], goal: null }).goal).toBeNull();
    });

    it('does not query devnet for an account declared on another network or program', async () => {
        const readMarkets = vi.fn(async () => new Map());
        const readProposalStatuses = vi.fn(async () => new Map());
        const [source] = rows();
        for (const location of [
            { ...source.onchain_data, chainId: 'solana-mainnet' },
            { ...source.onchain_data, contractAddress: 'another-program' }
        ]) {
            const res = await request(appFor({ pool: poolFor([{ ...source, onchain_data: location }]), readMarkets, readProposalStatuses })).get('/markets?city=test-city');
            expect(res.status).toBe(200);
            expect(res.body.contests).toEqual([]);
        }
        expect(readMarkets).not.toHaveBeenCalled();
        expect(readProposalStatuses).not.toHaveBeenCalled();
    });
});

describe('rowToProposal pictures (dividers.md M3)', () => {
    it('carries the before and pair pictures beside the thumbnail, null when not rendered', () => {
        const [row] = rows();
        expect(rowToProposal(row)).toMatchObject({ screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null });
        expect(rowToProposal({ ...row, screenshot_url: '/uploads/images/t.png', screenshot_before_url: '/uploads/images/b.png', screenshot_pair_url: '/uploads/images/p.png' }))
            .toMatchObject({ screenshotUrl: '/uploads/images/t.png', screenshotBeforeUrl: '/uploads/images/b.png', screenshotPairUrl: '/uploads/images/p.png' });
    });
});
