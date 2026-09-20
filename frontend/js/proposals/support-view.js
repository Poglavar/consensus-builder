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

    function statusText(status = {}, kind = 'pledge') {
        const label = kind === 'donate' ? 'donation' : 'pledge';
        if (status.state === 'preparing') return `Checking your wallet and preparing the ${label}…`;
        if (status.state === 'awaiting_signature') return `Approve the ${label} in your wallet…`;
        if (status.state === 'submitted') return 'Submitted to Solana; waiting for confirmation…';
        if (status.state === 'confirmed') return 'Confirmed on Solana.';
        return '';
    }

    function errorText(error, kind = 'pledge') {
        const label = kind === 'donate' ? 'Donation' : 'Pledge';
        if (error?.code === 'INSUFFICIENT_SOL') return 'This wallet needs devnet SOL to pay the transaction fee.';
        if (error?.code === 'INSUFFICIENT_USDC') return error.message || 'This wallet does not have enough devnet USDC.';
        if (error?.code === 'WRONG_NETWORK') return 'Switch the wallet to Solana devnet and try again.';
        if (error?.code === 'CONFIRMATION_UNKNOWN') return `${label} was submitted, but confirmation is still unknown. Check the transaction before retrying.`;
        if (error?.code === 'SIMULATION_FAILED') return `${label} cannot be submitted. Check the wallet balances and proposal state.`;
        return error?.reason || error?.shortMessage || error?.message || 'Unknown error';
    }

    return { actionKeys, hasActivePledge, hasRefundableDonation, hasUnreleasedDonations, statusText, errorText };
});
