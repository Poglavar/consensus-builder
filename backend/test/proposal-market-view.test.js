// The bet dialog's pure presentation of an agreement's pool (frontend/js/proposals/market-view.js):
// exact USDC amounts, odds and claims, the signing copy, and the lifecycle words read from the
// agreement account's chain status (executed settles yes; cancelled or expired settles no).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const view = require('../../frontend/js/proposals/market-view.js');

describe('agreement pool presentation', () => {
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

    it('settles from the agreement account: executed yes, cancelled or expired no', () => {
        const open = view.model({ yesPool: 2n, noPool: 1n, resolved: false });
        expect(view.lifecycle('active', open)).toMatchObject({ state: 'Open for bets', stateKey: 'open', canStake: true, canResolve: false });
        expect(view.lifecycle('active', { exists: false })).toMatchObject({ state: 'No pool yet', stateKey: 'needsPool', canOpen: true });
        expect(view.lifecycle('executed', open)).toMatchObject({ state: 'Ready to settle yes', stateKey: 'settleYes', canStake: false, canResolve: true, expectedOutcome: 'yes' });
        expect(view.lifecycle('cancelled', open)).toMatchObject({ state: 'Ready to settle no', stateKey: 'settleNo', canStake: false, canResolve: true, expectedOutcome: 'no' });
        // An agreement whose rule was not met by its deadline is expired on chain; its pool settles no.
        expect(view.lifecycle('expired', open)).toMatchObject({ state: 'Ready to settle no', canStake: false, canResolve: true, expectedOutcome: 'no' });
        expect(view.lifecycle('expired', open).rule).toMatch(/agreement account on Solana: executed settles yes; cancelled or expired settles no/);
        // The index spells the status in lower case; any case reads the same.
        expect(view.lifecycle('Executed', open)).toEqual(view.lifecycle('executed', open));
        expect(view.confirmedText()).toBe('Confirmed on Solana.');
    });

    it('explains both parimutuel winnings and empty-winning-pool refunds', () => {
        const normal = view.model({ yesPool: 2n, noPool: 1n, resolved: true, outcome: 1 });
        expect(view.lifecycle('executed', normal)).toMatchObject({ stateKey: 'settledYes', nextKey: 'settledSplit' });
        expect(view.lifecycle('executed', normal).next).toMatch(/shares the whole pool/);
        const refunded = view.model({ yesPool: 0n, noPool: 1n, resolved: true, outcome: 1 });
        expect(view.lifecycle('executed', refunded)).toMatchObject({ nextKey: 'settledRefund' });
        expect(view.lifecycle('executed', refunded).next).toMatch(/collected back in full/);
    });

    it('allows no new market action without a known chain status', () => {
        for (const status of [undefined, null, 'Unknown', 'unsupported']) {
            for (const market of [null, { yesPool: 2n, noPool: 1n, resolved: false }]) {
                expect(view.lifecycle(status, view.model(market))).toMatchObject({
                    stateKey: 'closed', canOpen: false, canStake: false, canResolve: false
                });
            }
        }
        expect(view.lifecycle(null).next).toMatch(/agreement must be active on-chain, before its deadline/);
    });
});
