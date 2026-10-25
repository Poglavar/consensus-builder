<!-- Current product and API contract for the experimental LMSR agreement betting books. -->
# Agreement betting: LMSR and points

The current Bets flow uses a dated LMSR market for each minted, eligible agreement. A market asks
whether the agreement's on-chain status becomes Executed with a valid execution timestamp at or
before the agreement deadline. Trading stops at that deadline. The grace interval delays an
absence-based NO decision; it does not extend the deadline.

## Independent books

The selected asset determines a separate book:

| Book | How it works | Wallet |
| --- | --- | --- |
| Points | Server-side simulated balance and positions. New accounts receive 1,000 points. The points are not redeemable, transferable or backed by cash. | Not required. The browser creates an opaque random credential and sends it only to the points API. |
| Devnet USDC | On-chain LMSR market and token positions on Solana devnet. | Required for market creation, trades and claims. Optional wallet proof can associate the public points profile with a wallet. |

The books are independent: a points buy never changes a devnet market, and an on-chain trade never
changes points inventory or balance. A simulation run is part of the points account, market,
transaction and leaderboard identity, so test-run data remains segregated from ordinary activity.
The optional wallet link proves control of a wallet; it does not move or convert points.

## Market and quote contract

The canonical kind 0 Solana market is sponsored by the agreement's sponsor. Its PDA uses
`['lmsr', agreementAccount, sponsor]`; the agreement account is the subject. The current parameters
are `b = 100_000_000` atomic units, `closes_at` equal to the on-chain agreement deadline, zero grace,
and no per-position share cap (`max_position = 0`). These terms are verified by the backend reader.
The ProposalMarket program was upgraded on Solana devnet on 26 October 2026 at slot
`515120833`. Its downloaded executable matches the built LMSR artifact, including zero padding.
See the [release evidence](betting-validation-2026-10-25.md#devnet-release-follow-up).
This verifies deployment; it does not establish a completed public trade with the new instructions.

The frontend release (`5c8e731e6`, deployed 25 October 2026 at 22:30:49 UTC) and backend
(`79733ecd8`) are running with the points schema and API installed. The current deployed state is
reported by the [live proof endpoint](https://api.urbangametheory.xyz/hackathon/proof.json). Browser
and points user checks so far used simulated users; no outside humans have participated. A first
public points trade and complete devnet trading journey remain unverified. The proposed San Francisco
agreement pair is still unpublished.

The LMSR quote begins at 50/50 even with no trades. `b` controls price sensitivity; YES and NO
inventory move the quoted prices along the scoring rule. A buy quote specifies shares and a maximum
cost. A sell quote specifies shares and a minimum return. The client quotes the complete trade
including price impact; the backend or program recomputes it and enforces the user's limit. Each
winning share pays one atomic unit. Quotes are not parimutuel pool shares or estimates of a final
payout multiple.

## Resolution and claims

| Agreement evidence | Market outcome |
| --- | --- |
| Executed with valid positive `executed_at` no later than the deadline | YES |
| Executed after the deadline | NO |
| Expired | NO |
| Cancelled | VOID |
| Still Active once deadline plus grace is reached | NO |
| Missing, malformed or unrecognized lifecycle evidence | Cannot settle from that evidence |

YES pays one atomic unit per YES share; NO pays one unit per NO share. VOID pays half a unit for
each share on either side, rounded down per position. This is intentionally different from the
historical parimutuel contract, where a winning pool divided the pool's stakes. Existing parimutuel
chain accounts remain historical records; the current points and frontend contract has no legacy
pool reader or conversion.

## Points identity and public profile

The browser stores a 32-byte random bearer credential locally, keyed by backend, profile and
simulation run. Its hash identifies the points account server-side. The bearer is sent to the
points endpoints only; public agreement/market reads remain unauthenticated. Transactions use a
persisted request ID so an interrupted response can be retried idempotently. A pending uncertain
request blocks a different intent until reconciled.

Each account receives an anonymous display alias. Public positions and the leaderboard expose this alias (and
the wallet only when linked), not the credential. Positions are grouped by agreement account.
Unresolved leaderboard equity adds cash balance to a deterministic liquidation estimate: sell all
YES shares first, then all NO shares at the resulting LMSR price. Resolved equity includes unclaimed
payouts. This ranking is a model of current exit value, not cash withdrawable from the points book.

## Contract references

- Browser quote and asset choice: `frontend/js/bets/betting-contract.js`, `bets-trading.js`,
  `lmsr.js` and `bets-model.js`.
- Server points ledger and routes: `backend/markets/points-ledger.js` and
  `backend/routes/bets-points.js`.
- Chain program source: `blockchain/solana/programs/proposal_market/src/lmsr_market.rs`.
- Public points routes include account, market catalog, positions, leaderboard and wallet-link
  proof under `/bets/points/`; the regular city catalog remains `GET /markets`.
- `GET /oracle/recipes/agreement-execution-by-deadline-v1?agreement=<account>` provides the
  canonical agreement-market recipe and its deterministic hash, plus a separate fresh observation
  of current lifecycle evidence. The hash identifies the terms; the observation does not change
  that identity. Historical parimutuel recipe endpoints describe old market records and are not the
  current LMSR identity contract.
