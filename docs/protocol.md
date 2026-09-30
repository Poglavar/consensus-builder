# Protocol identifiers, schemas, and trust model

This document is the compact technical contract for the hackathon build. It describes what is live
on Solana devnet, how evidence recipes are represented, how another evidence source should integrate,
and which parties or systems must be trusted.

## Solana devnet programs

| Program | Address | Role | Schema |
|---|---|---|---|
| ParcelNFT | [`4zad…kV1`](https://explorer.solana.com/address/4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1?cluster=devnet) | Parcel anchors: v1 (deployed) mints a first-come certificate with an `owner`; v2 (built) mints it ownerless | [`parcel_nft.json`](../blockchain/solana/idl/parcel_nft.json) |
| ProposalNFT | [`3WsV…xbg`](https://explorer.solana.com/address/3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg?cluster=devnet) | Proposal lifecycle; v1 (deployed) accepts by certificate holder, v2 (built) by attested owner signature | [`proposal_nft.json`](../blockchain/solana/idl/proposal_nft.json) |
| ProposalMarket | [`GDYn…YDRB`](https://explorer.solana.com/address/GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB?cluster=devnet) | Parimutuel YES/NO stake and claims; v2 (built) also resolves Expired → NO | [`proposal_market.json`](../blockchain/solana/idl/proposal_market.json) |
| ProposalPledge | [`1jES…rp6g`](https://explorer.solana.com/address/1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g?cluster=devnet) | Escrowed donations and revocable soft pledges | [`proposal_pledge.json`](../blockchain/solana/idl/proposal_pledge.json) |

The canonical address book is [`frontend/contracts/addresses.json`](../frontend/contracts/addresses.json),
mirrored in [`blockchain/solana/Anchor.toml`](../blockchain/solana/Anchor.toml), each program's
`declare_id!`, and the generated IDLs. Contract tests fail when these representations diverge.

The public hackathon manifest also pins the exact mutable devnet deployments inspected on
2026-09-23 (the two hackathon programs) and 2026-09-30 (the two older ones, with the first two re-read
unchanged), rather than treating a stable program address as a version:

| Program | ProgramData | Last deployed slot | Deployed binary SHA-256 |
|---|---|---:|---|
| ProposalPledge | `EtV7…SyZQ` | `503098918` | `649c6fda…9d053c` |
| ProposalMarket | `AGmZ…qhx7` | `503099080` | `3039d28d…ba91c0e` |
| ProposalNFT | `GS6T…9RMP` | `501070500` | `977590f5…e9e1b3` |
| ParcelNFT | `6Fgh…JbTn` | `450670421` | `34a0d0bb…824959` |

All four remain upgradeable by `AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ`. These hashes identify
what devnet executed; they do not claim a reproducible source-to-binary build or an audited program.
The 2026-09-23 upgrades (commit `361cf41`) made every market and donation vault `init_if_needed`, so
pre-creating a vault's predictable token account can no longer block a proposal's donations or market.
Live proof (`blockchain/solana/scripts/vault-precreate-proof.mjs --live`): a second wallet
[pre-created both vaults](https://explorer.solana.com/tx/4fHgCF6HrUseRUAcY4DKF6J3FAZprzzAA2oXkNZg3JmFcvQcsJHS8X9yjP3dZc1NzesaXYHiLuZCKZ5hwKNgaSUv?cluster=devnet)
of a fresh proposal, then its owner still opened the
[donation escrow](https://explorer.solana.com/tx/3zVdTx1PBAobY9YhpMLuQwAVNuyr37EcjJGDFFp6opx9xo1iBUVr4q95rMMwqCisvKhpLSDQTeamKYjfBmbdxKBX?cluster=devnet)
and the [market](https://explorer.solana.com/tx/398Z39Qmps26Z9iV4rn3K9RGHaD2ysZadLu5KeAgywAuga6ScpEPGNVT8DCcnDYrFemXy2ANb9tPqWSZfnAvm89j?cluster=devnet).
ProposalPledge, ProposalMarket and ParcelNFT also publish their current Anchor IDL on-chain
(`4PJB…Zb7X`, `66R6…MJZ`, `EjG4…RRSL`); `anchor idl fetch <program> --provider.cluster devnet`
returns JSON equal to `blockchain/solana/idl/*.json`, whose SHA-256s the manifest pins as `idlSha256`.
ProposalNFT's on-chain IDL (`EXYu…w3zq`) is stale: it predates `cancel_and_refund` and
`distribute_funds`, which the deployed binary implements, so the manifest pins no `idlSha256` for it
and `blockchain/solana/idl/proposal_nft.json` is the one to use.

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

## Lens model and the trust boundary

Design of record: [`lens-model.md`](../lens-model.md). Program detail:
[`blockchain/solana/README.md`](../blockchain/solana/README.md#lens-model-v2--built-and-tested-on-localnet-not-deployed-to-devnet-yet).

### Deployed versus built

| Part | State on 2026-10-01 |
|---|---|
| ParcelNFT, ProposalNFT, ProposalMarket **v1** | **Deployed on devnet** (table above). v1 is what every devnet transaction so far ran. |
| ParcelNFT, ProposalNFT, ProposalMarket **v2** (lens model) | **Built, not deployed.** Tested on localnet (136 tests, SAS mocked at its real program id). The checked-in IDLs already describe v2, so v2 clients fail against devnet until each program is upgraded. |
| Program ids | **Unchanged.** v2 ships as an in-place upgrade of the same four addresses; no new program is created. |
| `ParcelOwnership-v1`, `ProposalVerdict-v1` SAS schemas | Defined (parsers, `GET /lenses/schemas`); registration on devnet is migration step 1. |
| Attester directory, reference lens member, picker, member console, MCP tools | Built in this branch; they become meaningful once v2 is deployed. |

### Vocabulary

- **Lens.** A list of public keys stored on one proposal at mint (the `lens` field of the Proposal
  account). It is passive: it only says whose attestations this proposal accepts. It is chosen by
  the proposer, immutable after mint (fork to change it), and never read from anywhere else.
- **Lens member.** One key in that list, i.e. an attester: a notary, a court, a cadastre office, a
  permit register. Members state facts as Solana Attestation Service (SAS) attestations. They do not
  accept proposals, and being listed costs a member nothing: an attestation it never issues is simply
  absent.
- **Owner.** A wallet that a lens member has attested as an owner of a parcel. Owners say yes by
  signing `accept_with_attestations` themselves; there is no acceptance attestation.
- **Parcel anchor.** The on-chain identity of a cadastral parcel (PDA `["parcel", parcel_id]`). It
  carries **no ownership**: v2 mints it with `owner = Pubkey::default()`, and no v2 instruction reads
  the `owner` field of any anchor, old or new. Real ownership stays in the land registry and reaches
  the chain only as a lens member's attestation.

### The rule

A v2 proposal executes when, for every parcel, each owner a lens member attested has signed its
acceptance. Per parcel the program checks, in order: proposal Active and accepting; parcel listed
and not yet accepted; anchor exists; the ownership attestation is owned by SAS, is an attestation
(discriminator 2), was issued under the passed credential whose authority is its signer, uses the
`ParcelOwnership` v1 schema of that credential, and **carries a strictly future expiry**
(`expiry > now`; an attestation without a future expiry is refused, so members must issue with
one); the signer is in the proposal's lens; the payload names this parcel and this signer,
`ownerCount ≥ 1` and `sourceObservedAt ≤ now`. One acceptance is recorded per attested owner: a
parcel is accepted when its tally reaches the member's `ownerCount` (no majority shortcut), and a
second member cannot start a competing tally for the same parcel. Each acceptance record keeps the
SHA-256 of the whole attestation account, so the evidence survives the SAS account expiring or
being closed.

A lens member may also submit `ProposalVerdict-v1`: `expired` makes the proposal Expired on-chain
(markets then resolve NO), and `executed` settles only proposals minted with
`verdict_may_execute = true` (permit-style evidence); a verdict can never skip per-parcel consent
otherwise.

### Schema layouts

Borsh payloads (strings are u32 LE length + UTF-8, `uint8` one byte, `int64` LE), consumed exactly:

```
ParcelOwnership-v1:  string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt
ProposalVerdict-v1:  string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt
```

`owner` and `proposalAccount` are base58 public keys; `verdict` is `executed` or `expired`;
`evidenceRef` is opaque (a hash or the member's own case id, never a name or personal identifier).

### Tally and acceptance PDAs (proposal_nft v2)

| Account | Seeds | Fields |
|---|---|---|
| `ConsentTally` | `["consent", proposal, parcel_id]` | `proposal, parcel_id, member, required u8, accepted u8, bump` (111 bytes) |
| `AcceptanceRecord` | `["acceptance", proposal, parcel_id, owner]` | `proposal, parcel_id, owner, member, ownership_attestation, ownership_hash [u8;32], payout, accepted_at i64, bump` (245 bytes) |

`distribute_funds` pays each record's `payout` (the proposal owner when none was given).

### What changed from v1, and what did not

- **Removed in v2:** v1 certificate-holder acceptance (`accept_proposal`, `withdraw_acceptance` and
  the certificate-owner check). In v1 anyone could mint the certificates first and accept their own
  proposal; v2 has no path from holding an anchor to accepting anything.
- **Legacy proposals whose lens is their creator remain self-decidable on devnet.** The lens was
  required at mint in v1 but never read, and defaulted to the proposer's own key. After the upgrade
  those proposals keep their layout and status, and their creator can still execute them by
  attesting its own ownership under a credential it controls. This is disclosed rather than patched:
  the lens is immutable by design. The public audit's `no_self_lens` check watches that no new agent
  proposal is minted that way.
- **Unchanged:** program ids, the Proposal account prefix every other reader decodes, the market's
  Executed → YES and Cancelled → NO mapping (v2 adds Expired → NO), and the court oracle's own V2
  schema; the court is simply a lens member whose verdicts keep resolving external markets.
- **Informational only:** the attester directory (`GET /lenses/members`) lists known members and
  their coverage. No program reads it; the lens on the proposal is the only authority list.

## Security and trust assumptions

### On-chain state

- The current market trusts the deployed ProposalNFT program and Solana consensus. Resolution is
  permissionless, but the market accepts only ProposalNFT `Executed` as YES and `Cancelled` as NO.
- **Deployed v1:** `Executed` means the signer holding each parcel's on-chain certificate accepted.
  Certificates are first-come mints with no authority behind them, so on devnet today a proposer can
  decide its own ProposalNFT-status market. Treat v1 execution as a demonstration of the lifecycle,
  not as evidence of land-owner consent.
- **Built v2 (not deployed):** `Executed` means every attested owner signed, each under an
  ownership attestation from a member of the proposal's own lens. The trust therefore moves to the
  lens the proposer chose: a reader must judge the listed members, not the program. A lens made of
  the proposer's own key proves nothing, which is why the directory, the picker and the audit
  surface who is in each lens.
- The new `ExternalMarket` code trusts Solana consensus, the SAS program, one committed credential,
  schema and issuer, plus the exact parcel/operation mapping in the hashed recipe. Any caller can
  resolve, but cannot select the outcome; the attestation payload selects it.
- External trading closes before resolution. Only a live, unexpired SAS attestation under the
  market's exact schema is accepted. Existing V1 markets accept the four-string court payload. V2
  adds `sourceObservedAt`; the upgraded source enforces that it is not earlier than market close or
  later than resolution. The program records the evidence address and full-account SHA-256.
- On deployed v1 an app-level `Expired` label is not terminal on-chain. Until execution or
  cancellation, market stakes can remain locked indefinitely because the program has no deadline.
  Built v2 makes Expired an on-chain state reachable by a lens member's `expired` verdict, and the
  market resolves it NO.
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

**Built, not deployed:** lens model v2 of ParcelNFT, ProposalNFT and ProposalMarket (136 localnet
tests), the two lens SAS schemas, the attester directory, the reference lens member service, the
lens picker and member console, and the MCP lens tools. Deployment is one program at a time under
the same ids, after which the attested canonical case runs and the audit's lens checks
(`attested_execution`, `no_self_lens`, `attester_diversity`) move from advisory to required.

**Next:** complete the open prospective court market from a later matching record, then
package the existing proposal, funding, market and verified-fact contracts for more autonomous agent
clients and cities. Additional public-record and sensing adapters are deliberately deferred; they
can enter later through the existing adapter contract and Lens evaluator.
