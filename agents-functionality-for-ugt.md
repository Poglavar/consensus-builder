<!-- Design for "Agents functionality for UGT": the x402 pay-to-propose gate, server-side persona agents, a per-proposal prediction market program, and the UI that exposes them. Written as independent workstreams with explicit interfaces so pieces can be built in parallel or handed out. -->

# Agents functionality for UGT

Branch and worktree: `colosseum-worlds-fair` (off `main` at `3ee1855`, 2026-09-16).
Submission target: Colosseum Crypto World's Fair, Solana track. Only work under this document is
hackathon work; Urban Game Theory (UGT, this repo) is the disclosed pre-existing platform.

## 1. Decisions (2026-09-16)

| # | Decision | Value |
|---|---|---|
| 1 | Market deadline | **None.** A market resolves only when its proposal reaches a terminal on-chain state. |
| 2 | Currency for the x402 fee and for market stakes | **Devnet USDC** (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). The proposal program itself keeps escrowing SOL; that is untouched. |
| 3 | Agent model spend | **Hard cap $1,000 per day** in the cost ledger. x402 prices start low and are adjusted by config, never by code. |
| 4 | Product name | **Agents functionality for UGT**. |
| 5 | Where the work lives | This worktree; this document is the source of truth for scope and interfaces. |

## 2. What already exists (verified against `main` on 2026-09-16)

- **Proposal write API.** `POST /proposals` in `backend/routes/proposals.js`. **Correction (build, 2026-09-16):**
  `POST /proposals/batch` is a READ — it takes `{ ids }` and returns stored records (POST only because the
  id list outgrows a query string). There is no batch create, so there is nothing to gate there.
  The body validator (`proposalCreateBodyValidator`, line ~211) has every field optional and
  `allowUnknownFields: true`; the durable land declaration is `cadastreParcelIds`. Only an IP write
  limiter protects these routes (`backend/index.js`, 15-minute window; `/proposals/batch` is exempt).
- **Machine-readable docs.** `GET /docs`, `/docs/api`, `/docs/database` in `backend/routes/docs.js`.
- **On-chain proposals (devnet).** `blockchain/solana/programs/proposal_nft` (Anchor 0.32). Program id
  `3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg`, IDL in `blockchain/solana/idl/proposal_nft.json`.
  Proposal PDA seeds `["proposal", counter_le_u64]`; counter PDA `["proposal_counter"]`.
  Fields: `proposal_id, owner, parcel_ids, is_conditional, image_uri, acceptance_possible, status,
  sol_balance, token_balance, acceptance_count, accepted_parcels, lens, bump`.
  `ProposalStatus { Active=0, Executed=1, Cancelled=2, Expired=3 }`.
  `accept_proposal` verifies the accepter owns the parcel in `parcel_nft`
  (`4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1`) and flips to **Executed only when every listed
  parcel has accepted**. `cancel_and_refund` sets Cancelled. **Nothing ever sets Expired**: the
  program has no clock. `mint_and_fund` requires at least one `lens` pubkey.
- **Frontend Solana stack.** `frontend/js/solana/{wallet-adapter,proposal-bridge,chain-data-loader,
  blockchain-sync,parcel-mint}.js`; Phantom/Solflare via the unified wallet flow; cluster defaults to
  devnet; program ids in `frontend/contracts/addresses.json` under `solana-devnet`. `solana-web3`
  1.98.4 is vendored.
- **Pure modules usable from Node.** `frontend/js/urban-rule-variation.js`,
  `frontend/js/proposals/plan-yield.js`, `frontend/js/proposals/gain.js` (UMD, no DOM), so an agent
  can compute the same massing and numbers the UI shows.
- **Toolchain on this machine.** `anchor-cli 0.32.1`, `solana-cli 3.1.11`, RPC = devnet, keypair at
  `~/.config/solana/id.json`. **rustup has no default toolchain** (`rustup default stable` is the
  first command before any `anchor build`). Compiled `.so` files from an earlier build sit in
  `blockchain/solana/target/deploy`.
- **x402 v2 on Solana.** Packages `@x402/express`, `@x402/core`, `@x402/svm`; scheme `exact`;
  devnet network id `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; public test facilitator
  `https://x402.org/facilitator` (devnet only; mainnet uses a different facilitator). The 402 response
  carries a `PAYMENT-REQUIRED` header; clients pay with `@x402/fetch`.

## 3. Architecture

```mermaid
flowchart LR
    subgraph agents [Agent runner (backend/agents, scheduled)]
        P[Persona planner] --> L[LLM step via Batches API]
        L --> S[Submitter]
        S --> MNT[Minter: mint_and_fund with agent keypair]
        MNT --> BET[Bettor: place stake]
        LED[(Cost ledger, $1000/day cap)] --- L
    end
    S -- "x402 payment (devnet USDC)" --> GATE[x402 gate /agent/proposals]
    GATE --> API[Existing POST /proposals handler]
    API --> DB[(proposal table)]
    MNT --> PN[proposal_nft program]
    BET --> PM[proposal_market program]
    PM -- "reads Proposal PDA" --> PN
    UI[Details panel: Market card + Agent activity] --> PM
    UI --> DB
    OWN[Parcel owners: accept_proposal] --> PN
```

The market never needs an oracle: it deserializes the proposal account and pays on its status.

## 4. Workstreams

Each workstream is independently buildable. The contract between them is in §5.

### WS1: x402 pay-to-propose gate — BUILT 2026-09-16 (see §8)

- **New paid route** `POST /agent/proposals` that calls the same handler function as the free route
  (`createProposalCreateHandler(pool)`, hoisted out of `setupProposalsRoute` for exactly this). No batch
  variant: see the §2 correction. The free routes stay exactly as they are, because the app's
  own frontend uses them. Gating `/proposals` itself would break humans.
- Middleware: `paymentMiddleware` from `@x402/express` with `ExactSvmScheme` and
  `HTTPFacilitatorClient`. Route price from config.
- **Identity binding:** the payer pubkey verified by the facilitator becomes the record's `author`
  and is stored in a new `agent` object on the record (see §5.1). A paid request with a mismatching
  `author` is rejected.
- Config in `ecosystem.config.cjs` (public values) and `backend/.env` (secrets): `X402_NETWORK`,
  `X402_FACILITATOR_URL`, `X402_PAY_TO` (treasury pubkey), `X402_PRICE_PROPOSAL` (e.g. `$0.05`),
  `X402_PRICE_BATCH_ITEM`. No value is hardcoded.
- Paid routes bypass the IP write limiter (payment is the limiter).
- **Acceptance:** `curl -X POST /agent/proposals` without payment returns 402 with a
  `PAYMENT-REQUIRED` header; a funded devnet wallet using `@x402/fetch` gets 201 and the stored row
  has `author = payer`. A test asserts the free route is unchanged.

### WS2: Agent quickstart

- `GET /docs/agents`: a page plus a JSON schema for the **minimal recipe**: `city`,
  `cadastreParcelIds`, `type`, one of `buildingProposal | structureProposal | roadProposal`, `offer`,
  `offerCurrency`, `description`, `agent`. Everything else may be omitted.
- Worked example with `@x402/fetch`, how to get devnet SOL (airdrop) and devnet USDC (Circle faucet),
  and how to read `/parcels/under`, `/buildings/footprints`, `/urban-rules` to choose land.
- **Acceptance:** an outside script following only the page succeeds end to end on devnet.

### WS3: Agent runner (`backend/agents/`)

- **Personas** in `backend/agents/personas.json`: name, wallet keypair path, weights (density,
  open space, value uplift, heritage), target areas (bbox or KO), daily proposal count, stake size.
- **Planner** (pure, tested): picks candidate parcels in the persona's areas, builds candidate
  proposals with the existing pure modules, computes yield and gain numbers.
- **LLM step:** one Batches API job per run with all personas' candidates; the model chooses which
  candidates to post and writes the rationale. Every item carries its own cost; the ledger refuses to
  submit once the day's total would exceed **$1,000**. Batch first, never single calls for bulk work.
- **Submitter:** pays through WS1 with the persona keypair.
- **Minter:** Node port of `proposal-bridge.js`'s `mint_and_fund` (same discriminator/borsh
  encoding) using the persona keypair; `lens` = the persona pubkey until a real lens is wired.
  Writes the resulting PDA into the record's `onchain` fields so the UI shows it as minted.
- **Bettor:** stakes on its own proposal through the WS4 client, side and size from the persona.
- **Job conventions:** runnable from the CLI, `--help` prints usage and does nothing, checkpoint per
  persona per day, idempotent on rerun (skips items whose artifact exists), timestamped logs,
  progress `k/N`, one Telegram summary per run, outcome check registered in
  `alerts-server-telegram` `bot-list.json` on the ledger table's freshness.
- **Acceptance:** a dry run prints the plan and cost estimate and writes nothing; a live run with one
  persona posts, mints and stakes on devnet and the ledger shows the per-item cost.

### WS4: Market program (`blockchain/solana/programs/proposal_market`) — BUILT 2026-09-16, not yet on devnet (see §8)

- **Model:** parimutuel, one market per proposal PDA, stakes in devnet USDC, no fee, no deadline.
- **Accounts.** `Market` PDA seeds `["market", proposal_pda]`: `proposal, usdc_mint, vault (ATA
  owned by market), yes_pool, no_pool, resolved, outcome, bump`. `Position` PDA seeds
  `["position", market, owner, side]`: `amount, claimed`.
- **Instructions.** `create_market(proposal)` (anyone, once, proposal must be Active). `stake(side, amount)` while the
  proposal is Active and the market unresolved. `resolve()` permissionless: reads the proposal account
  directly (owner = proposal_nft, discriminator, then a mirrored prefix struct up to `status`; NOT
  `declare_program!`, which would have dragged a second anchor-lang version into the workspace — the
  layout is pinned by `backend/test/proposal-market-layout.test.js`); `Executed` → YES, `Cancelled` → NO; any other
  status → error `NotTerminal`. `claim()` pays `amount * (yes_pool + no_pool) / winning_pool` to
  winners; if the winning pool is empty, everyone is refunded.
- **Decision 1 consequence:** while a proposal stays Active, stakes are locked indefinitely. The
  program has no Expired path today. Recorded as an open risk (§6); no withdrawal before resolution
  in v1 because a visible acceptance count makes late exits gameable.
- **Build/test/deploy:** `rustup default stable` once; `anchor build`; localnet mocha tests under
  `blockchain/solana/tests/` (run only when asked); `anchor deploy` to devnet; program id added to
  `frontend/contracts/addresses.json` under `solana-devnet.ProposalMarket` and to `Anchor.toml`.
- **Acceptance:** localnet test: create → stake both sides → mark proposal Executed through the real
  `proposal_nft` flow → resolve → claim pays the parimutuel amounts to the lamport.

### WS5: UI

- **Market card** in the proposal details panel, rendered beside Share in `primaryActionsHtml`
  (`frontend/js/proposals/details-panel.js`). Shows pools, implied probability, the viewer's
  positions; Stake YES / Stake NO through the existing wallet adapter; Resolve and Claim when
  applicable. Only for proposals that carry a Solana `onchain` ref.
- **Agent activity panel:** the proposal list filtered to agent authors, each with its persona and
  rationale, reusing the browse-mode panel.
- New strings in all four locales (`frontend/i18n/{en,es,hr,sr}.json`), no hardcoded text.
- **Acceptance:** verified in a launched headed Chrome against devnet by the person doing the work;
  pure parts (payout math, probability formatting) unit-tested headless.

### WS6: Demo realism

- `Executed` needs every listed parcel accepted by its verified owner. For the demo area, mint the
  parcels to wallets we control with `blockchain/scripts/mint-parcels.js --bbox`, fund persona and
  owner wallets (SOL airdrop, devnet USDC faucet), and script an acceptance so at least one market
  resolves YES on camera.
- Public devnet instance reachable by outside agents; the count of agent-submitted proposals is the
  traction number.

### WS7: Ops and submission

- Ledger tables in the shared `geodata` database, `consensus` schema, owned by `geo_user`,
  with `created_at`/`updated_at`: `agent_run` (run id, persona, started, finished, status, summary)
  and `agent_cost` (run id, item, model, input/output tokens, usd).
- README section for the product, the Colosseum disclosure text (what pre-existed, what is new),
  the presentation and demo videos.

## 5. Interfaces between workstreams

### 5.1 The `agent` object on a proposal record (WS1 writes, WS3 fills, WS5 reads)

```json
"agent": {
  "wallet": "<base58 payer pubkey>",
  "persona": "densifier-01",
  "rationale": "…one paragraph written by the model…",
  "run_id": "2026-09-20T02:00Z-densifier-01",
  "paid": {
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    "amount": "0.05",
    "amountAtomic": "50000",
    "tx": "<settlement signature>"
  }
}
```
Stored on the row alongside the existing JSON; `author` is always `agent.wallet`. Whatever the agent
sent under `agent` (`persona`, `rationale`, `run_id`) is kept; `wallet` and `paid` are always overwritten
from the settlement (`utils/x402-payment.js` `buildAgentStamp`).

### 5.2 Market program client (WS4 exposes, WS3 and WS5 consume)

`blockchain/solana/idl/proposal_market.json` plus a small pure client module
`frontend/js/solana/market-client.js` (UMD, works in Node and browser) with
`getMarketPda(proposalPda)`, `buildCreateMarketIx`, `buildStakeIx(side, amount)`, `buildResolveIx`,
`buildClaimIx`, `readMarket(connection, pda)`. Payout math lives in a pure, tested function.

### 5.3 Persona config (WS3) and ledger schema (WS7)

Documented in `backend/agents/README.md` once WS3 lands; the ledger DDL ships under
`backend/db/agents-ddl.sql` and is applied with the existing DDL path.

## 6. Open risks

- **Locked stakes.** With no deadline and no on-chain expiry, a proposal nobody accepts or cancels
  keeps stakes forever. Candidate remedies if it bites: owner-only `cancel_and_refund` (exists), or
  a later program version with a market-creator void after the server-side `expiresAt`.
- **Facilitator dependency.** The x402.org facilitator is a third party; if it is down the paid
  route is down. Fallback: verify the USDC transfer signature ourselves and keep the 402 shape.
- **Multi-parcel proposals rarely execute.** Personas should favour few-parcel proposals so some
  markets resolve YES during the demo.
- **Self-dealing.** An agent staking on its own proposal is by design; humans can see it.
- **Devnet USDC supply.** Faucet-limited; prices and stakes stay small.
- **Anchor `declare_program!` and the existing IDL.** Must be checked against Anchor 0.32 on first
  build; if it fails, deserialize the account manually from the IDL layout.

- **`anchor keys sync` is destructive here.** The parcel_nft/proposal_nft deploy keypairs are not in
  the repo, so a sync rewrites their `declare_id!` to throwaway keys. Happened on 2026-09-16, reverted;
  the layout test pins the ids. Deploy one program at a time by name.
- **Upfront settlement has no verify step.** The pre-charge refusal (author ≠ payer, undecodable
  transaction) runs in `onBeforeSettle` off the signed transaction; a handler failure after settlement
  (e.g. 409 duplicate id) has still been paid.
- **Devnet money.** The deploy wallet holds 1.4 SOL and a 290 KB program needs ~2; the CLI airdrop is
  rate-limited. Nobody here holds devnet USDC yet, so the paid 201 path is untested against the real
  facilitator (the 402 path is).

## 7. Verification standard

Every workstream ends with an artifact check, not a report: a row read back, a PDA read back, a
402 seen in curl, a payout checked to the lamport. Headless tests cover pure logic; browser checks
are done by the person in a launched headed Chrome. Nothing is "done" on the strength of a log line.

## 8. Build log

### 2026-09-16 — WS1 and WS4 built (worktree, uncommitted)

**WS1, verified.** `backend/routes/agent-proposals.js` + pure `backend/utils/x402-payment.js`.
Flow is `upfront` (route `extra.paymentFlow`): the facilitator settles the USDC transfer BEFORE the
handler runs, so every stored row carries the settlement signature and nothing is stored on a failed
payment. Order on the wire: body validation (400 for free) → 402 challenge → `onBeforeSettle` refuses
`author_mismatch` / `invalid_payment_payload` for free, reading the payer off the signed transaction →
settle → `onAfterSettle` stamps `req.x402Payment` → handler writes `author = payer` and `agent`.
`/agent/*` bypasses the Origin/Referer gate and the IP write limiter in `index.js`. With any of
`X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_PAY_TO`, `X402_PRICE_PROPOSAL` unset the route answers
503 naming them (values in `ecosystem.config.cjs`; devnet copies in the worktree `backend/.env`).
Evidence: `test/agent-proposals.test.js` (real @x402 middleware, real partially-signed transaction
built with @solana/kit, faked facilitator; asserts `['settle','db','db']` ordering, author column =
payer, the stored `agent` object, 409 after settlement, free route unchanged) and `test/x402-payment.test.js`;
full backend suite 4262 passed. Live: backend on :3999, `curl -X POST /agent/proposals` with no Origin
→ 402 whose challenge carried x402.org's fee payer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`,
amount `50000`, the devnet USDC mint and `paymentFlow: upfront`; `POST /proposals` without Origin still 403.

**WS4, verified on localnet.** Program id `GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB` (in lib.rs,
both Anchor.toml sections, `idl/proposal_market.json`, `frontend/contracts/addresses.json`). anchor-lang
0.30.1 + anchor-spl 0.30.1 (single anchor version in the workspace; anchor-cli 0.32.1 builds it).
Payout math is a pure `payout_amount` with Rust unit tests. `blockchain/solana/tests/proposal_market.ts`:
18 cases — create/duplicate/non-proposal, stake both sides + top-up + invalid side/zero, NotTerminal
while Active, Executed through the real accept flow → YES → sole winner paid the whole pot to the unit,
loser NothingToClaim, AlreadyClaimed, Cancelled → NO with empty winning pool → refunds, two-winner
pro-rata split. `anchor test --skip-build`: 41 passing (18 new + 23 existing). `tests/proposal_nft.ts`
now fetches-or-initialises the counter because mocha runs files alphabetically.
Client `frontend/js/solana/market-client.js` (UMD, global `SolanaMarketClient`, no other top-level
names): PDAs, ATA derivation, the four instruction builders, `decodeMarket`/`decodePosition`,
`readMarket`/`readPosition(connection, …)`, `payoutAmount` (BigInt mirror of the Rust function, same
cases), `impliedProbability`, `formatAtomic`. `backend/test/market-client.test.js`: 55 cases, account
metas asserted against the IDL's own writable/signer flags, discriminators recomputed from sha256;
8 mutations of the implementation each turned the suite red. Web3 comes from `configure({ web3 })`
or `globalThis.solanaWeb3` (the vendored IIFE); a Node caller in `backend/` passes
`require('@solana/web3.js')` in, since the file cannot resolve backend's node_modules itself.
Not yet in `frontend/index.html`'s script list — that is WS5's first line.

### 2026-09-16, later — devnet deploy and the paid path, both verified

**Market program on devnet.** `anchor deploy --program-name proposal_market --provider.cluster devnet`
after the wallet was topped up from faucet.solana.com. `solana program show` reads back id
`GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB`, 289,728 bytes, upgrade authority
`AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ`, rent 1.47 SOL (measured with `solana rent`, a
refundable deposit — `solana program close` returns it). IDL account `66R6QbYprREJcxd2saTTEWmMUPpyx6ixx2KtBCDYGMJZ`.

**Paid 201 against x402.org.** `backend/scripts/agent-submit.mjs` (also the WS2 worked example: keypair
in, `@x402/fetch` + `ExactSvmScheme`, `--dry-run` prints the challenge and pays nothing). Payer = persona
wallet `G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg` (keypair `~/.config/solana/ugt-persona-01.json`,
outside the repo; funded 0.2 SOL + 5 USDC from the treasury wallet). Backend run natively with
`PGHOST=localhost` on :3999 against the docker Postgres. Result: 201, row **1339** in the local `proposal`
table; read back through the free `GET /proposals/1339`: `author` = the persona wallet, `agent` =
`{ persona, rationale, run_id, wallet, paid: { network, asset, amount: "0.05", amountAtomic: "50000", tx } }`.
Treasury USDC 15 → 15.05, persona 5 → 4.95, settlement transaction
`3qzwHhFzEMzVNjCpsePnVwRM2NUdNNqjggoSrWrGSviqCnSxBtaYfiJDWZrEvpjfcyvf5zCumeKXRMmCvG6DHsds` confirmed on devnet.

### 2026-09-16, night — WS2 page, and the transaction explorer (owner request, outside the 7 workstreams)

**WS2 done.** `GET /docs/agents` renders `backend/routes/docs-agents.md` through the same page template
as `/docs` (lifted into `renderDocPage`), with the live price, network, base URL and market program id
substituted; `GET /docs/agents.json` serves `routes/agent-recipe-schema.json` (JSON Schema of the
minimal recipe, only `cadastreParcelIds` required) plus the live x402 terms and endpoint URLs. Four
docs tests. `scripts/agent-submit.mjs` is the worked example the page points at.

**Transaction explorer.** A standalone page, `frontend/tx-explorer.html` (+ `css/tx-explorer.css`,
`js/tx-explorer.js`, global `TxExplorer`), backed by `GET /transactions`, `GET /transactions/watched`,
`POST /transactions/sync` in `backend/routes/transactions.js`. Derived from the chain, not from
bookkeeping: `backend/solana/address-book.js` labels who is who (our three programs, treasury wallet
+ USDC account, each persona in `backend/agents/personas.json` + USDC account, the x402 facilitator
fee payer, USDC mint, system programs); `backend/solana/tx-decoder.js` decodes parsed transactions
with the three IDLs (instruction name by discriminator, IDL account names as roles, borsh args),
SPL/system amounts with owners, and one plain-sentence summary per transaction (x402 settlement,
stake/create_market/resolve/claim, mint_and_fund/accept/cancel, SOL transfers, ATA creation, program
deploy, deploy-buffer chunks, Anchor IDL writes). **Store-backed**: `consensus.solana_transaction`
(`routes/transactions-ddl.sql`, applied by hand with psql like the other DDL files, owned by
`geo_user`) keeps the raw parsed transaction per signature; a sync scans signatures for the 7 watched
addresses, fetches only unseen ones in 5-signature chunks with spacing and backoff, and stores
partial batches; the page reads from the store (67 ms) and is never failed by the RPC. Backfill CLI
`scripts/sync-transactions.mjs` (checkpoint = the table; 20 throttled runs converged with zero
refetches). Links to Solana Explorer and Solscan per transaction and address; expandable rows with
the instruction list, roles, flags and full addresses; filters by text/program/action; phone layout
verified in a launched Chrome. Tests: address-book 18, tx-decoder 42, tx-store 28, transactions 21,
page model 38; all mutation-checked.

**Facts learned.** (1) The public devnet RPC counts every signature in a `getTransaction` batch and
throttles for minutes; the store is load-bearing, and `SOLANA_RPC_URL` can point at a dedicated
endpoint. (2) The facilitator fee payer must be LABELLED but never SCANNED: it signs every x402
payment on devnet by anyone, and scanning it pulled 49 strangers' payments into the store (pruned).
(3) The deployed `proposal_nft` on devnet predates the checked-in source: its `accept_proposal` takes 2
accounts where the IDL declares 4, so the decoder drops roles for it with `accountsWarning`. The
Proposal ACCOUNT layout matches the source (18 devnet proposals decode cleanly with the mirrored
prefix), so `proposal_market` resolves correctly against the deployed program; only the accept
path's parcel-ownership check differs from the source — relevant to WS6.

**Not done.** WS3, WS5, WS6, WS7. Prod has none of this yet (`X402_*` values are in
`ecosystem.config.cjs`, uncommitted; the deploy script refuses uncommitted backend changes; the
transactions DDL must be applied on the server by hand before the route can serve there).

