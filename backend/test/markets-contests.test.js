// Contests group a city's proposals by shared land and put each proposal's market beside it;
// these tests pin the grouping, the ordering and the public shape GET /markets serves.
import { describe, expect, it } from 'vitest';
import { buildContests, closesAtOf, contestId, groupByLand, normalizeParcelIds, proposalAccountOf, siteNameOf } from '../markets/contests.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';

const ACCOUNT_A = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const ACCOUNT_B = 'Fh3K8apDKKKjPUPLVV5Y327Hd5s2HY9Y7bqAvjidFcC5';
const ACCOUNT_C = '5A9kzK2SzjP5nU2Dnz958wQcy96KkMnavoMNGxt7p1h3';
// More stand-in accounts; buildContests keys markets by them and never decodes them.
const account = n => `Acct${String(n).padStart(2, '1')}${'z'.repeat(36)}`;

const proposal = (overrides) => ({
    id: 1, proposalId: 'p-1', title: 'One', goal: 'single', lifecycleStatus: 'Active',
    createdAt: '2026-10-01T00:00:00Z', expiresAt: null, author: 'a', agent: false, proposalRole: null,
    screenshotUrl: null, parcelIds: ['SF-1'], parcelSource: { sourceId: 'hr-cadastre', snapshotId: null }, proposalAccount: null, ...overrides
});
const market = (address, yesPool, noPool, resolved = false, outcome = 0) => ({
    address, market: { yesPool, noPool, resolved, outcome }
});

describe('proposalAccountOf', () => {
    it('requires the exact devnet program and canonical account field', () => {
        const location = { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: ACCOUNT_A };
        expect(proposalAccountOf(location)).toBe(ACCOUNT_A);
        for (const change of [
            { chainId: 'solana-mainnet' }, { chainId: 'solana' }, { chainId: 'solana-devnet-fake' },
            { contractAddress: null }, { contractAddress: ACCOUNT_B },
            { proposalId: undefined, proposalAccount: ACCOUNT_A }, { proposalId: undefined, tokenId: ACCOUNT_A },
            { proposalId: 'not-base58-0OIl' }, { proposalId: 'z'.repeat(44) }, { proposalId: ` ${ACCOUNT_A}` }
        ]) expect(proposalAccountOf({ ...location, ...change })).toBeNull();
        expect(proposalAccountOf(null)).toBeNull();
    });
});

describe('groupByLand', () => {
    it('joins proposals transitively through shared parcels and keeps the rest apart', () => {
        const groups = groupByLand([
            proposal({ proposalId: 'a', parcelIds: ['P1', 'P2'] }),
            proposal({ proposalId: 'b', parcelIds: ['P2', 'P3'] }),
            proposal({ proposalId: 'c', parcelIds: ['P3'] }),
            proposal({ proposalId: 'd', parcelIds: ['P9'] }),
            proposal({ proposalId: 'e', parcelIds: [] })
        ]);
        const ids = groups.map(group => group.map(entry => entry.proposalId).sort());
        expect(ids).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
    });

    it('normalizes parcel ids before matching', () => {
        expect(normalizeParcelIds([' P1 ', 'P1', '', null, 'P0'])).toEqual(['P0', 'P1']);
        expect(groupByLand([proposal({ parcelIds: [' P1'] }), proposal({ parcelIds: ['P1 '] })])).toHaveLength(1);
    });

    it('qualifies parcel matches by recognized source and snapshot, leaving unknown sources isolated', () => {
        const rows = [
            proposal({ proposalId: 'hr', parcelIds: ['P1'] }),
            proposal({ proposalId: 'other-source', parcelIds: ['P1'], parcelSource: { sourceId: 'us-ca-sf-datasf-active-parcels', snapshotId: null } }),
            proposal({ proposalId: 'unknown', parcelIds: ['P1'], parcelSource: null }),
            proposal({ proposalId: 'unknown-too', parcelIds: ['P1'], parcelSource: null })
        ];
        expect(groupByLand(rows).map(group => group.map(row => row.proposalId).sort()))
            .toEqual([['hr'], ['other-source'], ['unknown'], ['unknown-too']]);
    });

    it('keeps same-source references together but distinguishes snapshots', () => {
        const rows = [
            proposal({ proposalId: 'captured', parcelIds: ['P1'], parcelSource: { sourceId: 'hr-cadastre', snapshotId: '2025' } }),
            proposal({ proposalId: 'same', parcelIds: ['P1'], parcelSource: { sourceId: 'hr-cadastre', snapshotId: '2025' } }),
            proposal({ proposalId: 'other-snapshot', parcelIds: ['P1'], parcelSource: { sourceId: 'hr-cadastre', snapshotId: '2026' } })
        ];
        expect(groupByLand(rows).map(group => group.map(row => row.proposalId).sort())).toEqual([['captured', 'same'], ['other-snapshot']]);
    });
});

describe('siteNameOf', () => {
    it('keeps an authored site name and ignores the generated parcel-selection labels', () => {
        expect(siteNameOf([{ siteName: 'Candlestick Point' }, { siteName: 'Candlestick Point' }, { siteName: 'Hunters Point' }])).toBe('Candlestick Point');
        expect(siteNameOf([{ siteName: 'Parcel HR-335614-2355' }, { siteName: 'Parcels 12, 13' }, { siteName: '  ' }, {}])).toBeNull();
    });
});

describe('contestId', () => {
    it('depends on the land, not on which proposals happen to be in the contest', () => {
        const p1 = { sourceId: 'hr-cadastre', snapshotId: null, parcelId: 'P1' };
        const p2 = { sourceId: 'hr-cadastre', snapshotId: null, parcelId: 'P2' };
        expect(contestId([p2, p1])).toBe(contestId([p1, p2]));
        expect(contestId([p1])).not.toBe(contestId([p2]));
        expect(contestId([p1])).not.toBe(contestId([{ ...p1, sourceId: 'dgu-wfs' }]));
        expect(contestId([], 'p-1')).not.toBe(contestId([], 'p-2'));
        expect(contestId(['P1'])).toMatch(/^c-[0-9a-f]{12}$/);
    });
});

describe('buildContests', () => {
    it('requires observed Active chain status to offer either opening a pool or placing a bet', () => {
        for (const lifecycleStatus of [undefined, 'Unknown', 'Active', 'Expired']) {
            for (const existingMarket of [null, market('MKT', 1n, 1n)]) {
                const { contests } = buildContests({
                    city: 'test-city', proposals: [proposal({ proposalAccount: ACCOUNT_A, lifecycleStatus })],
                    markets: new Map(existingMarket ? [[ACCOUNT_A, existingMarket]] : []), statuses: new Map()
                });
                expect(contests[0].proposals[0]).toMatchObject({
                    lifecycleStatus: lifecycleStatus || 'Unknown', chainStatus: null, bettable: false, canOpenMarket: false
                });
            }
        }
    });

    it('keeps only contests someone can bet on, open pools first and settled ones after those still in play', () => {
        const proposals = [
            proposal({ id: 1, proposalId: 'minted-one-sided', parcelIds: ['L1'], proposalAccount: ACCOUNT_A, createdAt: '2026-10-03T00:00:00Z', siteName: 'Candlestick Point' }),
            proposal({ id: 2, proposalId: 'rival-unminted', parcelIds: ['L1'], createdAt: '2026-10-04T00:00:00Z', siteName: 'Candlestick Point' }),
            proposal({ id: 3, proposalId: 'minted-no-market', parcelIds: ['L2'], proposalAccount: ACCOUNT_B }),
            proposal({ id: 4, proposalId: 'resolved', parcelIds: ['L3'], proposalAccount: ACCOUNT_C, lifecycleStatus: 'Executed' }),
            proposal({ id: 5, proposalId: 'nobody-minted', parcelIds: ['L4'] })
        ];
        const markets = new Map([
            [ACCOUNT_A, market('MKT-A', 250000n, 50000n)],
            [ACCOUNT_B, { address: 'MKT-B', market: null }],
            [ACCOUNT_C, market('MKT-C', 10000n, 10000n, true, 1)]
        ]);
        const out = buildContests({ city: 'san_francisco', proposals, markets,
            statuses: new Map([[ACCOUNT_A, 'Active'], [ACCOUNT_B, 'Active'], [ACCOUNT_C, 'Executed']]),
            now: new Date('2026-10-09T00:00:00Z') });

        expect(out.city).toBe('san_francisco');
        expect(out.generatedAt).toBe('2026-10-09T00:00:00.000Z');
        // A pool anyone can still open is in play; a settled pool, however big, comes after it (D6).
        expect(out.contests.map(c => c.proposals.map(p => p.proposalId))).toEqual([
            ['minted-one-sided', 'rival-unminted'], ['minted-no-market'], ['resolved']
        ]);
        expect(out.summary).toEqual({ contests: 3, proposals: 4, markets: 2, openMarkets: 1, poolAtomic: '320000' });

        const [contest] = out.contests;
        expect(contest).toMatchObject({ parcelIds: ['L1'], siteName: 'Candlestick Point', proposalCount: 2, mintedCount: 1, marketCount: 1, openMarketCount: 1, poolAtomic: '300000', latestCreatedAt: '2026-10-04T00:00:00Z' });
        expect(out.contests[1].siteName).toBeNull();
        expect(contest.proposals[0]).toMatchObject({
            proposalAccount: ACCOUNT_A, bettable: true, canOpenMarket: false, closesAt: null,
            market: { address: 'MKT-A', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null }
        });
        expect(contest.proposals[1]).toMatchObject({ proposalAccount: null, market: null, bettable: false, canOpenMarket: false, closesAt: null });

        const noMarket = out.contests[1].proposals[0];
        expect(noMarket).toMatchObject({ market: null, bettable: false, canOpenMarket: true });
        const resolved = out.contests[2].proposals[0];
        expect(resolved).toMatchObject({ bettable: false, canOpenMarket: false, market: { resolved: true, outcome: 'yes' } });
    });

    it('serializes pools as decimal strings so the JSON never loses a u64', () => {
        const big = (1n << 63n) + 7n;
        const out = buildContests({
            city: 'zagreb', markets: new Map([[ACCOUNT_A, market('MKT', big, 1n)]]),
            proposals: [proposal({ proposalAccount: ACCOUNT_A })]
        });
        expect(out.contests[0].proposals[0].market.yesPool).toBe(big.toString());
        expect(out.contests[0].poolAtomic).toBe((big + 1n).toString());
        expect(() => JSON.stringify(out)).not.toThrow();
    });
});

describe('closesAtOf', () => {
    it('reads the market deadline from i64 Unix seconds, and nothing from a legacy pool', () => {
        expect(closesAtOf({ closesAt: 1795000000n })).toBe(new Date(1795000000 * 1000).toISOString());
        expect(closesAtOf({ closesAt: 1795000000 })).toBe(new Date(1795000000 * 1000).toISOString());
        expect(closesAtOf({ closesAt: '2026-12-31T00:00:00Z' })).toBe('2026-12-31T00:00:00.000Z');
        expect(closesAtOf({ yesPool: 1n, noPool: 0n })).toBeNull();
        expect(closesAtOf({ closesAt: 0n })).toBeNull();
        expect(closesAtOf({ closesAt: 1n << 62n })).toBeNull();
        expect(closesAtOf(null)).toBeNull();
    });
});

describe('row order inside a contest (D6)', () => {
    const SOON = 1795000000n;
    const LATE = 1798000000n;
    const dated = (address, yesPool, noPool, closesAt) => ({ address, market: { yesPool, noPool, resolved: false, outcome: 0, closesAt } });
    const accounts = Array.from({ length: 9 }, (_, index) => account(10 + index));
    const contestInput = () => ({
        city: 'zagreb',
        proposals: [
            // Four settled bot bets with the biggest pools on the land.
            proposal({ id: 1, proposalId: 'settled-big', parcelIds: ['R1'], proposalAccount: accounts[0], createdAt: '2026-10-01T00:00:00Z' }),
            proposal({ id: 2, proposalId: 'settled-bigger', parcelIds: ['R1'], proposalAccount: accounts[1], createdAt: '2026-10-01T00:00:00Z' }),
            proposal({ id: 3, proposalId: 'settled-mid', parcelIds: ['R1'], proposalAccount: accounts[2], createdAt: '2026-10-01T00:00:00Z' }),
            proposal({ id: 4, proposalId: 'settled-small', parcelIds: ['R1'], proposalAccount: accounts[3], createdAt: '2026-10-01T00:00:00Z' }),
            // Rows still in play, with small pools or none.
            proposal({ id: 5, proposalId: 'open-small', parcelIds: ['R1'], proposalAccount: accounts[4], createdAt: '2026-10-02T00:00:00Z' }),
            proposal({ id: 6, proposalId: 'open-dated-late', parcelIds: ['R1'], proposalAccount: accounts[5], createdAt: '2026-10-02T00:00:00Z' }),
            proposal({ id: 7, proposalId: 'open-dated-soon', parcelIds: ['R1'], proposalAccount: accounts[6], createdAt: '2026-10-02T00:00:00Z' }),
            proposal({ id: 8, proposalId: 'needs-market', parcelIds: ['R1'], proposalAccount: accounts[7], createdAt: '2026-10-02T00:00:00Z' }),
            proposal({ id: 9, proposalId: 'settling', parcelIds: ['R1'], proposalAccount: accounts[8], createdAt: '2026-10-02T00:00:00Z' }),
            proposal({ id: 10, proposalId: 'not-minted', parcelIds: ['R1'], createdAt: '2026-10-03T00:00:00Z' })
        ],
        markets: new Map([
            [accounts[0], market('M0', 0n, 5_000_000n, true, 0)],
            [accounts[1], market('M1', 9_000_000n, 0n, true, 1)],
            [accounts[2], market('M2', 1_000_000n, 1_000_000n, true, 0)],
            [accounts[3], market('M3', 0n, 500_000n, true, 0)],
            [accounts[4], market('M4', 10_000n, 0n)],
            [accounts[5], dated('M5', 1n, 0n, LATE)],
            [accounts[6], dated('M6', 0n, 0n, SOON)],
            [accounts[7], { address: 'M7', market: null }],
            [accounts[8], market('M8', 25_000n, 25_000n)]
        ]),
        statuses: new Map(accounts.map((item, index) => [item, index === 8 ? 'Cancelled' : 'Active']))
    });

    it('puts rows in play first, dated ones by deadline, and settled pools after them however big', () => {
        const [contest] = buildContests(contestInput()).contests;
        expect(contest.proposals.map(entry => entry.proposalId)).toEqual([
            'open-dated-soon', 'open-dated-late',          // in play, dated: soonest deadline first
            'settling', 'open-small', 'needs-market',      // in play, no deadline (legacy): bigger pool first
            'settled-bigger', 'settled-big', 'settled-mid', 'settled-small', // settled: bigger pool first
            'not-minted'                                   // nothing to do
        ]);
        expect(contest.proposals[0]).toMatchObject({ bettable: true, closesAt: new Date(Number(SOON) * 1000).toISOString() });
        expect(contest.proposals.find(entry => entry.proposalId === 'open-small').closesAt).toBeNull();
    });

    it('never lets a contest of settled pools lead one where a bet can go in', () => {
        const { contests } = buildContests({
            city: 'zagreb',
            proposals: [
                proposal({ id: 1, proposalId: 'settled-huge', parcelIds: ['X1'], proposalAccount: ACCOUNT_A }),
                proposal({ id: 2, proposalId: 'open-tiny', parcelIds: ['Y1'], proposalAccount: ACCOUNT_B })
            ],
            markets: new Map([[ACCOUNT_A, market('MA', 90_000_000n, 1n, true, 1)], [ACCOUNT_B, market('MB', 1n, 0n)]]),
            statuses: new Map([[ACCOUNT_A, 'Executed'], [ACCOUNT_B, 'Active']])
        });
        expect(contests.map(contest => contest.proposals[0].proposalId)).toEqual(['open-tiny', 'settled-huge']);
    });
});
