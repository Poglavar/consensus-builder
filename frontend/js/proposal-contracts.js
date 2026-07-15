// Which ProposalNFT contracts to read for the current city. A city may declare its own in
// cityConfig.blockchain.proposalContracts (an array of { chainId, contractAddress }); when it does
// not, we fall back to the global deployed test contract (Base Sepolia, chain 84532) so the
// blockchain features still work everywhere. All reads that use this are wallet-gated elsewhere —
// this only decides the address list, it does not touch the chain.

(function (global) {
    'use strict';

    // The deployed test ProposalNFT (Base Sepolia). Matches DEFAULT_ADDRESSES in blockchain-proposals.js.
    const DEFAULT_PROPOSAL_CONTRACTS = [
        { chainId: '84532', contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709' }
    ];

    // Returns [{ chainId, contractAddress }]. Per-city config wins; otherwise the global fallback
    // (pass a custom fallback to override the Base Sepolia default).
    function resolveProposalContracts(cityConfig, fallback) {
        const configured = cityConfig && cityConfig.blockchain && cityConfig.blockchain.proposalContracts;
        if (Array.isArray(configured)) {
            const valid = configured.filter(c => c && c.chainId != null && c.contractAddress);
            if (valid.length) return valid;
        }
        return (Array.isArray(fallback) && fallback.length) ? fallback : DEFAULT_PROPOSAL_CONTRACTS;
    }

    const api = { resolveProposalContracts, DEFAULT_PROPOSAL_CONTRACTS };

    if (typeof window !== 'undefined') {
        window.ProposalContracts = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
