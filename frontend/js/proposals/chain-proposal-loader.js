// Reconstruct a proposal from its on-chain LOCATION (a ChainRef). The shared URL carries only the
// location; this reads the NFT + its metadata JSON and rebuilds the full proposal. Chain-agnostic by
// dispatch: EVM is wired today (composing the existing ChainDataLoader + importOnChainProposal), and
// the Solana/Canton adapters implement the same loadFrom(ref) signature when they land.
//
// Wallet/RPC only, by design: the read goes through ChainDataLoader, which uses the CONNECTED
// WALLET'S provider (no public RPC). No wallet → { ok:false, reason:'chain-unavailable' }, and the
// caller shows a connect-wallet prompt. This never touches the server.

(function (global) {
    'use strict';

    // ipfs:// → a gateway; otherwise defer to the app's resolver if present, else pass through.
    function resolveMetadataUrl(uri) {
        if (!uri) return null;
        if (typeof global.resolveResourceUrl === 'function') {
            try {
                const resolved = global.resolveResourceUrl(uri);
                if (resolved) return resolved;
            } catch (_) { /* fall through */ }
        }
        const s = String(uri);
        if (s.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + s.slice('ipfs://'.length);
        return s;
    }

    async function loadEvmProposal(ref) {
        const loader = global.ChainDataLoader;
        const storage = global.proposalStorage;
        if (!loader || typeof loader.getProposalsByIds !== 'function'
            || !storage || typeof storage.importOnChainProposal !== 'function') {
            return { ok: false, reason: 'chain-unavailable' };
        }

        let rows;
        try {
            rows = await loader.getProposalsByIds(ref.chainId, ref.contract, [ref.tokenId]);
        } catch (error) {
            return { ok: false, reason: 'read-failed', error };
        }
        const row = rows && rows[0];
        if (!row) return { ok: false, reason: 'not-found' };

        // The on-chain imageURI field is actually the metadata URI (see minted-proposals.js).
        let metadata = null;
        const metaUrl = resolveMetadataUrl(row.imageURI);
        if (metaUrl && typeof fetch === 'function') {
            try {
                const resp = await fetch(metaUrl);
                if (resp.ok) metadata = await resp.json();
            } catch (_) { /* reconstruct with what the chain gave us */ }
        }

        const imported = storage.importOnChainProposal({
            ...row,
            chainId: ref.chainId,
            contractAddress: ref.contract,
            metadata,
            lens: row.lens,
            onchain: { chainId: ref.chainId, contractAddress: ref.contract, proposalId: ref.tokenId, metadata }
        });
        return imported ? { ok: true, proposal: imported } : { ok: false, reason: 'import-failed' };
    }

    // Dispatch by chain type → { ok, proposal?, reason? }.
    async function loadChainProposalFromRef(ref) {
        if (!ref || !ref.chainType) return { ok: false, reason: 'bad-ref' };
        switch (ref.chainType) {
            case 'evm':
                return loadEvmProposal(ref);
            case 'solana':
            case 'canton':
                console.warn('[chain-proposal] chain type not wired yet:', ref.chainType);
                return { ok: false, reason: 'chain-not-supported' };
            default:
                return { ok: false, reason: 'unknown-chain' };
        }
    }

    if (typeof window !== 'undefined') {
        window.ChainProposalLoader = { loadChainProposalFromRef, resolveMetadataUrl };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { loadChainProposalFromRef, resolveMetadataUrl };
    }
})(typeof window !== 'undefined' ? window : globalThis);
