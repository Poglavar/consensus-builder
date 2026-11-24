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

Any wallet may open a funded devnet USDC LMSR market on an agreement and choose its deadline and liquidity. Positions, prices and share links identify the exact market account; multiple markets may exist for one agreement and lists rank by funded liquidity `b` descending. The points simulator uses a single execution question independently. Cancellation resolves NO; an active market closes strictly after `closesAt + graceSeconds`.

The permissionless market address contract requires coordinated client and program releases. Existing funded vaults must remain accessible under their original signer until their outstanding obligations are settled. [LMSR market contract](lmsr-market.md)

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
| Cancelled | NO |
| Still Active strictly after deadline plus grace | NO |
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
- `GET /oracle/recipes/agreement-execution-by-deadline-v1?agreement=<account>` describes the points book. Add `&market=<address>` for a funded USDC book's exact execution or public-record terms and current observation. For public-record markets, the response includes the recipe CID, verifier, schema and committed outcome hashes. `/markets/recipes/<cid>` serves the matching question.
