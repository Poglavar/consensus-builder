// Shared pure helpers for the society policies (agents/policies/<role>.js): agreement identity,
// eligibility, market-implied probability, age and the per-invocation budget check. An agreement here is
// discovery.js's summary: { cid, name, author, sponsor, account, createdAt, deadline, chainStatus, … };
// its CID is its key and its chain account the subject of its market and pledges. No I/O here;
// society-run.mjs gathers the inputs and executes whatever a policy returns.
import { stableNumber, isOthersOpen } from '../supporter-picker.js';
import { isOpen } from '../discovery.js';

export { stableNumber, isOthersOpen, isOpen };

const DAY_MS = 86_400_000;

export function agreementName(agreement = {}) {
    return agreement.name || agreement.cid;
}

/** Atomic USDC units (bigint) from a bigint, safe integer or digit string; null when unreadable. */
export function atomic(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.floor(value));
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    return null;
}

/**
 * YES share of a parimutuel market's pools, or null when there is no market, it is resolved, a pool
 * is unreadable, or nobody has staked. A missing market is "no signal", never 0 or 0.5.
 */
export function impliedYesProbability(market) {
    if (!market || market.resolved) return null;
    const yes = atomic(market.yesPool);
    const no = atomic(market.noPool);
    if (yes === null || no === null) return null;
    const total = yes + no;
    if (total === 0n) return null;
    return Number(yes) / Number(total);
}

export function totalPool(market) {
    const yes = atomic(market?.yesPool);
    const no = atomic(market?.noPool);
    return yes === null || no === null ? 0 : Number(yes + no);
}

/** Days from the agreement's own createdAt to `now` (ms), or null when it has no creation time. */
export function agreementAgeDays(agreement, now) {
    const created = Date.parse(agreement?.createdAt || '');
    if (!Number.isFinite(created) || typeof now !== 'number' || !Number.isFinite(now)) return null;
    return Math.max(0, (now - created) / DAY_MS);
}

/** Budget left in this invocation: { actionsLeft, usdcLeft }. An action fits when both cover it. */
export function fitsBudget(action, budget) {
    if (!budget) return true;
    return action.signedActions <= budget.actionsLeft && action.usdc <= budget.usdcLeft + 1e-9;
}

export function positiveDecimal(value, fallback, label) {
    const text = value === undefined || value === null || value === '' ? fallback : String(value);
    if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) throw new Error(`${label} must be a positive USDC decimal string, got ${JSON.stringify(value)}`);
    return text;
}

export function fraction(value, fallback, label) {
    const number = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${label} must be between 0 and 1`);
    return number;
}

export function nonNegative(value, fallback, label) {
    const number = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
    return number;
}

/**
 * The first option that fits the budget, or none. `capped` says options existed but the invocation's
 * caps left no room, so the runner can report "cap reached" instead of "nothing to do".
 */
export function firstFitting(options, budget) {
    const chosen = options.find(option => fitsBudget(option.action, budget)) || null;
    return { chosen, capped: !chosen && options.length > 0 };
}
