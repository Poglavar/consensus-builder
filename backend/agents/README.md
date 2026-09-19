# `backend/agents/` — the agent runner

Server-side personas that plan building proposals, have a model choose and justify them, and post
them through the paid `/agent/proposals` route. Design: `agents-functionality-for-ugt.md` §WS3.

## Data flow

```
personas.json ──▶ parcel-source.js ──▶ planner.js ──▶ llm-picker.js ──▶ record-builder.js ──▶ POST /agent/proposals
  (who, where)      parcels + rules      candidates      picks + text        the stored record       (x402, pays, binds author)
```

| stage | what it is | pure? |
|---|---|---|
| `parcel-source.js` | one SQL statement: parcels in a persona's bbox with area, geometry, the GDI buildings on them and the urban rule over them | no — the only I/O here |
| `planner.js` | envelope, one legal build-out, GFA, € gain, offer, persona score | yes (turf injected) |
| `record-builder.js` | the POST body, in the shape the app stores for a single freeform building | yes (turf injected) |
| `llm-picker.js` | the Anthropic Batches step: request building, parsing, cost estimate, submit/await/collect | pure except `runPickBatch` |

`run.mjs` (the orchestrator) owns the sequencing, the checkpoints, the proposal ids, the daily
spend cap and the Telegram summary. The modules here hold no state and never decide to spend.

This is intentionally hybrid rather than an unconstrained LLM loop: SQL and the deterministic
planner decide what is feasible, the model chooses among those candidates and explains why, and
deterministic adapters validate, pay, mint and stake. `donor.js` funds refundable proposal escrow
with an idempotent receipt, while `pledger.js` records an updateable commitment without moving USDC
and can later fulfil it after execution.
Policy—what proposal another agent wants to back and for how much—stays outside the money-moving
module and can be supplied by a later model step.

## Persona config (`personas.json`)

| field | meaning |
|---|---|
| `name` | the persona's id; appears in `candidateId`, `custom_id`, the record's `agent.persona` and the building's `author` |
| `wallet` | public key, for labels; the record's `author` is bound by the paid route from the settlement, never from here |
| `keypairPath` | where the signing key lives — **outside the repo** |
| `weights` | `{ density, openSpace, valueUplift, heritage }`; drives the planner's score and is put into the prompt in words |
| `areas` | `[{ city, bbox: [minLng, minLat, maxLng, maxLat] }]` |
| `dailyProposals` | how many picks the model may make for this persona in one run |
| `stakeUsdc` | the bettor's stake size |

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

## Cost

Every LLM call goes through the shared harness (`agents/lib/llm-cost`), in **batch only** — half
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
| `ANTHROPIC_API_KEY` | `llm-picker.js` (via the SDK client the caller constructs) | the Batches API key |
| `AGENT_LLM_MODEL` | the orchestrator, passed into `buildPickRequests`/`runPickBatch` | overrides `DEFAULT_MODEL` (`claude-opus-5`); must be priced in `agents/lib/llm-cost/rates.json` or the cost call throws |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `parcel-source.js` (via the pool the caller passes) | the shared `geodata` database |
| `X402_*`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | `routes/agent-proposals.js` | the hosted-CDP pay-to-post gate; see the design doc §WS1 |

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
PGHOST=localhost node agents/run.mjs --dry-run                       # plan + cost estimate, writes nothing
PGHOST=localhost node agents/run.mjs --live --persona densifier-01 --api http://localhost:3999
PGHOST=localhost node agents/run.mjs --live --until posted          # stop before staking
```

One `consensus.agent_run` row per persona per UTC day is the checkpoint (`stage`, `summary` with
candidates, batchId, picks, mints, posts, stakes); a rerun resumes at the first unfinished stage and
a finished day is a no-op. Model calls go through ONE Anthropic Batches job per run and are refused
when the day's `agent_cost` total plus the estimate would exceed `AGENT_LLM_DAILY_CAP_USD` (1000).
Mint happens BEFORE the paid post because a stored record has no on-chain write path after creation.
Confirmation polls `getSignatureStatuses` (`solana-send.js`): Alchemy's devnet RPC has no
`signatureSubscribe`, and web3's default confirm then reports a landed transaction as expired.
Env: `ANTHROPIC_API_KEY`, `AGENT_LLM_MODEL` (claude-opus-5), `AGENT_LLM_DAILY_CAP_USD`, `AGENT_API_BASE`,
`SOLANA_RPC_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (optional; one summary per run).
