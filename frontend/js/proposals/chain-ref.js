// A unified proposal URL scheme. Server proposals stay /proposals/<numericId>; on-chain proposals
// get /proposals/<chainType>/<chainId>/<contract>/<tokenId> — one route space for both, and one that
// is chain-agnostic (evm | solana | canton | ...). Only the LOCATION is in the URL; the recipient's
// frontend reads the NFT and reconstructs the proposal from its metadata (chain-proposal-loader.js).
//
// Pure string parsing — no chain, no DOM — so it is unit-tested headless.

(function (global) {
    'use strict';

    const CHAIN_TYPES = ['evm', 'solana', 'canton'];

    // /proposals/evm/84532/0x6c3…/5 → { chainType:'evm', chainId:'84532', contract:'0x6c3…', tokenId:'5' }
    // Returns null for a server path (/proposals/12) or anything malformed.
    function parseChainProposalRef(pathname) {
        const m = String(pathname || '').match(/^\/proposals\/([a-z0-9-]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
        if (!m) return null;
        const chainType = m[1].toLowerCase();
        if (!CHAIN_TYPES.includes(chainType)) return null;
        const chainId = m[2];
        const contract = m[3];
        const tokenId = m[4]; // last segment; the earlier two are single path segments
        if (!chainId || !contract || !tokenId) return null;
        return { chainType, chainId, contract, tokenId };
    }

    // { chainType, chainId, contract, tokenId } → /proposals/<chainType>/<chainId>/<contract>/<tokenId>
    function buildChainProposalPath(ref) {
        if (!ref) return null;
        const { chainType, chainId, contract, tokenId } = ref;
        if (!chainType || !CHAIN_TYPES.includes(String(chainType).toLowerCase())) return null;
        if (chainId == null || !contract || tokenId == null || tokenId === '') return null;
        return `/proposals/${String(chainType).toLowerCase()}/${chainId}/${contract}/${tokenId}`;
    }

    // Build a ChainRef from a proposal's stored on-chain fields (nft.* preferred, then onchain.*).
    // Chain type is explicit if the proposal carries it; otherwise it's inferred from the chainId —
    // Solana stores it as "solana-<cluster>" (see create.js), everything else is treated as EVM.
    function chainRefFromProposal(proposal) {
        if (!proposal) return null;
        const nft = proposal.nft || {};
        const onchain = proposal.onchain || {};
        const rawChainId = nft.chain ?? nft.chainId ?? onchain.chainId ?? proposal.chainId ?? null;
        const contract = nft.contract ?? onchain.contractAddress ?? proposal.contractAddress ?? null;
        const tokenId = nft.tokenId ?? onchain.proposalId ?? onchain.tokenId ?? proposal.tokenId ?? null;
        if (rawChainId == null || !contract || tokenId == null || tokenId === '') return null;

        const chainIdStr = String(rawChainId);
        let chainType = proposal.chainType || onchain.chainType || null;
        let chainId = chainIdStr;
        if (!chainType) {
            if (/^solana/i.test(chainIdStr)) {
                chainType = 'solana';
                chainId = chainIdStr.replace(/^solana-/i, ''); // the cluster (devnet / mainnet-beta)
            } else if (/^canton/i.test(chainIdStr)) {
                chainType = 'canton';
                chainId = chainIdStr.replace(/^canton-/i, ''); // the Canton network/domain (e.g. devnet)
            } else {
                chainType = 'evm';
            }
        }
        if (!CHAIN_TYPES.includes(chainType)) return null;
        // Stored receipts carry a namespaced network even when chainType is explicit. URLs and
        // wallet readers take the bare cluster/domain in both cases.
        if (chainType === 'solana') chainId = chainIdStr.replace(/^solana-/i, '');
        if (chainType === 'canton') chainId = chainIdStr.replace(/^canton-/i, '');
        return { chainType, chainId, contract: String(contract), tokenId: String(tokenId) };
    }

    // Return a proposal account only when this complete ChainRef names the configured Solana
    // deployment. A cluster label or token-like field alone is not enough to scope chain reads.
    function solanaAccountForDeployment(proposal, programId, cluster = 'devnet') {
        if (typeof programId !== 'string' || programId.length === 0) return null;
        const ref = chainRefFromProposal(proposal);
        if (!ref || ref.chainType !== 'solana' || ref.chainId !== cluster || ref.contract !== programId) return null;
        return ref.tokenId;
    }

    // Equality is scoped by chain family, network, program/contract and token/account. EVM's
    // hexadecimal addresses are case-insensitive; Solana and Canton identifiers are not.
    function identityKey(ref) {
        if (!ref || !CHAIN_TYPES.includes(ref.chainType)) return null;
        let { chainType, chainId, contract, tokenId } = ref;
        if ([chainId, contract, tokenId].some(value => value == null || String(value).trim() === '')) return null;
        chainId = String(chainId);
        contract = String(contract);
        tokenId = String(tokenId);
        if (chainType === 'evm') {
            if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(chainId) || !/^(?:0x[0-9a-f]+|\d+)$/i.test(tokenId)) return null;
            chainId = BigInt(chainId).toString();
            tokenId = BigInt(tokenId).toString();
            if (chainId === '0') return null;
            contract = contract.toLowerCase();
        } else {
            chainId = chainId.replace(new RegExp(`^${chainType}-`), '');
            if (!chainId || chainId === chainType) return null;
        }
        return JSON.stringify([chainType, chainId, contract, tokenId]);
    }

    function sameReference(left, right) {
        const key = identityKey(left);
        return key !== null && key === identityKey(right);
    }

    function findByReference(proposals, ref) {
        if (!identityKey(ref)) throw new Error('A complete chain proposal reference is required.');
        const matches = (proposals || []).filter(proposal => sameReference(chainRefFromProposal(proposal), ref));
        if (matches.length > 1) throw new Error('Multiple local records name the same chain proposal.');
        return matches[0] || null;
    }

    const api = { parseChainProposalRef, buildChainProposalPath, chainRefFromProposal, solanaAccountForDeployment, identityKey, sameReference, findByReference, CHAIN_TYPES };

    if (typeof window !== 'undefined') {
        window.ChainProposalRef = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
