// Locks game-mode donation escrow, soft pledge, settlement and refund semantics.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const support = require('../../frontend/js/agent-support-simulation.js');

describe('agent support simulation', () => {
    it('funds donations immediately but leaves pledges unfunded until execution', () => {
        const proposal = { proposalId: 'p1', budget: 0 };
        const agent = { id: 'a1', ethBalance: 100 };
        support.donate(proposal, agent, 5, 'd1');
        support.pledge(proposal, agent, 80);
        expect(agent.ethBalance).toBe(95);
        expect(proposal.budget).toBe(5);
        expect(proposal.simulatedPledges[0]).toMatchObject({ amount: 80, status: 'Active' });
        expect(support.settle(proposal, id => id === agent.id ? agent : null)).toEqual({ fulfilled: 1, unfunded: 0 });
        expect(agent.ethBalance).toBe(15);
        expect(proposal.budget).toBe(85);
        expect(proposal.simulatedDonations[0].status).toBe('Released');
    });

    it('allows overcommitment and lets the first executed proposal consume the budget', () => {
        const agent = { id: 'a1', ethBalance: 10 };
        const first = { proposalId: 'first', budget: 0 }; const second = { proposalId: 'second', budget: 0 };
        support.pledge(first, agent, 10); support.pledge(second, agent, 10);
        support.settle(first, () => agent); support.settle(second, () => agent);
        expect(first.simulatedPledges[0].status).toBe('Fulfilled');
        expect(second.simulatedPledges[0].status).toBe('Unfunded');
        expect(agent.ethBalance).toBe(0);
    });

    it('refunds escrowed donations and voids pledges on terminal failure', () => {
        const proposal = { proposalId: 'p1', budget: 2 };
        const agent = { id: 'a1', ethBalance: 8 };
        support.donate(proposal, agent, 2, 'd1'); support.pledge(proposal, agent, 10);
        expect(support.refund(proposal, () => agent)).toEqual({ refunded: 1, refundedAmount: 2, voided: 1 });
        expect(agent.ethBalance).toBe(8);
        expect(proposal.simulatedDonations[0].status).toBe('Refunded');
        expect(proposal.simulatedPledges[0].status).toBe('Voided');
    });
});
