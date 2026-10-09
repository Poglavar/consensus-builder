// The Bets sheet's numbers: chance from pool share, the payout multiple of a reference bet, and the
// state word per proposal. All exact integer math on atomic USDC.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

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
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Cancelled', market: { resolved: false } })).toBe('settling');
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Executed' })).toBe('closed');
        // The chain's word wins over the database's expiry-aware one.
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Expired', chainStatus: 'Active', market: { resolved: false } })).toBe('closed');
        expect(BetsModel.rowState({ ...base, lifecycleStatus: 'Active', chainStatus: 'Expired', market: { resolved: false } })).toBe('settling');
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
        expect(out.rows[0]).toMatchObject({ state: 'open', chanceYes: 83.3, chanceNo: 16.7, pool: '0.3', paysYes: 1.04, paysNo: 1.23, closesAt: '2026-12-31T00:00:00Z', marketAddress: 'MKT' });
        expect(out.rows[1]).toMatchObject({ state: 'not-minted', chanceYes: null, pool: null, paysYes: null });
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
