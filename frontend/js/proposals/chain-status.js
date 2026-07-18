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
        let code;
        try { code = Number(statusCode); } catch (_) { return 'Unknown'; }
        if (!Number.isInteger(code) || code < 0 || code >= STATUS_BY_CODE.length) return 'Unknown';
        return STATUS_BY_CODE[code];
    }

    return { STATUS_BY_CODE, decodeProposalStatus };
});
