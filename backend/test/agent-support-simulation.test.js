// Locks game-mode donation escrow, soft pledge, settlement and refund semantics.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const support = require('../../frontend/js/agent-support-simulation.js');
const ethSupport = amount => ({ amount, currency: 'ETH', basis: 'simulated-agent-eth-balance' });

describe('agent support simulation', () => {
    it('keeps absent balances and invalid amounts from becoming real money', () => {
        for (const ethBalance of [null, undefined, '', NaN]) {
            expect(() => support.donate({}, { id: 'a1', ethBalance }, ethSupport(2))).toThrow(/balance/);
        }
        for (const value of [null, true, '2', 0.001]) {
            expect(() => support.pledge({}, { id: 'a1', ethBalance: 10 }, ethSupport(value))).toThrow(/amount/);
        }
        const proposal = { simulatedPledges: [{ agentId: 'a1', ...ethSupport(5), status: 'Active' }] };
        const agent = { id: 'a1', ethBalance: null };
        expect(support.settle(proposal, () => agent)).toEqual({ fulfilled: 0, unfunded: 0, unsupported: 1 });
        expect(agent.ethBalance).toBeNull();
        expect(proposal.simulatedPledges[0].status).toBe('Active');
    });
    it('records explicit ETH support without changing authored proposal money terms', () => {
        const proposal = { proposalId: 'p1', budget: 0 };
        const agent = { id: 'a1', ethBalance: 100 };
        support.donate(proposal, agent, ethSupport(5), 'd1');
        support.pledge(proposal, agent, ethSupport(80));
        expect(agent.ethBalance).toBe(95);
        expect(proposal.budget).toBe(0);
        expect(proposal.simulatedDonations[0]).toMatchObject({ amount: 5, currency: 'ETH', basis: 'simulated-agent-eth-balance', status: 'Escrowed' });
        expect(proposal.simulatedPledges[0]).toMatchObject({ amount: 80, currency: 'ETH', basis: 'simulated-agent-eth-balance', status: 'Active' });
        expect(support.settle(proposal, id => id === agent.id ? agent : null)).toEqual({ fulfilled: 1, unfunded: 0, unsupported: 0 });
        expect(agent.ethBalance).toBe(15);
        expect(proposal.budget).toBe(0);
        expect(proposal.offer).toBeUndefined();
        expect(proposal.simulatedDonations[0].status).toBe('Released');
    });

    it('allows overcommitment and lets the first executed proposal consume the budget', () => {
        const agent = { id: 'a1', ethBalance: 10 };
        const first = { proposalId: 'first', budget: 0 }; const second = { proposalId: 'second', budget: 0 };
        support.pledge(first, agent, ethSupport(10)); support.pledge(second, agent, ethSupport(10));
        support.settle(first, () => agent); support.settle(second, () => agent);
        expect(first.simulatedPledges[0].status).toBe('Fulfilled');
        expect(second.simulatedPledges[0].status).toBe('Unfunded');
        expect(agent.ethBalance).toBe(0);
    });

    it('refunds escrowed donations and voids pledges on terminal failure', () => {
        const proposal = { proposalId: 'p1', budget: 2 };
        const agent = { id: 'a1', ethBalance: 8 };
        support.donate(proposal, agent, ethSupport(2), 'd1'); support.pledge(proposal, agent, ethSupport(10));
        expect(support.refund(proposal, () => agent)).toEqual({ refunded: 1, refundedAmount: 2, voided: 1, unsupported: 0 });
        expect(agent.ethBalance).toBe(8);
        expect(proposal.budget).toBe(2);
        expect(proposal.offer).toBeUndefined();
        expect(proposal.simulatedDonations[0].status).toBe('Refunded');
        expect(proposal.simulatedPledges[0].status).toBe('Voided');
    });

    it('does not settle or refund support whose currency and basis are not explicit ETH simulation terms', () => {
        const proposal = {
            offer: 500,
            offerCurrency: 'EUR',
            budget: 250,
            budgetCurrency: 'USD',
            simulatedPledges: [{ agentId: 'a1', amount: 4, status: 'Active' }],
            simulatedDonations: [{ id: 'old', agentId: 'a1', amount: 3, status: 'Escrowed' }]
        };
        const agent = { id: 'a1', ethBalance: 10 };

        expect(support.settle(proposal, () => agent)).toEqual({ fulfilled: 0, unfunded: 0, unsupported: 2 });
        expect(support.refund(proposal, () => agent)).toEqual({ refunded: 0, refundedAmount: 0, voided: 1, unsupported: 1 });
        expect(agent.ethBalance).toBe(10);
        expect(proposal).toMatchObject({
            offer: 500,
            offerCurrency: 'EUR',
            budget: 250,
            budgetCurrency: 'USD',
            simulatedPledges: [{ status: 'Voided' }],
            simulatedDonations: [{ status: 'Escrowed' }]
        });
    });

    it('rejects incoming support amounts without explicit matching ETH currency and basis', () => {
        const proposal = {};
        const agent = { id: 'a1', ethBalance: 10 };

        expect(() => support.donate(proposal, agent, 3, 'd1')).toThrow(/explicit matching ETH simulation currency and basis/);
        expect(() => support.pledge(proposal, agent, { amount: 2, currency: 'USD', basis: 'simulated-agent-eth-balance' })).toThrow(/explicit matching ETH simulation currency and basis/);
        expect(agent.ethBalance).toBe(10);
        expect(proposal.simulatedDonations).toBeUndefined();
        expect(proposal.simulatedPledges).toBeUndefined();
    });
});
