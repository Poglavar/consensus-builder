// Current LMSR agreement-market view contract: prices, fixed share payouts, lifecycle gates,
// row shaping, grouping and ordering used by the Bets sheet.
import { describe, expect, it } from 'vitest';
import { buildContests } from '../markets/contests.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetsModel = require('../../frontend/js/bets/bets-model.js');
const Lmsr = require('../../frontend/js/bets/lmsr.js');
const market = (overrides = {}) => ({ model: 'lmsr', asset: 'points', b: '100000000', qYes: '0', qNo: '0', seed: '69314720',
    closesAt: 1800000000, graceSeconds: 0, maxPosition: '0', paidOut: '0', creator: 'sponsor', resolved: false, outcome: null, ...overrides });

describe('LMSR prices and fixed payouts', () => {
    it('quotes prices from inventory and leaves an empty market at 50/50', () => {
        expect(BetsModel.chance(market())).toEqual({ yes: 50, no: 50 });
        expect(BetsModel.chance(market({ qYes: '100000000', qNo: '0' })).yes).toBeGreaterThan(50);
        expect(BetsModel.chance(market({ qYes: '0', qNo: '100000000' })).no).toBeGreaterThan(50);
    });

    it('quotes the actual LMSR cost for a one USDC buy, including the one-unit guard', () => {
        const m = market({ asset: 'devnet-usdc', b: '100000000', qYes: '0', qNo: '0' });
        const quote = BetsModel.quote(m, 'yes', 1_000_000n, 'buy');
        expect(quote.amount).toBe(Lmsr.buyCost(100_000_000n, 0n, 0n, 'yes', quote.shares));
        expect(quote.amount).toBeLessThanOrEqual(1_000_000n);
        expect(BetsModel.toWin('yes', m, 1_000_000n)).toBe(quote.shares);
        expect(BetsModel.payoutMultiple('yes', m)).toBe(Number(quote.shares * 100n / quote.amount) / 100);
    });

    it('does not round up a sell quote and recognizes one share pays one unit', () => {
        const m = market({ qYes: '100000000', qNo: '100000000' });
        const quote = BetsModel.quote(m, 'yes', 10_000n, 'sell');
        expect(quote.amount).toBe(Lmsr.sellReturn(100_000_000n, 100_000_000n, 100_000_000n, 'yes', 10_000n));
        expect(quote.minReturn).toBe(quote.amount);
        expect(BetsModel.payoutMultiple('yes', m, 1_000_000n)).toBeGreaterThan(0);
    });
});

describe('row states and lifecycle', () => {
    const base = { account: 'acct', chainStatus: 'active', market: market(), bettable: false, canSettle: false };
    it('distinguishes open, unminted, needs-market and known settlement states', () => {
        expect(BetsModel.rowState({ ...base, bettable: true })).toBe('open');
        expect(BetsModel.rowState({ ...base, account: null, market: null })).toBe('not-minted');
        expect(BetsModel.rowState({ ...base, market: null, canOpenMarket: true })).toBe('needs-market');
        expect(BetsModel.rowState({ ...base, chainStatus: 'cancelled', canSettle: true })).toBe('settling');
        expect(BetsModel.rowState({ ...base, market: market({ resolved: true, outcome: 'void' }) })).toBe('resolved-void');
    });

    it('does not infer settlement from a missing status or a passed deadline alone', () => {
        for (const chainStatus of [null, undefined, 'unknown', 'active']) {
            expect(BetsModel.rowState({ ...base, chainStatus, canSettle: false })).toBe('closed');
        }
        expect(BetsModel.settlementOf('cancelled')).toBe('void');
        expect(BetsModel.settlementOf('expired')).toBe('no');
        expect(BetsModel.settlementOf('executed')).toBe('yes');
        expect(BetsModel.settlementOf('unknown')).toBeNull();
    });

    it('honors the market cutoff and grace interval in chain summaries', () => {
        const now = 1_800_000_000_000;
        const m = market({ closesAt: 1_800_000_000, graceSeconds: 10 });
        expect(BetsModel.chainEntry('acct', { chainStatus: 'active', deadline: '2027-01-16T00:00:00Z', market: m }, now - 1))
            .toMatchObject({ bettable: true, canSettle: false });
        expect(BetsModel.chainEntry('acct', { chainStatus: 'active', deadline: '2027-01-16T00:00:00Z', market: m }, now + 10_000))
            .toMatchObject({ bettable: false, canSettle: true });
        expect(BetsModel.chainEntry('acct', { chainStatus: null, deadline: '2027-01-16T00:00:00Z', market: m }, now + 10_000))
            .toMatchObject({ bettable: false, canSettle: false });
    });

    it('exposes the market fields and asset without parimutuel pool amounts', () => {
        const result = BetsModel.row({ cid: 'cid', account: 'acct', sponsor: 'sponsor', chainStatus: 'active', bettable: true,
            deadline: '2027-01-01T00:00:00Z', market: market({ asset: 'devnet-usdc', qYes: '7', qNo: '5' }) });
        expect(result).toMatchObject({ asset: 'devnet-usdc', sponsor: 'sponsor', state: 'open', liquidity: '100', sharesAtomic: 12n,
            yesSharesAtomic: 7n, noSharesAtomic: 5n, closesAt: new Date(1800000000 * 1000).toISOString() });
        expect(result).not.toHaveProperty('pool');
        expect(result.market).toEqual(market({ asset: 'devnet-usdc', qYes: '7', qNo: '5' }));
    });

    it('keeps agreement titles, authored design labels and parcel labels readable', () => {
        expect(BetsModel.labelOf({ title: ' Deal ', designTitles: ['A'] })).toBe('Deal');
        expect(BetsModel.labelOf({ designTitles: ['Park', 'Homes'] })).toBe('Park + Homes');
        expect(BetsModel.parcelLabel('HR-335614-1754/1')).toBe('1754/1');
        expect(BetsModel.authorLabel('A named author')).toBe('A named author');
    });
});

describe('claims, filters and sorting', () => {
    it('offers both sides for a VOID payout when each has a positive half-unit claim', () => {
        const row = BetsModel.row({ account: 'acct', market: market({ resolved: true, outcome: 'void' }) });
        expect(BetsModel.claimSides(row, { yes: { amount: 3n }, no: { amount: 5n } })).toEqual(['yes', 'no']);
        expect(BetsModel.claimSides(row, { yes: { amount: 1n }, no: { amount: 2n } })).toEqual(['no']);
    });

    it('folds away only unminted or closed entries without markets and filters by held positions', () => {
        const rows = [
            { account: 'a', state: 'open', market: market() },
            { account: null, state: 'not-minted', market: null },
            { account: 'b', state: 'closed', market: null },
            { account: 'c', state: 'resolved-void', market: market({ resolved: true, outcome: 'void' }) }
        ];
        expect(BetsModel.splitRows(rows)).toEqual({ shown: [rows[0], rows[3]], hidden: [rows[1], rows[2]] });
        expect(BetsModel.filterRows(rows, 'mine', { c: { no: { amount: 2n } } }).map(row => row.account)).toEqual(['c']);
    });

    it('orders a dated actionable market first, then larger shares, with resolved markets after', () => {
        const makeContest = (id, agreements) => BetsModel.contest({ id, parcelIds: [], agreements });
        const entries = [
            { cid: 'later', account: 'a', chainStatus: 'active', bettable: true, deadline: '2027-06-01T00:00:00Z', market: market({ closesAt: 1825000000, qYes: '100' }) },
            { cid: 'soon', account: 'b', chainStatus: 'active', bettable: true, deadline: '2027-01-01T00:00:00Z', market: market({ closesAt: 1798761600, qYes: '1' }) },
            { cid: 'void', account: 'c', chainStatus: 'cancelled', market: market({ qYes: '100000', resolved: true, outcome: 'void' }) }
        ];
        expect(makeContest('c', entries).rows.map(row => row.cid)).toEqual(['soon', 'later', 'void']);
    });
});

describe('server and sheet market ordering agree', () => {
    it('retains deadline-first order and stable grouping in both representations', () => {
        const marketAt = (closesAt, qYes) => ({ ...market({ closesAt, qYes: String(qYes) }), address: 'm' });
        const agreements = [
            { cid: 'late', account: 'late', chainStatus: 'active', deadline: '2027-02-01T00:00:00Z', inputParcelIds: ['P'], market: marketAt(1801612800, 100) },
            { cid: 'soon', account: 'soon', chainStatus: 'active', deadline: '2027-01-01T00:00:00Z', inputParcelIds: ['P'], market: marketAt(1798761600, 1) }
        ];
        const api = buildContests({ city: 'zagreb', agreements, now: new Date('2026-10-25T00:00:00Z'),
            markets: new Map(agreements.map(entry => [entry.account, { address: 'm', chainStatus: 'active', deadline: entry.deadline, market: {
                b: 100000000n, qYes: BigInt(entry.market.qYes), qNo: 0n, seed: 69314720n, closesAt: entry.market.closesAt, graceSeconds: 0,
                maxPosition: 0n, paidOut: 0n, creator: 'creator', resolved: false, outcome: 0
            } }])) });
        const sheet = BetsModel.contest(api.contests[0]);
        expect(api.contests[0].agreements.map(row => row.cid)).toEqual(['soon', 'late']);
        expect(sheet.rows.map(row => row.cid)).toEqual(['soon', 'late']);
        expect(sheet.rows[0].sharesAtomic).toBe(1n);
    });
});
