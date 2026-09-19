// Pure presentation policy for proposal-support controls. Chain reads stay in pledge-bridge;
// this module only decides which actions make sense for the connected wallet and lifecycle.
(function attachProposalSupportView(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalSupportView = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalSupportViewFactory() {
    'use strict';

    const PLEDGE_ACTIVE = 0;

    function positive(value) {
        try { return BigInt(value || 0) > 0n; } catch (_) { return false; }
    }

    function hasRefundableDonation(summary) {
        return (summary?.myDonations || []).some(position => position && !position.refunded && positive(position.amount));
    }

    function hasUnreleasedDonations(summary) {
        const escrow = summary?.donations;
        if (!escrow || escrow.released) return false;
        const donated = BigInt(escrow.totalDonated || 0);
        const refunded = BigInt(escrow.totalRefunded || 0);
        return donated > refunded;
    }

    function hasActivePledge(summary) {
        return summary?.myPledge?.status === PLEDGE_ACTIVE && positive(summary.myPledge.amount);
    }

    function actionKeys({ lifecycle, walletConnected, summary = null, summaryReady = false } = {}) {
        if (!walletConnected) return ['connect'];
        if (lifecycle === 'Active') {
            return ['donate', 'pledge', ...(summaryReady && hasActivePledge(summary) ? ['revokePledge'] : [])];
        }
        if (!summaryReady) return [];
        if (lifecycle === 'Executed') {
            return [
                ...(hasUnreleasedDonations(summary) ? ['releaseDonations'] : []),
                ...(hasActivePledge(summary) ? ['fulfillPledge'] : [])
            ];
        }
        if (lifecycle === 'Cancelled' || lifecycle === 'Expired') {
            return [
                ...(hasRefundableDonation(summary) ? ['refundMyDonations'] : []),
                ...(hasActivePledge(summary) ? ['voidPledge'] : [])
            ];
        }
        return [];
    }

    return { actionKeys, hasActivePledge, hasRefundableDonation, hasUnreleasedDonations };
});
