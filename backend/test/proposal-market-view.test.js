import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const view = require('../../frontend/js/proposals/market-view.js');

describe('proposal market presentation', () => {
    it('renders exact USDC amounts and rejects lossy stake input', () => {
        expect(view.formatAtomic(1_250_000n)).toBe('1.25');
        expect(view.parseUsdc('0.000001')).toBe(1n);
        expect(() => view.parseUsdc('0')).toThrow(/positive/);
        expect(() => view.parseUsdc('1.1234567')).toThrow(/6 decimal/);
        expect(() => view.parseUsdc('1e2')).toThrow(/positive/);
    });

    it('derives pools, odds, wallet positions, and claim eligibility without floats', () => {
        const active = view.model({ yesPool: 2_000_000n, noPool: 1_000_000n, resolved: false }, {
            yes: { amount: 750_000n, claimed: false }, no: null
        });
        expect(active).toMatchObject({ exists: true, total: 3_000_000n, yesOdds: 66.7, noOdds: 33.3, canClaim: false });
        const resolved = view.model({ yesPool: 2_000_000n, noPool: 1_000_000n, resolved: true, outcome: 1 }, {
            yes: { amount: 750_000n, claimed: false }, no: { amount: 50_000n, claimed: false }
        });
        expect(resolved).toMatchObject({ resolved: true, outcome: 'yes', canClaim: true, claimSides: ['yes'] });
        expect(view.model(null)).toEqual({ exists: false });
    });

    it('gives every signing state and uncertain confirmation actionable copy', () => {
        expect(view.statusText({ state: 'awaiting_signature' })).toMatch(/Approve/);
        expect(view.statusText({ state: 'submitted' })).toMatch(/waiting for confirmation/);
        expect(view.errorText({ code: 'CONFIRMATION_UNKNOWN' })).toMatch(/Check the transaction/);
    });
});
