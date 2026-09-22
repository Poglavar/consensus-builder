# Hackathon next steps

_Audit date: 2026-09-22 · branch: `colosseum-worlds-fair` · audited head: `b8b9a99` · disclosed baseline: `3ee1855`_

> Urban Game Theory is a market for real-world land change: humans and AI agents propose, fund,
> and forecast changes to real parcel sets, while public records resolve what actually happened.

## Executive assessment

The project should not pivot again. The difficult primitives now exist and work together on Solana
devnet: paid agent proposals, refundable donations, revocable pledges, two-sided markets, public
evidence recipes, court attestations, deterministic and LLM-controlled agents, shared activity
records, and permissionless resolution.

The main weakness is no longer missing infrastructure. It is **proof fragmentation**. The current
judge story is assembled from several valid but separate examples:

- a paid proposal created and forecast by an agent;
- another agent's pledge;
- a cancelled proposal-lifecycle event;
- a retrospective court-market settlement and payout; and
- an open, genuinely prospective court market waiting for later evidence.

The next work should compose those pieces into one canonical, inspectable story and strengthen the
public evidence that humans, agents, funding, forecasting, and resolution all use the same system.
New oracle sources and more elaborate AI should come only after that.

## What is implemented now

| Capability | Status | Audit evidence |
|---|---|---|
| x402 pay-to-propose | Live | Hosted CDP facilitator, exact-resource Bazaar listing, payer-bound authorship, replay protection, `0.05` devnet USDC price |
| Paid verified facts | Live | Separate Bazaar-listed endpoint, source-hashed event + recipe + Lens evaluation, `0.01` devnet USDC price |
| Agent proposal runtime | Live | Deterministic daily proposer and an earlier LLM-controlled run both minted, paid, published, and forecast on devnet |
| Proposal support | Live | `ProposalPledge` program, human wallet UI, agent adapters, refundable donation lifecycle, revocable soft pledges, live supporter pledge |
| Prediction markets | Live | `ProposalMarket`, human and agent staking, two-sided pools, resolution, claims, empty-winning-pool refunds |
| Proposal-state oracle | Live but narrow | The canonical case now has a public source-hashed terminal event; its source transaction and account hash are independently inspectable |
| Court oracle | Live | 92 total devnet attestations, including 35 source-timestamped V2 attestations from 29 decisions |
| External court market | Live integration proof | Two-sided V1 market settled permissionlessly from SAS evidence and paid the winner; chronology is honestly labelled retrospective |
| Prospective court market | Open, not yet complete | Both sides staked before the `2026-09-22 21:00 UTC` close; hourly resolver is healthy and rejects pre-close evidence |
| Shared actor/activity model | Implemented | Browser simulation, deterministic agents, LLM agents, and wallet actions use one activity envelope and explorer |
| Public activity proof | Partial | The canonical case contributes eleven transaction-backed agent events, including donation, pledge, both forecast sides, resolution, refund, void and claim; a confirmed human-wallet event is still missing |
| MCP action surface | Complete for current programs | Twenty-two tools cover reads, paid proposals/facts, acceptance, pledge, donation, forecast, cancellation, active revoke, refund, void, execution-side release/fulfilment, and proposal- plus external-market resolution and claims |
| Judge surfaces | Live | Deck, Demo Center, actor explorer, proof manifest, public audit command, program IDs, schemas, architecture, trust assumptions, Apache-2.0 license |
| Operations | Mostly live | Proposer, supporter, lifecycle materializer, court pipeline, and prospective resolver are scheduled; central monitoring covers proposer, court pipeline, and resolver only |

## Verification performed during this audit

- `cd backend && npm test`: **4,897 passed, 2 skipped** across 354 test files.
- `cd backend && npm run demo:judge`: **11 passed, 0 warnings, 0 failures**; readiness `READY`.
- `cargo test --workspace --lib`: **15 passed** across the four Solana programs.
- `anchor test --skip-build`: **41 local-validator integration tests passed**.
- Hosted Bazaar discovery: both paid resources are listed with exact schemas and no partial result.
- Bazaar usage is real but still self-referential: proposals show 4 calls / 1 unique payer; verified
  facts show 5 calls / 1 unique payer.
- Public schedules and latest outcomes are healthy: the proposer and supporter completed live runs,
  the court pipeline produced fresh V2 attestations, and the prospective resolver completed its
  latest hourly check in `market_open` state.
- Rust emits Anchor `check-cfg` warnings and unused decoded-field warnings. These do not fail the
  programs but should be cleaned before presenting the repository as production-ready.

## Ordered next steps

### 1. Complete the genuinely prospective court-market proof

Progress on 2026-09-22: the market remains honestly open until its committed 21:00 UTC close. The
resolver and court schedules are installed and fresh. The resolver now writes a redacted V2
settlement artifact containing the evidence address/hash, source and first-seen times, resolution,
claim, and outcome; the public status endpoint, Demo Center, and audit consume it automatically.
The audit permits the experiment to remain pending, but after `settled` it fails unless the full
ordering and payout are present. The qualifying later court record itself remains external and
cannot be manufactured.

This is the strongest remaining claim and is time-dependent. Preserve the current market and let
the existing schedule do its work; do not manufacture a matching record or weaken the recipe.

Work:

1. Confirm the market transitions from `open` to `awaiting_evidence` after its committed close.
2. Keep the court interpreter/attester daily and the resolver hourly.
3. When a qualifying matching V2 attestation arrives, resolve permissionlessly and claim the winning
   pool.
4. Publish the evidence address and hash, source publication time, first attestation transaction,
   market close, resolution transaction, and claim transaction.
5. Make `npm run audit:hackathon` fail if any timestamp is out of order or the payout is absent.
6. Switch the Demo Center automatically from “open”/“awaiting evidence” to “settled from later
   evidence.”

Done when: one public artifact proves `market + both stakes < market close <= sourceObservedAt <=
attestation first seen <= resolution < claim`.

If no matching record arrives before submission, keep the market visibly pending. The honest open
experiment is more credible than a second retrospective proof. In that case, the submission should
say that the protocol and guard are live while the first independent future event is still pending.

### 2. Build one canonical end-to-end demo case

Progress on 2026-09-22: a generic `/hackathon/cases/:id` aggregate now derives one proposal's
canonical parcel-set hash, actor activity, donations/pledges, YES/NO pools, lifecycle state,
source-hashed events, resolution and settlement state. The Demo Center renders that graph and links
straight to the parcel set in read-only proposal Details. Support, forecasts and owner action are
explicit parallel branches; the response never marks a missing stage complete. The new canonical
Borovje case is live across three cadastral parcels: the existing deterministic personas minted and
paid for it, donated 0.05 devnet USDC, pledged 0.10, and staked 0.01 on each of YES and NO. The
proposer then cancelled it; the lifecycle materializer emitted a source-hashed event, a second actor
resolved the market NO, the donation was refunded, the pledge was voided and the winning NO position
was claimed. The aggregate derives all seven stages as complete and eleven transaction-backed
actions are visible in the shared public activity feed. The code and public manifest are ready;
deployment is the only remaining publication step for this milestone.

Create a single “golden case” that a judge can follow without assembling five unrelated accounts.
It should be a real parcel **set**, even if the initial set contains only a few parcels.

Suggested shape:

```text
parcel set
  → paid proposal
  → donation + pledge
  → YES + NO forecasts
  → owner decision / terminal proposal state
  → source-hashed event
  → recipe evaluation
  → permissionless market resolution
  → refund, release, fulfilment, and/or payout
```

Add a read-only aggregate endpoint such as `/hackathon/cases/:id` that derives this graph from the
existing proposal, activity, funding, market, and oracle records. It must not hard-code a success
state. Use it to power one Demo Center case card and one deep link that opens the parcel set and
read-only proposal Details on the map.

Done when: a new reviewer can start from one URL and inspect every stage, actor, transaction, and
pending/completed state without consulting `HACKATHON.md`. **Functionally complete; awaiting the
next requested deployment.**

### 3. Fill the public human-and-agent activity matrix

Progress on 2026-09-22: the public feed now projects confirmed instructions from the existing
Solana transaction mirror into the same neutral activity envelope as agent-run events. The pledge
program is now a watched address, so donations and pledges by previously unknown wallets are
classified as human actions from their chain signer instead of relying on a browser claim. Richer
run provenance wins deduplication when the signer is a configured persona. A real human-wallet
transaction is still needed to complete the public proof matrix after deployment.

The UI supports a neutral actor model, but the currently deployed public feed proves only agent activity.
Exercise and preserve at least this matrix on devnet:

| Actor | Required public actions |
|---|---|
| Human wallet | donate or pledge; forecast YES or NO |
| Deterministic proposer | create, pay, publish, open/enter market |
| Deterministic supporter | pledge **and** one funded donation |
| LLM-controlled agent | propose or choose support through the same deterministic executors |
| Resolver | attest/resolve and claim or refund |

Record all confirmed wallet actions through the same activity envelope. The public audit now reports
an explicit advisory matrix until it finds transaction-backed human support and forecasting, an
algorithmic actor, an LLM actor, and terminal resolver activity. Promote that advisory to required
once a real human-wallet proof exists. Keep actor/controller provenance in Details, not as separate
product silos.

Done when: the Activity explorer visibly demonstrates humans, algorithms, and an LLM controller
using the same actions, with transaction links for every money-moving event.

### 4. Complete the shared lifecycle action surface

Progress on 2026-09-22: the shared signer adapters and MCP now cover the complete lifecycle of the
currently deployed programs. In addition to cancellation, refund, void, proposal-market resolution
and claim, they now expose parcel-owner acceptance, active pledge revocation, permissionless donation
release, pledge fulfilment, external-market SAS resolution and external-market claim. The adapters
read chain state first, reject a wrong owner/position signer before signing, and make terminal retries
idempotent. Confirmed instructions flow into the shared activity envelope through the transaction
mirror added in step 3.

The action surface now traverses both execution and cancellation branches without bespoke scripts:

- inspect owner requirements and accept a proposal as a parcel owner;
- cancel an eligible proposal;
- withdraw a soft pledge;
- refund a donation after cancellation/expiry;
- release a donation or fulfil a pledge after execution;
- resolve an eligible proposal or external market; and
- claim winnings or an empty-winning-pool refund.

Each action should delegate to the existing browser/agent codec, retain `UGT_MCP_LIVE=1` plus
per-call confirmation, enforce role/ownership checks before signing, cap value, and emit the same
activity record. Do not introduce another agent backend.

Done when: a deterministic policy, an MCP-hosted LLM, and a human wallet can all traverse the same
lifecycle using shared adapters. **Implementation complete; a human-wallet proof and deployment are
still required for the full public demonstration.**

### 5. Prove cold-start use by an independent agent and wallet

Progress on 2026-09-22: `backend/examples/independent-x402-client.mjs` imports no UGT module. It
found the verified-fact resource through the public hosted-Bazaar proof, decoded and capped the
advertised challenge, paid 0.01 devnet USDC from the separate supporter wallet, decoded the x402
receipt, and matched the purchased event and source hash against the free public event feed. The
settlement is transaction
`3T7mg2f5FRk6uFND6eyRKrS5VyHviizk4vmPqB1zxVJbmnz4f1nxaMjXxGi4XEh8JMMesPXNbaaCNzgFQxRxTGPn`.
The public manifest and Demo Center now carry that proof. The transaction-backed activity projector
also recognizes generic facilitator-paid x402 transfers. Coinbase's cached listing still showed its
pre-purchase one-payer metric immediately afterward; confirm the catalog refresh before marking the
unique-payer criterion complete.

Both Bazaar resources previously reported one unique payer. Preserve this clean-room proof and, if
needed, repeat it with an outside participant rather than another internal runner.

It should:

1. find the proposal or fact resource through hosted Bazaar discovery;
2. parse the declared input and payment requirements;
3. pay from a second low-value devnet wallet;
4. buy one verified fact or publish one valid parcel-set proposal;
5. verify the returned transaction and object through public endpoints; and
6. appear in the shared Activity explorer.

Prefer an outside hackathon participant or agent framework. If that is unavailable, use a separate
minimal client repository and wallet so the proof is still independent of the internal runner.

Done when: Bazaar reports at least two unique payers and the demo links the independent call. **The
call and demo proof are complete; the hosted quality counter is awaiting refresh.**

### 6. Make parcel sets a first-class product object

Progress on 2026-09-22: the canonical parcel-set builder is now shared by the proposal serializer
and the hackathon aggregate instead of living only in the demo case. Every full and summary proposal
API record receives sorted canonical IDs, jurisdiction, inferred authority, reference time, optional
geometry hash, parcel count and a deterministic set hash. The identity hash deliberately excludes
reference time so competing proposals over the same cadastral set group together; capture time
remains explicit metadata. Existing `cadastreParcelIds` stays intact for backward compatibility.
Counterpropose already copies that full cadastral set. Proposal Details now shows the stable set
identity, exact same-set alternatives, containing/contained/partial overlaps and shared-parcel counts;
selecting an alternative reuses the same read-only Details and whole-set map highlight. The comparison
logic rejects cross-jurisdiction local-ID collisions and is covered without a browser. An explicit
"fork with changed land set" authoring action remains.

The protocol already carries arrays of cadastral parcels, but the product still often speaks and
links as if one parcel were the unit. Introduce a canonical parcel-set identity containing:

- jurisdiction and cadastral authority;
- sorted canonical parcel identifiers;
- capture/reference time;
- optional geometry hash; and
- deterministic set hash.

Proposals, counterproposals, support books, markets, recipes, timelines, and deep links should refer
to this identity. Counterpropose should inherit the set by default while allowing an explicit fork
to a changed set. The map should highlight the whole set and compare overlapping proposals.

Done when: the UI can answer “what is proposed where, by whom, and how do competing proposals over
the same parcel set differ?” without inspecting raw JSON.

### 7. Close operations and release-proof gaps

Progress on 2026-09-22: the land-event materializer now writes an atomic redacted run-stat artifact
on every success or failure, including scanned/terminal/event/insert/reconcile/missing-evidence
counters; a zero-work run is successful only with an explicit successful verdict, while persistent
missing evidence fails it. `/hackathon/operations.json` combines that artifact with proposer and
supporter checkpoints and the prospective resolver status, applies daily/hourly freshness windows,
and exposes no credentials or private court matching data. The public audit consumes this endpoint
as an advisory check until the schedules are redeployed and central monitoring is registered. The
proof manifest now separates the backend release commit, a frontend `/release.json` stamped with its
own commit/build number, and the two mutable devnet deployments. ProposalPledge and ProposalMarket
are pinned to their public ProgramData addresses, last deployment slots and binaries read back from
Solana and SHA-256 hashed on 2026-09-22; this identifies deployed code without claiming a reproducible
source build.

Add central outcome monitoring for the two scheduled jobs not currently registered:

- `consensus-builder-supporter` at 02:15 UTC; and
- `consensus-builder-land-oracle` at 02:30 UTC.

Use completion evidence, not process status: supporter checkpoint/activity transaction for the
former, and a fresh idempotent run-stat artifact plus event counters for the latter. Keep zero-work
runs valid when their explicit verdict is successful.

Also:

- **Implemented, deployment pending:** distinguish API/backend commit, frontend commit/build, and
  deployed program identity in the public proof manifest and frontend release artifact;
- **Implemented, deployment pending:** publish schedule freshness and last successful outcome in one
  redacted operations endpoint;
- **Implemented as advisory, promotion pending:** make the public audit check monitoring freshness
  rather than only the underlying data; and
- **Implemented:** correct stale documentation that described the active proposer monitor as
  inactive while clearly leaving supporter and land-oracle central registration pending.

Done when: every scheduled stage can fail independently and produce a visible, actionable verdict.

### 8. Finish the unified explorer instead of adding another dashboard

Consolidate the map Activity panel, standalone Actor Explorer, proposal timeline, and game-mode
events around one reusable explorer component and one data-source contract:

- `live`, `simulation`, and `combined` sources;
- the same filters for actor, controller, action, result, parcel set, proposal, and run;
- expandable provenance rather than different visual treatment for humans and agents; and
- deep links between actor → action → proposal → parcel set → transaction/evidence.

Simulation should remain clearly inspectable as simulation, but an activity row should not reveal
human/AI status until provenance is opened. Remove obsolete statistics or dialog paths as the shared
component takes over; do not maintain two agent systems.

Done when: switching from game data to live data changes the source adapter, not the interface or
the action vocabulary.

### 9. Add the missing contract-level and security evidence

Before claiming anything beyond devnet:

- add a TypeScript local-validator integration suite for `ProposalPledge`; it currently has Rust
  unit tests and live lifecycle scripts but no equivalent Anchor client suite;
- cover donation release/refund, pledge update/withdraw/fulfil, duplicate receipts, wrong owner,
  wrong mint, and account-substitution attacks;
- eliminate or explicitly suppress the known Anchor `check-cfg` warning noise;
- publish program upgrade authorities and binary/IDL checksums;
- produce reproducible/verifiable program builds if the hackathon tooling supports them; and
- keep “unaudited, devnet only, no real-value assets” prominent.

Done when: a reviewer can connect source, IDL, deployed program, authority, invariant tests, and
live transaction evidence without trusting the project operator.

### 10. Improve the judge path and submission package

Once steps 1–7 are stable:

- make the canonical case the first Demo Center element;
- keep the deck to the current short narrative and move implementation detail behind proof links;
- record a 90–150 second demo showing discovery → action → shared timeline → evidence → payout;
- add a short “what existed before / what was built here” comparison drawn directly from the
  disclosed baseline;
- run the demo once from a fresh browser and a fresh wallet with no operator knowledge;
- freeze the public URLs and run the complete backend, Rust, Anchor, and public audit suites; and
- capture a final proof manifest with exact frontend/backend commits and the current market state.

The public claim should remain precise:

> The full protocol loop is live on Solana devnet. The first independently timed prospective
> public-record market is either settled with ordered proof or visibly awaiting qualifying evidence.

### 11. Add additional evidence sources only after the core proof is complete

Permit, imagery, OSM-provenance, news, and council-minute adapters still make sense, and the Lens
evaluator already supports thresholds, source classes, conflict detection, and challenge windows.
They are not the highest-value hackathon work now.

When resumed, add them through the existing adapter contract in this order:

1. deterministic permit/register source;
2. independent imagery/building-footprint change source;
3. OSM provenance verifier with account age, changeset survival, and revert checks; and
4. text extraction as supporting evidence only, never the sole resolver.

Do not build a second oracle service or let an LLM select the final outcome.

## Recommended cut line

**Must complete for the strongest submission:** steps 1–7.

**Do if time remains:** steps 8–10.

**Post-hackathon expansion:** step 11, mainnet preparation, governance/tokenomics, additional cities,
and unrestricted LLM autonomy.

## Things not to build now

- A second agent runtime for “smart” agents.
- A separate activity UI for simulations.
- A new token or governance system.
- Mainnet deployment before contract review and authority disclosure.
- More LLM decision-making merely for spectacle.
- A weak second oracle source that reduces rather than improves the trust story.

The highest-leverage outcome is not more surface area. It is one coherent parcel-set lifecycle,
used by humans and different agent controllers, paid through discoverable x402 endpoints, settled
from evidence under a precommitted rule, and independently inspectable from a single public page.
