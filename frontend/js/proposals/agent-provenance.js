// Pure presentation model for server-verified x402 agent provenance. The UI only calls a proposal
// an agent proposal when it carries both the settlement transaction and the wallet stamped by the
// paid route; a client-supplied `agent.persona` on the free route is not enough.
(function attachProposalAgentProvenance(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalAgentProvenance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProposalAgentProvenance() {
    function cleanText(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    function shorten(value, head = 6, tail = 4) {
        const text = cleanText(value);
        if (!text || text.length <= head + tail + 3) return text;
        return `${text.slice(0, head)}…${text.slice(-tail)}`;
    }

    function solanaExplorerUrl(transaction, network) {
        const tx = cleanText(transaction);
        if (!tx) return null;
        const networkName = cleanText(network) || '';
        let cluster = '';
        if (/devnet|EtWTRABZaYq6iMfeYKouRu166VU2xqa1/i.test(networkName)) cluster = 'devnet';
        else if (/testnet/i.test(networkName)) cluster = 'testnet';
        const suffix = cluster ? `?cluster=${cluster}` : '';
        return `https://explorer.solana.com/tx/${encodeURIComponent(tx)}${suffix}`;
    }

    function read(proposal) {
        const agent = proposal && typeof proposal.agent === 'object' && !Array.isArray(proposal.agent)
            ? proposal.agent
            : null;
        const paid = agent && typeof agent.paid === 'object' && !Array.isArray(agent.paid)
            ? agent.paid
            : null;
        const wallet = cleanText(agent?.wallet);
        const transaction = cleanText(paid?.tx);
        if (!wallet || !transaction) return null;

        const amount = cleanText(paid.amount);
        const amountAtomic = cleanText(paid.amountAtomic);
        return {
            persona: cleanText(agent.persona) || 'Autonomous agent',
            rationale: cleanText(agent.rationale),
            runId: cleanText(agent.run_id),
            wallet,
            walletShort: shorten(wallet),
            paymentId: cleanText(paid.id),
            network: cleanText(paid.network),
            asset: cleanText(paid.asset),
            amount,
            amountAtomic,
            paymentLabel: amount ? `${amount} USDC` : (amountAtomic ? `${amountAtomic} atomic USDC` : 'USDC'),
            transaction,
            transactionShort: shorten(transaction, 8, 6),
            explorerUrl: solanaExplorerUrl(transaction, paid.network)
        };
    }

    return Object.freeze({ read, shorten, solanaExplorerUrl });
});
