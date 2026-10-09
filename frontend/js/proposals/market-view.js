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

    // The card's lifecycle words. Each text comes with a key so the panel can translate it; the English
    // here is the fallback and what the tests pin.
    const RULE = 'The pool reads the proposal account on Solana: executed settles yes; cancelled or expired settles no. Anyone can settle it.';
    const STATE = {
        open: 'Open for bets', needsPool: 'No pool yet', settleYes: 'Ready to settle yes', settleNo: 'Ready to settle no',
        settledYes: 'Settled yes', settledNo: 'Settled no', closed: 'Not open for bets'
    };
    const NEXT = {
        open: 'Bets stay in the pool while the proposal is active; there is no early exit.',
        needsPool: 'Any wallet can open the one pool for this active proposal, then bet yes or no.',
        settleYes: 'Anyone can settle it; the program reads Executed straight from the proposal account.',
        settleNo: 'Anyone can settle it; the program reads the dropped status straight from the proposal account.',
        settledSplit: 'The winning side shares the whole pool in proportion to its bets. The losing side gets nothing.',
        settledRefund: 'Nobody bet on the winning side, so every bet can be collected back in full.',
        closed: 'The proposal must be active on-chain before a pool can open.'
    };
    function lifecycle(lifecycleStatus, marketModel = { exists: false }) {
        const status = String(lifecycleStatus || '').trim().toLowerCase();
        const exists = Boolean(marketModel?.exists);
        const resolved = Boolean(marketModel?.resolved);
        const terminalNo = status === 'cancelled' || status === 'expired';
        const base = {
            rule: RULE, ruleKey: 'rule',
            canOpen: !exists && status === 'active',
            canStake: exists && !resolved && status === 'active',
            // Expired is terminal since market v2 (a lens member's expired verdict) and resolves NO
            // like Cancelled; the program checks the proposal account, so an app-side expiry that has
            // not reached the chain simply fails the transaction instead of paying anyone.
            canResolve: exists && !resolved && (status === 'executed' || terminalNo),
            expectedOutcome: status === 'executed' ? 'yes' : terminalNo ? 'no' : null
        };
        const words = (stateKey, nextKey) => ({ stateKey, state: STATE[stateKey], nextKey, next: NEXT[nextKey] });
        if (resolved) {
            const winningPool = marketModel.outcome === 'yes' ? atomic(marketModel.yesPool) : atomic(marketModel.noPool);
            return {
                ...base, canOpen: false, canStake: false, canResolve: false,
                ...words(marketModel.outcome === 'yes' ? 'settledYes' : 'settledNo', winningPool === 0n ? 'settledRefund' : 'settledSplit')
            };
        }
        if (status === 'executed') return { ...base, ...words('settleYes', 'settleYes') };
        if (terminalNo) return { ...base, ...words('settleNo', 'settleNo') };
        if (status === 'active') return { ...base, ...words(exists ? 'open' : 'needsPool', exists ? 'open' : 'needsPool') };
        return { ...base, canOpen: false, canStake: false, canResolve: false, ...words('closed', 'closed') };
    }

    // What every confirmed transaction says; the specs wait for it.
    function confirmedText() {
        return 'Confirmed on Solana.';
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
        if (status.state === 'confirmed') return confirmedText();
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

    return { USDC_DECIMALS, formatAtomic, parseUsdc, model, lifecycle, confirmedText, marketHistory, oracleEvidence, statusText, errorText };
});
