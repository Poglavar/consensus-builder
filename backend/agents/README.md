# `backend/agents/` — the agent runners

Status (2026-10-22, plan-design-agreement M3): the agents publish designs and agreements
(`plan-design-agreement.md`). A proposer publishes a design (a building on a parcel it owns alone in the
lens member's devnet owner registry), proposes a binding owners' agreement over that parcel, mints it on
Solana devnet (the `agreement` program, `blockchain/solana/programs/agreement`), records its account in
the index and stakes on its market; on its next run it approves the agreement as the owner, has the lens
member it operates attest the decision, records it on chain and executes it. A vote (community or
owners, not binding) is a poll in the index: never minted, no market. Supporters and society personas
bet and pledge on agreement markets. Written, not yet run: the agreement program is not deployed (its id
in `frontend/js/solana/agreement-client.js` is a placeholder), and the lens member's approval facts must
read the devnet owner registry (today they read only a `--rights` file).

## Data flow

```
personas.json ──▶ parcel-source.js ──▶ planner.js ──▶ candidate-preflight.js ──▶ algorithmic-picker.js ──▶ record-builder.js
  (who, where)      parcels + rules      candidates     the design binds exactly      picks + text ($0)       design + terms
                                                        its parcel                └─▶ llm-picker.js (explicit optional controller)

record-builder ──▶ agreement-objects ──▶ publication-client ──▶ lens-owner-registry ──▶ agreement-objects ──▶ publication-client ──▶ agreement-minter ──▶ index ──▶ bettor
                   design/v1 + CID       POST /pins, /designs    the parcel's owners       binding owners'         POST /pins, /agreements   create + fund        onchain    YES stake
                                                                 (--seed-owners)           agreement + CID

next run: lens-approval-client ──▶ publication-client ──▶ lens-approval-client ──▶ agreement-minter ──▶ lifecycle-actions
          owner approval receipt     POST /decisions        lens decision (operator)    attest, execute       resolve YES, claim
```

| module | what it is | pure? |
|---|---|---|
| `parcel-source.js` | one SQL statement: parcels in a persona's bbox with area, geometry, the GDI buildings on them and the urban rule over them | no |
| `planner.js` | envelope, one legal build-out, GFA, € gain, persona score | yes (turf injected) |
| `candidate-preflight.js` | the binding the index will give the candidate's design (`proposals/binding.js` checkProposalBinding, as POST /designs runs it): kept only when it is exactly the candidate parcel with complete coverage | orchestration (checker injected) |
| `algorithmic-picker.js` | guardrails plus seeded variation among the near-best candidates | yes |
| `llm-picker.js` | the Anthropic Batches step: request building, parsing, cost estimate, submit/await/collect | pure except `runPickBatch` |
| `record-builder.js` | the recipe of one pick: the local design record (goal `buildings`, single-building typology: the massing stands on its parcel and forms no new piece) and the agreement terms (title, `deadlineDays`, `lamports` from the persona) | yes |
| `agreement-objects.js` | design/v1 and agreement/v1 objects and their CIDs, built on the browser's own `design-record.js`, `agreement-record.js` and `cid.js`; `ownersRule` (binding, unanimous, one lens), `registryRights` (parcel-rights/v1 from the devnet owner registry), `holdersFromRights`, `communityRule` (a poll: the restatement scripts), `parcelOutputs`, `deadlineAfterDays` | yes |
| `lens-owner-registry.js` | the lens member's devnet owner registry (`consensus.lens_devnet_owner`): read a parcel's owners, plan and register a persona as sole owner (never replacing another owner) | no |
| `lens-approval-client.js` | the owner's approval receipt as the browser makes it (lens challenge → rights and authority facts → signed `agreement-decision/v1`, admitted by the relay's own rules) and the lens operator's `POST /lens/agreements/:cid/decision` | no |
| `publication-client.js` | the index client: pin (`POST /pins`), index designs and agreements, `POST /designs/binding`, relay owner decisions (`GET`/`POST /agreements/:cid/decisions`), `POST /agreements/:cid/onchain`, reads; every CID computed locally, every write repeatable | no |
| `agreement-minter.js` | `mintAgreement` (create + fund up to the escrow in one transaction), `fundAgreement`, `recordAgreementDecision` (attest), `executeAgreement`, `expireAgreement`, `readAgreementAccount`; every step reads the chain first | no |
| `bettor.js`, `pledger.js`, `donor.js`, `lifecycle-actions.js` | market stake, soft pledge, donation, and their resolve/claim/refund/release/fulfil/void steps, all on the agreement account as subject; the proposer's settlement (`inspectSettlement`, `executeSettlement`) | no |

Several runs a day: `--slot auto|LABEL` (all three runners) puts the slot into the run id
(`<day>-<slot>-<persona>`), the pick ids and the seed, while `consensus.agent_run.day` stays the date;
`auto` is `h` + the UTC hour.

Server RPC reads retry transient transport, rate-limit and provider failures up to four total
attempts, with 1/2/4-second backoff. The shared transaction sender (`solana-send.js`) checks the
locally derived signature even if the submission response is lost, and rebroadcasts the identical
signed bytes up to three times while the blockhash remains valid. Confirmation polls
`getSignatureStatuses` (Alchemy's devnet RPC has no `signatureSubscribe`). Proposer parcel reads get at
most three attempts within 180 seconds (`parcel-read-retry.js`); signed actions are never retried by
that policy.

Funding: with `AGENT_SOL_FUNDING_ENABLED=1` a configured bot below 0.05 SOL is topped up to 0.2 SOL
from the main bot wallet before it signs; with `AGENT_USDC_FUNDING_ENABLED=1` an actor about to stake
or donate is topped up to 0.5 test USDC (`funding.js`). The escrow lamports an agreement is funded with
come from the proposer's own SOL and return to it when the agreement expires or is cancelled.

## The proposer run (`run.mjs`)

For each proposer persona: plan → choose → for each pick, in order, each stage checkpointed in
`consensus.agent_run.summary` before the next starts:

| stage | what happens | checkpoint |
|---|---|---|
| `planned` | candidates in this run's area window, preflighted against the index's binding rule | `candidates`, `candidatePreflight`, `city`, `area` |
| `chosen` | the controller's picks (`pickId` = `agent-<persona>-<runKey>-<n>`, a stable pick id, not a record) | `picks`, `decisionInput`, `decisionResult` |
| `designed` | the design/v1 object is built and checkpointed with its CID **before** it leaves the machine, then pinned and indexed (`POST /pins`, `POST /designs` with the candidate's `parcelSourceId`); the index's binding must be exactly the candidate parcel with complete coverage, or the pick fails | `designs[candidateId] = { cid, content, terms, city, binding: { parcelIds, coverage }, indexedAt }` |
| `proposed` | the parcel's owners are read from the devnet owner registry (with `--seed-owners` a parcel nobody owns is registered to the persona first; a parcel without owners fails the pick); then the binding owners' agreement/v1 object (`rule = { electorate: 'owners', binding: true, approvalConfig: { schema: 'proposal-approval/v1', rights: <parcel-rights/v1 from the registry, provider lens-devnet-owners>, policy: { type: 'unanimous' } }, lens: [<the operated lens member>] }`; inputs = the design's binding with the registered owners as holders; outputs = that parcel as it stands, role `parcel`, hashed over the parcel geometry its source serves; `deadline` = build time + `agreement.deadlineDays`; `sponsor` = the persona's wallet; `author` = the persona) is built and checkpointed, then pinned and indexed (`POST /agreements`) | `owners[candidateId] = { parcelId, owners, soleOwner, readAt }`, `agreements[candidateId] = { cid, content, title, deadline, lamports, soleOwner, indexedAt }` |
| `minted` | `create(cid, lens, deadline, open_ground = false, required_lamports = lamports, payout = sponsor)` and `fund(lamports)` in one transaction; an existing account is read and only funded up to what it lacks | `mints[candidateId] = { account, signature, createSignature, created, fundedLamports, escrowLamports, status, cluster, mintedAt }` |
| `recorded` | `POST /agreements/:cid/onchain { chain: 'solana', cluster: 'devnet', account, signature }`: the index reads the account itself (201 first record, 200 refresh) | `onchain[candidateId]` |
| `staked` | YES stake of `stakeUsdc` on the agreement's market (created when missing); skipped when `stakeUsdc` is 0 | `stakes[candidateId]` |

`--until STAGE` stops after a stage; a rerun resumes at the first unfinished one and never builds a
second CID for a pick (the stored content is reused). The run also stores `lens`, `bindingFailures`,
`activities` (action-engine events: `design`, `propose`, `mint`, `stake`, `decide`, `lens-decision`,
`attest`, `execute`, `expire`, `resolve`, `claim`, entity `{ type: 'agreement' | 'design', id: <cid> }`), `executionPolicy` and `outcome`
(`completed`, `partial`, `no-picks`, `failed`). The headline `AGENT DAILY RUN — status=completed` is the
monitor's success sentinel; Telegram carries failures only.

`run-policy.js` refuses a live plan before it touches a wallet when it would exceed
`AGENT_DAILY_ACTION_CAP` signed actions (default 4; a pick needs at most 3: create+fund, market
creation, stake) or `AGENT_DAILY_USDC_CAP` (default 0.35). Pinning and indexing sign nothing.

**Lens.** An agreement program account holds one lens key, so every agreement names exactly one: the
lens member this runner operates, a `lens-member` persona whose `service` names an `operatorTokenEnv`
(`--lens NAME|KEY`, else `AGENT_LENS`, else the only such persona: `lifecycle-01`). Its approval facts
verify the owners' receipts, and its operator-only decision is what the program records, so a live run
refuses to start without that token. Its key is checkpointed as `summary.lens`.

**Settlement phase.** Before anything new, each run settles the persona's own agreements of earlier runs
(`ownedAgreementsFromRuns` over its runs, leaving out accounts already settled → `inspectSettlement`
reads the account, market and YES position), so every market stays open for at least one run:

- **decidable** (Active, before its deadline, decision pending, the persona owns all its land alone, its
  lens is the operated member): `decide` (the approval receipt, signed and relayed to
  `POST /agreements/:cid/decisions`; nothing when the relay holds one) → `lens-decision` (the operated
  member's `AgreementDecision-v1`, `POST /lens/agreements/:cid/decision`) → `attest` → `execute` (once
  the escrow holds what it requires; the whole escrow goes to the payout, the sponsor) → `resolve` (YES)
  → `claim` the YES winnings;
- **due** (Active, past its deadline): `expire` (the escrow returns to the sponsor) → `resolve` (NO) →
  `claim` the YES refund (a full refund when nobody staked NO; otherwise the stake is lost);
- **executed / cancelled / expired**: `resolve` → `claim` when still open; **awaiting-owners** (a contest
  answer on land the persona does not own), **lens-not-operated** and **awaiting-funds** wait.

Each step goes through the action engine and is checkpointed under `summary.settlements[account]`; the
index is then refreshed (`POST /agreements/:cid/onchain`), and an account that reached its end is marked
`settled: true` so later runs skip it. At most `AGENT_SETTLE_MAX_PER_RUN` (default 3) agreements a run;
their transactions (attest, execute, expire, resolve, claim: at most 4 each) share
`AGENT_DAILY_ACTION_CAP` with the picks. `--dry-run` lists what would be settled.

**Contest mode.** An area `{ mode: 'contest', floorCap, withinDays }` answers other proposers'
agreements on the same parcels (proposed in the last `withinDays` days, deadline still ahead, still
open) with a lower build-out, so both agreements share input land and form one market contest.
Whether a rival is still open comes from the chain, by two routes: its index row's `onchain.status`
(read with `GET /agreements/:cid`; written when it is minted and refreshed, with `onchain.endedAt`, the
chain time it ended, on every pass of the lifecycle oracle, `oracle/agreement-lifecycle.js`), which
knows an agreement whoever executed, cancelled or expired it; and its author's own settlement
checkpoints (`execution`, `expiry`), which say so before the next oracle pass. An executed agreement
already settled its land; a cancelled or expired one can never execute. The rival does not own that
land: its agreement names the registered owners, waits for them and expires when they do not decide it.

**Owner registry.** `scripts/seed-lens-owners.mjs` registers proposer personas as the sole owners of the
parcels their runs picked (`--day [--slot] [--persona]`, from the runs' checkpoints; or `--parcel ID
--persona NAME`), dry run unless `--apply`; a parcel another wallet holds is reported, never replaced.
`run.mjs --seed-owners` does the same for each pick as it reaches `proposed`.

**Affordabot** (`AFFORDABOT.md`) is a proposer persona with `housingResearch`; its published
agreements fill `summary.outreach` (drafts linking `/agreements/<cid>`), read with
`node agents/affordabot-outreach.mjs --list`; `affordabot-outcome.mjs` is its monitor check.
It starts with the daily priority city, then tries each other configured city once when source
loading fails or planning/binding yields no eligible candidates. Selected runs retain the city
attempts in their summary. An exhausted search with source errors fails rather than reporting
a clean no-picks result.

## Supporters and a society of agents that disagree

`discovery.js` reads the agreements of a persona's cities from the index (`GET /agreements?city=`,
newest first, at most 1000 per read; `["*"]` = one read over every city), derives each one's account
from its sponsor and CID, and reads every account's status from the chain in batches
(`readAgreementStatuses`; an account owned by another program, or holding another CID or sponsor,
fails the read). Only the chain's word counts: minted = the account exists; open = Active on chain and
before its deadline.

`support-run.mjs` (role `supporter`) chooses one open agreement by another actor with
`supporter-picker.js` (a stable daily `$0` hash) and performs one pledge, donation or YES stake on it;
`supporter-state.js` excludes resolved markets and agreements this wallet already supports and
re-checks the target on chain before funding or signing.

`society-run.mjs` runs any persona whose role has a pure policy at `policies/<role>.js` (`decide(input)`
→ one action or none, plus `NEEDS`). Each turn reads the agreements, their markets, the persona's
positions and pledges, and (for density policies) the designs of open agreements by others
(`POST /designs/batch`). The shared collect step (`policies/collect.js`) first claims what a settled
market owes the persona (an unresolved market on a terminal agreement is resolved first: Executed →
YES, Cancelled/Expired → NO). Otherwise the role decides:

| persona | role | rule |
|---|---|---|
| `preservationist-01` | `contrarian` | NO stake on the densest open agreement by another actor (proposed gross floor area of its building designs; a text heuristic ranks after measured ones; parks score 0) |
| `backer-01` | `backer` | YES stake on the most modest open agreement by another actor, the underdog (YES pool < NO pool) first |
| `speculator-01` | `speculator` | revoke an own pledge when the market's implied YES falls below `revokeBelowProbability` or the agreement is older than `maxAgeDays`; else pledge to the favourite ≥ `minPledgeProbability` and ≤ `pledgeWithinDays` old |

Caps bound one invocation: `AGENT_SOCIETY_ACTION_CAP` (default 4) and `AGENT_SOCIETY_USDC_CAP`
(default 0.05). `--turns N` plays N game days; `--slot` runs again on the same UTC day;
`--controller llm` lets a model pick one of the policy's options (`society-llm.js`), never anything
else. History (`policies/history.js`) is keyed by agreement CID.

## Persona config (`personas.json`)

| field | meaning |
|---|---|
| `name` | the persona's id; the author of its designs and agreements |
| `role` | `proposer`, `supporter`, `lens-member`, or a society role with a `policies/<role>.js` module |
| `wallet` | public key; a proposer's wallet is the sponsor of its agreements (their account is PDA(sponsor, CID)) |
| `keypairPath` | where the signing key lives — **outside the repo** |
| `weights` | `{ density, openSpace, valueUplift, heritage }`; the planner's score, put into the LLM prompt in words |
| `areas` | where the proposer looks: `{ city, bbox }` (Croatian cadastre and GUP rules in the database), `{ city, label, sourceId, bbox }` (a live parcel source), or `{ mode: 'contest', floorCap, withinDays }` |
| `dailyProposals` | how many picks a controller may make in one run |
| `agreement` | proposers: `{ deadlineDays, lamports }`: each binding agreement's deadline (days after it is built; unexecuted by then it expires) and the escrow it is funded with at mint and execution requires, paid back to the sponsor at execution (`"0"` for none) |
| `stakeUsdc` | proposers: the YES stake on each own agreement's market (`"0"` skips the stage) |
| `support` | supporters: cities, allowed action types and per-action USDC amount |
| `service` | lens members: `port`, `url`, `kind`, `priceUsdc`, `credentialName`, `identity`, optional `operatorTokenEnv` |
| `policy` | society roles: `cities` plus the policy module's parameters |

`heritage` is declared and weighted but contributes **0**: no heritage dataset is wired in.

### Lens-member personas

`notary-01` and `lifecycle-01` run the reference lens member in `../lens/` through
`lens-member-run.mjs` (`--print` shows the command, `--live` after the key exists and the credential and
schemas are registered with `scripts/register-lens-schemas.mjs`). The member attests ownership and,
with its operator token, agreement decisions (`AgreementDecision-v1`, `../lens/README.md`). The proposer
runner operates `lifecycle-01`: it asks for its approval facts as an owner and for its decision as its
operator, with the token the persona's `operatorTokenEnv` names.

## Optional LLM cost

The default algorithmic controller makes no model calls and costs `$0`. With `--controller llm` every
call goes through the shared LLM layer (`agents/lib/llm-cost/llm.mjs`, via `createAgentLlm()` in
`llm-picker.js`), in batch only, ledgered per item; `estimateBatchCostUsd()` is an upper bound, and
calls are refused when the day's `agent_cost` plus the estimate would exceed
`AGENT_LLM_DAILY_CAP_USD`. A batch still processing is checkpointed (`batchId`) and resumed, never
resubmitted. The model is the layer's default; the run header logs which one ran.

## Environment

| variable | used by | meaning |
|---|---|---|
| `DATABASE_URL` | all runners (`db/connection.cjs`) | the shared `geodata` database (ledger, candidate parcels, binding preflight) |
| `AGENT_API_BASE` | all runners (`--api` overrides) | the index the designs and agreements are published to and read from |
| `AGENT_APP_ORIGIN` | `run.mjs` | the Origin the index writes send (default `https://urbangametheory.xyz`); the API's write guard admits the app's origins |
| `AGENT_LENS` | `run.mjs` | the lens member to operate (a lens-member persona's name or key) when `--lens` is not given |
| `AGENT_LENS_SERVICE_URL` | `run.mjs` | overrides that persona's `service.url` |
| `AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN` (the persona's `operatorTokenEnv`) | `run.mjs`, the lens member | the operator token of agreement decisions; a live proposer run refuses to start without it |
| `AGENT_DAILY_ACTION_CAP` / `AGENT_DAILY_USDC_CAP` | `run-policy.js` | signed actions (default 4) and stake USDC (default 0.35) per proposer run |
| `AGENT_SETTLE_MAX_PER_RUN` | `run-policy.js` | own agreements settled per run (default 3) |
| `AGENT_SUPPORT_USDC_CAP` | `support-run.mjs` | the supporter's one action (default 0.25 USDC) |
| `AGENT_SOCIETY_ACTION_CAP` / `AGENT_SOCIETY_USDC_CAP` | `society-run.mjs` | per invocation, defaults 4 / 0.05 |
| `AGENT_SOL_FUNDING_ENABLED` / `AGENT_USDC_FUNDING_ENABLED` | `funding.js` | bot wallet top-ups |
| `SOLANA_RPC_URL`, `SOLANA_RPC_MAX_ACCOUNTS` | all runners | devnet RPC and its batch size |
| `ANTHROPIC_API_KEY`, `AGENT_LLM_DAILY_CAP_USD` | explicit `--controller llm` only | the optional Batches API |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | all runners | failure alerts |

## Running

```bash
cd backend
node agents/run.mjs --dry-run                                   # plan + pick, settlement preview; writes, pins and signs nothing
node scripts/seed-lens-owners.mjs --day 2026-10-22              # who the day's picks would register as owners (dry run)
node scripts/seed-lens-owners.mjs --day 2026-10-22 --apply
node agents/run.mjs --live --persona densifier-01 --seed-owners --api http://localhost:3999
node agents/run.mjs --live --persona densifier-01 --api http://localhost:3999
node agents/run.mjs --live --persona densifier-01 --until proposed --api http://localhost:3999   # publish, do not mint
node agents/run.mjs --live --controller llm                     # optional explicit Anthropic mode
node agents/support-run.mjs --dry-run --api https://api.urbangametheory.xyz
node agents/support-run.mjs --live --persona supporter-01 --api https://api.urbangametheory.xyz
node agents/society-run.mjs --persona preservationist-01 --turns 3 --api https://api.urbangametheory.xyz   # dry run (default)
node agents/society-run.mjs --persona backer-01 --slot auto --api https://api.urbangametheory.xyz
node agents/lens-member-run.mjs --persona notary-01 --print
```

## MCP: one surface for any controller

`npm run mcp` starts the local stdio server (49 tools). `npm run mcp:http` starts the hosted
Streamable HTTP service on loopback port 3097 (30 tools), with `/healthz` and the experimental
`/mcp/server-card` discovery document. Both use `ugt-agent-tools.js`; the hosted catalogue contains
no signing or paying tool. Its launcher forwards only public configuration and the HTTP entry
refuses credential-bearing environments. It never loads the backend `.env`.

Read and draft tools need no key. `ugt_publish_design` and `ugt_propose_agreement` are **public,
permanent, unsigned** writes: `confirm: true` is required, with no `UGT_MCP_LIVE` or key requirement.
Publishing recomputes the CID and reads the index back, checking both CID and content. Public prose
and canonical artifacts appear under `untrusted`; canonical objects are kept intact for reuse.
Failures return `{ code, message, next }`.

Publish ordinary designs individually, then reference their CIDs in `agreement.designs`. The
separate `ugt_propose_agreement.designs` argument is only for unpublished linked content, including
parcel layouts that must be indexed with their agreement. Do not resend already indexed designs.
The MCP transport and its nginx proxy accept the API's 15 MiB JSON request budget; each canonical
published object still has its own 10 MiB limit. A larger transport request returns HTTP 413 with
recovery guidance rather than changing the design/agreement contract.

`ugt_submit_feedback` sends a bug report or suggestion to the private maintainer inbox with
`confirm: true`. It needs no wallet or payment and returns a receipt ID; reuse `reportId` on retry.
The web form is `/feedback.html`, also linked from Settings → Information → Contact. The shared
API is `POST /feedback` with `{kind: "bug"|"feedback", message, pageUrl?, reportId?, source?}`;
headless API clients send the app Origin as for other writes. It stores bounded text, drops draft
fragments from links, rate limits submissions and exposes no public report listing. A receipt
means received, not triaged or fixed. Maintainers read it privately from the backend directory:

```sh
node --env-file=.env scripts/feedback-inbox.mjs --list --limit 20
node --env-file=.env scripts/feedback-inbox.mjs --id <receipt-UUID>
```

Deployment applies `routes/feedback-ddl.sql` as `geo_user` before reloading the API. Serving the
new form/tool requires frontend, API and MCP releases, plus the increased nginx request limit.

`ugt_find_place`, `ugt_parcel_context`, design/agreement reads, markets and `ugt_explain` discover
the place and its contract. The intent tools draft roads, buildings, spaces, parcel layouts and
urban rules with the app's pure modules; `ugt_modify_design` makes a fork with `origin.cid` and typed
changes. Local stdio returns canonical `draftArtifact` data. Hosted HTTP stores each draft object
separately and returns a short `draftRef` plus an app `previewUrl` containing that reference only.
URLs never carry geometry, compressed content or serialized records; the former fragment format is
intentionally no longer read. `GET /mcp/previews/<token>` returns one JSON object, with no redirect.
Collection manifests hold design CIDs and private references, and the browser fetches and checks
each member separately before applying anything. The individual object budget is 10 MiB; the
combined geometry of a collection is not measured against a URL or per-object limit.

The temporary bearer cache retains up to 4096 entries/128 MiB for at most 24 hours. Expiration,
eviction or restart requires a fresh preview; these are service capacity limits, not publication
authorization. If cache capacity prevents a preview, canonical `draftArtifact` data is retained.
No preview failure requests or performs publication. The app imports fetched content as local
drafts without pinning or indexing. Pass `draftRef` to modify, compare or draft an agreement;
a bare CID resolves only indexed designs. Local stdio clients can pass canonical content directly.
Agreement drafts run the app's formation handlers in an isolated fabric over
complete cadastral source ground. Single-building ground follows the app’s footprint-parcel rule; stations remain content on their
corridor and form no new parcel. Unsurveyed/open-ground agreements still require the app. Exact
node/browser ground parity passes for the actual Borovje alternatives and Pionir archived sources.

`ugt_inspect_design` reads exact authored fields by JSON Pointer. `ugt_edit_design` atomically
patches any authored field, with metric transforms and polygon operations; it checks the expected
CID, required drawing and coupled geometry. `ugt_inspect_plan` selects designs, buildings and
derived pieces in an agreement composition. `ugt_edit_plan` adds, removes, replaces or edits
designs and terms, rederiving ground for a private revision. See [the editing guide](../../docs/mcp-editing.md),
also exposed as `ugt://editing`, and the `edit-my-plan` prompt. This is the granular authoring
surface for composing requests beyond the optional typed conveniences.

Approval links select Mint, Fund, accept, Execute, Cancel, Expire or a bet; loading one never signs.
The current app has no pledge/donation wallet form, so those approval requests explicitly refuse;
local `ugt_pledge` and `ugt_donate` remain available. `ugt_compare` reports authored floor area, unioned green/road area, bound parcel inputs, full
building removals and partial cuts using the app’s demolition thresholds, and the shared per-party
land/cash ledger for agreements. Unsupported, truncated or missing building stock remains unknown
with a recovery. Design-only alternatives have no agreement ledger. CID resolution preserves the
indexed parcel source in comparisons, forks and agreement drafts.

Local signed/paid tools still require an operator-controlled devnet `UGT_AGENT_KEYPAIR`,
`UGT_MCP_LIVE=1` and `confirm: true`. `UGT_MCP_MAX_USDC_PER_ACTION` (default 0.25) caps every USDC
action and x402 price. `ugt_chain_agreements`, `ugt_chain_agreement`, `ugt_bet_on_account` and the
account-based settlement tools use RPC directly, so that flow needs no UGT API.

To stage a local package (provisional name, no publication):

```sh
cd backend
node scripts/mcp-package.mjs --output /tmp/ugt-mcp-package
npm pack /tmp/ugt-mcp-package --pack-destination /tmp
npx --package /tmp/urban-game-theory-mcp-0.3.0.tgz ugt-mcp
```

The staging directory must be new. The package pins the dependency versions installed in the
backend and carries the browser modules its node host loads; no credentials or repository state
are included. Choose the public npm name separately before publication.

`node scripts/mcp-check-contracts.mjs --origin <origin> --fixtures <tools.json>` checks every hosted
tool, resource and prompt. Fixture JSON maps tool names to arguments. Writes are probed with
`confirm:false`; missing fixtures fail the check. No tool publishes, signs or pays. The live origin
cannot pass before the service and nginx configuration are deployed.

`node scripts/mcp-eval.mjs --help` describes the opt-in Anthropic batch evaluator. It defaults to one
task, takes explicit model/batch prices/budget, checkpoints each batch and cost outside the checkout,
and scores tool artifacts. `--seed <json>` generates 20 tasks (21 with an agreement account) from
`{city, parcelSourceId, parcelIds, streetPoints, agreementAccount?}`; `--tasks <json>` accepts custom
cases. A paid run and public registry/npm publication require the user's separate authorization.

Production configuration is in `backend/ecosystem.config.cjs` (`ugt-mcp`, public-only launcher)
and the exact `/mcp`, `/mcp/`, `/mcp/server-card` nginx locations. Starting it is a separate deploy;
the API deploy still selects only the API process.

## Schedule (opt-in)

`agents/ecosystem.config.cjs` defines the scheduled proposers (`consensus-builder-agents`,
`-builder`, `-gentle`, `-affordabot`), the supporter, the society personas and the lens members; all
one-shot, non-restarting processes started explicitly with
`pm2 start agents/ecosystem.config.cjs --only <name>`, never by an API deploy. The proposer outcome is
covered by the `UGT Agent Runner` check in `alerts-server-telegram/bot-list.json` (its
`consensus.agent_run` rows).

## Actor and run explorer

`frontend/actor-explorer.html` is a read-only explorer of the shared activity envelope: it loads
`GET /agent/activity` (`routes/agent-activity.js`) and opens `GET /agent/runs/:runId` when a run is
selected, with the recorded rationales and exact `consensus.agent_cost` rows.

A complete public-source acceptance check can run against an ephemeral local hosted transport:

```sh
node scripts/mcp-local-acceptance.mjs --api https://api.urbangametheory.xyz \
  --origin https://urbangametheory.xyz --agreement <existing-minted-cid> --output /tmp/mcp-acceptance.json
```

It records every tool, resource and prompt; publication uses `confirm: false`. It never invokes a
model or wallet. The same current parcel fixture supplies a reproducible model-evaluation seed.

Ground drafting uses the exact browser Turf bundle. Agreement ground areas use a deterministic
spherical calculation at 1 mm² resolution; the radius stays Turf 6.5’s 6378137 m. Layout provenance
uses the existing 0.25 m² ancestry floor, retaining legitimate small parcel contributions. These
corrections can change experimental agreement CIDs; recreate affected records rather than retaining
a second geometry or area contract.
