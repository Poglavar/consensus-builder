// A unified proposal URL scheme. Server proposals stay /proposals/<numericId>; on-chain proposals
// get /proposals/<chainType>/<chainId>:<contract>:<tokenId> — one route space for both, and one that
// is chain-agnostic (evm | solana | canton | ...). Only the LOCATION is in the URL; the recipient's
// frontend reads the NFT and reconstructs the proposal from its metadata (chain-proposal-loader.js).
//
// Pure string parsing — no chain, no DOM — so it is unit-tested headless.

(function (global) {
    'use strict';

    const CHAIN_TYPES = ['evm', 'solana', 'canton'];

    // /proposals/evm/84532:0x6c3…:5 → { chainType:'evm', chainId:'84532', contract:'0x6c3…', tokenId:'5' }
    // Returns null for a server path (/proposals/12) or anything malformed.
    function parseChainProposalRef(pathname) {
        const m = String(pathname || '').match(/^\/proposals\/([a-z0-9-]+)\/(.+)$/i);
        if (!m) return null;
        const chainType = m[1].toLowerCase();
        if (!CHAIN_TYPES.includes(chainType)) return null;
        // Colons separate the coordinates; the token id may itself contain a ':' on some chains, so
        // only the first two splits are fixed.
        const rest = decodeURIComponent(m[2]);
        const parts = rest.split(':');
        if (parts.length < 3) return null;
        const chainId = parts[0];
        const contract = parts[1];
        const tokenId = parts.slice(2).join(':');
        if (!chainId || !contract || !tokenId) return null;
        return { chainType, chainId, contract, tokenId };
    }

    // { chainType, chainId, contract, tokenId } → /proposals/<chainType>/<chainId>:<contract>:<tokenId>
    function buildChainProposalPath(ref) {
        if (!ref) return null;
        const { chainType, chainId, contract, tokenId } = ref;
        if (!chainType || !CHAIN_TYPES.includes(String(chainType).toLowerCase())) return null;
        if (chainId == null || !contract || tokenId == null || tokenId === '') return null;
        // Colons are valid in a path segment (RFC 3986), so keep the URL readable.
        return `/proposals/${String(chainType).toLowerCase()}/${chainId}:${contract}:${tokenId}`;
    }

    // Build a ChainRef from a proposal's stored on-chain fields (nft.* preferred, then onchain.*).
    function chainRefFromProposal(proposal) {
        if (!proposal) return null;
        const nft = proposal.nft || {};
        const onchain = proposal.onchain || {};
        const chainId = nft.chain ?? nft.chainId ?? onchain.chainId ?? proposal.chainId ?? null;
        const contract = nft.contract ?? onchain.contractAddress ?? proposal.contractAddress ?? null;
        const tokenId = nft.tokenId ?? onchain.proposalId ?? onchain.tokenId ?? proposal.tokenId ?? null;
        if (chainId == null || !contract || tokenId == null || tokenId === '') return null;
        // Only EVM coordinates are inferable here; Solana/Canton adapters will set chainType explicitly.
        const chainType = proposal.chainType || onchain.chainType || 'evm';
        return { chainType, chainId: String(chainId), contract: String(contract), tokenId: String(tokenId) };
    }

    const api = { parseChainProposalRef, buildChainProposalPath, chainRefFromProposal, CHAIN_TYPES };

    if (typeof window !== 'undefined') {
        window.ChainProposalRef = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
