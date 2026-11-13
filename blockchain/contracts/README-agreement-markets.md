<!-- How agreement prediction markets work on EVM chains: the audited Gnosis contracts they reuse, the two
contracts of ours that bind them to Agreement.sol, their parity with the Solana market, and how to deploy. -->

# Agreement markets on EVM

Every EVM agreement (`Agreement.sol`) can have one canonical yes/no prediction market: will it be
executed? The market reuses the audited Gnosis contracts that Polymarket also builds on, and adds two
small contracts that bind them to the Agreement contract.

## Contracts

| Contract | Source | Role |
|---|---|---|
| `ConditionalTokens` | npm `@gnosis.pm/conditional-tokens-contracts` 1.0.3 (LGPL-3.0) | ERC-1155 outcome tokens, split and merge against collateral, payout reports and redemption |
| `LMSRMarketMakerFactory`, `LMSRMarketMaker`, `Fixed192x64Math` | npm `@gnosis.pm/conditional-tokens-market-makers` 1.8.1 and `@gnosis.pm/util-contracts` 3.0.0-alpha.3 (LGPL-3.0) | LMSR automated market maker clones; the library is linked into the maker |
| `AgreementOutcomeReporter.sol` | ours | The Conditional Tokens oracle for agreements |
| `AgreementMarkets.sol` | ours | Opens, gates and reclaims the market of each agreement |

`IConditionalMarkets.sol` holds the 0.8 interfaces of the Gnosis contracts; 0.8 code cannot import
their solc 0.5 sources.

### Settling without an oracle

The question is the agreement key (`keccak256(abi.encode(sponsor, cid))`), with two outcome slots:
index 0 is NO and index 1 is YES. The condition's oracle is `AgreementOutcomeReporter`, which has no
owner and no off-chain input. Anyone may call `report(key)` once the agreement has left Active:

- Executed reports `[0, 1]`, so YES wins.
- Cancelled or Expired reports `[1, 0]`, so NO wins.
- Active, or an unknown key, reverts.

`execute` and `expire` on the Agreement contract are themselves permissionless, so a market can always
be settled from chain state alone.

### Opening, trading and the leftover

- `AgreementMarkets.open(key, b)` can be called only by the agreement's sponsor, once, while the
  agreement is Active and before its deadline. It prepares the condition if needed and takes funding
  `F = ceil(b · ln 2)` of the collateral from the sponsor (who approves it first). It then creates an
  LMSR maker with fee 0 and records `marketOf(key)`.
- The maker belongs to `AgreementMarkets`, and the contract never uses the owner powers to pause the
  maker, change its fee or pull its funding. The sponsor cannot do any of that either.
- `AgreementMarkets` is also each maker's whitelist. It admits every trader while the agreement is
  Active and before its deadline, and nobody after that. Trading therefore stops at the moment the
  outcome is decided on chain, as the Solana program's buy and sell checks do. Without this gate, a
  maker left trading after resolution would sell the winning side below 1 until the sponsor's whole
  leftover was gone.
- Traders call the maker directly: `trade([noAmount, yesAmount], collateralLimit)`. Positive amounts
  buy and negative amounts sell. Selling needs `setApprovalForAll(maker)` on `ConditionalTokens`.
  `calcNetCost` gives quotes and `calcMarginalPrice(1)` gives the YES price (a 2^64 fixed point).
- Winners redeem on `ConditionalTokens.redeemPositions(collateral, 0x0, conditionId, [1, 2])`, and each
  winning share pays one collateral unit.
- **The leftover funding goes to the sponsor, and only the sponsor can take it.** After resolution,
  `reclaim(key)` (sponsor only, once) reports the outcome first if nobody has. It then closes the maker,
  redeems the maker's outcome tokens and pays the sponsor everything they yield: the funding plus what
  traders paid, minus what the winning positions are owed. This is Solana's `reclaim_seed`. The
  winners' collateral stays locked in `ConditionalTokens` and is never touched.

## Parity with the Solana market

- The pricing is the same LMSR. Gnosis's maker with funding F has b = F / ln 2 for two outcomes. So
  `F = ceil(b · ln 2)` with b = 5 USDC (5,000,000 units, `DEFAULT_B` in `backend/agents/bettor.js`)
  deposits 3,465,736 units. That gives b = 5,000,000.13. The Solana seed is `maxLoss(b)`, one unit more,
  because Gnosis's maker always holds full collateral and needs no rounding slack.
- State maps one-to-one: Gnosis's maker holds `F + paid − sold` of each outcome token, which is the
  same as lmsr.js's `(qYes, qNo)` shares outstanding.
- `forge-test/fixtures/LmsrMarketVectors.sol` holds a trade sequence, generated from
  `frontend/js/bets/lmsr.js` by `scripts/gen-lmsr-market-vectors.mjs`, that covers both sides, buys,
  sells and prices near 0 and 1. On a real maker every trade costs or returns what lmsr.js quotes,
  within one atomic unit. Gnosis rounds in the maker's favour in 64.64 fixed point, while lmsr.js adds
  one unit of guard to buys. Bots can reuse lmsr.js quoting as it is, or call `calcNetCost`.
- Resolution is the same: Executed is YES, and Cancelled or Expired is NO. Both chains have one market
  per agreement, opened only by the sponsor while the agreement is Active.

## Gnosis dependencies

- `blockchain/solidity-deps/` is a separate npm package (`pnpm install` there). It keeps the
  truffle-era JS of these packages out of the app's `node_modules`, and its pnpm overrides drop that
  JS. The overrides also pin util-contracts to 3.0.0-alpha.3, because the `^3.0.0-alpha.3` range would
  otherwise resolve to 3.0.1, which no longer ships `Fixed192x64Math`.
- Nothing is vendored. Tests and deployments use the creation bytecode that Gnosis published in those
  packages (`build/contracts/*.json`, solc 0.5.10 with the optimizer on). This is the build deployed on
  mainnet. A one-off forge compile of the same sources with solc 0.5.10 and 200 optimizer runs
  reproduced the ConditionalTokens and LMSRMarketMakerFactory runtime bytecode byte for byte (excluding
  metadata). It also reproduced LMSRMarketMaker up to the library link placeholder.
- The forge project does not compile them, for two reasons. svm ships solc 0.5.x only for x86_64,
  which does not run on Apple silicon without Rosetta. Also, `forge test --match-path` builds only
  `contracts/` and the matched test, and `contracts/` is also compiled by hardhat with 0.8 only.
- `foundry.toml` grants read access to `solidity-deps/node_modules` so tests can load those artifacts.

## Tests

```
cd blockchain && (cd solidity-deps && pnpm install) && forge test --match-path forge-test/AgreementMarkets.t.sol
```

## Deploy

```
scripts/deploy-agreement.sh <network>           # the Agreement contract, if not deployed yet
scripts/deploy-agreement-markets.sh <localhost|baseSepolia|sepolia>
```

- The script deploys ConditionalTokens, Fixed192x64Math and the factory from the Gnosis artifacts, then
  the reporter and `AgreementMarkets` with forge.
- It reuses any of them already deployed: given in the environment (`CONDITIONAL_TOKENS`,
  `LMSR_FACTORY`, `AGREEMENT_REPORTER`, `AGREEMENT_MARKETS`), or on localhost recorded in
  `frontend/contracts/addresses.json`, provided they still point at the same contracts.
- The collateral is Circle's USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia and
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` on Sepolia. Both are checked on chain as "USDC" with
  6 decimals. On localhost the collateral is `contracts/test/TestUSDC.sol`, which anyone can mint.
- Only localhost addresses are written to `addresses.json`. A public deployment prints its addresses,
  to be recorded when a frontend reads them.
- Nothing has been deployed to a public network.

## Not built yet

- There is no JS adapter, frontend or bettor for EVM markets. The backend and agents still trade only
  the Solana market.
- No contracts have been verified on Basescan or Etherscan. The Gnosis artifacts carry their solc
  metadata, but verification is untested.
- There is no fee and no per-wallet position cap. Solana has an optional `max_position`.
