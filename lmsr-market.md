<!-- Design of record for the LMSR market in the proposal_market program (streamline.md, track 1): units, account layout, instructions, invariants, rounding, resolution and void rules, and the test contract shared with the JavaScript reference module. -->
# LMSR market: program design

The market maker replaces the parimutuel for every new market. The JavaScript reference is
`frontend/js/bets/lmsr.js`; the Rust port must reproduce `backend/test/fixtures/lmsr-vectors.json`
exactly, because the browser quote, the points ledger and the vault all run the same arithmetic.

## Units and arithmetic

- Shares and money share one unit: the stake token's atomic unit (10^-6 USDC). A winning share
  pays one atomic unit per unit held, so one full share pays 1 USDC.
- `b` is the liquidity parameter in the same unit. The maker's worst-case loss is `b · ln 2`;
  `max_loss(b) = ceil(b · ln 2) + 1` is the seed the creator deposits at creation.
- Fixed point is base 10^18. Every operation floors. `exp(-x)` reduces by `ln 2` and uses 24
  Taylor terms; `ln(s)` for `1 ≤ s ≤ 2` uses 40 terms of `2·atanh((s−1)/(s+1))`. The constants
  `LN2 = 693147180559945309`, the term counts and the loop shapes are part of the contract.
- Cost: `C(q) = max(q_yes, q_no) + b · ln(e^{(q_yes−max)/b} + e^{(q_no−max)/b})`, so both
  exponentials lie in `(0, 1]` and nothing overflows: quantities are u64 and every product of a
  u64 with ONE fits a u128. `b` is capped at 10^16 in both implementations: the fixed-point noise
  in the cost is about `b · 2.7e-17` units, so above roughly 2·10^17 a buy could be quoted at zero
  and a buy-then-sell loop would drain the vault (found by the review of the reference module;
  pinned by a test).
- Buy quote: `C(after) − C(before) + 1`. Sell quote: `C(before) − C(after) − 1`, floored at 0.
  The one-unit guard exceeds the fixed-point error by many orders of magnitude, so a round trip
  never profits the trader and the vault never pays more than the true cost difference.
- Price of a side: its exponential term over the sum of both, a 10^18-scaled fraction. The UI
  shows it as the chance; it is meaningful from the first trade because the maker sets it.

## Account: `LmsrMarket`

One account type for both resolution paths; `kind` selects the path at resolution.

| Field | Type | Meaning |
|---|---|---|
| `kind` | u8 | 0 proposal-state (settles from the proposal account), 1 recipe-bound (settles from an attestation) |
| `proposal` | Pubkey | the proposal account for kind 0; for kind 1 an optional binding (default when none) |
| `creator` | Pubkey | deposited the seed, reclaims what the payout leaves |
| `stake_mint`, `vault` | Pubkey | as today |
| `b` | u64 | liquidity |
| `q_yes`, `q_no` | u64 | outstanding shares per side |
| `seed` | u64 | the deposit, `max_loss(b)` or more |
| `closes_at` | i64 | last trade; also the question's deadline |
| `grace_seconds` | u32 | after `closes_at + grace`, absence of evidence settles NO |
| `max_position` | u64 | per wallet per side, 0 for none |
| `recipe_hash`, `subject_hash`, `yes_value_hash`, `no_value_hash` | [u8; 32] | kind 1 commitments, as in `ExternalMarket` |
| `credential`, `schema`, `trusted_attester` | Pubkey | kind 1, as in `ExternalMarket` |
| `resolved`, `outcome`, `resolved_at`, `evidence`, `evidence_hash` | | `outcome`: 0 NO, 1 YES, 2 VOID |
| `paid_out` | u64 | claims paid so far, for the creator's reclaim |
| `bump` | u8 | |

PDA seeds are `["lmsr", proposal, creator]` for kind 0 and
`["lmsr_recipe", recipe_hash, creator]` for kind 1, with positions under
`["lmsr_position", market, owner, side]`. `Position` keeps its layout (`amount` holds shares).
Separate namespaces prevent a recipe hash from taking an agreement market's address; the creator
signature prevents another wallet from reserving that creator's address with unusable terms.
Vault payouts sign with the full namespace, subject and creator seeds. The browser and Node codec
is `frontend/js/solana/lmsr-client.js`; tests compare its bytes and account ordering with the IDL and
independent Anchor serialization. Earlier unscoped experimental LMSR addresses are intentionally
not read by this codec. These changes still require a market-program release.

## Instructions

- `create_lmsr_market(kind, b, closes_at, grace_seconds, max_position, commitments…)`. Requires
  `closes_at` in the future, `b > 0`, and transfers `max_loss(b)` from the creator into the vault.
  Kind 0 requires an Active proposal. Kind 1 validates the SAS credential and schema and, when a
  proposal is bound, that the attester is in its lens, as `create_external_market` does today.
- `buy(side, shares, max_cost)`. Open market, before `closes_at`, not an insider. Computes the buy
  quote on-chain, requires it `≤ max_cost` (the client's slippage guard), transfers it, adds the
  shares to the side and the position, enforces `max_position`.
- `sell(side, shares, min_return)`. Same checks; requires the position holds the shares; computes
  the sell quote, requires it `≥ min_return`, transfers it from the vault, removes the shares.
- `resolve_lmsr()` kind 0: Executed with valid `executed_at ≤ closes_at` → YES; execution after
  `closes_at` → NO; Expired → NO; Cancelled → see below; else, once
  `now ≥ closes_at + grace`, NO. Kind 1: a qualifying attestation whose event time is on or before
  `closes_at` → the committed outcome; else, once `now ≥ closes_at + grace`, NO. Conflicting
  qualifying attestations for both outcomes → VOID (streamline B5).
- `claim()`. YES or NO: shares on the winning side pay one unit each. VOID: every share on either
  side pays one half, floored. Adds to `paid_out`.
- `reclaim_seed()`. Creator only, after resolution: transfers `vault − (obligation − paid_out)`,
  where `obligation` is the winning side's shares, or half of both sides for VOID.

The client computes shares for a budget off-chain with `sharesForBudget` and sends `shares` plus
`max_cost`; the program never searches. Each trade costs two evaluations of `C`. Measured on
localnet (2026-10-12): `buy` 56k to 79k compute units, `sell` 47k to 66k, under the 200k default,
so clients need no compute-budget instruction. The binary grew from 397 KB to 565 KB; a devnet
upgrade needs `solana program extend` first.

As built: two create instructions (`create_lmsr_market` for kind 0, `create_lmsr_external_market`
for kind 1) rather than one with a kind argument; the seed is exactly `max_loss(b)`; kind 0 trades
require the proposal to still be Active, so nobody buys a known outcome at a stale price between
the terminal state and resolution; the attestation's `recipeHash` must match the market's
`recipe_hash`; VOID's obligation is `floor(q_yes / 2) + floor(q_no / 2)`; the first attestation is
stored on the account and a second only in the `LmsrMarketResolved` event; errors 6028 to 6044 are
appended so the deployed codes keep their numbers. New instruction and account discriminators are
in the program's IDL under `target/idl` until the checked-in IDL is refreshed at deploy time,
together with the two backend tests that pin its hash and its instruction list.

## Evidence for kind 1: one schema, every source

The program never parses a source-specific payload. Every milestone market resolves from one SAS
schema, `MarketEvidence-v1`, issued by a lens member whose adapter did the source-specific work
(the permits dataset, the legislation records, the gazette):

| Payload field | Type | Meaning |
|---|---|---|
| `recipeHash` | string | `sha256:<hex>` of the recipe the attestation answers |
| `subject` | string | the recipe's `subjectText`: the jurisdiction and the canonical hash of the sorted parcel ids (`US-CA-SF\|sha256:…`, about 80 bytes, never the ids themselves, which would not fit a 116-parcel site into one attestation); the program hashes it and compares with `subject_hash` |
| `value` | string | the recipe's `yesText` or `noText`; hashed and compared with the committed outcome hashes |
| `eventTime` | i64 | the source's own time of the event (a permit's issued date), never the fetch time |
| `sourceObservedAt` | i64 | when the adapter read the source |
| `sourceRef` | string | where to look: a dataset row id, a document link |

`resolve_lmsr` for kind 1 requires: credential, schema and authority match the market's
commitments; the attestation is unexpired; `subject` hashes to `subject_hash`; `value` hashes to
`yes_value_hash` or `no_value_hash`; `eventTime ≤ closes_at` (the event happened by the deadline);
`eventTime ≤ sourceObservedAt ≤ now`. A YES attestation resolves YES at any time after it exists,
so a permit issued in October settles an end-of-year market in October. With no qualifying
attestation, `now ≥ closes_at + grace` resolves NO. The grace must cover the source's publication
lag: the permits dataset refreshes about weekly, so permit markets use at least fourteen days.
An "any new-construction permit" recipe also carries a not-before bound (the market's conception),
and a record dated on or before it is not evidence. Two qualifying attestations with different
values, submitted together, resolve VOID. The court market's chronology rule (evidence must
postdate close) belongs to its own question shape and stays with the legacy `ExternalMarket`.

## Invariants the tests pin

1. Vault ≥ `max(q_yes, q_no)` after every trade, so either outcome is always payable. Holds
   because `vault = seed + C(q) − C(0)` and `C(q) ≥ max(q)` while `seed ≥ C(0)`.
2. VOID at one half per share is always payable: `C(q) − C(0) ≥ (q_yes + q_no) / 2`.
3. A buy followed by a sell of the same shares never returns more than it cost.
4. Price of a side rises with its own shares and falls with the other side's.
5. The JavaScript module and the Rust port agree on every vector in `lmsr-vectors.json`.

NO-by-absence for kind 1 sees only the
attestations passed in, so the attester's service must resolve within the grace window, ideally in
the same transaction as its attestation. Kind 0 reads the agreement account's existing `executed_at`
field. A missing, nonpositive or future execution time, or an unrecognized lifecycle status, is
invalid evidence and fails settlement. The grace period delays the absence decision; it does not
extend the event cutoff. The account reader's test serializes a real agreement, independently of
the reader's offsets. This source correction requires a market-program release before deployment
can be claimed; it does not change the agreement account layout.

## Insiders (streamline B3)

`buy` and `sell` reject the proposal's owner, every lens member, and `trusted_attester`. For kind 0
and bound kind 1 markets those come from the proposal account at trade time (`ProposalLensView`);
an unbound kind 1 market bars the attester only. The check is best effort by construction: a
colluding second wallet is not detectable on-chain, which is why cancellation has its own rule.

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

## Legacy coexistence

The deployed parimutuel instructions and the `Market`, `ExternalMarket` and `Position` layouts
stay as they are, so existing devnet markets resolve and claim exactly as before. New markets are
LMSR only. Before the immutable mainnet deploy the parimutuel instructions are dropped behind a
cargo feature so the binary carries only what mainnet uses (streamline B6).

## Test contract (streamline K7)

Rust unit tests reproduce `lmsr-vectors.json`. Localnet tests cover: create with and without the
seed, buy under and over `max_cost`, sell under `min_return` and over the position, late trade,
insider trade, `max_position`, both resolution paths, VOID on conflicting evidence, claim on each
outcome, double claim, reclaim before and after resolution, and the vault invariant replayed over a
scripted trade sequence. The compute units of `buy` and `sell` are measured and recorded here.
