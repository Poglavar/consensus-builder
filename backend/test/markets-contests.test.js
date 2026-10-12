// Contests group a city's proposals by shared land and put each proposal's market beside it;
// these tests pin the grouping, the ordering and the public shape GET /markets serves.
import { describe, expect, it } from 'vitest';
import { buildContests, closesAtOf, contestId, foldVersions, groupByLand, normalizeParcelIds, proposalAccountOf, siteNameOf } from '../markets/contests.js';

const ACCOUNT_A = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const ACCOUNT_B = 'Fh3K8apDKKKjPUPLVV5Y327Hd5s2HY9Y7bqAvjidFcC5';
const ACCOUNT_C = '5A9kzK2SzjP5nU2Dnz958wQcy96KkMnavoMNGxt7p1h3';
// More stand-in accounts; buildContests keys markets by them and never decodes them.
const account = n => `Acct${String(n).padStart(2, '1')}${'z'.repeat(36)}`;

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
        const out = buildContests({ city: 'san_francisco', proposals, markets, now: new Date('2026-10-09T00:00:00Z') });

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

describe('plan versions (F2)', () => {
    const plan = (overrides) => ({ slug: 'p', title: 'Plan', place: 'Borovje', author: 'a', createdAt: '2026-10-10T00:00:00Z',
        memberIds: [], proposalAccount: null, supersedes: null, ...overrides });
    // Three versions of one plan, as the Borovje importer names them: v2 supersedes v1, v3 supersedes v2.
    // v1's market is still open on-chain, v2's settled no, v3 is the current version.
    const V1 = account(1);
    const V2 = account(2);
    const V3 = account(3);
    const RIVAL = account(4);
    const input = () => ({
        city: 'zagreb',
        proposals: [
            proposal({ id: 1, proposalId: 'street', parcelIds: ['P1', 'P2'] }),
            proposal({ id: 2, proposalId: 'slab', parcelIds: ['P2'] }),
            proposal({ id: 3, proposalId: 'slab-v2', parcelIds: ['P2'] }),
            proposal({ id: 4, proposalId: 'rival', parcelIds: ['P1'], proposalAccount: RIVAL })
        ],
        plans: [
            plan({ slug: 'upu-borovje-v3', title: 'UPU Borovje', createdAt: '2026-10-10T19:02:23Z', memberIds: ['1', '3'], proposalAccount: V3, supersedes: 'upu-borovje-v2' }),
            plan({ slug: 'upu-borovje-v2', title: 'UPU Borovje', createdAt: '2026-10-10T18:17:15Z', memberIds: ['1', '3'], proposalAccount: V2, supersedes: 'upu-borovje' }),
            plan({ slug: 'upu-borovje', title: 'UPU Borovje', createdAt: '2026-10-10T14:08:54Z', memberIds: ['1', '2'], proposalAccount: V1 })
        ],
        markets: new Map([
            [V1, market('MKT-1', 300000n, 100000n)],
            [V2, market('MKT-2', 50000n, 150000n, true, 0)],
            [V3, market('MKT-3', 100000n, 0n)],
            [RIVAL, market('MKT-R', 10000n, 10000n)]
        ]),
        statuses: new Map([[V1, 'Active'], [V2, 'Cancelled'], [V3, 'Active'], [RIVAL, 'Active']])
    });

    it('lists one row per plan and folds the versions it replaced under it, newest first', () => {
        const out = buildContests(input());
        expect(out.contests).toHaveLength(1);
        const [contest] = out.contests;
        expect(contest.proposals.map(entry => [entry.kind, entry.proposalId])).toEqual([['plan', 'upu-borovje-v3'], ['proposal', 'rival']]);
        const current = contest.proposals[0];
        expect(current).toMatchObject({ planSlug: 'upu-borovje-v3', supersedes: 'upu-borovje-v2', bettable: true });
        expect(current.olderVersions.map(old => [old.slug, old.supersededBy])).toEqual([
            ['upu-borovje-v2', 'upu-borovje-v3'],
            ['upu-borovje', 'upu-borovje-v2']
        ]);
        // A piece only the first version used folds away with it instead of resurfacing as a row.
        expect(contest.proposals.some(entry => entry.proposalId === 'slab')).toBe(false);
    });

    it('keeps an older version reachable for its pool but never offers it', () => {
        const [{ proposals: [current] }] = buildContests(input()).contests;
        const [v2, v1] = current.olderVersions;
        // Still open on-chain: reachable, its state says so, but it is not a bet the API offers.
        expect(v1).toMatchObject({ slug: 'upu-borovje', title: 'UPU Borovje', createdAt: '2026-10-10T14:08:54Z', proposalAccount: V1,
            state: 'open', bettable: false, canOpenMarket: false, market: { address: 'MKT-1', poolAtomic: '400000', resolved: false } });
        // Settled: positions in it can be collected.
        expect(v2).toMatchObject({ slug: 'upu-borovje-v2', proposalAccount: V2, state: 'resolved-no', bettable: false, canOpenMarket: false,
            market: { resolved: true, outcome: 'no' } });
        // The current version's members travel once, with the current version.
        expect(v1.members).toBeUndefined();
        expect(v1.memberCount).toBe(2);
    });

    it('counts current versions only, and the folded versions with the folded members', () => {
        const out = buildContests(input());
        expect(out.contests[0]).toMatchObject({
            proposalCount: 2, planCount: 1, foldedCount: 3 + 2, mintedCount: 2, marketCount: 2, openMarketCount: 2,
            // v3 (0.1) and the rival (0.02); the older versions' pools are theirs, reached through the fold.
            poolAtomic: '120000'
        });
        expect(out.summary).toEqual({ contests: 1, proposals: 2, markets: 2, openMarkets: 2, poolAtomic: '120000' });
    });

    it('keeps a contest listed for an older version\'s pool when no current version is minted', () => {
        const base = input();
        const plans = base.plans.map(item => (item.slug === 'upu-borovje-v3' ? { ...item, proposalAccount: null } : item));
        const proposals = base.proposals.filter(item => item.id !== 4);
        const { contests } = buildContests({ ...base, plans, proposals });
        expect(contests).toHaveLength(1);
        expect(contests[0].mintedCount).toBe(0);
        expect(contests[0].proposals[0].olderVersions.map(old => old.proposalAccount)).toEqual([V2, V1]);
    });
});

describe('foldVersions', () => {
    const slugs = ({ current, older }) => ({
        current: current.map(plan => plan.slug),
        older: Object.fromEntries(current.map(plan => [plan.slug, older.get(plan.slug).map(({ plan: old, supersededBy }) => `${old.slug}<${supersededBy}`)]))
    });

    it('walks a chain from its newest version', () => {
        expect(slugs(foldVersions([{ slug: 'a' }, { slug: 'a-v2', supersedes: 'a' }, { slug: 'a-v3', supersedes: 'a-v2' }, { slug: 'b' }])))
            .toEqual({ current: ['a-v3', 'b'], older: { 'a-v3': ['a-v2<a-v3', 'a<a-v2'], b: [] } });
    });

    it('lets a version whose predecessor is on other land stand', () => {
        expect(slugs(foldVersions([{ slug: 'a-v2', supersedes: 'a' }]))).toEqual({ current: ['a-v2'], older: { 'a-v2': [] } });
    });

    it('folds a version two revisions replaced under one of them only', () => {
        const out = slugs(foldVersions([{ slug: 'a' }, { slug: 'x', supersedes: 'a' }, { slug: 'y', supersedes: 'a' }]));
        expect(out.current).toEqual(['x', 'y']);
        expect([...out.older.x, ...out.older.y]).toEqual(['a<x']);
    });

    it('drops nothing when versions supersede each other in a loop', () => {
        const out = slugs(foldVersions([{ slug: 'a', supersedes: 'b' }, { slug: 'b', supersedes: 'a' }]));
        expect(out).toEqual({ current: ['a'], older: { a: ['b<a'] } });
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

    it('breaks ties with the whole plan before its pieces, then the newest', () => {
        const { contests } = buildContests({
            city: 'zagreb',
            proposals: [
                proposal({ id: 1, proposalId: 'older-piece', parcelIds: ['T1'], proposalAccount: ACCOUNT_A, createdAt: '2026-10-01T00:00:00Z' }),
                proposal({ id: 2, proposalId: 'newer-piece', parcelIds: ['T1'], proposalAccount: ACCOUNT_B, createdAt: '2026-10-05T00:00:00Z' }),
                proposal({ id: 3, proposalId: 'member', parcelIds: ['T1'] })
            ],
            plans: [{ slug: 'whole', title: 'Whole', place: null, author: 'a', createdAt: '2026-09-01T00:00:00Z', memberIds: ['3'], proposalAccount: ACCOUNT_C }],
            markets: new Map([[ACCOUNT_A, market('MA', 0n, 0n)], [ACCOUNT_B, market('MB', 0n, 0n)], [ACCOUNT_C, market('MC', 0n, 0n)]]),
            statuses: new Map([[ACCOUNT_A, 'Active'], [ACCOUNT_B, 'Active'], [ACCOUNT_C, 'Active']])
        });
        expect(contests[0].proposals.map(entry => entry.proposalId)).toEqual(['whole', 'newer-piece', 'older-piece']);
    });
});
