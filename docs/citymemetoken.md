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

The rules in force (constants in `backend/markets/city-token-rewards.js`):

| Book | Recipient | Amount |
| --- | --- | --- |
| Devnet USDC | each winning wallet | `edge × 100`: one city token per 0.01 USDC of edge, uncapped |
| Points | each winning points account (wallet optional) | a pool of 1,000 city tokens per market, split pro rata by edge |

Every award comes with UGT worth 1/10 of the city amount. Tokens have 6 decimals. Simulation runs
get separate ledgers, as in the points book. A market whose city is not a slug (e.g. the simulated
San Francisco preview, "San Francisco (simulated preview)") gets no award; this is logged.

### What is built

- `backend/markets/city-token-rewards.js`: the pure math (average-cost edge, pool and rate
  awards, UGT). Tests are in `backend/test/city-token-rewards.test.js`.
- `backend/sql/city-token.sql`: `consensus.city_token_market` holds one row per awarded market,
  and that row is what makes awarding idempotent. `consensus.city_token_award` holds one row per
  (book, market, recipient, token). A balance is the sum of a recipient's awards; a wallet's
  balance also includes the points accounts linked to it.
- `backend/markets/city-token-ledger.js`: writes the awards and reads balances and standings.
- Points book: `POST /bets/points/resolve` awards the market in the same transaction, and the
  claim receipt carries `cityToken: [{ token, symbol, amount, display }]`.
- Devnet USDC book: `backend/scripts/award-city-tokens.mjs (--dry-run | --apply)` reads resolved
  markets from the chain and fills from the transaction mirror (`lmsrFills` in
  `backend/solana/tx-decoder.js`, which uses the USDC that actually moved). It refuses a market
  whose mirrored net shares differ from the chain's `q_yes`/`q_no`. It also backfills points
  markets resolved before awards existed. It is not scheduled yet.
- API: `GET /bets/city-token/balances?account=|wallet=` and
  `GET /bets/city-token/standings?token=` (`backend/routes/city-token.js`).
- UI: a city-token line in the Bets account box (`.bets-account__tokens`), and "Earned +N ZAGREB ·
  +M UGT." added to the collect message.
- MCP: awards are automatic and balances are a public GET, so there is nothing for an agent to
  edit and no MCP tool was added.

### Next

1. Schedule the award job after the transaction sync, and register an outcome check (bot-monitoring).
2. Run the job on prod (DDL ships with the backend deploy).
3. Add a city-token column or tab to the standings.
4. Later: an SPL mint per city plus UGT, and a claim of the ledger balance to a wallet.

## Boost: funding agreements with crypto and the city token

The old Boost button (ProposalNFT on EVM: fund a proposal in ETH or the city token, paid to owners
on execution) is gone. It was removed with the proposal write path in `fd91542e8` (2026-10-22,
M2); only its i18n strings (`boost.*`, `proposal_boost_failed`) remain.

The agreement took over the proposal's role: it is the record that is minted, executes and has a
beneficiary (its sponsor). Designs and plans only describe; agreements carry money. Support for an
agreement exists on chain, but nothing in the browser calls it:

- `agreement.fund(lamports)`: escrows SOL in the agreement.
- `proposal_pledge.donate`: a donation escrow per agreement, refundable if the agreement does not
  execute and released to the sponsor if it does. Its mint is pinned to devnet USDC, and the
  escrow PDA is `['donation_escrow', agreement]`, so there is one escrow and one currency per
  agreement. Soft pledges (`set_pledge`, `fulfill_pledge`) have the same limit.
- MCP has `ugt_fund_agreement`, `ugt_donate` and `ugt_pledge`, so today agents can boost and
  people cannot.

Bringing Boost back:

1. Add a Boost button to the agreement panel that donates devnet USDC through the existing
   `proposal_pledge.donate` (client: `frontend/js/solana/pledge-client.js`) and SOL through
   `agreement.fund`. No program change is needed.
2. Other SPL tokens need the escrow seeded per (agreement, mint) and the USDC pin dropped. That is
   a program change, so it must land before the immutable mainnet deploy.
3. Boosting with the city token works off-chain first: spend from the ledger into a boost row
   for the agreement, paid to the sponsor or to parcel owners on execution and refunded otherwise.
   This needs a debit side in the ledger, since today it only has awards.

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

- Are the pool size (1,000), the rate (100 per USDC cent of edge) and the UGT fraction (1/10) right?
- Who receives a city-token boost on execution: the sponsor, or the parcel owners as in ProposalNFT?
- What does the token buy? Options include boosting or funding proposals (the old ProposalNFT
  path), a weight in community votes, and access to agent actions.
- Does the 1-token-per-hour citizen accrual of the EVM contract carry over?
- Legal: a token with market value paid to winners turns the Points book into points with prizes.
  Check this against the gambling-act finding in
  [prediction-market-integration.md](prediction-market-integration.md) before the token becomes
  transferable on chain.
