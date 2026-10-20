// Canonical decoder for the ProposalStatus enum shared by the EVM and Solana proposal programs.
// Both contracts deliberately use the same ordinal order. Keep every browser adapter on this one
// codec so a stale private lookup table cannot reinterpret an on-chain lifecycle transition.
(function attachProposalChainStatus(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalChainStatus = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalChainStatusFactory() {
    'use strict';

    const STATUS_BY_CODE = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);

    function decodeProposalStatus(statusCode) {
        if (!['number', 'bigint', 'string'].includes(typeof statusCode)
            || (typeof statusCode === 'string' && !/^[0-9]+$/.test(statusCode.trim()))) return 'Unknown';
        let code;
        try { code = Number(statusCode); } catch (_) { return 'Unknown'; }
        if (!Number.isInteger(code) || code < 0 || code >= STATUS_BY_CODE.length) return 'Unknown';
        return STATUS_BY_CODE[code];
    }

    function evmId(value) {
        if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
        if (!['number', 'bigint', 'string'].includes(typeof value)
            || !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(String(value).trim())) return null;
        try { return BigInt(value).toString(); } catch (_) { return null; }
    }

    // Accept only the status read at the confirmed transaction block for the same NFT. A record
    // can change while the wallet is open, so both its submitted and current identity must match.
    function confirmedAcceptanceLifecycle(result, submittedNft, currentNft) {
        const chainId = evmId(result?.chainId);
        const tokenId = evmId(result?.proposalId);
        const contract = String(result?.contractAddress || '').toLowerCase();
        if (!chainId || chainId === '0' || tokenId === null || !/^0x[0-9a-f]{40}$/.test(contract)
            || !Number.isSafeInteger(result?.blockNumber) || result.blockNumber < 0
            || result.lifecycle?.blockNumber !== result.blockNumber) return null;
        for (const nft of [submittedNft, currentNft]) {
            if (!nft || evmId(nft.chain) !== chainId || evmId(nft.tokenId) !== tokenId
                || String(nft.contract || '').toLowerCase() !== contract) return null;
        }
        const status = decodeProposalStatus(result.lifecycle.statusCode);
        return status === 'Unknown' ? null : status;
    }

    return { STATUS_BY_CODE, decodeProposalStatus, confirmedAcceptanceLifecycle };
});
