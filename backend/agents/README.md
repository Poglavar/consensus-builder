# `backend/agents/` — the agent runner

Server-side personas that plan building proposals, choose and justify them with either a deterministic
algorithm or an explicitly requested model, and post them through the paid `/agent/proposals` route.
Design: `agents-functionality-for-ugt.md` §WS3.

## Data flow

```
personas.json ──▶ parcel-source.js ──▶ planner.js ──▶ algorithmic-picker.js ──▶ record-builder.js ──▶ POST /agent/proposals
  (who, where)      parcels + rules      candidates       picks + text ($0)      stored record          (x402, binds author)
                                                    └──▶ llm-picker.js (explicit optional controller)
```

| stage | what it is | pure? |
|---|---|---|
| `parcel-source.js` | one SQL statement: parcels in a persona's bbox with area, geometry, the GDI buildings on them and the urban rule over them | no — the only I/O here |
| `planner.js` | envelope, one legal build-out, GFA, € gain, offer, persona score | yes (turf injected) |
| `record-builder.js` | the POST body, in the shape the app stores for a single freeform building | yes (turf injected) |
| `algorithmic-picker.js` | explicit guardrails plus seeded variation among the near-best candidates | yes |
| `llm-picker.js` | the Anthropic Batches step: request building, parsing, cost estimate, submit/await/collect | pure except `runPickBatch` |

`run.mjs` (the orchestrator) owns the sequencing, the checkpoints, the proposal ids, the daily
spend cap, signed-action/USDC caps and the Telegram summary. The modules here hold no state and
never decide to spend. `run-policy.js` refuses a live plan before it touches a wallet when it would
exceed four possible signed actions or 0.35 USDC by default.

The daily schedule is intentionally algorithmic: SQL and the deterministic planner decide what is
feasible, then `algorithmic-picker.js` accepts only urban-rule-backed positive-uplift candidates and
uses a stable day/persona hash to vary among the top three candidates within 90% of the best score.
It has zero model spend and is reproducible for a given day. An LLM can still be demonstrated by
passing `--controller llm`; deterministic adapters validate, pay, mint and stake in both modes.
`donor.js` funds refundable proposal escrow
with an idempotent receipt, while `pledger.js` records an updateable commitment without moving USDC
and can later fulfil it after execution.
Policy—what proposal another agent wants to back and for how much—stays outside the money-moving
module and can be supplied by a later model step.

`support-run.mjs` is another persona role in the same runtime, not a second agent system. It reads
active minted proposals from the public summary endpoint, uses `supporter-picker.js` for a stable
daily `$0` choice, executes one pledge/donation/market action through the existing Solana adapters,
and writes the same `consensus.agent_run` and activity envelope. The initial `supporter-01` policy
uses a soft pledge, so it produces real signed evidence without requiring a funded USDC transfer.

`canonical-case-run.mjs` is a manual, resumable demonstration over those same modules. It uses the
configured proposer and supporter to mint one small real parcel set, pay the x402 endpoint, donate,
pledge, and forecast both YES and NO. Each action is checkpointed in `consensus.agent_run` and
appears through the shared activity envelope; it is not scheduled and does not introduce another
agent runtime. Preview it with `npm run demo:case`; execute only on devnet with
`npm run demo:case:live`.
After the setup is publicly inspected, add `-- --terminal` to cancel the case, resolve its NO
market outcome, refund the donation, void the unfunded pledge and claim the winning position.

Both this runner and the browser simulation use `frontend/js/agent-action-engine.js`. A controller
(`human`, `algorithm`, or `llm`) chooses an action, the registered deterministic handler executes
it, and the engine emits the same actor/action/entity/activity envelope. The browser Activity view
merges simulation events with `GET /agent/activity`; actor rows look the same by default, while the
closed Details disclosure preserves controller and source provenance for audits.

## Persona config (`personas.json`)

| field | meaning |
|---|---|
| `name` | the persona's id; appears in `candidateId`, `custom_id`, the record's `agent.persona` and the building's `author` |
| `role` | `proposer` or `supporter`; both share the controller, checkpoint and activity system |
| `wallet` | public key, for labels; the record's `author` is bound by the paid route from the settlement, never from here |
| `keypairPath` | where the signing key lives — **outside the repo** |
| `weights` | `{ density, openSpace, valueUplift, heritage }`; drives the planner's score and is put into the prompt in words |
| `areas` | `[{ city, bbox: [minLng, minLat, maxLng, maxLat] }]` |
| `dailyProposals` | how many picks a controller may make for this persona in one run (the hackathon persona is capped at one) |
| `stakeUsdc` | the bettor's stake size |
| `support` | supporter cities, allowed action types and per-action USDC amount |

`heritage` is declared and weighted but contributes **0**: there is no heritage dataset wired in
yet, and a term faked from something else would look like a judgement nobody made.

## Candidate and record shapes

`planCandidates()` returns, best first:

```
candidateId  `${persona}:${parcelId}`      massing         Feature, the sampled build-out
parcelId, koName, areaM2, centroid          proposedGfaM2   from plan-yield measureBuilding
geometry     the parcel, WGS84              gainEur         from gain.js computeGain
buildingCount, builtGfaM2                   offerEur        round(gain × offerShareOfGain)
rule         { maxFloors, minSetbackM,      score           the persona's weights applied
               source: 'urban-rule'|'default' }
allowedFloors, envelope                     scoreParts      { density, valueUplift, openSpace,
normalizedRule  what the massing derives from              heritage, capped? }
```

`source: 'default'` means **no urban rule stated anything** and the module defaults were used
(5 floors, 3 m setback). In the sampled Zagreb bbox that is 26 of 60 parcels, and the default is
*taller* than every value the plan does state there (3) — so a runner that wants to stay inside the
plan should prefer `source: 'urban-rule'` or lower the default.

`buildProposalRecord()` mirrors what the app itself stores for a single freeform building
(local proposal 660): `type: 'building'`, `goal/typologyType: 'single'`, `primaryType: 'Urban Rule'`,
`facets`, `buildingProposal.parameters` (with the rule the massing came from), one
`geometry.buildings[0]` feature, `bounds` from `turf.bbox`, `cadastreParcelIds`, `offer` /
`offerCurrency`, and the `agent` stamp. It deliberately writes **no `author`** — the paid route binds
that to the wallet the facilitator verified, and a body naming a different one is refused before any
USDC moves. With an `onchain` argument it also writes `onchain`, `nft`, `isMinted` and `tokenId`,
which is what `frontend/js/proposals/chain.js` reads to show a proposal as minted.

## Optional LLM cost

The default and scheduled algorithmic controller makes no model calls and costs `$0`. When
`--controller llm` is explicitly selected, every call goes through the shared harness
(`agents/lib/llm-cost`), in **batch only** — half
price, ledgered per item as it arrives, so a killed run still accounts for what it spent. Read it
back with `llm-cost --repo consensus-builder --by script`.

`estimateBatchCostUsd()` is an **upper bound**, not a prediction: input tokens are estimated at 4
characters each and every request is billed as if the model wrote its full `max_tokens`. One
persona with 8 candidates estimates at ~$0.05 on `claude-opus-5`; the real item cost is far lower.

A batch that has not finished inside `awaitMs` is not an error — `runPickBatch` returns
`{ batchId, done: false, results: [] }` so the caller can checkpoint the id and resume with
`existingBatchId`. A batch already paid for must never be resubmitted.

## Environment

| variable | used by | meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | explicit `--controller llm` only | the optional Batches API key; not needed by the scheduled agent |
| `AGENT_LLM_MODEL` | the orchestrator, passed into `buildPickRequests`/`runPickBatch` | overrides `DEFAULT_MODEL` (`claude-opus-5`); must be priced in `agents/lib/llm-cost/rates.json` or the cost call throws |
| `AGENT_LLM_DAILY_CAP_USD` | `ledger.js` | hard metered-model ceiling; safe default 0.25 |
| `AGENT_DAILY_ACTION_CAP` | `run-policy.js` | maximum signed mint/x402/market-create/stake actions; safe default 4 |
| `AGENT_DAILY_USDC_CAP` | `run-policy.js` | maximum x402 plus stake spend; safe default 0.35 USDC |
| `AGENT_PROPOSAL_FEE_USDC` | `run-policy.js` | conservative x402 fee used in the pre-signing plan; default 0.05 USDC |
| `AGENT_SUPPORT_USDC_CAP` | `support-run.mjs` | maximum amount of its one daily support action; safe default 0.25 USDC |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `parcel-source.js` (via the pool the caller passes) | the shared `geodata` database |
| `X402_*`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | `routes/agent-proposals.js`, `routes/agent-oracle-facts.js` | hosted-CDP pay-to-propose and paid verified-fact gates; see the agent quickstart |

## Tests

```
cd backend && npx vitest run test/agent-parcel-source.test.js test/agent-planner.test.js \
                              test/agent-record-builder.test.js test/agent-llm-picker.test.js
```

None of them touch the network or the ledger. The one test that needs the database is opt-in:
`RUN_DB_TESTS=1 npx vitest run test/agent-parcel-source.test.js`.

## Running

```bash
cd backend
PGHOST=localhost node agents/run.mjs --dry-run                       # algorithmic plan + pick, writes nothing
PGHOST=localhost node agents/run.mjs --live --persona densifier-01 --api http://localhost:3999
PGHOST=localhost node agents/run.mjs --live --controller llm         # optional explicit Anthropic mode
PGHOST=localhost node agents/run.mjs --live --until posted          # stop before staking
node agents/support-run.mjs --dry-run --api https://api.urbangametheory.xyz
PGHOST=localhost node agents/support-run.mjs --live --persona supporter-01 --api https://api.urbangametheory.xyz
PGHOST=localhost npm run sync:land-events -- --dry-run
```

## MCP: one surface for any controller

`npm run mcp` starts `agents/mcp-server.mjs` over stdio. Its twenty-two tools expose the same proposal,
activity, x402, pledge, donation, and market adapters used elsewhere in this directory. This lets an
MCP-capable LLM host choose actions while the deterministic runners keep their existing algorithmic
choice policy; both execute through the same modules and appear in the same product views.

The server is read-only by default. Signed or paid tools require all three controls:

- a low-value devnet key at `UGT_AGENT_KEYPAIR`;
- `UGT_MCP_LIVE=1` in the MCP process environment;
- `confirm: true` in the individual tool call.

`UGT_MCP_MAX_USDC_PER_ACTION` defaults to `0.25`. It caps pledges, donations and forecasts before a
transaction is built, and the server inspects proposal and verified-fact x402 challenges against the
same ceiling before it permits payment. Prices remain server-declared. See
`GET /docs/agents.json` for the machine-readable tool list and `/docs/agents` for setup.

The opt-in PM2 ecosystem schedules the proposer at 02:00 UTC, the supporter at 02:15 UTC,
and the deterministic proposal-lifecycle oracle at 02:30 UTC. The oracle only materializes
terminal Solana account state that has matching transaction evidence in the shared ledger.

One `consensus.agent_run` row per persona per UTC day is the checkpoint (`stage`, `summary` with
candidates, controller input/result, picks and rationales, execution policy,
mint records, x402 payment ids/transactions, posts, stakes and activity); a rerun resumes at the
first unfinished stage and a finished day is a no-op. A valid zero-pick answer is terminal and is
stored as `outcome: "no-picks"`, rather than leaving a permanently-running row. In explicit LLM
mode, the complete prompt/model/batch/usage/cost is also stored and calls are refused when the day's
`agent_cost` total plus the estimate would exceed `AGENT_LLM_DAILY_CAP_USD` (safe default 0.25).
Mint happens BEFORE the paid post because a stored record has no on-chain write path after creation.
Confirmation polls `getSignatureStatuses` (`solana-send.js`): Alchemy's devnet RPC has no
`signatureSubscribe`, and web3's default confirm then reports a landed transaction as expired.
Env: `AGENT_API_BASE`, `SOLANA_RPC_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (optional; one
summary per run). Anthropic variables are optional and read only in explicit LLM mode.

## Daily schedule (opt-in)

`agents/ecosystem.config.cjs` defines `consensus-builder-agents` at 02:00 UTC, the shared-runtime
`consensus-builder-supporter` persona at 02:15 UTC, and the deterministic
`consensus-builder-land-oracle` materializer at 02:30 UTC. All three are one-shot,
non-restarting scheduled processes; the proposer has the limits above and four candidates offered
to the algorithmic controller.
They are deliberately separate from the API
ecosystem file, so an ordinary backend deploy cannot silently acquire a signing key or start an
autonomous spender.

After the dedicated low-value devnet key exists at the persona's `keypairPath` and the server-local
`.env` has database credentials and `SOLANA_RPC_URL`, activation is explicit:

```bash
cd /root/code/consensus-builder/backend
pm2 start agents/ecosystem.config.cjs --only consensus-builder-agents
pm2 start agents/ecosystem.config.cjs --only consensus-builder-supporter
pm2 start agents/ecosystem.config.cjs --only consensus-builder-land-oracle
pm2 save
```

The proposer is covered by the active `UGT Agent Runner` outcome check in
`alerts-server-telegram/bot-list.json`. The supporter and land oracle still need their own central
registry entries. Until those are added, `/hackathon/operations.json` exposes their redacted latest
outcome and freshness: supporter evidence comes from `consensus.agent_run`, and the land oracle
writes `logs/land-oracle-stats.json` atomically only after deriving its complete verdict. Process
status or a recent log line alone is not proof that either job finished successfully.

Candidate discovery repairs malformed imported parcel, building-footprint and urban-rule polygons
with `ST_MakeValid` before topology operations. This keeps one invalid source geometry from aborting
the bounded daily run; it does not rewrite the source tables.

## Actor and run explorer

`frontend/actor-explorer.html` is a read-only explorer of the shared activity envelope. It loads
`GET /agent/activity` and opens `GET /agent/runs/:runId` only when a run is selected; the latter
returns the recorded rationales plus exact `consensus.agent_cost` rows, not a cost estimate.

The map-app wiring seam is `window.ActorExplorer.mount(element, { events, loadRun })`. Feed it the
same merged activity list already used by the Activity UI (human, algorithmic, and LLM events all
share that shape), and provide `loadRun` only for live run IDs. It deliberately does not create,
schedule, or execute an agent.
