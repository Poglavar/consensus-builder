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

    it('states the exact on-chain resolution lifecycle and never treats app expiry as NO', () => {
        const open = view.model({ yesPool: 2n, noPool: 1n, resolved: false });
        expect(view.lifecycle('Active', open)).toMatchObject({ state: 'Open for staking', canStake: true, canResolve: false });
        expect(view.lifecycle('Executed', open)).toMatchObject({ state: 'Ready to resolve YES', canStake: false, canResolve: true, expectedOutcome: 'yes' });
        expect(view.lifecycle('Cancelled', open)).toMatchObject({ state: 'Ready to resolve NO', canStake: false, canResolve: true, expectedOutcome: 'no' });
        expect(view.lifecycle('Expired', open)).toMatchObject({ state: 'Awaiting on-chain cancellation', canStake: false, canResolve: false, expectedOutcome: null });
        expect(view.lifecycle('Expired', open).next).toMatch(/not a terminal status/);
    });

    it('explains both parimutuel winnings and empty-winning-pool refunds', () => {
        const normal = view.model({ yesPool: 2n, noPool: 1n, resolved: true, outcome: 1 });
        expect(view.lifecycle('Executed', normal).next).toMatch(/split the full pool/);
        const refunded = view.model({ yesPool: 0n, noPool: 1n, resolved: true, outcome: 1 });
        expect(view.lifecycle('Executed', refunded).next).toMatch(/reclaim its original stake/);
    });

    it('builds a deduplicated newest-first transaction history for this market only', () => {
        const matching = { action: { type: 'stake', proposalId: 'p1' }, transaction: 'tx1', recordedAt: '2026-09-20T02:00:00Z' };
        const history = view.marketHistory([
            matching,
            { ...matching },
            { action: { type: 'resolve', proposalId: 'p1' }, transaction: 'tx2', recordedAt: '2026-09-20T03:00:00Z' },
            { action: { type: 'pledge', proposalId: 'p1' }, transaction: 'tx-pledge', recordedAt: '2026-09-20T04:00:00Z' },
            { action: { type: 'stake', proposalId: 'other' }, transaction: 'tx-other', recordedAt: '2026-09-20T05:00:00Z' }
        ], ['p1']);
        expect(history.map(event => event.transaction)).toEqual(['tx2', 'tx1']);
    });

    it('requires oracle evidence to match the declared recipe subject and outcome', () => {
        const recipe = {
            id: 'proposal-lifecycle-v1', hash: 'sha256:recipe',
            subject: { proposalAccount: 'p1' }, outcomes: { executed: 'YES', cancelled: 'NO' }
        };
        expect(view.oracleEvidence(recipe, null)).toMatchObject({ tone: 'waiting', label: 'Recipe declared; terminal event pending' });
        expect(view.oracleEvidence(recipe, {
            eventType: 'proposal_lifecycle', outcome: 'executed', subject: { id: 'p1' },
            observedAt: '2026-09-20T01:00:00Z', source: { hash: 'sha256:evidence' }
        })).toMatchObject({ tone: 'success', label: 'YES evidence recorded' });
        expect(view.oracleEvidence(recipe, {
            outcome: 'cancelled', subject: { id: 'other' }, source: { hash: 'sha256:evidence' }
        })).toMatchObject({ tone: 'error' });
        expect(view.oracleEvidence(null, null, 'offline')).toMatchObject({ tone: 'error', detail: 'offline' });
    });
});
