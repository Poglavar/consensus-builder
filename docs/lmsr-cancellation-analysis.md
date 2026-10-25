<!-- Prior cancellation analysis retained for review; the current rule is VOID. -->
# Cancellation tradeoff record

This is the prior analysis retained on 25 October 2026. The current implementation uses VOID at half per share. The notice-period alternative below is unimplemented; it is not the active settlement rule.

## Cancellation: decided VOID, with a refinement to confirm

Decision 2026-10-12 (streamline B2): cancelling a proposal with open positions voids its market.
VOID pays one half per share, the standard void settlement, provably covered by invariant 2.

Two consequences to confirm before this becomes immutable:

- An honest cancellation is the common case and the truthful answer to "will it be agreed by the
  date?" is then NO. VOID pays the NO holders who were right one half instead of one, and pays
  the YES holders who were wrong one half instead of nothing. The forecast is right and the money
  says otherwise.
- The exploit VOID guards against survives in smaller form: a colluder buys NO at a low price,
  the author cancels, the colluder collects one half.

Measured with the reference module, `b` = 100 USDC, an honest YES crowd that spent 100 USDC
(price 81.6% YES), then a colluder buys NO and the author cancels:

| Colluder spends on NO | VOID at one half | VOID at last price | Resolve NO |
|---|---|---|---|
| 10 USDC | +12.61 | +1.83 | +35.22 |
| 50 USDC | +25.50 | +26.26 | +101.00 |
| 200 USDC | −21.19 | +118.12 | +157.61 |

Resolving NO on cancel is open-ended, which is why the parimutuel's rule had to go. VOID at one
half caps the extraction near a quarter of `b`, but it is available to any author and colluder at
any time, and it misprices every honest cancellation.

The alternative that fixes both: Cancelled → NO, but a proposal with an open market can only be
cancelled with notice. `proposal_nft` records `cancel_requested_at` and the cancellation takes
effect after a fixed notice period during which trading continues with the pending cancel visible,
so the market prices the cancellation in and nobody can cancel into a position. The author is
barred anyway. The same notice mechanism serves the "retire test data" path with a zero notice
period while a market has no positions. Recommendation: NO with notice; VOID reserved for
conflicting evidence. Whichever rule the user confirms is a one-line policy in `resolve_lmsr`.
