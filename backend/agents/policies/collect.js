// Collecting fixed LMSR share payouts, shared by every society role. A terminal agreement or an
// elapsed market deadline can make an unresolved market eligible for permissionless resolution.
import { createRequire } from 'node:module';
import { agreementName, firstFitting } from './common.js';
import { positionKey } from './history.js';

const require = createRequire(import.meta.url);
const contract = require('../../../frontend/js/bets/betting-contract.js');

const OUTCOME = Object.freeze({ 0: 'no', 1: 'yes', 2: 'void' });
const SIDE = Object.freeze({ yes: 1, no: 0 });

export function settlement(market, agreement, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!market || !agreement) return null;
    if (market.resolved) {
        const outcome = OUTCOME[market.outcome];
        return outcome ? { outcome, resolveFirst: false } : null;
    }
    const status = String(agreement?.chainStatus || '').toLowerCase();
    const source = { chainStatus: status, executedAt: agreement?.executedAt || 0 };
    // The chain codec preserves i64 deadlines as bigint; the shared rules validate safe integer seconds.
    const terms = { closesAt: typeof market.closesAt === 'bigint' ? Number(market.closesAt) : market.closesAt,
        graceSeconds: market.graceSeconds };
    const outcome = contract.executionOutcome(source, terms, nowSeconds);
    return outcome ? { outcome, resolveFirst: true } : null;
}

const formatAtomic = value => {
    const amount = BigInt(value);
    const whole = amount / 1_000_000n;
    const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
};

/** @param {{ agreements, markets, positions, history, budget }} input Maps are keyed by agreement account. */
export function decideCollect({ agreements = [], markets = {}, positions = {}, history = {}, budget = null, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
    const claimed = new Set(history.claimedPositions || []);
    const seen = new Set();
    const owed = [];
    for (const agreement of agreements || []) {
        const account = agreement.account;
        if (!account || seen.has(account)) continue;
        seen.add(account);
        const market = markets?.[account];
        const held = positions?.[account];
        const settled = held && settlement(market, agreement, nowSeconds);
        if (!settled) continue;
        for (const side of ['yes', 'no']) {
            const position = held[side];
            if (!position || position.claimed || BigInt(position.amount || 0) <= 0n || claimed.has(positionKey(agreement.cid, side))) continue;
            const payout = contract.payout(side, position.amount, settled.outcome);
            if (payout <= 0n) continue;
            owed.push({ agreement, account, side, payout, ...settled });
        }
    }
    owed.sort((a, b) => Number(a.resolveFirst) - Number(b.resolveFirst)
        || (b.payout > a.payout ? 1 : b.payout < a.payout ? -1 : 0)
        || a.agreement.cid.localeCompare(b.agreement.cid) || a.side.localeCompare(b.side));
    const options = owed.map(item => {
        const payout = formatAtomic(item.payout);
        const name = agreementName(item.agreement);
        const explanation = item.outcome === 'void'
            ? `the agreement was cancelled and each share pays half`
            : `the ${item.side.toUpperCase()} shares pay one USDC each`;
        return {
            agreementCid: item.agreement.cid,
            action: {
                type: 'claim', side: item.side, outcome: item.outcome, resolveFirst: item.resolveFirst,
                amount: null, usdc: 0, payout, signedActions: item.resolveFirst ? 2 : 1,
                agreementCid: item.agreement.cid, account: item.account, agreementName: name,
                rationale: `Collect ${payout} USDC from the ${item.side.toUpperCase()} position on ${name}: ${explanation}${item.resolveFirst ? ' (the market must be resolved first).' : '.'}`
            }
        };
    });
    if (!options.length) return { action: null, options, capped: false, reason: 'No resolved market position owes this persona anything.' };
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, capped,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} claim(s) owed but the invocation budget (${budget.actionsLeft} action(s) left) covers none.`
    };
}

export function decideTurn(roleDecide, input) {
    const collect = decideCollect(input);
    if (collect.action) return { ...collect, step: 'collect', eligibleCids: collect.options.map(option => option.agreementCid) };
    const decision = roleDecide(input);
    return { ...decision, step: 'role', capped: Boolean(decision.capped || (!decision.action && collect.capped)), owedClaims: collect.options.length };
}
