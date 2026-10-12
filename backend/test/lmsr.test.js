// Pins the yes/no LMSR module (frontend/js/bets/lmsr.js) to the atomic unit: its fixed-point primitives,
// cost, prices and trade quotes, the bounded-loss invariant the market vault relies on, and the shared
// vectors in fixtures/lmsr-vectors.json that the on-chain u128 port must reproduce exactly.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Lmsr = require('../../frontend/js/bets/lmsr.js');
const fixture = require('./fixtures/lmsr-vectors.json');

const { ONE, LN2 } = Lmsr;
const USDC = 1000000n;                                   // atomic units per USDC (6 decimals)
// b values the properties are checked at: b = 1, a tiny b, 10, 100 and 10,000 USDC, 10^14, and 10^16,
// the ceiling the module's header documents.
const LIQUIDITIES = [1n, 3n, 10n * USDC, 100n * USDC, 10000n * USDC, 10n ** 14n, 10n ** 16n];

const abs = (x) => (x < 0n ? -x : x);
const larger = (a, b) => (a > b ? a : b);

// Deterministic 64-bit LCG (Knuth's MMIX constants); a draw stitches the top halves of four steps into
// 128 bits so ranges far beyond 2^53 stay uniform enough for property tests.
function lcg(seed) {
    let state = BigInt(seed);
    const next32 = () => {
        state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return state >> 32n;
    };
    const below = (limit) => ((next32() << 96n) | (next32() << 64n) | (next32() << 32n) | next32()) % limit;
    return { below, pick: (list) => list[Number(below(BigInt(list.length)))] };
}

// A count between 1 and cap, spread over orders of magnitude so one-unit and 5·b trades both occur.
function spread(rng, cap) {
    const top = 10n ** rng.below(BigInt(cap.toString().length) + 1n);
    return 1n + rng.below(top < cap ? top : cap);
}

// A market state for b: balanced, a few b apart, or deep enough that the cheap side's price is zero.
function marketState(rng, b) {
    const base = rng.below(1000n * b + 1n);
    const gap = rng.pick([rng.below(8n), rng.below(b + 1n), rng.below(5n * b + 1n), rng.below(50n * b + 1n)]);
    return rng.below(2n) === 0n ? { qYes: base + gap, qNo: base } : { qYes: base, qNo: base + gap };
}

const bought = (s, side, shares) => (side === 'yes'
    ? { qYes: s.qYes + shares, qNo: s.qNo }
    : { qYes: s.qYes, qNo: s.qNo + shares });

describe('Lmsr fixed-point primitives', () => {
    it('pins ONE and LN2 = floor(ln 2 · 10^18)', () => {
        expect(ONE).toBe(10n ** 18n);
        expect(LN2).toBe(693147180559945309n);
    });

    it('expNeg is exact at 0 and at every multiple of ln 2, and is 0 deep in the tail', () => {
        expect(Lmsr.expNeg(0n)).toBe(ONE);
        expect(Lmsr.expNeg(LN2)).toBe(ONE / 2n);
        for (let k = 1n; k <= 70n; k += 1n) expect(Lmsr.expNeg(k * LN2)).toBe(ONE >> k);
        for (const x of [60n * LN2, 128n * LN2, 10n ** 30n, 1n << 200n]) expect(Lmsr.expNeg(x)).toBe(0n);
    });

    it('expNeg(1) is e^-1 to within 2 units', () => {
        expect(abs(Lmsr.expNeg(ONE) - 367879441171442321n)).toBeLessThanOrEqual(2n);
    });

    it('lnFixed is 0 at 1, ln 2 to within 25 units at 2, and never above the true value there', () => {
        expect(Lmsr.lnFixed(ONE)).toBe(0n);
        const ln2 = Lmsr.lnFixed(2n * ONE);
        expect(abs(ln2 - 693147180559945309n)).toBeLessThanOrEqual(25n);
        expect(ln2).toBeLessThan(LN2);                    // every step floors, so the series undershoots
    });

    it('lnFixed never decreases across [ONE, 2·ONE] (cost monotonicity rests on it)', () => {
        const rng = lcg(7);
        for (let i = 0; i < 2000; i++) {
            const s = ONE + rng.below(ONE);
            expect(Lmsr.lnFixed(s + 1n)).toBeGreaterThanOrEqual(Lmsr.lnFixed(s));
        }
    });
});

describe('Lmsr.cost', () => {
    it('is b·ln 2 for an empty market, within 2 units', () => {
        for (const b of [...LIQUIDITIES, 7n, 10n, USDC]) {
            expect(abs(Lmsr.cost(b, 0n, 0n) - (b * LN2) / ONE)).toBeLessThanOrEqual(2n);
        }
    });

    it('lies between the larger quantity and that plus b·ln 2, including q far beyond b', () => {
        for (const b of LIQUIDITIES) {
            // Quantities are u64 on-chain, so the far end stops at the cap.
            for (const q of [0n, 1n, b / 2n, b, 10n * b, 50n * b, 1000000n * b, 10n ** 18n, Lmsr.MAX_QUANTITY].filter(value => value <= Lmsr.MAX_QUANTITY)) {
                const c = Lmsr.cost(b, q, 0n);
                expect(c).toBeGreaterThanOrEqual(q);
                expect(c).toBeLessThanOrEqual(q + (b * LN2) / ONE + 2n);
            }
        }
    });

    it('is symmetric in the two quantities', () => {
        const rng = lcg(11);
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 100; i++) {
                const { qYes, qNo } = marketState(rng, b);
                expect(Lmsr.cost(b, qYes, qNo)).toBe(Lmsr.cost(b, qNo, qYes));
            }
        }
    });

    it('never decreases when either quantity grows, by one unit or by many', () => {
        const rng = lcg(13);
        const drops = [];
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 300; i++) {
                const s = marketState(rng, b);
                const before = Lmsr.cost(b, s.qYes, s.qNo);
                for (const side of ['yes', 'no']) {
                    for (const step of [1n, spread(rng, 5n * b)]) {
                        const next = bought(s, side, step);
                        if (Lmsr.cost(b, next.qYes, next.qNo) < before) drops.push({ b, ...s, side, step });
                    }
                }
            }
        }
        expect(drops).toEqual([]);
    });

    it('agrees with a floating-point log-sum-exp to within one unit, never above it', () => {
        const rng = lcg(17);
        for (const b of [1n, 3n, 10n * USDC, 10000n * USDC]) {
            for (let i = 0; i < 150; i++) {
                const { qYes, qNo } = marketState(rng, b);
                const hi = Number(larger(qYes, qNo));
                const gap = Math.abs(Number(qYes - qNo));
                const reference = hi + Number(b) * Math.log1p(Math.exp(-gap / Number(b)));
                const diff = Number(Lmsr.cost(b, qYes, qNo)) - reference;
                expect(diff).toBeGreaterThan(-1.001);
                expect(diff).toBeLessThan(0.001);
            }
        }
    });
});

describe('Lmsr.priceFixed and Lmsr.chance', () => {
    it('prices both sides at exactly one half in an empty market', () => {
        for (const b of LIQUIDITIES) {
            expect(Lmsr.priceFixed(b, 0n, 0n, 'yes')).toBe(ONE / 2n);
            expect(Lmsr.priceFixed(b, 0n, 0n, 'no')).toBe(ONE / 2n);
            expect(Lmsr.chance(b, 0n, 0n, 'yes')).toBe(50);
        }
    });

    it('keeps yes + no within 2 units of ONE', () => {
        const rng = lcg(19);
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 100; i++) {
                const { qYes, qNo } = marketState(rng, b);
                const total = Lmsr.priceFixed(b, qYes, qNo, 'yes') + Lmsr.priceFixed(b, qYes, qNo, 'no');
                expect(abs(total - ONE)).toBeLessThanOrEqual(2n);
            }
        }
    });

    it('rises for the side that was bought and falls for the other', () => {
        const rng = lcg(23);
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 60; i++) {
                const base = rng.below(1000n * b + 1n);
                const s = { qYes: base + rng.below(10n * b + 1n), qNo: base + rng.below(10n * b + 1n) };
                const shares = larger(1n, b / 10n);
                const price = Lmsr.priceFixed(b, s.qYes, s.qNo, 'yes');
                const yes = bought(s, 'yes', shares);
                const no = bought(s, 'no', shares);
                expect(Lmsr.priceFixed(b, yes.qYes, yes.qNo, 'yes')).toBeGreaterThan(price);
                expect(Lmsr.priceFixed(b, no.qYes, no.qNo, 'yes')).toBeLessThan(price);
            }
        }
    });

    it('quotes chance as a percentage rounded to one decimal', () => {
        expect(Lmsr.chance(USDC, USDC, 0n, 'yes')).toBe(73.1);
        expect(Lmsr.chance(USDC, USDC, 0n, 'no')).toBe(26.9);
        expect(Lmsr.chance(USDC, 0n, 10n ** 12n, 'yes')).toBe(0);
        expect(Lmsr.chance(USDC, 10n ** 12n, 0n, 'yes')).toBe(100);
        const rng = lcg(29);
        for (let i = 0; i < 200; i++) {
            const { qYes, qNo } = marketState(rng, 10n * USDC);
            const percent = Lmsr.chance(10n * USDC, qYes, qNo, 'yes');
            const exact = Number(Lmsr.priceFixed(10n * USDC, qYes, qNo, 'yes')) / 1e16;
            expect(Math.abs(percent * 10 - Math.round(percent * 10))).toBeLessThan(1e-9);
            expect(Math.abs(percent - exact)).toBeLessThanOrEqual(0.05 + 1e-9);
        }
    });
});

describe('Lmsr.buyCost and Lmsr.sellReturn', () => {
    it('quote nothing for zero shares', () => {
        expect(Lmsr.buyCost(USDC, 0n, 0n, 'yes', 0n)).toBe(0n);
        expect(Lmsr.sellReturn(USDC, 5n, 0n, 'yes', 0n)).toBe(0n);
    });

    it('never let a buy-then-sell round trip return more than was paid', () => {
        // buy = Δcost + 1 and sell = max(0, Δcost − 1), so the trader loses exactly the two guard units,
        // or one when the sell rounds to zero, and every buy costs at least one unit.
        const rng = lcg(31);
        const bad = [];
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 150; i++) {
                const s = marketState(rng, b);
                const side = rng.pick(['yes', 'no']);
                const shares = spread(rng, 5n * b);
                const paid = Lmsr.buyCost(b, s.qYes, s.qNo, side, shares);
                const next = bought(s, side, shares);
                const back = Lmsr.sellReturn(b, next.qYes, next.qNo, side, shares);
                const loss = paid >= 2n ? 2n : 1n;
                if (paid < 1n || back > paid || paid - back !== loss) bad.push({ b, ...s, side, shares, paid, back });
            }
        }
        expect(bad).toEqual([]);
    });

    it('never charge less for more shares, and charge strictly more across steps worth a few units', () => {
        // One share is usually worth less than one atomic unit, so single-share steps can quote the same;
        // a step worth four units at the current price must cost strictly more.
        const rng = lcg(37);
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 20; i++) {
                const s = marketState(rng, b);
                const side = rng.pick(['yes', 'no']);
                let previous = 0n;
                for (let n = 1n; n <= 40n; n += 1n) {
                    const quote = Lmsr.buyCost(b, s.qYes, s.qNo, side, n);
                    expect(quote).toBeGreaterThanOrEqual(previous);
                    previous = quote;
                }
                const price = Lmsr.priceFixed(b, s.qYes, s.qNo, side);
                if (price === 0n) continue;                      // the cheap side underflowed to zero
                const step = (4n * ONE) / price + 1n;
                let last = Lmsr.buyCost(b, s.qYes, s.qNo, side, step);
                for (let k = 2n; k <= 5n; k += 1n) {
                    const quote = Lmsr.buyCost(b, s.qYes, s.qNo, side, k * step);
                    expect(quote).toBeGreaterThan(last);
                    last = quote;
                }
            }
        }
    });

    it('refuses to sell more than the side holds, and can sell all of it', () => {
        expect(() => Lmsr.sellReturn(USDC, 5n, 0n, 'yes', 6n)).toThrow(/more shares than the side holds/);
        expect(() => Lmsr.sellReturn(USDC, 0n, 5n, 'yes', 1n)).toThrow(/more shares than the side holds/);
        expect(() => Lmsr.sellReturn(USDC, 5n, 0n, 'no', 1n)).toThrow(/more shares than the side holds/);
        expect(Lmsr.sellReturn(USDC, 5n * USDC, 0n, 'yes', 5n * USDC)).toBe(4313567n);
    });
});

describe('Lmsr.sharesForBudget', () => {
    it('returns exactly the most shares a budget buys', () => {
        const rng = lcg(41);
        const bad = [];
        for (const b of LIQUIDITIES) {
            for (let i = 0; i < 4; i++) {
                const s = marketState(rng, b);
                const side = rng.pick(['yes', 'no']);
                for (const budget of [1n, 2n, 10n, 999n, 10n ** 6n, 10n ** 9n, 10n ** 12n, spread(rng, 10n ** 12n)]) {
                    const shares = Lmsr.sharesForBudget(b, s.qYes, s.qNo, side, budget);
                    const fits = shares === 0n || Lmsr.buyCost(b, s.qYes, s.qNo, side, shares) <= budget;
                    const maximal = Lmsr.buyCost(b, s.qYes, s.qNo, side, shares + 1n) > budget;
                    if (!fits || !maximal) bad.push({ b, ...s, side, budget, shares });
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it('returns 0 when even one share costs more than the budget', () => {
        expect(Lmsr.buyCost(1n, 0n, 0n, 'yes', 1n)).toBe(2n);
        expect(Lmsr.sharesForBudget(1n, 0n, 0n, 'yes', 1n)).toBe(0n);
        // The favourite in a lopsided market: a share costs its whole unit plus the guard.
        expect(Lmsr.buyCost(10n * USDC, 50n * USDC, 0n, 'yes', 1n)).toBe(2n);
        expect(Lmsr.sharesForBudget(10n * USDC, 50n * USDC, 0n, 'yes', 1n)).toBe(0n);
        expect(Lmsr.sharesForBudget(USDC, 0n, 0n, 'yes', 0n)).toBe(0n);
    });
});

describe('Lmsr bounded loss', () => {
    it('keeps the vault able to pay the winning side after every trade of random sequences', () => {
        // The vault starts at maxLoss(b) and takes every buy and pays every sell. Each trade moves it by at
        // least the change in cost, and cost ≥ max(qYes, qNo), so vault − cost never falls and the vault
        // always covers the payout of either outcome. Sellers only sell what they hold.
        const failures = [];
        let sells = 0;
        let zeroSells = 0;
        let deepest = 0n;
        for (const b of [3n, 10n * USDC, 100n * USDC, 10000n * USDC, 10n ** 14n]) {
            for (let sequence = 0; sequence < 20; sequence++) {
                const rng = lcg(1000n * b + BigInt(sequence));
                const traders = [{ yes: 0n, no: 0n }, { yes: 0n, no: 0n }, { yes: 0n, no: 0n }];
                let qYes = 0n;
                let qNo = 0n;
                let vault = Lmsr.maxLoss(b);
                let slack = vault - Lmsr.cost(b, 0n, 0n);
                if (slack < 1n) failures.push({ b, sequence, step: -1, slack });
                for (let step = 0; step < 200; step++) {
                    const trader = rng.pick(traders);
                    const side = rng.pick(['yes', 'no']);
                    const sell = trader[side] > 0n && rng.below(5n) < 2n;
                    const amount = sell
                        ? (rng.below(4n) === 0n ? trader[side] : 1n + rng.below(trader[side]))
                        : spread(rng, 5n * b);
                    if (sell) {
                        const back = Lmsr.sellReturn(b, qYes, qNo, side, amount);
                        sells += 1;
                        if (back === 0n) zeroSells += 1;
                        vault -= back;
                        trader[side] -= amount;
                    } else {
                        vault += Lmsr.buyCost(b, qYes, qNo, side, amount);
                        trader[side] += amount;
                    }
                    const delta = sell ? -amount : amount;
                    if (side === 'yes') qYes += delta; else qNo += delta;
                    const gap = (qYes > qNo ? qYes - qNo : qNo - qYes) / b;
                    if (gap > deepest) deepest = gap;
                    const nextSlack = vault - Lmsr.cost(b, qYes, qNo);
                    if (vault < larger(qYes, qNo) || nextSlack < slack) {
                        failures.push({ b, sequence, step, side, sell, amount, vault, qYes, qNo, slack, nextSlack });
                    }
                    slack = nextSlack;
                }
            }
        }
        expect(failures).toEqual([]);
        // The run must have reached what it claims to cover: sells, sells rounding to zero, and states
        // more than 40·b apart where the cheap side's price underflows to zero.
        expect(sells).toBeGreaterThan(5000);
        expect(zeroSells).toBeGreaterThan(100);
        expect(deepest).toBeGreaterThanOrEqual(40n);
    });
});

describe('Lmsr.maxLoss and Lmsr.liquidityForSeed', () => {
    it('seeds b·ln 2 rounded up plus one unit, above the empty-market cost', () => {
        expect(Lmsr.maxLoss(USDC)).toBe(693149n);
        expect(Lmsr.maxLoss(1n)).toBe(2n);
        for (const b of [...LIQUIDITIES, 2n, 7n, 999999n]) {
            expect(Lmsr.maxLoss(b)).toBe((b * LN2 + ONE - 1n) / ONE + 1n);
            expect(Lmsr.maxLoss(b)).toBeGreaterThanOrEqual(Lmsr.cost(b, 0n, 0n) + 1n);
        }
    });

    it('gives the largest b a seed covers', () => {
        expect(Lmsr.liquidityForSeed(0n)).toBe(0n);
        expect(Lmsr.liquidityForSeed(1n)).toBe(0n);
        const rng = lcg(43);
        const seeds = [2n, 3n, 10n, 693149n, USDC, 10n ** 9n, 69314718055996n];
        for (let i = 0; i < 100; i++) seeds.push(2n + spread(rng, 10n ** 15n));
        for (const seed of seeds) {
            const b = Lmsr.liquidityForSeed(seed);
            expect(Lmsr.maxLoss(b)).toBeLessThanOrEqual(seed);
            expect(Lmsr.maxLoss(b + 1n)).toBeGreaterThan(seed);
        }
    });
});

describe('Lmsr.payout', () => {
    it('pays one unit per share on the winning side and nothing on the other', () => {
        expect(Lmsr.payout('yes', 5n, 'yes')).toBe(5n);
        expect(Lmsr.payout('no', '7', 'no')).toBe(7n);
        expect(Lmsr.payout('yes', 5n, 'no')).toBe(0n);
        expect(Lmsr.payout('no', 5n, 'yes')).toBe(0n);
    });

    it('throws on an unknown side or outcome', () => {
        expect(() => Lmsr.payout('maybe', 1n, 'yes')).toThrow(/side must be yes or no/);
        expect(() => Lmsr.payout('yes', 1n, 'void')).toThrow(/side must be yes or no/);
        expect(() => Lmsr.payout('YES', 1n, 'yes')).toThrow(/side must be yes or no/);
    });
});

describe('Lmsr input checks', () => {
    const invalid = [-1n, -1, '-5', 1.5, '1.5', 'abc', NaN, Infinity, undefined, null];

    it('rejects negative and non-integer amounts wherever an amount is read', () => {
        for (const value of invalid) {
            const calls = [
                () => Lmsr.cost(value, 0n, 0n),
                () => Lmsr.cost(USDC, value, 0n),
                () => Lmsr.cost(USDC, 0n, value),
                () => Lmsr.priceFixed(USDC, value, 0n, 'yes'),
                () => Lmsr.chance(value, 0n, 0n, 'yes'),
                () => Lmsr.buyCost(USDC, 0n, 0n, 'yes', value),
                () => Lmsr.buyCost(USDC, value, 0n, 'yes', 1n),
                () => Lmsr.sellReturn(USDC, 5n, 0n, 'yes', value),
                () => Lmsr.sellReturn(USDC, value, 0n, 'yes', 1n),
                () => Lmsr.sharesForBudget(USDC, 0n, 0n, 'yes', value),
                () => Lmsr.maxLoss(value),
                () => Lmsr.liquidityForSeed(value),
                () => Lmsr.payout('yes', value, 'yes')
            ];
            for (const call of calls) expect(call).toThrow(/must be an integer|must not be negative/);
        }
    });

    it('rejects b = 0 for every quote', () => {
        expect(() => Lmsr.cost(0n, 0n, 0n)).toThrow(/b must be positive/);
        expect(() => Lmsr.priceFixed(0n, 0n, 0n, 'yes')).toThrow(/b must be positive/);
        expect(() => Lmsr.chance(0n, 0n, 0n, 'yes')).toThrow(/b must be positive/);
        expect(() => Lmsr.buyCost(0n, 0n, 0n, 'yes', 1n)).toThrow(/b must be positive/);
        expect(() => Lmsr.sellReturn(0n, 5n, 0n, 'yes', 1n)).toThrow(/b must be positive/);
        expect(() => Lmsr.sharesForBudget(0n, 0n, 0n, 'yes', 10n)).toThrow(/b must be positive/);
    });

    it('rejects an unknown side', () => {
        expect(() => Lmsr.buyCost(USDC, 0n, 0n, 'maybe', 1n)).toThrow(/side must be yes or no/);
        expect(() => Lmsr.priceFixed(USDC, 0n, 0n, 'YES')).toThrow(/side must be yes or no/);
        expect(() => Lmsr.sellReturn(USDC, 5n, 5n, 'both', 1n)).toThrow(/side must be yes or no/);
    });
});

describe('Lmsr port vectors (fixtures/lmsr-vectors.json)', () => {
    const FUNCTIONS = ['expNeg', 'lnFixed', 'cost', 'priceFixed', 'buyCost', 'sellReturn', 'sharesForBudget', 'maxLoss', 'liquidityForSeed'];

    it('are well-formed decimal strings covering every function', () => {
        expect(typeof fixture.note).toBe('string');
        expect(fixture.vectors.length).toBeGreaterThanOrEqual(60);
        expect([...new Set(fixture.vectors.map((v) => v.fn))].sort()).toEqual([...FUNCTIONS].sort());
        for (const v of fixture.vectors) {
            for (const arg of v.args) expect(arg).toMatch(/^(0|[1-9]\d*|yes|no)$/);
            expect(v.expected).toMatch(/^(0|[1-9]\d*)$/);
        }
    });

    it('are reproduced exactly by the module', () => {
        const mismatches = fixture.vectors
            .map((v) => ({ ...v, actual: String(Lmsr[v.fn](...v.args.map((a) => (a === 'yes' || a === 'no' ? a : BigInt(a))))) }))
            .filter((v) => v.actual !== v.expected);
        expect(mismatches).toEqual([]);
    });
});

describe('Lmsr above its precision ceiling (open bug: fails until b is capped)', () => {
    it('never lets a buy-then-sell round trip pay the trader, whatever b it accepts', () => {
        // At b = 10^18 the fixed-point noise in cost exceeds one unit: this one-share YES buy is quoted at
        // −2 (the pool pays the buyer) and selling the share straight back returns 0, leaving the market
        // where it was, so repeating the pair drains the vault. Rejecting such a b is a valid fix.
        const b = 10n ** 18n;
        const qYes = 174461888874088054n;
        const qNo = 753301n;
        let paid;
        try {
            paid = Lmsr.buyCost(b, qYes, qNo, 'yes', 1n);
        } catch (error) {
            expect(error.message).toMatch(/\bb\b/);
            return;
        }
        const back = Lmsr.sellReturn(b, qYes + 1n, qNo, 'yes', 1n);
        expect(paid - back).toBeGreaterThan(0n);
    });
});
