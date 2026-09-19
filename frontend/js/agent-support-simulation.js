// Pure state transitions for game-mode proposal support. The UI owns persistence and rendering;
// this module gives algorithmic and future LLM agents the same donation/pledge semantics.
(function attachAgentSupportSimulation(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentSupportSimulation = api;
})(typeof window !== 'undefined' ? window : globalThis, function agentSupportSimulationFactory() {
    'use strict';

    function amount(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('support amount must be positive');
        return Math.round(parsed * 100) / 100;
    }
    function proposalId(proposal) { return String(proposal.proposalId ?? proposal.id ?? proposal.tokenId ?? ''); }
    function ensureAgent(agent) {
        if (!agent?.id) throw new Error('agent is required');
        if (!Number.isFinite(Number(agent.ethBalance))) throw new Error('agent balance is required');
    }
    function donate(proposal, agent, value, supportId) {
        ensureAgent(agent); const donated = amount(value);
        if (Number(agent.ethBalance) < donated) throw new Error('insufficient balance for donation');
        proposal.simulatedDonations = Array.isArray(proposal.simulatedDonations) ? proposal.simulatedDonations : [];
        const id = String(supportId || `${agent.id}:${proposalId(proposal)}:${proposal.simulatedDonations.length + 1}`);
        const existing = proposal.simulatedDonations.find(entry => entry.id === id);
        if (existing) return { replayed: true, donation: existing };
        const donation = { id, agentId: agent.id, amount: donated, status: 'Escrowed' };
        proposal.simulatedDonations.push(donation);
        agent.ethBalance = Math.round((Number(agent.ethBalance) - donated) * 100) / 100;
        proposal.budget = Math.round((Number(proposal.budget ?? proposal.offer ?? 0) + donated) * 100) / 100;
        proposal.offer = proposal.budget;
        return { replayed: false, donation };
    }
    function pledge(proposal, agent, value) {
        ensureAgent(agent); const pledged = amount(value);
        proposal.simulatedPledges = Array.isArray(proposal.simulatedPledges) ? proposal.simulatedPledges : [];
        let commitment = proposal.simulatedPledges.find(entry => entry.agentId === agent.id);
        if (commitment?.status === 'Fulfilled') throw new Error('fulfilled pledge cannot be changed');
        if (!commitment) {
            commitment = { agentId: agent.id, amount: pledged, status: 'Active' };
            proposal.simulatedPledges.push(commitment);
        } else {
            commitment.amount = pledged;
            commitment.status = 'Active';
        }
        return { commitment };
    }
    function settle(proposal, findAgent) {
        const commitments = Array.isArray(proposal.simulatedPledges) ? proposal.simulatedPledges : [];
        let fulfilled = 0; let unfunded = 0;
        for (const commitment of commitments) {
            if (commitment.status !== 'Active') continue;
            const agent = findAgent(commitment.agentId);
            if (!agent || Number(agent.ethBalance) < commitment.amount) {
                commitment.status = 'Unfunded';
                unfunded += 1;
                continue;
            }
            agent.ethBalance = Math.round((Number(agent.ethBalance) - commitment.amount) * 100) / 100;
            proposal.budget = Math.round((Number(proposal.budget ?? proposal.offer ?? 0) + commitment.amount) * 100) / 100;
            proposal.offer = proposal.budget;
            commitment.status = 'Fulfilled';
            fulfilled += 1;
        }
        for (const donation of (proposal.simulatedDonations || [])) {
            if (donation.status === 'Escrowed') donation.status = 'Released';
        }
        return { fulfilled, unfunded };
    }
    function refund(proposal, findAgent) {
        let refunded = 0; let refundedAmount = 0; let voided = 0;
        for (const donation of (proposal.simulatedDonations || [])) {
            if (donation.status !== 'Escrowed') continue;
            const agent = findAgent(donation.agentId);
            if (!agent) continue;
            agent.ethBalance = Math.round((Number(agent.ethBalance) + donation.amount) * 100) / 100;
            proposal.budget = Math.max(0, Math.round((Number(proposal.budget ?? proposal.offer ?? 0) - donation.amount) * 100) / 100);
            proposal.offer = proposal.budget;
            donation.status = 'Refunded';
            refunded += 1; refundedAmount += donation.amount;
        }
        for (const commitment of (proposal.simulatedPledges || [])) {
            if (commitment.status === 'Active' || commitment.status === 'Unfunded') {
                commitment.status = 'Voided';
                voided += 1;
            }
        }
        return { refunded, refundedAmount: Math.round(refundedAmount * 100) / 100, voided };
    }

    return { donate, pledge, settle, refund };
});
