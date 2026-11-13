// The Boost section's pure model (frontend/js/agreement-boost.js): amounts and which actions an agreement offers.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const { model } = createRequire(import.meta.url)('../../frontend/js/agreement-boost.js');

describe('agreement boost model', () => {
    it('parses positive amounts with up to 6 decimals and formats them back', () => {
        expect(model.parseAmount('12.5')).toBe(12_500_000n);
        expect(model.parseAmount('0,25')).toBe(250_000n);
        for (const bad of ['', '0', '-1', '1.1234567', 'abc']) expect(model.parseAmount(bad)).toBeNull();
        expect(model.formatAmount(12_500_000n)).toBe('12.5');
    });
    it('offers Boost only while active, Release after execution, and Refund to donors after cancel or expiry', () => {
        const escrow = { totalDonated: 5_000_000n, totalRefunded: 1_000_000n, donorCount: 2n, released: false };
        const mine = [{ amount: 1_000_000n, refunded: true }, { amount: 2_000_000n, refunded: false }];
        const boosts = [{ token: 'zagreb', symbol: 'ZAGREB', status: 'active', amount: '7000000', boosters: 1 },
            { token: 'zagreb', symbol: 'ZAGREB', status: 'refunded', amount: '9', boosters: 1 }];
        const active = model.boostState({ chainStatus: 'Active', escrow, mine, boosts });
        expect(active).toMatchObject({ canBoost: true, canRelease: false, canRefund: false, usdc: { amount: 4_000_000n, donors: 2 } });
        expect(active.tokens).toEqual([{ token: 'zagreb', symbol: 'ZAGREB', amount: 7_000_000n, boosters: 1 }]);
        expect(model.boostState({ chainStatus: 'Executed', escrow, mine, boosts })).toMatchObject({ canBoost: false, canRelease: true, canRefund: false });
        expect(model.boostState({ chainStatus: 'Executed', escrow: { ...escrow, released: true }, mine, boosts }).canRelease).toBe(false);
        expect(model.boostState({ chainStatus: 'Cancelled', escrow, mine, boosts })).toMatchObject({ canRefund: true, refundable: 2_000_000n });
        expect(model.boostState({ chainStatus: 'Expired', escrow: null, mine: [], boosts: [] })).toMatchObject({ canRefund: false, canRelease: false });
    });
});
