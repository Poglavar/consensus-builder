// Logarithmic market scoring rule (LMSR) for a yes/no market, in deterministic integer math so the
// browser quote, the server points ledger and the on-chain program (a u128 port of exactly these
// steps, checked against the same vectors) agree to the atomic unit. Shares and money share one
// unit: a share is counted in the stake token's atomic units and a winning share pays one atomic
// unit per unit held, so one full share pays 1 USDC. The liquidity parameter `b` is in the same
// units; the maker's worst-case loss is b·ln 2, which the market's creator deposits as the seed.
// Fixed point is base 10^18 ("ONE"); every operation floors; buy quotes add one atomic unit and
// sell quotes subtract one, so rounding always favours the pool. No floats anywhere.
// Every intermediate fits a u128 while quantities (plus any shares being priced) stay below
// 3.4·10^20 and b below 4.9·10^20, so u64 inputs are always safe, but the rounding guards need
// b ≤ 10^16: from about 2·10^17 fixed-point noise exceeds a unit and a buy can cost zero or less.
(function attachLmsr(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Lmsr = api;
})(typeof window !== 'undefined' ? window : globalThis, function lmsrFactory() {
    'use strict';

    const ONE = 10n ** 18n;
    const LN2 = 693147180559945309n;      // floor(ln 2 · 10^18)
    const EXP_TERMS = 24;                 // Taylor terms of e^-r for 0 ≤ r < ln 2: error < 10^-19
    const LN_TERMS = 40;                  // atanh terms of ln s for 1 ≤ s ≤ 2: z ≤ 1/3, error < 10^-19
    const SEARCH_STEPS = 64;              // doubling + bisection steps of sharesForBudget
    // Above 10^16 the fixed-point noise in the cost (about b · 2.7e-17 units) exceeds one unit and
    // a buy can be quoted at zero or less. Quantities are u64 on-chain, and every product of a u64
    // quantity with ONE fits a u128.
    const MAX_LIQUIDITY = 10n ** 16n;
    const MAX_QUANTITY = 2n ** 64n - 1n;

    // A non-negative integer given as a BigInt, a safe integer or a string of digits; nothing else.
    function big(value, label) {
        if (typeof value === 'bigint') {
            if (value < 0n) throw new Error(`${label} must not be negative`);
            return value;
        }
        if (typeof value === 'number') {
            if (Number.isInteger(value) && value < 0) throw new Error(`${label} must not be negative`);
            if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
            return BigInt(value);
        }
        if (typeof value === 'string') {
            if (/^\d+$/.test(value)) return BigInt(value);
            if (/^-\d+$/.test(value)) throw new Error(`${label} must not be negative`);
        }
        throw new Error(`${label} must be an integer`);
    }

    function quantity(value, label) {
        const out = big(value, label);
        if (out > MAX_QUANTITY) throw new Error(`${label} must not exceed ${MAX_QUANTITY}`);
        return out;
    }

    function liquidity(value) {
        const out = big(value, 'b');
        if (out === 0n) throw new Error('b must be positive');
        if (out > MAX_LIQUIDITY) throw new Error(`b must not exceed ${MAX_LIQUIDITY}`);
        return out;
    }

    function side(value) {
        if (value !== 'yes' && value !== 'no') throw new Error('side must be yes or no');
        return value;
    }

    // e^-x · ONE for a fixed-point x ≥ 0: x = n·ln2 + r, e^-x = e^-r / 2^n, e^-r by its alternating
    // Taylor series with term magnitudes kept unsigned so an unsigned port behaves identically.
    function expNeg(x) {
        const n = x / LN2;
        const r = x - n * LN2;
        let sum = ONE;
        let term = ONE;
        for (let k = 1n; k <= BigInt(EXP_TERMS); k += 1n) {
            term = (term * r) / (k * ONE);
            if (term === 0n) break;
            sum = (k % 2n === 1n) ? sum - term : sum + term;
        }
        return n >= 128n ? 0n : sum >> n;
    }

    // ln(s / ONE) · ONE for ONE ≤ s ≤ 2·ONE: ln s = 2·atanh(z), z = (s − 1)/(s + 1) ≤ 1/3.
    function lnFixed(s) {
        const z = ((s - ONE) * ONE) / (s + ONE);
        const z2 = (z * z) / ONE;
        let sum = 0n;
        let power = z;
        for (let k = 1n; k < BigInt(2 * LN_TERMS); k += 2n) {
            if (power === 0n) break;
            sum += power / k;
            power = (power * z2) / ONE;
        }
        return 2n * sum;
    }

    // The two e^((q − max)/b) terms of the cost function, shifted by the larger quantity so both lie
    // in (0, ONE] and their sum in [ONE, 2·ONE].
    function terms(b, qYes, qNo) {
        const max = qYes > qNo ? qYes : qNo;
        return {
            max,
            yes: expNeg(((max - qYes) * ONE) / b),
            no: expNeg(((max - qNo) * ONE) / b)
        };
    }

    // C(q) = b · ln(e^(qYes/b) + e^(qNo/b)) in atomic units, floored.
    function cost(b, qYes, qNo) {
        const scale = liquidity(b);
        const t = terms(scale, quantity(qYes, 'qYes'), quantity(qNo, 'qNo'));
        return t.max + (scale * lnFixed(t.yes + t.no)) / ONE;
    }

    // The probability of a side as a ONE-scaled fraction: its term over the sum of both.
    function priceFixed(b, qYes, qNo, which) {
        const t = terms(liquidity(b), quantity(qYes, 'qYes'), quantity(qNo, 'qNo'));
        return ((side(which) === 'yes' ? t.yes : t.no) * ONE) / (t.yes + t.no);
    }

    // Percent with one decimal, for display only.
    function chance(b, qYes, qNo, which) {
        return Number((priceFixed(b, qYes, qNo, which) * 1000n + ONE / 2n) / ONE) / 10;
    }

    // Every input of a trade, checked before anything is computed or returned.
    function trade(b, qYes, qNo, which, shares) {
        return {
            b: liquidity(b),
            qYes: quantity(qYes, 'qYes'),
            qNo: quantity(qNo, 'qNo'),
            which: side(which),
            shares: quantity(shares, 'shares')
        };
    }

    function after(t, add) {
        const held = t.which === 'yes' ? t.qYes : t.qNo;
        if (!add && t.shares > held) throw new Error('cannot sell more shares than the side holds');
        const next = add ? quantity(held + t.shares, 'shares') : held - t.shares;
        return t.which === 'yes' ? { qYes: next, qNo: t.qNo } : { qYes: t.qYes, qNo: next };
    }

    // What buying `shares` on a side costs now, in atomic units: the cost difference plus one unit.
    function buyCost(b, qYes, qNo, which, shares) {
        const t = trade(b, qYes, qNo, which, shares);
        if (t.shares === 0n) return 0n;
        const next = after(t, true);
        return cost(t.b, next.qYes, next.qNo) + 1n - cost(t.b, t.qYes, t.qNo);
    }

    // What selling `shares` held on a side returns now: the cost difference minus one unit, never
    // below zero. Selling more than the side holds is an error.
    function sellReturn(b, qYes, qNo, which, shares) {
        const t = trade(b, qYes, qNo, which, shares);
        if (t.shares === 0n) return 0n;
        const next = after(t, false);
        const before = cost(t.b, t.qYes, t.qNo);
        const afterwards = cost(t.b, next.qYes, next.qNo);
        return before > afterwards + 1n ? before - afterwards - 1n : 0n;
    }

    // The most shares `budget` atomic units buy on a side: doubling to bracket, then bisection,
    // both on buyCost, which is monotonic in shares. Never more than the quantity cap allows.
    function sharesForBudget(b, qYes, qNo, which, budget) {
        const t = trade(b, qYes, qNo, which, 0n);
        const money = quantity(budget, 'budget');
        const limit = MAX_QUANTITY - (t.which === 'yes' ? t.qYes : t.qNo);
        if (money === 0n || limit === 0n) return 0n;
        const priced = shares => buyCost(t.b, t.qYes, t.qNo, t.which, shares);
        if (priced(1n) > money) return 0n;
        if (priced(limit) <= money) return limit;
        let low = 1n;
        let high = 1n;
        for (let i = 0; i < SEARCH_STEPS && priced(high) <= money; i += 1) {
            low = high;
            high = high * 2n < limit ? high * 2n : limit;
        }
        while (high - low > 1n) {
            const mid = (low + high) / 2n;
            if (priced(mid) <= money) low = mid; else high = mid;
        }
        return low;
    }

    // The maker's worst-case loss for a liquidity b: b·ln 2, rounded up, plus one unit of slack.
    function maxLoss(b) {
        return (liquidity(b) * LN2 + ONE - 1n) / ONE + 1n;
    }

    // The largest b a seed deposit covers: the inverse of maxLoss, never above the liquidity cap.
    function liquidityForSeed(seed) {
        const money = quantity(seed, 'seed');
        if (money <= 1n) return 0n;
        const b = ((money - 1n) * ONE) / LN2;
        return b > MAX_LIQUIDITY ? MAX_LIQUIDITY : b;
    }

    // What a position of `shares` on a side collects once the outcome is known: one atomic unit per
    // unit held on the winning side, nothing on the other.
    function payout(which, shares, outcome) {
        const held = quantity(shares, 'shares');
        return side(which) === side(outcome) ? held : 0n;
    }

    return {
        ONE, LN2, EXP_TERMS, LN_TERMS, MAX_LIQUIDITY, MAX_QUANTITY, expNeg, lnFixed, cost, priceFixed, chance,
        buyCost, sellReturn, sharesForBudget, maxLoss, liquidityForSeed, payout
    };
});
