//! Logarithmic market scoring rule in u128 fixed point: a line-by-line port of
//! frontend/js/bets/lmsr.js (see lmsr-market.md at the repository root). The two must agree to the
//! atomic unit on every vector in backend/test/fixtures/lmsr-vectors.json, so the loop shapes,
//! constants and flooring here are a contract, not an implementation detail. Quantities are u64;
//! every product of a u64 with ONE fits a u128. Liquidity is capped at 10^16 because above that the
//! fixed-point noise in the cost exceeds one unit and a buy could be quoted at zero.

/// Fixed-point base.
pub const ONE: u128 = 1_000_000_000_000_000_000;
/// floor(ln 2 · 10^18).
pub const LN2: u128 = 693_147_180_559_945_309;
/// Taylor terms of e^-r for 0 ≤ r < ln 2.
pub const EXP_TERMS: u128 = 24;
/// atanh terms of ln s for 1 ≤ s ≤ 2.
pub const LN_TERMS: u128 = 40;
/// Largest liquidity the rounding guards are proven for.
pub const MAX_LIQUIDITY: u128 = 10_000_000_000_000_000;

pub const SIDE_NO: u8 = 0;
pub const SIDE_YES: u8 = 1;

#[derive(Debug, PartialEq, Eq)]
pub enum LmsrError {
    ZeroLiquidity,
    InputTooLarge,
    InvalidSide,
    Overflow,
    SellExceedsHeld,
}

fn liquidity(b: u64) -> Result<u128, LmsrError> {
    let wide = b as u128;
    if wide == 0 {
        return Err(LmsrError::ZeroLiquidity);
    }
    if wide > MAX_LIQUIDITY {
        return Err(LmsrError::InputTooLarge);
    }
    Ok(wide)
}

/// e^-x · ONE for a fixed-point x ≥ 0: x = n·ln2 + r, e^-x = e^-r / 2^n, e^-r by its alternating
/// Taylor series. Term magnitudes shrink monotonically, so the subtractions never underflow.
pub fn exp_neg(x: u128) -> u128 {
    let n = x / LN2;
    let r = x - n * LN2;
    let mut sum = ONE;
    let mut term = ONE;
    let mut k: u128 = 1;
    while k <= EXP_TERMS {
        term = term * r / (k * ONE);
        if term == 0 {
            break;
        }
        if k % 2 == 1 {
            sum -= term;
        } else {
            sum += term;
        }
        k += 1;
    }
    if n >= 128 {
        0
    } else {
        sum >> n
    }
}

/// ln(s / ONE) · ONE for ONE ≤ s ≤ 2·ONE: ln s = 2·atanh(z), z = (s − 1)/(s + 1) ≤ 1/3.
pub fn ln_fixed(s: u128) -> u128 {
    let z = (s - ONE) * ONE / (s + ONE);
    let z2 = z * z / ONE;
    let mut sum: u128 = 0;
    let mut power = z;
    let mut k: u128 = 1;
    while k < 2 * LN_TERMS {
        if power == 0 {
            break;
        }
        sum += power / k;
        power = power * z2 / ONE;
        k += 2;
    }
    2 * sum
}

struct Terms {
    max: u128,
    yes: u128,
    no: u128,
}

fn terms(b: u128, q_yes: u128, q_no: u128) -> Terms {
    let max = if q_yes > q_no { q_yes } else { q_no };
    Terms {
        max,
        yes: exp_neg((max - q_yes) * ONE / b),
        no: exp_neg((max - q_no) * ONE / b),
    }
}

/// C(q) = b · ln(e^(q_yes/b) + e^(q_no/b)) in atomic units, floored.
pub fn cost(b: u64, q_yes: u64, q_no: u64) -> Result<u64, LmsrError> {
    let b = liquidity(b)?;
    let t = terms(b, q_yes as u128, q_no as u128);
    let value = t.max + b * ln_fixed(t.yes + t.no) / ONE;
    u64::try_from(value).map_err(|_| LmsrError::Overflow)
}

/// The probability of a side as a ONE-scaled fraction.
pub fn price_fixed(b: u64, q_yes: u64, q_no: u64, side: u8) -> Result<u128, LmsrError> {
    let b = liquidity(b)?;
    let t = terms(b, q_yes as u128, q_no as u128);
    let own = match side {
        SIDE_YES => t.yes,
        SIDE_NO => t.no,
        _ => return Err(LmsrError::InvalidSide),
    };
    Ok(own * ONE / (t.yes + t.no))
}

fn after(q_yes: u64, q_no: u64, side: u8, shares: u64, add: bool) -> Result<(u64, u64), LmsrError> {
    let apply = |q: u64| -> Result<u64, LmsrError> {
        if add {
            q.checked_add(shares).ok_or(LmsrError::Overflow)
        } else {
            q.checked_sub(shares).ok_or(LmsrError::SellExceedsHeld)
        }
    };
    match side {
        SIDE_YES => Ok((apply(q_yes)?, q_no)),
        SIDE_NO => Ok((q_yes, apply(q_no)?)),
        _ => Err(LmsrError::InvalidSide),
    }
}

/// What buying `shares` on a side costs now: the cost difference plus one unit.
pub fn buy_cost(b: u64, q_yes: u64, q_no: u64, side: u8, shares: u64) -> Result<u64, LmsrError> {
    if shares == 0 {
        return Ok(0);
    }
    let (next_yes, next_no) = after(q_yes, q_no, side, shares, true)?;
    // Cost never decreases when a side grows, so this subtraction holds; checked, never assumed.
    cost(b, next_yes, next_no)?
        .checked_add(1)
        .and_then(|value| value.checked_sub(cost(b, q_yes, q_no).ok()?))
        .ok_or(LmsrError::Overflow)
}

/// What selling `shares` held on a side returns now: the cost difference minus one unit, never
/// below zero. Selling more than the side holds is an error.
pub fn sell_return(b: u64, q_yes: u64, q_no: u64, side: u8, shares: u64) -> Result<u64, LmsrError> {
    if shares == 0 {
        return Ok(0);
    }
    let (next_yes, next_no) = after(q_yes, q_no, side, shares, false)?;
    let before = cost(b, q_yes, q_no)?;
    let afterwards = cost(b, next_yes, next_no)?;
    Ok(if before > afterwards + 1 { before - afterwards - 1 } else { 0 })
}

/// The maker's worst-case loss for a liquidity b: b·ln 2, rounded up, plus one unit of slack.
pub fn max_loss(b: u64) -> Result<u64, LmsrError> {
    let b = liquidity(b)?;
    let value = (b * LN2 + ONE - 1) / ONE + 1;
    u64::try_from(value).map_err(|_| LmsrError::Overflow)
}

/// The largest b a seed deposit covers: the inverse of max_loss.
pub fn liquidity_for_seed(seed: u64) -> Result<u64, LmsrError> {
    let seed = seed as u128;
    if seed <= 1 {
        return Ok(0);
    }
    let b = (seed - 1) * ONE / LN2;
    Ok(if b > MAX_LIQUIDITY { MAX_LIQUIDITY as u64 } else { b as u64 })
}

#[cfg(test)]
#[path = "lmsr_vectors.rs"]
mod lmsr_vectors;

#[cfg(test)]
mod tests {
    use super::*;

    fn side_of(text: &str) -> u8 {
        match text {
            "yes" => SIDE_YES,
            "no" => SIDE_NO,
            other => panic!("unknown side {other}"),
        }
    }

    // Every vector the JavaScript reference produced, except sharesForBudget, which is client-side
    // only; a vector whose arguments exceed the on-chain input types is checked to be rejected.
    #[test]
    fn reproduces_every_reference_vector() {
        let mut checked = 0;
        for (name, args, expected) in super::lmsr_vectors::VECTORS {
            let want: u128 = expected.parse().expect("expected value");
            let num = |index: usize| -> u128 { args[index].parse().expect("argument") };
            let got: Option<u128> = match *name {
                "expNeg" => Some(exp_neg(num(0))),
                "lnFixed" => Some(ln_fixed(num(0))),
                "maxLoss" => max_loss(num(0) as u64).ok().map(u128::from),
                "liquidityForSeed" => liquidity_for_seed(num(0) as u64).ok().map(u128::from),
                "cost" => cost(num(0) as u64, num(1) as u64, num(2) as u64).ok().map(u128::from),
                "priceFixed" => price_fixed(num(0) as u64, num(1) as u64, num(2) as u64, side_of(args[3])).ok(),
                "buyCost" => buy_cost(num(0) as u64, num(1) as u64, num(2) as u64, side_of(args[3]), num(4) as u64).ok().map(u128::from),
                "sellReturn" => sell_return(num(0) as u64, num(1) as u64, num(2) as u64, side_of(args[3]), num(4) as u64).ok().map(u128::from),
                "sharesForBudget" => continue,
                other => panic!("unknown vector function {other}"),
            };
            assert_eq!(got, Some(want), "{name}({args:?})");
            checked += 1;
        }
        assert!(checked >= 50, "only {checked} vectors checked");
    }

    const USDC: u64 = 1_000_000;

    // Values printed by the JavaScript module on 2026-10-12; the vectors file extends this list.
    #[test]
    fn primitives_match_the_javascript_module() {
        assert_eq!(exp_neg(0), ONE);
        assert_eq!(exp_neg(LN2), ONE / 2);
        assert_eq!(exp_neg(ONE), 367_879_441_171_442_320);
        assert_eq!(exp_neg(200 * ONE), 0);
        assert_eq!(ln_fixed(ONE), 0);
        assert_eq!(ln_fixed(2 * ONE), 693_147_180_559_945_290);
        assert_eq!(ln_fixed(15 * ONE / 10), 405_465_108_108_164_370);
    }

    #[test]
    fn quotes_match_the_javascript_module() {
        let b = 100 * USDC;
        assert_eq!(cost(b, 0, 0).unwrap(), 69_314_718);
        assert_eq!(max_loss(b).unwrap(), 69_314_720);
        assert_eq!(price_fixed(b, 0, 0, SIDE_YES).unwrap(), ONE / 2);
        assert_eq!(buy_cost(b, 0, 0, SIDE_YES, 10 * USDC).unwrap(), 5_124_949);
        assert_eq!(sell_return(b, 10 * USDC, 0, SIDE_YES, 10 * USDC).unwrap(), 5_124_947);
        assert_eq!(cost(b, 5_000 * USDC, 0).unwrap(), 5_000 * USDC);
    }

    #[test]
    fn vault_covers_either_outcome_and_a_void() {
        for &b in &[USDC, 100 * USDC, 10_000 * USDC] {
            for &q_yes in &[0u64, 1, 50 * USDC, 500 * USDC, 50_000 * USDC] {
                for &q_no in &[0u64, 3, 20 * USDC, 500 * USDC, 70_000 * USDC] {
                    let vault = max_loss(b).unwrap() + cost(b, q_yes, q_no).unwrap() - cost(b, 0, 0).unwrap();
                    assert!(vault >= q_yes.max(q_no), "b {b} q {q_yes}/{q_no}");
                    assert!(vault >= (q_yes + q_no) / 2, "void b {b} q {q_yes}/{q_no}");
                }
            }
        }
    }

    #[test]
    fn round_trips_never_profit_and_prices_move_the_right_way() {
        let b = 100 * USDC;
        let q_yes = 30 * USDC;
        let q_no = 10 * USDC;
        for &shares in &[1u64, 7, USDC, 25 * USDC, 400 * USDC] {
            let paid = buy_cost(b, q_yes, q_no, SIDE_NO, shares).unwrap();
            let back = sell_return(b, q_yes, q_no + shares, SIDE_NO, shares).unwrap();
            assert!(back <= paid, "shares {shares}: back {back} > paid {paid}");
        }
        let before = price_fixed(b, q_yes, q_no, SIDE_YES).unwrap();
        assert!(price_fixed(b, q_yes + USDC, q_no, SIDE_YES).unwrap() > before);
        assert!(price_fixed(b, q_yes, q_no + USDC, SIDE_YES).unwrap() < before);
        let yes = price_fixed(b, q_yes, q_no, SIDE_YES).unwrap();
        let no = price_fixed(b, q_yes, q_no, SIDE_NO).unwrap();
        assert!(ONE - (yes + no) <= 2);
    }

    #[test]
    fn rejects_bad_inputs() {
        assert_eq!(cost(0, 1, 1), Err(LmsrError::ZeroLiquidity));
        assert_eq!(cost(100_000_000_000_000_000, 1, 1), Err(LmsrError::InputTooLarge));
        assert_eq!(cost(10_000_000, u64::MAX, 0).unwrap(), u64::MAX);
        assert_eq!(price_fixed(USDC, 0, 0, 7), Err(LmsrError::InvalidSide));
        assert_eq!(sell_return(USDC, 5, 0, SIDE_YES, 6), Err(LmsrError::SellExceedsHeld));
        assert_eq!(liquidity_for_seed(1).unwrap(), 0);
        assert_eq!(buy_cost(USDC, 0, 0, SIDE_YES, 0).unwrap(), 0);
    }
}
