// Shared dated agreement-market rules and exact quotes. Points, UI and API use this contract;
// the Solana program implements the same cutoff and payout rules in lmsr_market.rs.
(function attach(root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./lmsr.js') : root.Lmsr);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BettingContract = api;
})(typeof window !== 'undefined' ? window : globalThis, function (lmsr) {
    'use strict';
    const DEFAULT_B = 100_000_000n;
    const GRACE_SECONDS = 0;
    const ASSETS = ['points', 'devnet-usdc'];
    const STATUSES = ['active', 'executed', 'cancelled', 'expired'];
    const fail = message => { throw new Error(message); };
    const seconds = (value, name) => Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} must be unix seconds`);
    const atomic = value => {
        if (typeof value === 'bigint' && value >= 0n && value <= lmsr.MAX_QUANTITY) return value;
        if (typeof value === 'string' && /^\d+$/.test(value)) return atomic(BigInt(value));
        return fail('An atomic quantity is required');
    };
    function parseAmount(value) {
        const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
        if (!match) return fail('Use a positive amount with up to six decimal places.');
        const result = atomic(BigInt(match[1]) * 1_000_000n + BigInt((match[2] || '').padEnd(6, '0')));
        if (result === 0n) return fail('The amount must be positive.');
        return result;
    }
    function terms(market) {
        const closesAt = seconds(market.closesAt, 'closesAt');
        if (!closesAt) return fail('A market deadline is required');
        const graceSeconds = seconds(market.graceSeconds, 'graceSeconds');
        if (!Number.isSafeInteger(closesAt + graceSeconds)) return fail('Market deadline overflow');
        return { closesAt, graceSeconds };
    }
    function executionOutcome(source, market, nowSeconds) {
        const { closesAt, graceSeconds } = terms(market);
        const now = seconds(nowSeconds, 'now');
        if (!STATUSES.includes(source.chainStatus)) return fail('Agreement status is unknown');
        if (source.chainStatus === 'executed') {
            const executedAt = seconds(source.executedAt, 'executedAt');
            if (!executedAt || executedAt > now) return fail('Agreement execution time is invalid');
            return executedAt <= closesAt ? 'yes' : 'no';
        }
        if (source.chainStatus === 'cancelled') return 'void';
        if (source.chainStatus === 'expired') return 'no';
        return now >= closesAt + graceSeconds ? 'no' : null;
    }
    function canTrade(source, market, nowSeconds) {
        const { closesAt } = terms(market);
        return !market.resolved && source.chainStatus === 'active' && seconds(nowSeconds, 'now') < closesAt;
    }
    function payout(side, shares, outcome) {
        const held = atomic(shares);
        if (!['yes', 'no'].includes(side) || !['yes', 'no', 'void'].includes(outcome)) return fail('Unknown side or outcome');
        return outcome === 'void' ? held / 2n : side === outcome ? held : 0n;
    }
    function quote(market, side, amount, action = 'buy') {
        if (market?.model !== 'lmsr') return fail('An LMSR market is required');
        const b = atomic(market.b), qYes = atomic(market.qYes), qNo = atomic(market.qNo);
        const requested = atomic(amount);
        if (!requested) return fail('The amount must be positive');
        if (action !== 'buy' && action !== 'sell') return fail('Unknown trade action');
        const shares = action === 'buy' ? lmsr.sharesForBudget(b, qYes, qNo, side, requested) : requested;
        const cost = action === 'buy' ? lmsr.buyCost(b, qYes, qNo, side, shares) : lmsr.sellReturn(b, qYes, qNo, side, shares);
        if (!shares || !cost) return fail('The amount is too small for a trade');
        return { action, side, shares, amount: cost,
            ...(action === 'buy' ? { maxCost: cost } : { minReturn: cost }),
            priceAfter: lmsr.chance(b, side === 'yes' ? qYes + (action === 'buy' ? shares : -shares) : qYes,
                side === 'no' ? qNo + (action === 'buy' ? shares : -shares) : qNo, side) };
    }
    return { DEFAULT_B, GRACE_SECONDS, ASSETS, STATUSES, atomic, parseAmount, terms, executionOutcome, canTrade, payout, quote };
});
