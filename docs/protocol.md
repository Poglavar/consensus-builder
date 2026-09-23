# Protocol identifiers, schemas, and trust model

This document is the compact technical contract for the hackathon build. It describes what is live
on Solana devnet, how evidence recipes are represented, how another evidence source should integrate,
and which parties or systems must be trusted.

## Solana devnet programs

| Program | Address | Role | Schema |
|---|---|---|---|
| ParcelNFT | [`4zad…kV1`](https://explorer.solana.com/address/4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1?cluster=devnet) | Parcel certificates and ownership | [`parcel_nft.json`](../blockchain/solana/idl/parcel_nft.json) |
| ProposalNFT | [`3WsV…xbg`](https://explorer.solana.com/address/3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg?cluster=devnet) | Proposal lifecycle and parcel-owner acceptance | [`proposal_nft.json`](../blockchain/solana/idl/proposal_nft.json) |
| ProposalMarket | [`GDYn…YDRB`](https://explorer.solana.com/address/GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB?cluster=devnet) | Parimutuel YES/NO stake and claims | [`proposal_market.json`](../blockchain/solana/idl/proposal_market.json) |
| ProposalPledge | [`1jES…rp6g`](https://explorer.solana.com/address/1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g?cluster=devnet) | Escrowed donations and revocable soft pledges | [`proposal_pledge.json`](../blockchain/solana/idl/proposal_pledge.json) |

The canonical address book is [`frontend/contracts/addresses.json`](../frontend/contracts/addresses.json),
mirrored in [`blockchain/solana/Anchor.toml`](../blockchain/solana/Anchor.toml), each program's
`declare_id!`, and the generated IDLs. Contract tests fail when these representations diverge.

The public hackathon manifest also pins the exact mutable devnet deployments inspected on
2026-09-23, rather than treating a stable program address as a version:

| Program | ProgramData | Last deployed slot | Deployed binary SHA-256 |
|---|---|---:|---|
| ProposalPledge | `EtV7…SyZQ` | `503098918` | `649c6fda…9d053c` |
| ProposalMarket | `AGmZ…qhx7` | `503099080` | `3039d28d…ba91c0e` |

Both remain upgradeable by `AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ`. These hashes identify
what devnet executed; they do not claim a reproducible source-to-binary build or an audited program.
The 2026-09-23 upgrades (commit `361cf41`) made every market and donation vault `init_if_needed`, so
pre-creating a vault's predictable token account can no longer block a proposal's donations or market.

The devnet USDC mint used by the demo is
[`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet).

## Other machine-readable schemas

| Schema | Purpose |
|---|---|
| [`backend/routes/agent-recipe-schema.json`](../backend/routes/agent-recipe-schema.json) | Body accepted by the x402-paid proposal route |
| [`backend/routes/api-schema.json`](../backend/routes/api-schema.json) | Shared API field descriptions |
| [`backend/oracle/recipe.schema.json`](../backend/oracle/recipe.schema.json) | Resolution recipe envelope |
| `backend/routes/*-ddl.sql` | PostgreSQL persistence contracts for proposals, activity, transactions, and land events |

The live agent schema and current payment terms are served together at
<https://api.urbangametheory.xyz/docs/agents.json>.

## Resolution recipe format

A recipe declares the rule before it is relied on. The hash is SHA-256 over canonical JSON of every
field except `hash`: object keys are sorted recursively, arrays retain order, and JSON scalar
encoding is unchanged. The current implementation is
[`buildProposalLifecycleRecipe`](../backend/oracle/proposal-lifecycle.js).

```json
{
  "id": "proposal-lifecycle-v1",
  "version": 1,
  "question": "Will this proposal execute?",
  "eventType": "proposal_lifecycle",
  "subject": {
    "chain": "solana:devnet",
    "proposalAccount": "<base58>",
    "marketAccount": "<base58-or-null>"
  },
  "trustedAttesters": [
    { "kind": "solana_program", "address": "3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg" }
  ],
  "outcomes": { "executed": "YES", "cancelled": "NO" },
  "verification": {
    "kind": "program_account_state",
    "marketProgram": "GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB",
    "proposalOwnerProgram": "3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg",
    "statusBytes": { "executed": 1, "cancelled": 2 },
    "permissionless": true
  },
  "hash": "sha256:<64 lowercase hex characters>"
}
```

The public declaration is:

```text
GET /oracle/recipes/proposal-lifecycle-v1?proposal=<proposal-account>&market=<market-account>
```

The external court recipe is declared with all market-sensitive values explicit:

```text
GET /oracle/recipes/court-parcel-operation-v1
    ?parcelUid=<HR parcel uid>
    &yesOperation=<exact SAS operation>
    &noOperation=<exact SAS operation>
    &closesAt=<Unix seconds>
```

The response includes the canonical recipe and the deterministic `ExternalMarket` PDA. The program
stores the recipe digest, close time, SAS program/credential/schema trust set, issuer, and SHA-256
commitments to the parcel UID and two operation strings. These duplicate the security-sensitive
recipe fields intentionally: settlement does not depend on the API remaining available.

The prospective V2 declaration additionally requires the newly registered SAS schema account:

```text
GET /oracle/recipes/court-parcel-operation-v2
    ?parcelUid=<HR parcel uid>
    &yesOperation=<exact SAS operation>
    &noOperation=<exact SAS operation>
    &closesAt=<Unix seconds>
    &schema=<CourtParcelOperationV2 SAS account>
```

V2 appends `int64 sourceObservedAt` to the four V1 fields. The market program accepts both shapes
for compatibility with existing markets, but whenever that fifth field is present it requires
`market.closesAt <= sourceObservedAt <= resolution time`. A V2 schema cannot issue a four-field
payload, so a V2 market cannot bypass the temporal check.

Materialized evidence follows the matching event envelope:

```json
{
  "id": "<globally stable source-derived id>",
  "eventType": "proposal_lifecycle",
  "subject": { "type": "proposal", "id": "<proposal account>" },
  "outcome": "executed",
  "observedAt": "<source time, never ingestion time>",
  "recordedAt": "<database insertion time>",
  "attester": { "kind": "solana_program", "address": "<program id>" },
  "source": {
    "url": "<verifiable source>",
    "hash": "sha256:<source bytes>",
    "transaction": "<source transaction when applicable>"
  },
  "evidence": {}
}
```

## Evidence adapter interface

An adapter turns one independently verifiable source into normalized events; it does not decide a
market outcome outside its declared recipe. New court, permit, imagery, or OSM adapters should
implement this contract:

```js
const adapter = {
  id: 'source-name-v1',
  eventType: 'stable_event_type',

  // Return the unhashed recipe body for one subject. The shared layer canonicalizes and hashes it.
  buildRecipe({ subject, marketAccount }) {},

  // Read source facts. A dry run must perform no writes and must not sign transactions.
  async collect({ subject, cursor, dryRun, onProgress }) {},

  // Verify source identity, timestamps, hashes, attester eligibility, and outcome mapping.
  verify(event, recipe) {
    return { valid: true, reason: null };
  }
};
```

Adapters must obey these invariants:

1. `id` and `eventType` are stable and versioned when semantics change.
2. `observedAt` comes from the source; ingestion time is recorded separately.
3. `source.hash` covers the evidence needed to reproduce the claim.
4. Event IDs are deterministic so retries are idempotent.
5. Collection and verification are separate; a fetch cannot make itself authoritative.
6. An LLM may extract candidates or source spans, but cannot be the sole attester or final judge.
7. The recipe names accepted attesters, outcome mapping, agreement rule, and any challenge delay
   before funds are at risk.
8. Raw records that create privacy or redistribution risk stay behind the source boundary; public
   events disclose only the minimum evidence allowed by that source.

The shared [`recipe-evaluator`](../backend/oracle/recipe-evaluator.js) applies the Lens after an
adapter validates each source-specific fact. `verification.evidencePolicy` may declare:

```json
{
  "threshold": 2,
  "requiredAttesterKinds": ["independent_imagery", "osm_provenance"],
  "challengeWindowSeconds": 259200
}
```

The evaluator counts each trusted attester once, rejects wrong subjects and unsupported outcomes,
detects one attester equivocating, treats evidence for competing outcomes as disputed, and resolves
only after the threshold, required source classes, and challenge window all pass. The default for
existing one-source recipes is threshold 1 with no delay. This gives future permit/imagery/OSM
recipes one decision engine instead of bespoke resolution logic per source.

The current `proposal-lifecycle-v1` module predates a generic loader and directly exports equivalent
recipe, collection, and verification helpers. `court-parcel-operation-v1` is the live concrete
external adapter; `court-parcel-operation-v2` adds the source-time contract needed for prospective
markets. Both match the fixed parser in `ExternalMarket`; dynamic adapter loading is not implemented.

## Security and trust assumptions

### On-chain state

- The current market trusts the deployed ProposalNFT program and Solana consensus. Resolution is
  permissionless, but the market accepts only ProposalNFT `Executed` as YES and `Cancelled` as NO.
- The new `ExternalMarket` code trusts Solana consensus, the SAS program, one committed credential,
  schema and issuer, plus the exact parcel/operation mapping in the hashed recipe. Any caller can
  resolve, but cannot select the outcome; the attestation payload selects it.
- External trading closes before resolution. Only a live, unexpired SAS attestation under the
  market's exact schema is accepted. Existing V1 markets accept the four-string court payload. V2
  adds `sourceObservedAt`; the upgraded source enforces that it is not earlier than market close or
  later than resolution. The program records the evidence address and full-account SHA-256.
- An app-level `Expired` label is not terminal on-chain. Until execution or cancellation, market
  stakes can remain locked indefinitely because the program has no deadline.
- Donations move devnet USDC into program escrow immediately; cancellation or expiry lets each
  donor refund their receipts. Soft pledges hold no funds and remain revocable until fulfilled after
  execution.
- The programs have not received an independent audit. Their devnet addresses do not prove
  immutability, safe upgrade authority, or suitability for assets with real value.

### x402 and identity

- The hosted CDP facilitator verifies and settles the x402 payment. Its availability is an API
  dependency; the Solana payment transaction is the durable settlement evidence.
- The backend binds proposal authorship to the paying Solana wallet and rejects a conflicting
  `author`. This proves control of the payer key, not whether the actor is human, algorithmic, or an
  LLM.
- Agent wallets are operator-controlled, low-value devnet keys stored outside Git. Scheduled agents
  are opt-in and apply action and daily USDC caps before signing.

### Evidence and oracle

- The current recipe API and `consensus.land_event` table are operator-hosted. Source transactions,
  source timestamps, raw account bytes, and hashes make records independently checkable, but API
  availability and indexing completeness still depend on the operator.
- The deployed market binary reads ProposalNFT state directly and also supports the separate,
  recipe-bound `ExternalMarket` account. The first Croatian court SAS settlement completed on devnet
  on 2026-09-21; its market and transaction links are recorded in `HACKATHON.md`.
- The Croatian court bridge exposes aggregate health and a public Solana Attestation Service schema.
  The UGT API deliberately does not republish decision identifiers, parties, quotations, or parcel
  identifiers. Those attestations do not currently settle prediction markets.
- OSM alone is not an authoritative land-event source. A future physical-change recipe must require
  provenance and an independent source such as permits or imagery.

### LLMs and data

- LLM output is advisory: candidate selection, explanation, extraction, and reconciliation. Schema
  validation, wallet signatures, program constraints, and declared evidence rules remain
  deterministic.
- Public cadastral, court, permit, map, and imagery sources have different freshness, licensing,
  privacy, and manipulation risks. Each adapter must preserve source provenance and enforce its own
  publication boundary.

## Current versus next

**Live:** ProposalNFT terminal-state recipe, source-hashed events, permissionless lifecycle-market
resolution, court-oracle aggregate health, SAS attestations, and public program/transaction links.

**Live on devnet:** `ExternalMarket`, direct SAS account verification, canonical court recipe
endpoint, checked-in IDL and browser codec. The first market accepted 0.01 USDC on each outcome,
resolved from the committed SAS evidence, and paid 0.02 USDC to the winner. Its public chronology
correctly classifies it as retrospective because the attestation existed before the market.

**Live API:** agents can buy a recipe-bound proposal lifecycle fact over x402. Availability and
integrity are checked before charging; the paid response packages the public source-hashed event,
exact recipe, deterministic Lens evaluation and verification checks. Bazaar discovery declares its
query and output contracts.

**Code-ready:** the reusable Lens evaluator supports unique-attester thresholds, required source
classes, equivocation/conflict detection and challenge windows. The proposal fact endpoint uses it;
permit, imagery and OSM collectors are not yet connected.

**Live V2 evidence path:** the V2 recipe, two-phase runner, attestation parser and market guard commit
the court source-publication time and reject pre-close or future evidence. The V2 SAS schema is
registered, the devnet market program is upgraded, the dedicated court attester is deployed, and
35 source-timed attestations now prove the scraper → strict interpreter → SAS path. Market
`Atps…kaNQ` was then opened and staked on both sides with a 2026-09-22 21:00 UTC close. The earlier
attestations cannot resolve it; only a matching record officially published after that close can.

**Next:** complete the open prospective court market from a later matching record, then
package the existing proposal, funding, market and verified-fact contracts for more autonomous agent
clients and cities. Additional public-record and sensing adapters are deliberately deferred; they
can enter later through the existing adapter contract and Lens evaluator.
