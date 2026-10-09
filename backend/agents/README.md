# `backend/agents/` — the agent runner

Release status (2026-10-02): devnet ParcelNFT v2, ProposalMarket v2 and ProposalNFT v3 are byte-verified. An API deploy does not activate opt-in signing personas or lens-member services. Live member-service/schema setup and a real attested owner journey remain separate follow-ups; see [next steps](../../next-steps.md).

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

## A society of agents that disagree

`society-run.mjs` runs any persona whose role has a pure policy module at `policies/<role>.js`
(`decide(input)` → one action or none, plus `NEEDS` saying what to gather). Each turn it reads the
active minted proposals, every proposal's market, and the persona's own history (its checkpointed
turns, its on-chain positions/pledges, and in a dry run the earlier simulated turns), asks the policy,
and executes the one action through `AgentActionEngine` with the same `consensus.agent_run` rows,
activity envelope and Telegram summary as the supporter. `$0` by default; `--controller llm` lets a
model (Batches, via `llm-picker.js` and `society-llm.js`) pick one of the policy's options that fit the
caps, or none — never anything the policy did not offer. `support-run.mjs` is unchanged.

| persona | role | rule |
|---|---|---|
| `preservationist-01` | `contrarian` (`policies/contrarian.js`) | Among active minted proposals by other actors it has not already bet against (on-chain NO position or checkpointed stake) and whose market is unresolved, score density: proposed gross floor area = Σ footprint m² × floors from the record's `geometry.buildings` (floors from the feature, else `buildingProposal.parameters.floors`, else height / 3); without a massing, a text heuristic (floors mentioned × 100 + 50 per density word) ranked after every measured one. Score 0 (parks, squares) is never a target. Stake NO `policy.amountUsdc` (0.01) on the highest; ties by a `seed`-stable hash. A missing market costs a second signature. |
| `speculator-01` | `speculator` (`policies/speculator.js`) | Implied YES = yesPool / (yesPool + noPool); no/empty/resolved market = no signal. First, revoke (`revoke_pledge`) an active own pledge on a still-Active proposal whose probability < `revokeBelowProbability` (0.5) or whose age (from its `createdAt`) > `maxAgeDays` (7), lowest probability first. Otherwise pledge `amountUsdc` (0.05) to the proposal with the highest probability ≥ `minPledgeProbability` (0.6) that is ≤ `pledgeWithinDays` (3) old and was never pledged to before (a revoked pledge is not re-made, so it cannot flap). |
| `lifecycle-01` | `lens-member`, kind `lifecycle` | Runs the reference lens member through `lens-member-run.mjs` (port 3096). Its `service.operatorTokenEnv` maps `AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN` to the member's `LENS_OPERATOR_TOKEN`, so the proposer's retire phase and the member share one token; set `AGENT_LIFECYCLE_LENS_SERVICE_URL=http://127.0.0.1:3096` for the proposer to expire stale proposals by verdict. |

All three have `wallet: null` until the operator generates `~/.config/solana/ugt-<name>.json`; a
`--live` society run refuses before reading anything until the key exists and `wallet` matches it.

Caps bound one invocation: `AGENT_SOCIETY_ACTION_CAP` signed actions (default 4) and
`AGENT_SOCIETY_USDC_CAP` (default 0.05; stakes and pledge commitments count, revokes are free). The
policy sees the remaining budget, so a revoke can still happen after the USDC is spent; when options
exist but none fits, the turn ends `cap-reached` and the invocation stops.

Game days: `--turns N` (1–10) plays N turns in one invocation. Turn k is checkpointed as
`<day>-<persona>-t<k>` with seed `<day>:t<k>` and re-reads the chain, so turn k sees what turn k−1
signed; a rerun resumes at the first unfinished turn and counts the finished ones against the caps.
Without `--turns` the run id is `<day>-<persona>` and the seed `<day>`. Proposal ages always use the
real clock. Outcomes: `completed`, `no-action`, `replayed` (already on-chain), `cap-reached`, `failed`.

`/hackathon/operations.json` lists these roles under `optionalJobs` (not `jobs`, so the proof audit's
four-job check is unchanged): no row = `not-configured`; the newest finished row older than 36 h =
`inactive`; only a recent failure turns the overall status to `attention`.

`canonical-case-run.mjs` is a manual, resumable demonstration over those same modules. It uses the
configured proposer and supporter to mint one small real parcel set, pay the x402 endpoint, donate,
pledge, and forecast both YES and NO. Each action is checkpointed in `consensus.agent_run` and
appears through the shared activity envelope; it is not scheduled and does not introduce another
agent runtime. Preview it with `npm run demo:case`; execute only on devnet with
`npm run demo:case:live`.
After the setup is publicly inspected, add `-- --terminal` to cancel the case, resolve its NO
market outcome, refund the donation, void the unfunded pledge and claim the winning position.

The executed path is a second case on a second parcel set (`npm run demo:case:executed` to preview,
`npm run demo:case:executed:live` to run). It sets up the same way, then the supporter persona, which
holds the devnet ownership certificate of every listed parcel, accepts each parcel; the last acceptance
puts the proposal in `Executed` on-chain, the market resolves YES, the donation escrow is released, the
pledge is fulfilled from the supporter's wallet and the proposer claims the winning YES position. The
land-event materializer (daily 02:30 UTC) publishes the `executed` event that completes the public case
page and the `executed_case_yes` audit check.
That case was recorded on the v1 programs (2026-09). Lens model v2 removes `accept_proposal`, so the
runner replays it only from its checkpoint: the anchor step reads each parcel anchor (minting it
ownerless via `ensureParcelAnchor` if missing), and a new executed case with no recorded acceptances
stops with a message pointing at `--outcome attested`.

Both this runner and the browser simulation use `frontend/js/agent-action-engine.js`. A controller
(`human`, `algorithm`, or `llm`) chooses an action, the registered deterministic handler executes
it, and the engine emits the same actor/action/entity/activity envelope. The browser Activity view
merges simulation events with `GET /agent/activity`; actor rows look the same by default, while the
closed Details disclosure preserves controller and source provenance for audits.

## Persona config (`personas.json`)

| field | meaning |
|---|---|
| `name` | the persona's id; appears in `candidateId`, `custom_id`, the record's `agent.persona` and the building's `author` |
| `role` | `proposer`, `supporter`, `lens-member`, or a society role with a `policies/<role>.js` module (`contrarian`, `speculator`); all but lens members share the controller, checkpoint and activity system |
| `wallet` | public key, for labels; the record's `author` is bound by the paid route from the settlement, never from here |
| `keypairPath` | where the signing key lives — **outside the repo** |
| `weights` | `{ density, openSpace, valueUplift, heritage }`; drives the planner's score and is put into the prompt in words |
| `areas` | `[{ city, bbox: [minLng, minLat, maxLng, maxLat] }]` |
| `dailyProposals` | how many picks a controller may make for this persona in one run (the hackathon persona is capped at one) |
| `stakeUsdc` | the bettor's stake size |
| `support` | supporter cities, allowed action types and per-action USDC amount |
| `service` | lens members only: `port`, `url`, `kind` (`owner-consent` or `lifecycle`), `priceUsdc` per ownership attestation, `credentialName`, `identity` adapter, optional `operatorTokenEnv` (the env var passed on as `LENS_OPERATOR_TOKEN`) |
| `policy` | society roles only: `cities` plus the policy module's parameters (see the table above) |

`heritage` is declared and weighted but contributes **0**: there is no heritage dataset wired in
yet, and a term faked from something else would look like a judgement nobody made.

## Lens: who decides an agent proposal

A proposal's lens is the list of lens member keys whose attestations its contract accepts
(`../../lens-model.md`). Proposers never name themselves: `run.mjs` and `canonical-case-run.mjs`
take `--lens KEY,KEY`, or, without it, choose from the attester directory
(`GET /agent/lenses/members`) with `lens-directory-client.js`:

- `chooseLens(members, { kinds: ['owner-consent'], min: 1, exclude: [proposerWallet] })` keeps
  members of those kinds that are not excluded, ranks them by `coverage.ownership` descending then
  `key` ascending, and returns the first `min` (or `max`). Fewer than `min` throws.
- An empty or unreachable directory, or a `--lens` naming only the proposer, refuses the mint with a
  message; nothing falls back to a self-lens. `minter.js` itself throws when `lens` is empty.
- The daily run checkpoints the choice in `summary.lensChoice` (the canonical case in
  `canonicalCase.lensChoice` and `summary.lensChoice`), so a resumed run mints with the same
  authorities. `--dry-run` prints the chosen lens and why, or the refusal.
- The mint's `create` action carries the lens (`run-policy.js createAction`), so every create event in
  the activity feed has `action.lens` for the proof audit's `no_self_lens` check.

### `notary-01`, the lens-member persona

`notary-01` (role `lens-member`) runs the reference lens member in `../lens/` for its key
(`~/.config/solana/ugt-notary-01.json`; `wallet` stays `null` until that key is generated):

```bash
node agents/lens-member-run.mjs --persona notary-01 --owners /tmp/owners.json   # dry run (default)
node agents/lens-member-run.mjs --persona notary-01 --print                     # show the command only
node agents/lens-member-run.mjs --persona notary-01 --live                      # after schemas are registered
```

The runner registers nothing on chain. Before `--live`: generate the key, register its credential
and the two schemas (`scripts/register-lens-schemas.mjs`), install `sas-lib` and set `X402_*`. Its
PM2 entry `consensus-builder-lens-member` is inactive and unscheduled until then.

### Canonical case v3 (`--outcome attested`)

`node agents/canonical-case-run.mjs --dry-run --outcome attested [--owners rows.json]` prints every
step (`attestedCaseSteps` in `canonical-case.js`): mint with lens `[notary-01]`, publish, donate,
pledge, YES and NO stakes, one ownerless parcel anchor per parcel (existing anchors replay), one
`ParcelOwnership-v1` attestation per recorded owner wallet, requested from the notary service
(`--lens-service`, default the persona's `service.url`) with that owner's own challenge signature and
x402 payment, one `accept_with_attestations` signature per owner (the last one executes), a check that
the proposal is `Executed`, market YES, release, fulfil, claim. Owners come from `--owners` (every
wallet must be a persona wallet, since its keypair signs; each parcel must list exactly `ownerCount`
wallets) or default to the supporter wallet holding both parcels with `ownerCount` 1.

`--live` is refused before anything is read or signed until `LENS_V2_DEPLOYED=1` is set: the v2
programs are deployed on devnet and their binaries verified (`blockchain/solana/README.md`). After
allowed, it always runs the terminal path and checkpoints each step under `summary.canonicalCase`
(`anchors`, `attestations` and `ownerAcceptances` keyed `parcel|owner`, then `executed`,
`resolution`, `release`, `fulfilment`, `claim`); a rerun resumes at the first step not done.

### Lens v2 signing adapters (`lifecycle-actions.js`)

| function | instruction | accounts, in order |
|---|---|---|
| `acceptWithAttestations` / `buildAcceptWithAttestationsIx` | `accept_with_attestations(parcel_id, payout: Option<Pubkey>)` | proposal (w), parcel anchor `["parcel", id]` (parcel_nft), ownership attestation, ownership credential, tally `["consent", proposal, id]` (w), record `["acceptance", proposal, id, owner]` (w), owner (signer), payer (signer, w), system program |
| `settleWithVerdict` / `buildSettleWithVerdictIx` | `settle_with_verdict()` | proposal (w), verdict attestation, verdict credential, verdict record `["verdict", proposal, verdict_attestation]` (w, `init`), submitter (signer, w: pays the record's rent), system program |
| `ensureParcelAnchor` / `buildMintParcelIx` | `mint_parcel(id, metadata_uri)` | parcel anchor (w), payer (signer, w), system program |

The credential is `PDA(["credential", member, credentialName])` under SAS (`deriveCredentialPda`,
default name `LensMember`). Both write paths read first: an existing acceptance record, an existing
verdict record for that attestation, or a proposal already in the verdict's status, is replayed
without sending. Before signing they check what the
program will check (member in the lens, attestation signer/credential/payload, an existing tally's
member and `ownerCount`, the anchor) so a mismatch fails with a message, not a program error.
`readConsentTally`, `readAcceptanceRecord`, `readVerdictRecord` (`getVerdictRecordPda`) and `decodeProposalState` (now with `lens`, `bump`,
`verdictMayExecute`; status 3 = Expired) are the read side. `mint_and_fund` sends the trailing
`verdict_may_execute` (default false) from `minter.js`.

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
`--controller llm` is explicitly selected, every call goes through the shared LLM layer
(`agents/lib/llm-cost/llm.mjs`, via `createAgentLlm()` in `llm-picker.js`), in **batch only** — half
price, ledgered per item as it arrives, so a killed run still accounts for what it spent. Read it
back with `llm-cost --repo consensus-builder --by script`.

`estimateBatchCostUsd()` is an **upper bound**, not a prediction: input tokens are estimated at 4
characters each and every request is billed as if the model wrote its full `max_tokens`. One
persona with 8 candidates estimates at ~$0.04 on the layer default (`claude-opus-5-5`, effort `high`,
2026-10-09); the real item cost is far lower. The model is never set in this repo: it is the layer's
default (`agents/lib/llm-cost/defaults.json`), and the run header logs which one ran. A refused or
truncated item (`max_tokens`) is a failed pick, and its cost still goes into `consensus.agent_cost`.

A batch that has not finished inside `awaitMs` is not an error — `runPickBatch` returns
`{ batchId, done: false, results: [] }` so the caller can checkpoint the id and resume with
`existingBatchId`. A batch already paid for must never be resubmitted.

## Environment

| variable | used by | meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | explicit `--controller llm` only | the optional Batches API key; not needed by the scheduled agent |
| `AGENT_LLM_DAILY_CAP_USD` | `ledger.js` | hard metered-model ceiling; safe default 0.25 |
| `AGENT_DAILY_ACTION_CAP` | `run-policy.js` | maximum signed mint/x402/market-create/stake actions; safe default 4 |
| `AGENT_DAILY_USDC_CAP` | `run-policy.js` | maximum x402 plus stake spend; safe default 0.35 USDC |
| `AGENT_PROPOSAL_FEE_USDC` | `run-policy.js` | conservative x402 fee used in the pre-signing plan; default 0.05 USDC |
| `AGENT_SUPPORT_USDC_CAP` | `support-run.mjs` | maximum amount of its one daily support action; safe default 0.25 USDC |
| `AGENT_SOCIETY_ACTION_CAP` / `AGENT_SOCIETY_USDC_CAP` | `society-run.mjs` | signed actions / USDC per invocation across all turns; defaults 4 / 0.05 |
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
node agents/society-run.mjs --persona preservationist-01 --turns 3 --api https://api.urbangametheory.xyz   # dry run (default)
node agents/society-run.mjs --persona speculator-01 --api https://api.urbangametheory.xyz
node agents/lens-member-run.mjs --persona lifecycle-01 --print
```

## MCP: one surface for any controller

`npm run mcp` starts `agents/mcp-server.mjs` over stdio. Its twenty-six tools expose the same proposal,
activity, x402, pledge, donation, and market adapters used elsewhere in this directory. This lets an
MCP-capable LLM host choose actions while the deterministic runners keep their existing algorithmic
choice policy; both execute through the same modules and appear in the same product views.

Lens tools: `ugt_list_attesters` (read the directory, optional `kind`), `ugt_request_ownership`
(`serviceUrl`, `parcelUid`, optional `confirm`: challenge → ed25519 signature with the agent key →
`POST /lens/ownership`; returns the attestation address and account hash; free members answer
without the live gate, a priced member is paid only under the controls below) and
`ugt_mint_proposal` (`parcelIds`, `lens`, `imageUri`, `isConditional`, `confirm`; a lens naming only
the agent's own key is refused). `ugt_submit_proposal` accepts the minted `lens` in its body.
`ugt_accept_parcel` (`proposalAccount`, `parcelId`, `member`, optional `ownershipAttestation` and
`payout`, `confirm`) signs `accept_with_attestations` as the attested owner; without an attestation it
looks one up on the member's service (`serviceUrl` from the directory, `GET /lens/attestations`).
`ugt_submit_verdict` (`proposalAccount`, `verdictAttestation`, `member`, `confirm`) submits a lens
member's verdict with `settle_with_verdict` and returns `record`, the VerdictRecord PDA it created
(null when the proposal was already in that status through another settlement). The v1 `ugt_accept_proposal` is gone with the instruction.

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
`consensus-builder-supporter` persona at 02:15 UTC, the society personas
`consensus-builder-preservationist` (02:20) and `consensus-builder-speculator` (02:25) — opt-in until
their keys exist, one action per invocation each — and the deterministic
`consensus-builder-land-oracle` materializer at 02:30 UTC. `consensus-builder-lifecycle-member` is
inactive and unscheduled like the notary member. All three are one-shot,
non-restarting scheduled processes; the proposer has the limits above and four candidates offered
to the algorithmic controller.

Each proposer run starts with a retire phase, before it mints anything new. Nobody accepts the
persona's real-parcel proposals, so without it every day would leave another open market with a
locked stake. The phase lists the persona's own minted proposals from its `consensus.agent_run`
rows (age = the row's UTC run `day`), reads each proposal, market and YES position from the chain,
and retires those still Active, without acceptances and at least `AGENT_RETIRE_AFTER_DAYS` old
(default 7): owner `cancel_and_refund` → permissionless `resolve` (NO) → `claim`, which refunds the
YES stake in full because the NO pool is empty (with NO stakers present the stake is lost and no
claim is sent). A proposal already cancelled with steps outstanding is finished regardless of age.
Each step goes through the action engine (`cancel`, `resolve`, `claim` in the activity feed) and is
checkpointed under `summary.retirements[proposalPda]`; a rerun re-reads the chain and skips what is
done. At most `AGENT_RETIRE_MAX_PER_RUN` (default 3) retire per day, and their signatures share
`AGENT_DAILY_ACTION_CAP` with the day's proposal: retirements get only what the proposal plan leaves
over, so with the scheduled cap of 4 and one proposal (4 worst-case actions) they retire only on
no-pick days unless the cap is raised (4 + 3 × 3 = 13 drains three a day). `--dry-run` lists what
would be retired, and why the rest was skipped, without signing.

Expiry by verdict. With `AGENT_LIFECYCLE_LENS_SERVICE_URL` (a lens member service, typically kind
`lifecycle`) and `AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN` (its `LENS_OPERATOR_TOKEN`) set, the member's
key (read from its `GET /lens/status`) is appended to every new mint's lens, and a stale proposal
whose lens includes that key is retired with `expire` instead of `cancel`: the member attests
`ProposalVerdict-v1` "expired" (`POST /lens/verdict`), the persona submits it with
`settle_with_verdict`, the proposal becomes Expired (status 3) and the market resolves NO as after a
cancel. The verdict's `sourceObservedAt` is the run day's UTC midnight plus `AGENT_RETIRE_AFTER_DAYS`
(the instant the policy made it stale), so a retry maps to the same attestation. The activity type is
`verdict`; the checkpoint key is `summary.retirements[pda].expiry`. Proposals minted before (whose
lens lacks the member) keep the cancel path. A URL without the token, or an unreachable member,
fails the retire phase for that run instead of silently cancelling. Without the URL nothing changes.

The scheduled processes are deliberately separate from the API
ecosystem file, so an ordinary backend deploy cannot silently acquire a signing key or start an
autonomous spender.

After the dedicated low-value devnet key exists at the persona's `keypairPath` and the server-local
`.env` has database credentials and `SOLANA_RPC_URL`, activation is explicit:

```bash
cd /root/code/consensus-builder/backend
pm2 start agents/ecosystem.config.cjs --only consensus-builder-agents
pm2 start agents/ecosystem.config.cjs --only consensus-builder-supporter
pm2 start agents/ecosystem.config.cjs --only consensus-builder-land-oracle
# only after ugt-preservationist-01.json / ugt-speculator-01.json exist and their wallets are set:
pm2 start agents/ecosystem.config.cjs --only consensus-builder-preservationist
pm2 start agents/ecosystem.config.cjs --only consensus-builder-speculator
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
