<!-- Living plan for the city meme token: what exists, the decisions taken, the betting-reward design and every collected idea. Update it as steps finish. -->
# City meme token

Each city has its own meme token (`ZAGREB`, `SF`, `BOGOTA`, …), and there is one platform token, `UGT`.
The first use being built is rewarding people who bet correctly on agreements.

## Current state

### EVM contract (Base Sepolia, historical)

- `blockchain/contracts/CityMemeToken.sol`: ERC-20 "Zagreb Meme Token" (`ZAGREB`), capped at 1 B.
  A citizen calls `registerAsCitizen()` and accrues 1 token per hour from registration, which they
  `withdraw()`. The owner can also `mint`. Tests: `blockchain/forge-test/CityMemeToken.t.sol`;
  deploy: `blockchain/deploy/03-deploy-city-meme-token.ts`. Last address `0x3F7FF9fC46F32b462f4Cc2d02D07Ac3b6c0c2AeE`.
- `ProposalNFT.sol` takes `cityToken` as a second budget asset. A proposal can be funded or boosted
  in the city token, and that balance is paid out to parcel owners on execution.
- Frontend: the City token dialog in `frontend/js/user-management.js` (`cityToken*`: register,
  claim, balance), plus the `cityToken.*` i18n strings.
- It was never ported to Solana or Canton (`feature-daml.md` in the main checkout maps it to an SPL
  token or a DAML `Holding`).

### Betting today (Solana and server)

The agreement betting books are described in [betting-lmsr-points.md](betting-lmsr-points.md):

- **Points book**: a server-side LMSR ledger (`backend/markets/points-ledger.js`,
  `backend/routes/bets-points.js`, `backend/sql/points-ledger.sql`). It records every buy, sell
  and claim with its shares and amount in `consensus.points_transaction`. Accounts can link a
  wallet by signature.
- **Devnet USDC book**: the `proposal_market` LMSR program. Trades are mirrored into
  `consensus.solana_transaction` by the transaction sync job, and `backend/solana/tx-decoder.js`
  decodes `buy`, `sell` and `claim_lmsr` together with their token transfers.

Both books use the same unit: one winning share pays one atomic unit (10⁻⁶).

## Decisions (2026-11-13)

- **Off-chain first.** The token starts as a server ledger, like the Points book. Minting on chain
  (an SPL mint per city, then claims against the ledger) comes later.
- **Both books earn tokens**: Points and Devnet USDC.
- **Rewards are edge-weighted.** A correct call earns in proportion to how far the market was from
  the truth when the bet was placed, so early and contrarian calls earn the most and a buy at 0.99
  earns almost nothing.
- **Per-city tokens plus UGT.** A resolved market rewards correct bettors in that city's token,
  plus a smaller amount of UGT, using the same split.

## Betting reward design

### Edge

For one account (or wallet) in one resolved market, on the winning side:

```
edge = winning shares held at resolution × (1 − average entry price)
     = payout of those shares − their cost basis
```

The average cost method decides which shares a sell removes. VOID markets and losing sides earn
nothing. Agreement insiders, who are already barred from trading, earn nothing.

Edge is linear in stake: ten bets of 10 shares earn exactly what one bet of 100 shares earns, at the
same price. Larger bets earn more, and splitting a bet earns nothing extra.

### Sybil exposure: why the two books differ

- **Devnet USDC** has real stakes, and a losing bet loses them. Splitting across wallets gains
  nothing, because edge is linear. The remaining attack is self-dealing: wallet A pushes the price
  down, then wallet B buys cheap. A's loss is mostly B's gain, so the attack's real cost is only
  the LMSR spread, while B's token reward rises. A per-wallet rate that is small compared with that
  spread keeps the attack unprofitable.
- **Points** cost nothing: every new account gets 1,000 free points. A losing bet costs nothing real,
  so a hundred throwaway accounts betting both ways guarantee winners who collect tokens. This book
  needs bounded emission.

Proposal, pending the user's confirmation:

| Book | Who is eligible | Amount |
| --- | --- | --- |
| Devnet USDC | every winning wallet | `edge × rate` (uncapped, proportional to bet size) |
| Points | accounts with a linked wallet, ordinary realm only (no simulation runs) | a fixed pool per market, split pro rata by edge |

The UGT amount is the city amount × a fixed fraction (for example 1/10).

### Building blocks

1. Pure module `backend/markets/city-token-rewards.js`: fills (side, shares, cost or return, in
   order) plus the outcome give the edge; edges, the book rule and the pool or rate give the
   awards. Unit-tested headlessly.
2. Table `consensus.city_token_award`: one row per (book, market, recipient, token), with the edge,
   amount and the source transaction IDs. Its unique key makes awarding idempotent. A balance is
   the sum of a recipient's awards.
3. Award job `backend/scripts/award-city-tokens.js`: finds resolved markets without awards,
   computes them (points from `points_transaction`, USDC from the transaction mirror), and writes
   them. It can be rerun safely, logs progress and has a `--dry-run` mode.
4. API: balances per account or wallet and per token; a city-token leaderboard; the award shown
   on the claim receipt.
5. UI: the award on the claim result ("+120 ZAGREB · +12 UGT"), the balance in the Bets account
   view, and a column in the standings.
6. MCP parity: an agent can read balances and awards.
7. Later: an SPL mint per city plus UGT, with claims of the ledger balance to a wallet.

## Ideas collected

Moved here from `docs/BACKLOG.md`, `TODO.txt` and `TODO-blockchain.txt`, with the original wording kept.

From `docs/BACKLOG.md`:

> Incorporate the Meme Token
>
> - First without smart contract
> - Airdrop each turn

> - Earn city tokens by retweeting (KAITO, or tie into Schellinglayer)

> We need another set of agents to work with the shelling layer City meme coin well all agents should be able to work with this right use it but maybe some sort of randomness or speculation or minting or I don't really know.

> The user be just a player in the system or should we user be the mayor of the city if the letter then the user would be printing the meme coin sitting in coin with some other actions if not if the player is the player is just to player in the system then we need to set of other players; but this time in maybe politicians or you know the mayor or the City council or some other entity that also interacts with a system and with the proposals.

From `TODO.txt`:

> - Q: can this be gamified into a monopoly-like game? Where people strategically purchase parcels so they unlock higher building ratios, which airdrops them more meme tokens?

From `TODO-blockchain.txt`:

> - We should integrate attestations for city token ownership (only authorized address can take ownershp of the treasury?)

Already in place (`TODO-blockchain.txt`, the Boost item): donating city token to proposals, which
`ProposalNFT` holds and distributes on execution.

From the betting work (2026-11-13):

- Reward correct bettors with the city token: edge-weighted and proportional to bet size, as
  designed above.

## Open questions

- Should Points and USDC eligibility follow the table above, or should both books use one rule?
- What are the pool size, the rate and the UGT fraction?
- What does the token buy? Options include boosting or funding proposals (the old ProposalNFT
  path), a weight in community votes, and access to agent actions.
- Does the 1-token-per-hour citizen accrual of the EVM contract carry over?
- Legal: a token with market value paid to winners turns the Points book into points with prizes.
  Check this against the gambling-act finding in
  [prediction-market-integration.md](prediction-market-integration.md) before the token becomes
  transferable on chain.
