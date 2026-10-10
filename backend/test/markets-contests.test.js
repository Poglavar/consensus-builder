// Contests group a city's proposals by shared land and put each proposal's market beside it;
// these tests pin the grouping, the ordering and the public shape GET /markets serves.
import { describe, expect, it } from 'vitest';
import { buildContests, contestId, groupByLand, normalizeParcelIds, proposalAccountOf, siteNameOf } from '../markets/contests.js';

const ACCOUNT_A = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const ACCOUNT_B = 'Fh3K8apDKKKjPUPLVV5Y327Hd5s2HY9Y7bqAvjidFcC5';
const ACCOUNT_C = '5A9kzK2SzjP5nU2Dnz958wQcy96KkMnavoMNGxt7p1h3';

const proposal = (overrides) => ({
    id: 1, proposalId: 'p-1', title: 'One', goal: 'single', lifecycleStatus: 'Active',
    createdAt: '2026-10-01T00:00:00Z', expiresAt: null, author: 'a', agent: false, proposalRole: null,
    screenshotUrl: null, parcelIds: ['SF-1'], proposalAccount: null, ...overrides
});
const market = (address, yesPool, noPool, resolved = false, outcome = 0) => ({
    address, market: { yesPool, noPool, resolved, outcome }
});

describe('proposalAccountOf', () => {
    it('accepts only a base58 Solana proposal account on a solana chain', () => {
        expect(proposalAccountOf({ chainId: 'solana-devnet', proposalId: ACCOUNT_A })).toBe(ACCOUNT_A);
        expect(proposalAccountOf({ chainId: 'solana-mainnet', proposalAccount: ACCOUNT_A })).toBe(ACCOUNT_A);
        expect(proposalAccountOf({ chainId: '0x1', proposalId: '12' })).toBeNull();
        expect(proposalAccountOf({ chainId: 'solana-devnet', proposalId: 'not-base58-0OIl' })).toBeNull();
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
});

describe('siteNameOf', () => {
    it('keeps an authored site name and ignores the generated parcel-selection labels', () => {
        expect(siteNameOf([{ siteName: 'Candlestick Point' }, { siteName: 'Candlestick Point' }, { siteName: 'Hunters Point' }])).toBe('Candlestick Point');
        expect(siteNameOf([{ siteName: 'Parcel HR-335614-2355' }, { siteName: 'Parcels 12, 13' }, { siteName: '  ' }, {}])).toBeNull();
    });
});

describe('contestId', () => {
    it('depends on the land, not on which proposals happen to be in the contest', () => {
        expect(contestId(['P2', 'P1'])).toBe(contestId(['P1', 'P2']));
        expect(contestId(['P1'])).not.toBe(contestId(['P2']));
        expect(contestId([], 'p-1')).not.toBe(contestId([], 'p-2'));
        expect(contestId(['P1'])).toMatch(/^c-[0-9a-f]{12}$/);
    });
});

describe('buildContests', () => {
    it('keeps only contests someone can bet on and orders open pools first', () => {
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
        const out = buildContests({ city: 'san_francisco', proposals, markets, now: new Date('2026-10-09T00:00:00Z') });

        expect(out.city).toBe('san_francisco');
        expect(out.generatedAt).toBe('2026-10-09T00:00:00.000Z');
        expect(out.contests.map(c => c.proposals.map(p => p.proposalId))).toEqual([
            ['minted-one-sided', 'rival-unminted'], ['resolved'], ['minted-no-market']
        ]);
        expect(out.summary).toEqual({ contests: 3, proposals: 4, markets: 2, openMarkets: 1, poolAtomic: '320000' });

        const [contest] = out.contests;
        expect(contest).toMatchObject({ parcelIds: ['L1'], siteName: 'Candlestick Point', proposalCount: 2, mintedCount: 1, marketCount: 1, openMarketCount: 1, poolAtomic: '300000', latestCreatedAt: '2026-10-04T00:00:00Z' });
        expect(out.contests[1].siteName).toBeNull();
        expect(contest.proposals[0]).toMatchObject({
            proposalAccount: ACCOUNT_A, bettable: true, canOpenMarket: false,
            market: { address: 'MKT-A', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null }
        });
        expect(contest.proposals[1]).toMatchObject({ proposalAccount: null, market: null, bettable: false, canOpenMarket: false });

        const noMarket = out.contests[2].proposals[0];
        expect(noMarket).toMatchObject({ market: null, bettable: false, canOpenMarket: true });
        const resolved = out.contests[1].proposals[0];
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

describe('named plans in contests', () => {
    const plan = (overrides) => ({ slug: 'p', title: 'Plan', place: null, author: 'a', createdAt: '2026-10-10T00:00:00Z',
        memberIds: [], proposalAccount: null, ...overrides });

    it('folds members under every plan that lists them and keeps other proposals as rows', () => {
        const street = proposal({ id: 1, proposalId: 'street', parcelIds: ['P1', 'P2'] });
        const slab = proposal({ id: 2, proposalId: 'slab', parcelIds: ['P2'] });
        const block = proposal({ id: 3, proposalId: 'block', parcelIds: ['P2'] });
        const rival = proposal({ id: 4, proposalId: 'rival', parcelIds: ['P1'], proposalAccount: ACCOUNT_C });
        const { contests } = buildContests({
            city: 'zagreb',
            proposals: [street, slab, block, rival],
            plans: [
                plan({ slug: 'official', place: 'Borovje', memberIds: ['1', '2'], proposalAccount: ACCOUNT_A }),
                plan({ slug: 'blocks', place: 'Borovje', memberIds: ['1', '3'], proposalAccount: ACCOUNT_B })
            ]
        });
        expect(contests).toHaveLength(1);
        const [contest] = contests;
        expect(contest.siteName).toBe('Borovje');
        expect(contest.planCount).toBe(2);
        expect(contest.foldedCount).toBe(3);
        expect(contest.proposals.map(entry => entry.proposalId).sort()).toEqual(['blocks', 'official', 'rival']);
        const official = contest.proposals.find(entry => entry.proposalId === 'official');
        expect(official.members.map(member => member.proposalId)).toEqual(['street', 'slab']);
        expect(official.canOpenMarket).toBe(true);
    });

    it('lets a plan name the contest over the pieces\' block names', () => {
        expect(siteNameOf([
            { siteName: 'UPU Borovje Z1-5' }, { siteName: 'UPU Borovje Z1-5' },
            { kind: 'plan', siteName: 'Borovje' }
        ])).toBe('Borovje');
    });
});
