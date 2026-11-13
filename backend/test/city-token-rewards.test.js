// City meme token rewards: average-cost edge, pool and rate awards, UGT beside each city award.
import { describe, expect, it } from 'vitest';
import {
    holderEdge, edgesByHolder, marketAwards, netShares, cityToken, tokenSymbol, formatTokenAmount,
    POINTS_POOL, USDC_RATE, UGT, boostPayouts
} from '../markets/city-token-rewards.js';

const buy = (side, shares, amount, holder = 'a') => ({ holder, action: 'buy', side, shares, amount });
const sell = (side, shares, amount, holder = 'a') => ({ holder, action: 'sell', side, shares, amount });

describe('holderEdge', () => {
    it('is payout minus cost of the winning shares', () => {
        // 100 YES shares at 0.30 each: edge 70.
        expect(holderEdge([buy('yes', 100n, 30n)], 'yes')).toBe(70n);
    });
    it('is zero on the losing side, on VOID and for a buy at the top', () => {
        expect(holderEdge([buy('yes', 100n, 30n)], 'no')).toBe(0n);
        expect(holderEdge([buy('yes', 100n, 30n)], 'void')).toBe(0n);
        expect(holderEdge([buy('yes', 100n, 100n)], 'yes')).toBe(0n);
    });
    it('splitting a bet earns what the single bet earns (linear in stake)', () => {
        const one = holderEdge([buy('yes', 100n, 30n)], 'yes');
        const split = holderEdge(Array.from({ length: 10 }, () => buy('yes', 10n, 3n)), 'yes');
        expect(split).toBe(one);
    });
    it('a sell removes its average-cost slice', () => {
        // Buy 100 at 20, buy 100 at 60 → 200 shares, cost 80, avg 0.40; sell 100 → 100 left, cost 40.
        const fills = [buy('yes', 100n, 20n), buy('yes', 100n, 60n), sell('yes', 100n, 55n)];
        expect(holderEdge(fills, 'yes')).toBe(60n);
    });
    it('ignores the hedge on the losing side', () => {
        expect(holderEdge([buy('yes', 100n, 30n), buy('no', 100n, 70n)], 'yes')).toBe(70n);
    });
    it('rejects selling more than held', () => {
        expect(() => holderEdge([sell('yes', 1n, 1n)], 'yes')).toThrow(/more shares/);
    });
});

describe('edgesByHolder and netShares', () => {
    it('groups by holder and drops holders without edge', () => {
        const fills = [buy('yes', 100n, 30n, 'a'), buy('no', 50n, 20n, 'b'), buy('yes', 10n, 9n, 'c')];
        expect([...edgesByHolder(fills, 'yes')]).toEqual([['a', 70n], ['c', 1n]]);
        expect(netShares([...fills, sell('yes', 10n, 8n, 'c')])).toEqual({ yes: 100n, no: 50n });
    });
});

describe('marketAwards', () => {
    it('points: one fixed pool split by edge, UGT a tenth', () => {
        const awards = marketAwards({ book: 'points', city: 'zagreb', edges: new Map([['a', 3n], ['b', 1n]]) });
        expect(awards).toEqual([
            { holder: 'a', token: 'zagreb', edge: 3n, amount: POINTS_POOL * 3n / 4n },
            { holder: 'a', token: UGT, edge: 3n, amount: POINTS_POOL * 3n / 40n },
            { holder: 'b', token: 'zagreb', edge: 1n, amount: POINTS_POOL / 4n },
            { holder: 'b', token: UGT, edge: 1n, amount: POINTS_POOL / 40n }
        ]);
        const cityTotal = awards.filter(a => a.token === 'zagreb').reduce((s, a) => s + a.amount, 0n);
        expect(cityTotal <= POINTS_POOL).toBe(true);
    });
    it('points: more accounts never inflate the pool', () => {
        const many = new Map(Array.from({ length: 100 }, (_, i) => [`s${i}`, 7n]));
        const total = marketAwards({ book: 'points', city: 'zagreb', edges: many })
            .filter(a => a.token === 'zagreb').reduce((s, a) => s + a.amount, 0n);
        expect(total <= POINTS_POOL).toBe(true);
    });
    it('devnet USDC: a rate on edge, uncapped', () => {
        const awards = marketAwards({ book: 'devnet-usdc', city: 'san-francisco', edges: new Map([['w', 700_000n]]) });
        expect(awards).toEqual([
            { holder: 'w', token: 'san-francisco', edge: 700_000n, amount: 700_000n * USDC_RATE },
            { holder: 'w', token: UGT, edge: 700_000n, amount: 7_000_000n }
        ]);
        expect(formatTokenAmount(awards[0].amount)).toBe('70');
    });
    it('refuses a free-text city', () => {
        expect(() => cityToken('San Francisco (simulated preview)')).toThrow(/slug/);
    });
});

describe('display', () => {
    it('symbols and amounts', () => {
        expect(tokenSymbol('san-francisco')).toBe('SANFRANCISCO');
        expect(tokenSymbol(UGT)).toBe('UGT');
        expect(formatTokenAmount(1_500_000n)).toBe('1.5');
        expect(formatTokenAmount(0n)).toBe('0');
    });
});

describe('boostPayouts', () => {
    const rights = { parcels: [
        { parcelId: 'p1', complete: true, owners: [{ ownerId: 'alice', share: '1/2' }, { ownerId: 'bob', share: '1/2' }] },
        { parcelId: 'p2', complete: true, owners: [{ ownerId: 'carol', share: '1/1' }] }
    ] };
    it('pays the sponsor 30% and the owners 70%, equal per parcel and by share within it', () => {
        expect(boostPayouts({ amount: 1000n, sponsor: 'S', rights })).toEqual([
            { recipient: 'S', role: 'sponsor', amount: 300n },
            { recipient: 'alice', role: 'owner', amount: 175n },
            { recipient: 'bob', role: 'owner', amount: 175n },
            { recipient: 'carol', role: 'owner', amount: 350n }
        ]);
    });
    it('sends an unresolved parcel slice and missing rights to the sponsor, and always sums exactly', () => {
        const partial = { parcels: [rights.parcels[0], { parcelId: 'p3', complete: false, owners: [] }] };
        const rows = boostPayouts({ amount: 1001n, sponsor: 'S', rights: partial });
        expect(rows.reduce((s, r) => s + r.amount, 0n)).toBe(1001n);
        expect(rows[0]).toEqual({ recipient: 'S', role: 'sponsor', amount: 300n + 350n });
        expect(boostPayouts({ amount: 7n, sponsor: 'S', rights: null })).toEqual([{ recipient: 'S', role: 'sponsor', amount: 7n }]);
    });
    it('treats shares that do not sum to one as unresolved', () => {
        const bad = { parcels: [{ parcelId: 'p', complete: true, owners: [{ ownerId: 'a', share: '1/3' }] }] };
        expect(boostPayouts({ amount: 10n, sponsor: 'S', rights: bad })).toEqual([{ recipient: 'S', role: 'sponsor', amount: 10n }]);
    });
});
