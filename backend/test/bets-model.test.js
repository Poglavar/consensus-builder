// The Bets sheet's numbers: chance from pool share, the payout multiple of a reference bet, and the
// state word per proposal. All exact integer math on atomic USDC.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildContests } from '../markets/contests.js';

const require = createRequire(import.meta.url);
const BetsModel = require('../../frontend/js/bets/bets-model.js');

describe('BetsModel.chance', () => {
    it('is the pool share, one decimal, and null before the first bet', () => {
        expect(BetsModel.chance('250000', '50000')).toEqual({ yes: 83.3, no: 16.7 });
        expect(BetsModel.chance('0', '0')).toEqual({ yes: null, no: null });
        expect(BetsModel.chance('1', '0')).toEqual({ yes: 100, no: 0 });
    });
});

describe('BetsModel.payoutMultiple', () => {
    it('quotes what a 1 USDC bet pays with itself in the pool, floored to cents', () => {
        // 0.25 YES, 0 NO: a 1 USDC YES bet shares 1.25 with the 0.25 already there → 1.0×.
        expect(BetsModel.payoutMultiple('yes', '250000', '0')).toBe(1);
        // The same market from the NO side: 1 USDC NO takes the whole 1.25 → 1.25×.
        expect(BetsModel.payoutMultiple('no', '250000', '0')).toBe(1.25);
        // Thirds: 1 USDC YES into 1 YES / 2 NO pays (1+2+1)/(1+1) = 2×.
        expect(BetsModel.payoutMultiple('yes', '1000000', '2000000')).toBe(2);
        expect(BetsModel.payoutMultiple('yes', '0', '0')).toBe(1);
        expect(BetsModel.payoutMultiple('yes', '1', '1', 0n)).toBeNull();
    });

    it('never rounds up (the program floors the payout)', () => {
        // (1 + 0.1 + 1) / (1 + 1) = 1.05 exactly; (1 + 0.333333 + 1)/2 = 1.1666… → 1.16
        expect(BetsModel.payoutMultiple('yes', '1000000', '100000')).toBe(1.05);
        expect(BetsModel.payoutMultiple('yes', '1000000', '333333')).toBe(1.16);
    });
});

describe('BetsModel.rowState', () => {
    const base = { proposalAccount: 'acct', lifecycleStatus: 'Active', bettable: false, canOpenMarket: false, market: null };
    it('names each situation a bettor can meet', () => {
        expect(BetsModel.rowState({ ...base, bettable: true, market: { resolved: false } })).toBe('open');
        expect(BetsModel.rowState({ ...base, canOpenMarket: true })).toBe('needs-market');
        expect(BetsModel.rowState({ ...base, proposalAccount: null })).toBe('not-minted');
        expect(BetsModel.rowState({ ...base, market: { resolved: true, outcome: 'yes' } })).toBe('resolved-yes');
        expect(BetsModel.rowState({ ...base, market: { resolved: true, outcome: 'no' } })).toBe('resolved-no');
        expect(BetsModel.rowState({ ...base, chainStatus: 'Cancelled', market: { resolved: false } })).toBe('settling');
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Executed' })).toBe('closed');
        // The chain's word wins over the database's expiry-aware one.
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Expired', chainStatus: 'Active', market: { resolved: false } })).toBe('closed');
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Active', chainStatus: 'Expired', market: { resolved: false } })).toBe('settling');
    });

    it('never offers settlement from an app deadline or unknown chain status', () => {
        for (const lifecycleStatus of [undefined, 'Unknown', 'Active', 'Expired', 'Executed']) {
            for (const chainStatus of [undefined, null, 'Unknown', 'unsupported']) {
                expect(BetsModel.rowState({ ...base, lifecycleStatus, chainStatus, market: { resolved: false } })).toBe('closed');
            }
        }
        expect(BetsModel.row({ proposalAccount: 'acct' }).lifecycleStatus).toBe('Unknown');
    });
});

describe('BetsModel.contest', () => {
    it('shapes a GET /markets contest into sheet rows with text amounts', () => {
        const out = BetsModel.contest({
            id: 'c-1', parcelIds: ['L1', 'L2', 'L3'], poolAtomic: '300000', siteName: 'Candlestick Point',
            proposals: [
                { id: 1, proposalId: 'a', title: 'A', proposalAccount: 'acct', lifecycleStatus: 'Active', bettable: true, canOpenMarket: false, expiresAt: '2026-12-31T00:00:00Z',
                    market: { address: 'MKT', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null } },
                { id: 2, proposalId: 'b', title: 'B', proposalAccount: null, lifecycleStatus: 'Active', bettable: false, canOpenMarket: false, market: null }
            ]
        });
        expect(out).toMatchObject({ id: 'c-1', siteName: 'Candlestick Point', land: { first: 'L1', more: 2 }, proposalCount: 2, openCount: 1, pool: '0.3' });
        // closesAt is the market's own deadline (none on a legacy pool); the proposal's expiry stays beside it.
        expect(out.rows[0]).toMatchObject({ state: 'open', chanceYes: 83.3, chanceNo: 16.7, pool: '0.3', paysYes: 1.04, paysNo: 1.23, closesAt: null, expiresAt: '2026-12-31T00:00:00Z', marketAddress: 'MKT' });
        expect(out.rows[1]).toMatchObject({ state: 'not-minted', chanceYes: null, pool: null, paysYes: null });
        expect(BetsModel.row({ proposalAccount: 'A', bettable: true, closesAt: '2026-11-18T00:00:00.000Z', market: { yesPool: '1', noPool: '0', poolAtomic: '1' } }).closesAt)
            .toBe('2026-11-18T00:00:00.000Z');
        expect(BetsModel.landLabel([])).toEqual({ first: null, more: 0 });
    });

    it('shows the parcel number people know, and any other uid whole', () => {
        expect(BetsModel.parcelLabel('HR-335614-2311')).toBe('2311');
        expect(BetsModel.parcelLabel('HR-335614-1754/1')).toBe('1754/1');
        expect(BetsModel.parcelLabel('SF-3941-021')).toBe('021');
        expect(BetsModel.parcelLabel('US-CA-SF-4853003')).toBe('4853003');
        expect(BetsModel.parcelLabel('nyc-1234')).toBe('1234');
        expect(BetsModel.parcelLabel('A-B')).toBe('A-B');
        expect(BetsModel.parcelLabel(null)).toBe('');
    });
});

describe('BetsModel.toWin', () => {
    it('is the stake plus its share of the other side, floored, with the stake in the pool', () => {
        // 1 USDC NO into 0.25 YES / 0 NO: takes the whole 1.25.
        expect(BetsModel.toWin('no', '250000', '0', 1_000_000n)).toBe(1_250_000n);
        // 0.5 USDC YES into 1 YES / 2 NO: 0.5 × 3.5 / 1.5 = 1.1666… → 1.166666.
        expect(BetsModel.toWin('yes', '1000000', '2000000', '500000')).toBe(1_166_666n);
        expect(BetsModel.toWin('yes', '1000000', '2000000', 0n)).toBe(0n);
    });
});

describe('BetsModel.oneSided', () => {
    it('names the only side with bets, and nothing for an empty or two-sided pool', () => {
        expect(BetsModel.oneSided('250000', '0')).toBe('yes');
        expect(BetsModel.oneSided('0', '50000')).toBe('no');
        expect(BetsModel.oneSided('0', '0')).toBeNull();
        expect(BetsModel.oneSided('1', '1')).toBeNull();
        expect(BetsModel.row({ proposalAccount: 'A', bettable: true, market: { yesPool: '250000', noPool: '0', poolAtomic: '250000' } }).oneSided).toBe('yes');
    });
});

describe('BetsModel.claimSides', () => {
    const settled = outcome => BetsModel.row({ proposalAccount: 'A', market: { yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: true, outcome } });
    it('is the unclaimed winning side only', () => {
        const positions = { yes: { amount: 100000n, claimed: false }, no: { amount: 20000n, claimed: false } };
        expect(BetsModel.claimSides(settled('yes'), positions)).toEqual(['yes']);
        expect(BetsModel.claimSides(settled('no'), positions)).toEqual(['no']);
        expect(BetsModel.claimSides(settled('no'), { no: { amount: 20000n, claimed: true } })).toEqual([]);
    });
    it('is every unclaimed bet when nobody backed the winner (the program refunds)', () => {
        const row = BetsModel.row({ proposalAccount: 'A', market: { yesPool: '250000', noPool: '0', poolAtomic: '250000', resolved: true, outcome: 'no' } });
        expect(BetsModel.claimSides(row, { yes: { amount: 250000n, claimed: false } })).toEqual(['yes']);
    });
    it('is nothing while the pool is open', () => {
        const open = BetsModel.row({ proposalAccount: 'A', bettable: true, market: { yesPool: '250000', noPool: '0', poolAtomic: '250000' } });
        expect(BetsModel.claimSides(open, { yes: { amount: 250000n, claimed: false } })).toEqual([]);
    });
});

describe('BetsModel.splitRows and filterRows', () => {
    const rows = [
        { proposalAccount: 'A', state: 'open' }, { proposalAccount: null, state: 'not-minted' }, { proposalAccount: 'B', state: 'resolved-no' },
        { proposalAccount: 'C', state: 'closed' }, { proposalAccount: 'D', state: 'needs-market' }, { proposalAccount: 'E', state: 'settling' }
    ];
    it('folds unminted and never-pooled rows away', () => {
        const { shown, hidden } = BetsModel.splitRows(rows);
        expect(shown.map(r => r.state)).toEqual(['open', 'resolved-no', 'needs-market', 'settling']);
        expect(hidden.map(r => r.state)).toEqual(['not-minted', 'closed']);
    });
    it('keeps an existing pool visible when its current chain status is unavailable', () => {
        const closed = { proposalAccount: 'A', state: 'closed', pool: '0' };
        expect(BetsModel.splitRows([closed])).toEqual({ shown: [closed], hidden: [] });
    });
    it('filters by open, settled and the wallet\'s own bets', () => {
        expect(BetsModel.filterRows(rows, 'open').map(r => r.proposalAccount)).toEqual(['A', 'D', 'E']);
        expect(BetsModel.filterRows(rows, 'settled').map(r => r.proposalAccount)).toEqual(['B']);
        const positions = { B: { yes: null, no: { amount: 50000n, claimed: false } }, A: { yes: { amount: 0n }, no: null } };
        expect(BetsModel.filterRows(rows, 'mine', positions).map(r => r.proposalAccount)).toEqual(['B']);
        expect(BetsModel.filterRows(rows, 'all')).toHaveLength(6);
    });
});

describe('BetsModel.orderContests', () => {
    // A sheet contest as BetsModel.contest shapes it, from GET /markets entries.
    const shaped = (id, proposals, poolAtomic = '0') => BetsModel.contest({ id, parcelIds: [], poolAtomic, proposals });
    const entry = (proposalId, overrides) => ({ id: proposalId, proposalId, proposalAccount: `acct-${proposalId}`, lifecycleStatus: 'Active', ...overrides });
    const open = (yes, no = '0') => ({ bettable: true, market: { yesPool: yes, noPool: no, poolAtomic: (BigInt(yes) + BigInt(no)).toString(), resolved: false } });
    const settled = (pool, outcome) => ({ market: { yesPool: pool, noPool: '0', poolAtomic: pool, resolved: true, outcome } });

    it('never opens on settled pools: a bet that can go in now leads, however small', () => {
        const contests = [
            shaped('settled-bots', [entry('s1', settled('5000000', 'no')), entry('s2', settled('3000000', 'no'))], '8000000'),
            shaped('open-small', [entry('o1', open('1000'))], '1000'),
            shaped('needs-pool', [entry('n1', { canOpenMarket: true })]),
            shaped('open-dated', [entry('d1', { ...open('1'), closesAt: '2026-11-18T00:00:00.000Z' })], '1')
        ];
        expect(BetsModel.orderContests(contests).map(c => c.id)).toEqual(['open-dated', 'open-small', 'needs-pool', 'settled-bots']);
        expect(contests.map(c => c.id)).toEqual(['settled-bots', 'open-small', 'needs-pool', 'open-dated']);
    });

    it('keeps equal contests in the server\'s order', () => {
        const contests = ['a', 'b', 'c'].map(id => shaped(id, [entry(`${id}1`, { ...open('0'), createdAt: '2026-10-01T00:00:00Z' })]));
        expect(BetsModel.orderContests(contests).map(c => c.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('BetsModel.contest row order (D6)', () => {
    it('puts rows in play first by deadline then pool, settled rows after by pool, whatever order they arrive in', () => {
        const out = BetsModel.contest({ id: 'c', parcelIds: [], proposals: [
            { id: 1, proposalId: 'settled-big', proposalAccount: 'A1', market: { yesPool: '0', noPool: '5000000', poolAtomic: '5000000', resolved: true, outcome: 'no' } },
            { id: 2, proposalId: 'not-minted', proposalAccount: null },
            { id: 3, proposalId: 'open-small', proposalAccount: 'A3', bettable: true, market: { yesPool: '1000', noPool: '0', poolAtomic: '1000', resolved: false } },
            { id: 4, proposalId: 'settled-small', proposalAccount: 'A4', market: { yesPool: '100', noPool: '0', poolAtomic: '100', resolved: true, outcome: 'yes' } },
            { id: 5, proposalId: 'open-dated', proposalAccount: 'A5', bettable: true, closesAt: '2026-11-18T00:00:00.000Z', market: { yesPool: '0', noPool: '0', poolAtomic: '0', resolved: false } },
            { id: 6, proposalId: 'needs-market', proposalAccount: 'A6', canOpenMarket: true }
        ] });
        expect(out.rows.map(item => item.proposalId)).toEqual(['open-dated', 'open-small', 'needs-market', 'settled-big', 'settled-small', 'not-minted']);
    });
});

describe('the sheet and GET /markets agree on the order', () => {
    it('re-sorting the API\'s contests and rows in the sheet changes nothing, from any arrival order', () => {
        const proposal = (id, parcel, account, createdAt) => ({ id, proposalId: `p-${id}`, title: `P${id}`, goal: 'single', lifecycleStatus: 'Active',
            createdAt, expiresAt: null, author: 'a', agent: false, proposalRole: null, screenshotUrl: null,
            parcelIds: [parcel], parcelSource: { sourceId: 'hr-cadastre', snapshotId: null }, proposalAccount: account });
        const market = (yesPool, noPool, resolved = false, outcome = 0, closesAt) => ({ address: 'M', market: { yesPool, noPool, resolved, outcome, closesAt } });
        const payload = buildContests({
            city: 'zagreb',
            proposals: [
                proposal(1, 'A', 'acct-1', '2026-10-01T00:00:00Z'), proposal(2, 'A', 'acct-2', '2026-10-02T00:00:00Z'),
                proposal(3, 'A', 'acct-3', '2026-10-03T00:00:00Z'), proposal(4, 'B', 'acct-4', '2026-10-04T00:00:00Z'),
                proposal(5, 'B', null, '2026-10-05T00:00:00Z'), proposal(6, 'C', 'acct-6', '2026-10-06T00:00:00Z'),
                proposal(7, 'D', 'acct-7', '2026-10-07T00:00:00Z')
            ],
            markets: new Map([
                ['acct-1', market(9_000_000n, 0n, true, 1)], ['acct-2', market(1n, 0n)], ['acct-3', market(0n, 0n, false, 0, 1795000000n)],
                ['acct-4', market(0n, 7_000_000n, true, 0)], ['acct-6', { address: 'M', market: null }], ['acct-7', market(40n, 2n)]
            ]),
            statuses: new Map(['acct-1', 'acct-2', 'acct-3', 'acct-4', 'acct-6', 'acct-7'].map(item => [item, 'Active']))
        });
        const apiOrder = payload.contests.map(contest => contest.proposals.map(item => item.proposalId));
        expect(apiOrder).toEqual([['p-3', 'p-2', 'p-1'], ['p-7'], ['p-6'], ['p-4', 'p-5']]);
        const reversed = payload.contests.slice().reverse().map(contest => BetsModel.contest({ ...contest, proposals: contest.proposals.slice().reverse() }));
        expect(BetsModel.orderContests(reversed).map(contest => contest.rows.map(item => item.proposalId))).toEqual(apiOrder);
    });
});

describe('BetsModel.authorLabel', () => {
    it('shortens a wallet address and leaves a name alone', () => {
        expect(BetsModel.authorLabel('G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg')).toBe('G4R6…HvEg');
        expect(BetsModel.authorLabel('densifier-01')).toBe('densifier-01');
        expect(BetsModel.authorLabel(null)).toBe('');
    });
});

describe('named plan rows', () => {
    it('keep their kind, slug and members, and a contest counts its plans', () => {
        const entry = { id: 'plan:upu-borovje', kind: 'plan', planSlug: 'upu-borovje', memberCount: 2,
            members: [{ id: 1, proposalId: 'street', title: 'Ulica' }, { id: 2, proposalId: 'slab', title: 'Zgrada' }],
            proposalId: 'upu-borovje', proposalAccount: 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR', title: 'UPU Borovje',
            market: { yesPool: '300000', noPool: '100000', poolAtomic: '400000', resolved: false }, bettable: true };
        const row = BetsModel.row(entry);
        expect(row).toMatchObject({ kind: 'plan', planSlug: 'upu-borovje', memberCount: 2, chanceYes: 75, state: 'open' });
        expect(row.members.map(member => member.proposalId)).toEqual(['street', 'slab']);
        expect(BetsModel.row({ ...entry, kind: undefined }).kind).toBe('proposal');
        const contest = BetsModel.contest({ id: 'c', parcelIds: [], proposals: [entry, { ...entry, id: 9, kind: 'proposal' }] });
        expect(contest.planCount).toBe(1);
    });
});

describe('older plan versions (F2)', () => {
    // A GET /markets contest: the current version of a plan with two older versions folded under it
    // (one pool still open on-chain, one settled), and a loose proposal beside it.
    const contestEntry = () => ({
        id: 'c-borovje', parcelIds: ['P1', 'P2'], siteName: 'Borovje', poolAtomic: '120000',
        proposals: [
            { id: 'plan:upu-borovje-v3', kind: 'plan', planSlug: 'upu-borovje-v3', proposalId: 'upu-borovje-v3', title: 'UPU Borovje',
                proposalAccount: 'V3', lifecycleStatus: 'Active', bettable: true, memberCount: 2, members: [],
                market: { address: 'M3', yesPool: '100000', noPool: '0', poolAtomic: '100000', resolved: false, outcome: null },
                olderVersions: [
                    { id: 'plan:upu-borovje-v2', kind: 'plan', planSlug: 'upu-borovje-v2', slug: 'upu-borovje-v2', proposalId: 'upu-borovje-v2',
                        title: 'UPU Borovje', createdAt: '2026-10-10T18:17:15Z', proposalAccount: 'V2', supersededBy: 'upu-borovje-v3',
                        state: 'resolved-no', bettable: false, canOpenMarket: false,
                        market: { address: 'M2', yesPool: '50000', noPool: '150000', poolAtomic: '200000', resolved: true, outcome: 'no' } },
                    { id: 'plan:upu-borovje', kind: 'plan', planSlug: 'upu-borovje', slug: 'upu-borovje', proposalId: 'upu-borovje',
                        title: 'UPU Borovje', createdAt: '2026-10-10T14:08:54Z', proposalAccount: 'V1', supersededBy: 'upu-borovje-v2',
                        state: 'open', bettable: false, canOpenMarket: false, chainStatus: 'Active',
                        market: { address: 'M1', yesPool: '300000', noPool: '100000', poolAtomic: '400000', resolved: false, outcome: null } }
                ] },
            { id: 4, kind: 'proposal', proposalId: 'rival', title: 'Rival', proposalAccount: 'R', lifecycleStatus: 'Active', bettable: true,
                market: { address: 'MR', yesPool: '10000', noPool: '10000', poolAtomic: '20000', resolved: false, outcome: null }, olderVersions: [] }
        ]
    });

    it('fold under their plan\'s row as rows of their own, superseded, keeping where their pool stands', () => {
        const contest = BetsModel.contest(contestEntry());
        const [current] = contest.rows;
        expect(current).toMatchObject({ planSlug: 'upu-borovje-v3', superseded: false, state: 'open' });
        expect(current.olderVersions.map(item => [item.planSlug, item.state, item.superseded, item.supersededBy])).toEqual([
            ['upu-borovje-v2', 'resolved-no', true, 'upu-borovje-v3'],
            // Still open on-chain: the server's word stands, though the entry is not bettable.
            ['upu-borovje', 'open', true, 'upu-borovje-v2']
        ]);
        expect(current.olderVersions[0]).toMatchObject({ title: 'UPU Borovje', createdAt: '2026-10-10T18:17:15Z', outcome: 'no', pool: '0.2' });
        expect(current.olderVersions[1]).toMatchObject({ proposalAccount: 'V1', chanceYes: 75, pool: '0.4' });
    });

    it('are not entries of the contest: the dialog\'s "plans · proposals on this land" counts current versions', () => {
        const contest = BetsModel.contest(contestEntry());
        expect(contest).toMatchObject({ proposalCount: 2, planCount: 1, openCount: 2 });
        expect(contest.rows.map(item => item.proposalId)).toEqual(['upu-borovje-v3', 'rival']);
    });

    it('keep their plan in "Mine" while a bet sits in one of their pools', () => {
        const { rows } = BetsModel.contest(contestEntry());
        const positions = { V1: { yes: { amount: 50000n, claimed: false }, no: null } };
        expect(BetsModel.filterRows(rows, 'mine', positions).map(item => item.proposalId)).toEqual(['upu-borovje-v3']);
        expect(BetsModel.filterRows(rows, 'mine', {})).toEqual([]);
        // A settled older version with an unclaimed winning bet can be collected from its row.
        const settledV2 = rows[0].olderVersions[0];
        expect(BetsModel.claimSides(settledV2, { no: { amount: 150000n, claimed: false } })).toEqual(['no']);
    });
});
