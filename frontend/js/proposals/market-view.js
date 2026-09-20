// Pure presentation and amount policy for the proposal-market card. This keeps the browser
// renderer thin and makes the parimutuel numbers independently testable.
(function attachProposalMarketView(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalMarketView = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalMarketViewFactory() {
    'use strict';

    const USDC_DECIMALS = 6;

    function atomic(value) {
        try { return BigInt(value || 0); } catch (_) { return 0n; }
    }

    function formatAtomic(value, decimals = USDC_DECIMALS) {
        const amount = atomic(value);
        const unit = 10n ** BigInt(decimals);
        const whole = amount / unit;
        const fraction = (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole.toString();
    }

    // Decimal input is deliberately parsed without floats, matching the server bettor's USDC
    // conversion. The market program stores u64 atomic units.
    function parseUsdc(value) {
        const text = String(value || '').trim();
        if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Enter a positive USDC amount.');
        const [whole, fraction = ''] = text.split('.');
        if (fraction.length > USDC_DECIMALS) throw new Error('USDC supports at most 6 decimal places.');
        const amount = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS)
            + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0');
        if (amount <= 0n) throw new Error('Enter a positive USDC amount.');
        return amount;
    }

    function percentage(part, total) {
        if (total <= 0n) return null;
        // One decimal place, exactly rounded using integer math.
        return Number((part * 1000n + total / 2n) / total) / 10;
    }

    function model(market, positions = {}) {
        if (!market) return { exists: false };
        const yes = atomic(market.yesPool);
        const no = atomic(market.noPool);
        const total = yes + no;
        const yesPosition = positions.yes || null;
        const noPosition = positions.no || null;
        const resolved = Boolean(market.resolved);
        const outcome = Number(market.outcome);
        const winningSide = outcome === 1 ? 'yes' : 'no';
        const winningPool = winningSide === 'yes' ? yes : no;
        // When nobody backed the eventual winner the on-chain program refunds every position;
        // otherwise only a position on the winning side has a non-zero payout.
        const claimSides = resolved ? [['yes', yesPosition], ['no', noPosition]]
            .filter(([side, position]) => position && !position.claimed && atomic(position.amount) > 0n
                && (winningPool === 0n || side === winningSide))
            .map(([side]) => side) : [];
        return {
            exists: true,
            resolved,
            outcome: resolved ? winningSide : null,
            yesPool: yes,
            noPool: no,
            total,
            yesOdds: percentage(yes, total),
            noOdds: percentage(no, total),
            yesPosition,
            noPosition,
            canClaim: claimSides.length > 0,
            claimSides
        };
    }

    function statusText(status = {}) {
        if (status.state === 'preparing') return 'Checking your wallet and preparing the market transaction…';
        if (status.state === 'awaiting_signature') return 'Approve the market transaction in your wallet…';
        if (status.state === 'submitted') return 'Submitted to Solana; waiting for confirmation…';
        if (status.state === 'confirmed') return 'Confirmed on Solana.';
        return '';
    }

    function errorText(error) {
        if (error?.code === 'WALLET_NOT_CONNECTED') return 'Connect a Solana wallet to trade this market.';
        if (error?.code === 'WRONG_NETWORK') return 'Switch the wallet to Solana devnet and try again.';
        if (error?.code === 'INSUFFICIENT_SOL') return 'This wallet needs devnet SOL to pay the transaction fee.';
        if (error?.code === 'INSUFFICIENT_USDC') return error.message || 'This wallet does not have enough devnet USDC.';
        if (error?.code === 'CONFIRMATION_UNKNOWN') return 'Transaction was submitted, but confirmation is still unknown. Check the transaction before retrying.';
        return error?.reason || error?.shortMessage || error?.message || 'Unknown market transaction error.';
    }

    return { USDC_DECIMALS, formatAtomic, parseUsdc, model, statusText, errorText };
});
