// The Bets sheet's numbers: chance from pool share, the payout multiple of a reference bet, and the
// state word per agreement (frontend/js/bets/bets-model.js), that the sheet settles a pool as the
// agreement-execution-v1 recipe does (oracle/market-recipe.js), that it orders a GET /markets
// payload (markets/contests.js) exactly as the API does, and that an agreement read straight from the
// chain takes bets by the API's rule. All exact integer math on atomic USDC.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildContests } from '../markets/contests.js';
import { SETTLEMENT as RECIPE_SETTLEMENT, marketOutcome } from '../oracle/market-recipe.js';
import { ONCHAIN_STATUSES } from '../agreements/onchain.js';

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
    const base = { account: 'acct', chainStatus: 'active', bettable: false, canOpenMarket: false, market: null };
    it('names each situation a bettor can meet', () => {
        expect(BetsModel.rowState({ ...base, bettable: true, market: { resolved: false } })).toBe('open');
        expect(BetsModel.rowState({ ...base, canOpenMarket: true })).toBe('needs-market');
        expect(BetsModel.rowState({ ...base, account: null })).toBe('not-minted');
        expect(BetsModel.rowState({ ...base, market: { resolved: true, outcome: 'yes' } })).toBe('resolved-yes');
        expect(BetsModel.rowState({ ...base, market: { resolved: true, outcome: 'no' } })).toBe('resolved-no');
        // The account left Active on chain: its pool only needs someone to settle it.
        for (const chainStatus of ['executed', 'cancelled', 'expired']) {
            expect(BetsModel.rowState({ ...base, chainStatus, market: { resolved: false } }), chainStatus).toBe('settling');
            // Decided before anyone opened a pool: nothing to settle.
            expect(BetsModel.rowState({ ...base, chainStatus }), chainStatus).toBe('closed');
        }
        expect(BetsModel.rowState(null)).toBe('not-minted');
    });

    it('never offers settlement from a passed deadline or an unknown chain status', () => {
        // Active on chain with its deadline passed (the server says not bettable), or nothing observed.
        for (const chainStatus of [undefined, null, 'active', 'Executed', 'unsupported']) {
            expect(BetsModel.rowState({ ...base, status: 'expired', chainStatus, market: { resolved: false } }), String(chainStatus)).toBe('closed');
        }
        expect(BetsModel.settlementOf('executed')).toBe('yes');
        expect(BetsModel.settlementOf('expired')).toBe('no');
        expect(BetsModel.settlementOf('toString')).toBeNull();
    });
});

describe('BetsModel.settlementOf', () => {
    it('settles as agreement-execution-v1 does: executed yes, cancelled or expired no, nothing else', () => {
        expect(BetsModel.SETTLEMENT).toEqual({ executed: 'yes', cancelled: 'no', expired: 'no' });
        expect(BetsModel.SETTLEMENT).toEqual(RECIPE_SETTLEMENT);
        expect(Object.isFrozen(BetsModel.SETTLEMENT)).toBe(true);
        for (const status of [...ONCHAIN_STATUSES, undefined, null, '', 'Executed', 'constructor']) {
            expect(BetsModel.settlementOf(status), String(status)).toBe(marketOutcome(status));
        }
        expect(BetsModel.settlementOf('cancelled')).toBe('no');
        expect(BetsModel.settlementOf('active')).toBeNull();
        expect(BetsModel.settlementOf('constructor')).toBeNull();
    });
});

describe('BetsModel.labelOf', () => {
    it('is the agreement\'s title, else its design titles in authored order, else empty', () => {
        expect(BetsModel.labelOf({ title: ' Riverside deal ', designTitles: ['A'] })).toBe('Riverside deal');
        expect(BetsModel.labelOf({ title: '', designTitles: ['Six storeys', ' ', 'A park'] })).toBe('Six storeys + A park');
        expect(BetsModel.labelOf({ designTitles: ['A', 'B', 'C', 'D'] })).toBe('A + B + C + …');
        expect(BetsModel.labelOf({})).toBe('');
        expect(BetsModel.labelOf(null)).toBe('');
    });
});

describe('BetsModel.contest', () => {
    it('shapes a GET /markets contest into sheet rows with text amounts', () => {
        const out = BetsModel.contest({
            id: 'c-1', parcelIds: ['L1', 'L2', 'L3'], poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z',
            agreements: [
                { cid: 'a', title: 'A', account: 'acct', chainStatus: 'active', status: 'active', bettable: true, canOpenMarket: false, deadline: '2026-12-31T00:00:00Z',
                    market: { address: 'MKT', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null } },
                { cid: 'b', title: '', designTitles: ['A park'], account: null, chainStatus: null, bettable: false, canOpenMarket: false, market: null }
            ]
        });
        expect(out).toMatchObject({ id: 'c-1', land: { first: 'L1', more: 2 }, agreementCount: 2, openCount: 1, pool: '0.3', poolAtomic: 300000n, latestCreatedAt: '2026-10-02T00:00:00Z' });
        expect(out.rows[0]).toMatchObject({
            kind: 'agreement', cid: 'a', account: 'acct', contest: 'c-1', label: 'A', state: 'open', chanceYes: 83.3, chanceNo: 16.7, pool: '0.3',
            paysYes: 1.04, paysNo: 1.23, deadline: '2026-12-31T00:00:00Z', marketAddress: 'MKT', outcome: null
        });
        expect(out.rows[1]).toMatchObject({ cid: 'b', label: 'A park', state: 'not-minted', chanceYes: null, pool: null, paysYes: null, marketAddress: null });
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
        expect(BetsModel.row({ account: 'A', bettable: true, market: { yesPool: '250000', noPool: '0', poolAtomic: '250000' } }).oneSided).toBe('yes');
    });
});

describe('BetsModel.claimSides', () => {
    const settled = outcome => BetsModel.row({ account: 'A', market: { yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: true, outcome } });
    it('is the unclaimed winning side only', () => {
        const positions = { yes: { amount: 100000n, claimed: false }, no: { amount: 20000n, claimed: false } };
        expect(BetsModel.claimSides(settled('yes'), positions)).toEqual(['yes']);
        expect(BetsModel.claimSides(settled('no'), positions)).toEqual(['no']);
        expect(BetsModel.claimSides(settled('no'), { no: { amount: 20000n, claimed: true } })).toEqual([]);
    });
    it('is every unclaimed bet when nobody backed the winner (the program refunds)', () => {
        const row = BetsModel.row({ account: 'A', market: { yesPool: '250000', noPool: '0', poolAtomic: '250000', resolved: true, outcome: 'no' } });
        expect(BetsModel.claimSides(row, { yes: { amount: 250000n, claimed: false } })).toEqual(['yes']);
    });
    it('is nothing while the pool is open', () => {
        const open = BetsModel.row({ account: 'A', bettable: true, market: { yesPool: '250000', noPool: '0', poolAtomic: '250000' } });
        expect(BetsModel.claimSides(open, { yes: { amount: 250000n, claimed: false } })).toEqual([]);
    });
});

describe('BetsModel.splitRows and filterRows', () => {
    const rows = [
        { account: 'A', state: 'open' }, { account: null, state: 'not-minted' }, { account: 'B', state: 'resolved-no' },
        { account: 'C', state: 'closed' }, { account: 'D', state: 'needs-market' }, { account: 'E', state: 'settling' }
    ];
    it('folds unminted and never-pooled rows away', () => {
        const { shown, hidden } = BetsModel.splitRows(rows);
        expect(shown.map(r => r.state)).toEqual(['open', 'resolved-no', 'needs-market', 'settling']);
        expect(hidden.map(r => r.state)).toEqual(['not-minted', 'closed']);
    });
    it('keeps an existing pool visible when its current chain status is unavailable', () => {
        const closed = { account: 'A', state: 'closed', pool: '0' };
        expect(BetsModel.splitRows([closed])).toEqual({ shown: [closed], hidden: [] });
    });
    it('filters by open, settled and the wallet\'s own bets, keyed by the agreement account', () => {
        expect(BetsModel.filterRows(rows, 'open').map(r => r.account)).toEqual(['A', 'D', 'E']);
        expect(BetsModel.filterRows(rows, 'settled').map(r => r.account)).toEqual(['B']);
        const positions = { B: { yes: null, no: { amount: 50000n, claimed: false } }, A: { yes: { amount: 0n }, no: null } };
        expect(BetsModel.filterRows(rows, 'mine', positions).map(r => r.account)).toEqual(['B']);
        expect(BetsModel.filterRows(rows, 'all')).toHaveLength(6);
    });
});

describe('BetsModel.orderContests', () => {
    // A sheet contest as BetsModel.contest shapes it, from GET /markets entries.
    const shaped = (id, agreements, poolAtomic = '0') => BetsModel.contest({ id, parcelIds: [], poolAtomic, agreements });
    const entry = (cid, overrides) => ({ cid, account: `acct-${cid}`, chainStatus: 'active', ...overrides });
    const open = (yes, no = '0') => ({ bettable: true, market: { yesPool: yes, noPool: no, poolAtomic: (BigInt(yes) + BigInt(no)).toString(), resolved: false } });
    const settled = (pool, outcome) => ({ market: { yesPool: pool, noPool: '0', poolAtomic: pool, resolved: true, outcome } });

    it('never opens on settled pools: a bet that can go in now leads, however small', () => {
        const contests = [
            shaped('settled-bots', [entry('s1', settled('5000000', 'no')), entry('s2', settled('3000000', 'no'))], '8000000'),
            shaped('open-small', [entry('o1', open('1000'))], '1000'),
            shaped('needs-pool', [entry('n1', { canOpenMarket: true })]),
            shaped('open-dated', [entry('d1', { ...open('1'), deadline: '2026-11-18T00:00:00.000Z' })], '1')
        ];
        expect(BetsModel.orderContests(contests).map(c => c.id)).toEqual(['open-dated', 'open-small', 'needs-pool', 'settled-bots']);
        expect(contests.map(c => c.id)).toEqual(['settled-bots', 'open-small', 'needs-pool', 'open-dated']);
    });

    it('keeps equal contests in the server\'s order', () => {
        const contests = ['a', 'b', 'c'].map(id => shaped(id, [entry(`${id}1`, { ...open('0'), createdAt: '2026-10-01T00:00:00Z' })]));
        expect(BetsModel.orderContests(contests).map(c => c.id)).toEqual(['a', 'b', 'c']);
    });

    it('breaks a tie by the number of agreements', () => {
        const same = { ...open('0'), createdAt: '2026-10-01T00:00:00Z' };
        const one = shaped('one', [entry('a1', same)]);
        const two = shaped('two', [entry('b1', same), entry('b2', same)]);
        expect(BetsModel.orderContests([one, two]).map(c => c.id)).toEqual(['two', 'one']);
    });
});

describe('BetsModel.contest row order', () => {
    it('puts rows in play first by deadline then pool, settled rows after by pool, whatever order they arrive in', () => {
        const out = BetsModel.contest({ id: 'c', parcelIds: [], agreements: [
            { cid: 'settled-big', account: 'A1', market: { yesPool: '0', noPool: '5000000', poolAtomic: '5000000', resolved: true, outcome: 'no' } },
            { cid: 'not-minted', account: null },
            { cid: 'open-small', account: 'A3', bettable: true, market: { yesPool: '1000', noPool: '0', poolAtomic: '1000', resolved: false } },
            { cid: 'settled-small', account: 'A4', market: { yesPool: '100', noPool: '0', poolAtomic: '100', resolved: true, outcome: 'yes' } },
            { cid: 'open-dated', account: 'A5', bettable: true, deadline: '2026-11-18T00:00:00.000Z', market: { yesPool: '0', noPool: '0', poolAtomic: '0', resolved: false } },
            { cid: 'needs-market', account: 'A6', canOpenMarket: true }
        ] });
        expect(out.rows.map(item => item.cid)).toEqual(['open-dated', 'open-small', 'needs-market', 'settled-big', 'settled-small', 'not-minted']);
    });

    it('leads with the soonest agreement deadline, even over a bigger pool', () => {
        const out = BetsModel.contest({ id: 'c', parcelIds: [], agreements: [
            { cid: 'later-big', account: 'A1', bettable: true, deadline: '2026-12-31T00:00:00.000Z', market: { yesPool: '5000000', noPool: '0', poolAtomic: '5000000', resolved: false } },
            { cid: 'sooner-small', account: 'A2', bettable: true, deadline: '2026-11-18T00:00:00.000Z', market: { yesPool: '1', noPool: '0', poolAtomic: '1', resolved: false } }
        ] });
        expect(out.rows.map(item => item.cid)).toEqual(['sooner-small', 'later-big']);
    });
});

describe('BetsModel.chainEntry', () => {
    const NOW = Date.parse('2026-10-22T12:00:00Z');
    const pool = { yesPool: 300000n, noPool: 100000n, resolved: false, outcome: 0 };
    // A market-bridge.js readSummary: the agreement account's status and deadline, and its pool.
    const summary = (overrides = {}) => ({ chainStatus: 'Active', deadline: '2026-10-25T00:00:00.000Z', market: pool, marketAddress: 'market-1', ...overrides });

    it('takes bets while the account is Active and its deadline is ahead or unset', () => {
        const entry = BetsModel.chainEntry('acct', summary(), NOW);
        expect(entry).toMatchObject({ account: 'acct', chainStatus: 'active', deadline: '2026-10-25T00:00:00.000Z', bettable: true, canOpenMarket: false });
        expect(entry.market).toEqual({ address: 'market-1', yesPool: 300000n, noPool: 100000n, poolAtomic: 400000n, resolved: false, outcome: null });
        expect(BetsModel.row(entry)).toMatchObject({ state: 'open', deadline: '2026-10-25T00:00:00.000Z', pool: '0.4' });
        expect(BetsModel.chainEntry('acct', summary({ deadline: null }), NOW).bettable).toBe(true);
        // No pool yet: one can be opened on the same terms.
        expect(BetsModel.chainEntry('acct', summary({ market: null }), NOW)).toMatchObject({ bettable: false, canOpenMarket: true, market: null });
    });

    it('takes no bet once the deadline is reached, though the account is still Active', () => {
        for (const deadline of ['2026-10-22T12:00:00.000Z', '2026-10-01T00:00:00.000Z']) {
            const lapsed = BetsModel.chainEntry('acct', summary({ deadline }), NOW);
            expect(lapsed, deadline).toMatchObject({ chainStatus: 'active', bettable: false, canOpenMarket: false });
            expect(BetsModel.row(lapsed).state, deadline).toBe('closed');
            expect(BetsModel.chainEntry('acct', summary({ deadline, market: null }), NOW).canOpenMarket, deadline).toBe(false);
        }
    });

    it('takes no bet on a terminal account or a resolved pool', () => {
        const executed = BetsModel.chainEntry('acct', summary({ chainStatus: 'Executed' }), NOW);
        expect(executed).toMatchObject({ chainStatus: 'executed', bettable: false, canOpenMarket: false });
        expect(BetsModel.row(executed).state).toBe('settling');
        const resolved = BetsModel.chainEntry('acct', summary({ market: { ...pool, resolved: true, outcome: 1 } }), NOW);
        expect(resolved).toMatchObject({ bettable: false, market: { resolved: true, outcome: 'yes' } });
        expect(BetsModel.row(resolved).state).toBe('resolved-yes');
    });

    it('decides as GET /markets does for the same account status, deadline and pool', () => {
        const cases = [
            ['active', null, true], ['active', '2026-10-25T00:00:00.000Z', true], ['active', '2026-10-22T12:00:00.000Z', true],
            ['active', '2026-10-01T00:00:00.000Z', false], ['active', '2026-10-25T00:00:00.000Z', false], ['executed', null, true]
        ];
        cases.forEach(([chainStatus, deadline, pooled], index) => {
            const account = `acct-${index}`;
            const decoded = pooled ? { ...pool } : null;
            const [api] = buildContests({
                city: 'zagreb', now: new Date(NOW),
                agreements: [{ cid: `cid-${index}`, city: 'zagreb', inputParcelIds: [`P${index}`], parcelSourceId: null, deadline, createdAt: '2026-10-01T00:00:00Z', account, chainStatus }],
                markets: new Map([[account, { address: 'market-1', market: decoded }]])
            }).contests[0].agreements;
            // The chain spells the status as the account decoder names it ('Active'); the index lower-cases it.
            const onChain = BetsModel.chainEntry(account, summary({ chainStatus: chainStatus[0].toUpperCase() + chainStatus.slice(1), deadline, market: decoded }), NOW);
            expect({ bettable: onChain.bettable, canOpenMarket: onChain.canOpenMarket }, `${chainStatus} ${deadline} ${pooled}`)
                .toEqual({ bettable: api.bettable, canOpenMarket: api.canOpenMarket });
        });
    });
});

describe('the sheet and GET /markets agree on the order', () => {
    it('re-sorting the API\'s contests and rows in the sheet changes nothing, from any arrival order', () => {
        const agreement = (n, parcel, account, createdAt, overrides = {}) => ({
            cid: `cid-${n}`, city: 'zagreb', title: `A${n}`, author: 'a', designTitles: [], inputParcelIds: [parcel], parcelSourceId: null,
            deadline: null, createdAt, screenshotUrl: null, account, chainStatus: account ? 'active' : null, ...overrides
        });
        const market = (yesPool, noPool, resolved = false, outcome = 0) => ({ address: 'M', market: { yesPool, noPool, resolved, outcome } });
        const payload = buildContests({
            city: 'zagreb',
            now: new Date('2026-10-09T00:00:00Z'),
            agreements: [
                agreement(1, 'A', 'acct-1', '2026-10-01T00:00:00Z', { chainStatus: 'executed' }), agreement(2, 'A', 'acct-2', '2026-10-02T00:00:00Z'),
                agreement(3, 'A', 'acct-3', '2026-10-03T00:00:00Z', { deadline: '2026-11-18T00:00:00.000Z' }), agreement(4, 'B', 'acct-4', '2026-10-04T00:00:00Z', { chainStatus: 'cancelled' }),
                agreement(5, 'B', null, '2026-10-05T00:00:00Z'), agreement(6, 'C', 'acct-6', '2026-10-06T00:00:00Z'),
                agreement(7, 'D', 'acct-7', '2026-10-07T00:00:00Z')
            ],
            markets: new Map([
                ['acct-1', market(9_000_000n, 0n, true, 1)], ['acct-2', market(1n, 0n)], ['acct-3', market(0n, 0n)],
                ['acct-4', market(0n, 7_000_000n, true, 0)], ['acct-6', { address: 'M', market: null }], ['acct-7', market(40n, 2n)]
            ])
        });
        const apiOrder = payload.contests.map(contest => contest.agreements.map(item => item.cid));
        expect(apiOrder).toEqual([['cid-3', 'cid-2', 'cid-1'], ['cid-7'], ['cid-6'], ['cid-4', 'cid-5']]);
        const reversed = payload.contests.slice().reverse().map(contest => BetsModel.contest({ ...contest, agreements: contest.agreements.slice().reverse() }));
        expect(BetsModel.orderContests(reversed).map(contest => contest.rows.map(item => item.cid))).toEqual(apiOrder);
        // The row states the sheet derives are the ones the API's flags say.
        expect(BetsModel.contest(payload.contests[0]).rows.map(item => item.state)).toEqual(['open', 'open', 'resolved-yes']);
    });
});

describe('BetsModel.authorLabel', () => {
    it('shortens a wallet address and leaves a name alone', () => {
        expect(BetsModel.authorLabel('G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg')).toBe('G4R6…HvEg');
        expect(BetsModel.authorLabel('densifier-01')).toBe('densifier-01');
        expect(BetsModel.authorLabel(null)).toBe('');
    });
});
