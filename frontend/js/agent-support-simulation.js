// Pure state transitions for game-mode proposal support. The UI owns persistence and rendering;
// this module gives algorithmic and future LLM agents the same donation/pledge semantics.
(function attachAgentSupportSimulation(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentSupportSimulation = api;
})(typeof window !== 'undefined' ? window : globalThis, function agentSupportSimulationFactory() {
    'use strict';

    const SUPPORT_CURRENCY = 'ETH';
    const SUPPORT_BASIS = 'simulated-agent-eth-balance';

    function amount(terms) {
        if (terms?.currency !== SUPPORT_CURRENCY || terms?.basis !== SUPPORT_BASIS) {
            throw new Error('support amount needs explicit matching ETH simulation currency and basis');
        }
        const parsed = terms.amount;
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('support amount must be positive');
        const rounded = Math.round(parsed * 100) / 100;
        if (rounded <= 0) throw new Error('support amount is below the simulation precision');
        return rounded;
    }
    function proposalId(proposal) { return String(proposal.proposalId ?? proposal.id ?? proposal.tokenId ?? ''); }
    function ensureAgent(agent) {
        if (!agent?.id) throw new Error('agent is required');
        if (!Number.isFinite(agent.ethBalance) || agent.ethBalance < 0) throw new Error('agent balance is required');
    }
    function hasSupportedMoney(record) {
        return record?.currency === SUPPORT_CURRENCY
            && record?.basis === SUPPORT_BASIS
            && Number.isFinite(record.amount)
            && record.amount > 0;
    }
    function donate(proposal, agent, terms, supportId) {
        ensureAgent(agent); const donated = amount(terms);
        if (Number(agent.ethBalance) < donated) throw new Error('insufficient balance for donation');
        proposal.simulatedDonations = Array.isArray(proposal.simulatedDonations) ? proposal.simulatedDonations : [];
        const id = String(supportId || `${agent.id}:${proposalId(proposal)}:${proposal.simulatedDonations.length + 1}`);
        const existing = proposal.simulatedDonations.find(entry => entry.id === id);
        if (existing) return { replayed: true, donation: existing };
        const donation = { id, agentId: agent.id, amount: donated, currency: SUPPORT_CURRENCY, basis: SUPPORT_BASIS, status: 'Escrowed' };
        proposal.simulatedDonations.push(donation);
        agent.ethBalance = Math.round((Number(agent.ethBalance) - donated) * 100) / 100;
        return { replayed: false, donation };
    }
    function pledge(proposal, agent, terms) {
        ensureAgent(agent); const pledged = amount(terms);
        proposal.simulatedPledges = Array.isArray(proposal.simulatedPledges) ? proposal.simulatedPledges : [];
        let commitment = proposal.simulatedPledges.find(entry => entry.agentId === agent.id);
        if (commitment?.status === 'Fulfilled') throw new Error('fulfilled pledge cannot be changed');
        if (!commitment) {
            commitment = { agentId: agent.id, amount: pledged, currency: SUPPORT_CURRENCY, basis: SUPPORT_BASIS, status: 'Active' };
            proposal.simulatedPledges.push(commitment);
        } else {
            commitment.amount = pledged;
            commitment.currency = SUPPORT_CURRENCY;
            commitment.basis = SUPPORT_BASIS;
            commitment.status = 'Active';
        }
        return { commitment };
    }
    function settle(proposal, findAgent) {
        const commitments = Array.isArray(proposal.simulatedPledges) ? proposal.simulatedPledges : [];
        let fulfilled = 0; let unfunded = 0; let unsupported = 0;
        for (const commitment of commitments) {
            if (commitment.status !== 'Active') continue;
            if (!hasSupportedMoney(commitment)) { unsupported += 1; continue; }
            const agent = findAgent(commitment.agentId);
            if (agent && (!Number.isFinite(agent.ethBalance) || agent.ethBalance < 0)) { unsupported += 1; continue; }
            if (!agent || Number(agent.ethBalance) < commitment.amount) {
                commitment.status = 'Unfunded';
                unfunded += 1;
                continue;
            }
            agent.ethBalance = Math.round((Number(agent.ethBalance) - commitment.amount) * 100) / 100;
            commitment.status = 'Fulfilled';
            fulfilled += 1;
        }
        for (const donation of (proposal.simulatedDonations || [])) {
            if (donation.status !== 'Escrowed') continue;
            if (!hasSupportedMoney(donation)) { unsupported += 1; continue; }
            donation.status = 'Released';
        }
        return { fulfilled, unfunded, unsupported };
    }
    function refund(proposal, findAgent) {
        let refunded = 0; let refundedAmount = 0; let voided = 0; let unsupported = 0;
        for (const donation of (proposal.simulatedDonations || [])) {
            if (donation.status !== 'Escrowed') continue;
            if (!hasSupportedMoney(donation)) { unsupported += 1; continue; }
            const agent = findAgent(donation.agentId);
            if (!agent) continue;
            if (!Number.isFinite(agent.ethBalance) || agent.ethBalance < 0) { unsupported += 1; continue; }
            agent.ethBalance = Math.round((Number(agent.ethBalance) + donation.amount) * 100) / 100;
            donation.status = 'Refunded';
            refunded += 1; refundedAmount += donation.amount;
        }
        for (const commitment of (proposal.simulatedPledges || [])) {
            if (commitment.status === 'Active' || commitment.status === 'Unfunded') {
                commitment.status = 'Voided';
                voided += 1;
            }
        }
        return { refunded, refundedAmount: Math.round(refundedAmount * 100) / 100, voided, unsupported };
    }

    return { donate, pledge, settle, refund };
});
