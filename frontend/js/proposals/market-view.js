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

    function lifecycle(lifecycleStatus, marketModel = { exists: false }) {
        const status = String(lifecycleStatus || '').trim().toLowerCase();
        const exists = Boolean(marketModel?.exists);
        const resolved = Boolean(marketModel?.resolved);
        const base = {
            rule: 'The market reads the proposal account on Solana: Executed resolves YES; Cancelled resolves NO. Resolution is permissionless.',
            canOpen: !exists && status === 'active',
            canStake: exists && !resolved && status === 'active',
            canResolve: exists && !resolved && (status === 'executed' || status === 'cancelled'),
            expectedOutcome: status === 'executed' ? 'yes' : status === 'cancelled' ? 'no' : null
        };
        if (resolved) {
            const outcome = marketModel.outcome === 'yes' ? 'YES' : 'NO';
            const winningPool = marketModel.outcome === 'yes' ? atomic(marketModel.yesPool) : atomic(marketModel.noPool);
            return {
                ...base, canOpen: false, canStake: false, canResolve: false,
                state: `Resolved ${outcome}`,
                next: winningPool === 0n
                    ? 'Nobody backed the winning outcome, so every unclaimed position can reclaim its original stake.'
                    : 'Winning positions split the full pool pro rata. Losing positions have no payout.'
            };
        }
        if (status === 'executed') return { ...base, state: 'Ready to resolve YES', next: 'Anyone can submit resolution; the program verifies Executed directly from the proposal account.' };
        if (status === 'cancelled') return { ...base, state: 'Ready to resolve NO', next: 'Anyone can submit resolution; the program verifies Cancelled directly from the proposal account.' };
        if (status === 'expired') return {
            ...base, canOpen: false, canStake: false, canResolve: false,
            state: 'Awaiting on-chain cancellation',
            next: 'The app deadline passed, but Expired is not a terminal status understood by this market program. Stakes stay locked until the proposal is cancelled or executed on-chain.'
        };
        if (status === 'active') return {
            ...base,
            state: exists ? 'Open for staking' : 'Ready to open',
            next: exists
                ? 'Stakes are locked while the proposal remains Active. There is no market deadline or early exit.'
                : 'Any wallet can open the single market for this Active proposal, then stake YES or NO.'
        };
        return { ...base, canOpen: false, canStake: false, canResolve: false, state: 'Not tradeable', next: 'The proposal must be Active on-chain before a market can be opened.' };
    }

    function marketHistory(events, proposalIds) {
        const ids = new Set((proposalIds || []).filter(Boolean).map(String));
        const actionTypes = new Set(['createMarket', 'stake', 'resolve', 'claim']);
        const byTransaction = new Map();
        (events || []).forEach(event => {
            const proposalId = event?.entity?.id || event?.action?.proposalId;
            if (!event?.transaction || !actionTypes.has(event?.action?.type) || !ids.has(String(proposalId || ''))) return;
            byTransaction.set(String(event.transaction), event);
        });
        return Array.from(byTransaction.values()).sort((left, right) =>
            (Date.parse(right.recordedAt || right.occurredAt || 0) || 0)
            - (Date.parse(left.recordedAt || left.occurredAt || 0) || 0));
    }

    function oracleEvidence(recipe, event, error = null) {
        if (error) return { tone: 'error', label: 'Oracle evidence feed unavailable', detail: String(error) };
        if (!recipe) return { tone: 'waiting', label: 'Loading oracle recipe', detail: 'The market declaration has not loaded yet.' };
        if (!event) return {
            tone: 'waiting', label: 'Recipe declared; terminal event pending',
            detail: `${recipe.id} · ${recipe.hash}`
        };
        const proposalMatches = String(event.subject?.id || '') === String(recipe.subject?.proposalAccount || '');
        const outcomeMatches = recipe.outcomes?.[event.outcome] === (event.outcome === 'executed' ? 'YES' : 'NO');
        if (!proposalMatches || !outcomeMatches) return {
            tone: 'error', label: 'Oracle evidence does not match this market',
            detail: 'The subject or outcome is outside the declared recipe.'
        };
        return {
            tone: 'success',
            label: `${event.outcome === 'executed' ? 'YES' : 'NO'} evidence recorded`,
            detail: `${event.observedAt || 'source time unavailable'} · ${event.source?.hash || 'source hash unavailable'}`
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

    return { USDC_DECIMALS, formatAtomic, parseUsdc, model, lifecycle, marketHistory, oracleEvidence, statusText, errorText };
});
