# Lens model: soulbound parcels, a list of trusted attesters, attested execution

Design of record for making the proposal lens real on Solana. Written 2026-10-01 against branch
`colosseum-worlds-fair` at `24d4eaf`; every "today" statement cites the code at that commit. It
replaces the parcel-ownership model with three separated concepts and splits the work into
workstreams with interface contracts so teams can build in parallel.

## Vocabulary

- **Lens.** A list of public keys attached to one proposal at mint. It is passive: it only says whose
  attestations this proposal's contract will accept. One key or many. Three proposers can use three
  different lenses; one proposer can use a different lens per proposal. It is the `lens` field the
  proposal account already carries (`proposal_nft/src/lib.rs:383`).
- **Lens member.** One key in that list: a notary, a court, a cadastre office, a permit register, an
  imagery service. Members state facts about parcels and proposals as attestations. They do not
  accept proposals.
- **Owner.** A wallet that a lens member has attested as the owner of a parcel. Owners say yes.
- **Attestation.** A Solana Attestation Service (SAS) record signed by a lens member: ownership or
  verdict. Anyone may submit one to the contract; the contract verifies bytes and signers. An owner's
  yes is not an attestation but the owner's own signature on the accept transaction, because SAS
  schemas live under a credential and every owner would otherwise have to register one first.
- **Parcel anchor.** The on-chain identity of a cadastral parcel: a PDA seeded by its id, owned by
  nobody, never transferred. Real ownership stays in the land registry and reaches the chain only as
  a lens member's attestation.

## Why

Today a proposal executes when the signer holding each parcel's on-chain certificate calls
`accept_proposal` (`proposal_nft/src/lib.rs:97-133`). Certificates are first-come mints with no
authority behind them (`parcel_nft/src/lib.rs:13-28`), so a proposer can mint the certificates and
accept its own proposal, and every ProposalNFT-status market is proposer-decidable. The lens is
required at mint and never read by any instruction, defaults to the proposer's own key
(`frontend/js/proposals/create.js:1593-1605`, `backend/agents/minter.js:198`), and is dropped by the
frontend parser (`frontend/js/solana/chain-data-loader.js:285`). The one real authority gate in the
system is the external market's `trusted_attester`, hardcoded to the project key everywhere it is
used (`backend/oracle/court-parcel-operation.js:17`).

## Principles

1. **Parcels are identities.** Anchors exist so proposals, attestations and events have a stable
   subject. Nothing on chain owns a parcel.
2. **The lens is the proposer's choice of authority.** Chosen at mint, immutable afterwards (fork to
   change it). The contract trusts nobody outside the list.
3. **Member facts enter only as attestations; owners act by signing.** Programs verify bytes and
   signers, never trust a wallet on its own say-so.
4. **No person on chain.** Attestations carry wallets, hashes and opaque references. Identity proof
   happens inside the lens member's own process.
5. **Members need not consent to nomination.** Being listed costs a member nothing; an attestation
   it never issues is simply absent.

The version where a proposer only sees parcels vouched for by authorities it trusts is this design
plus a coverage filter in the picker. The only thing left out is parcels changing hands, which would
need the full tokenizer with reversals and cancellations; it can be layered on later.

## The flow

1. Proposer picks parcels and a lens, mints. The lens is stored; nothing else about it is on chain.
2. A lens member attests `ParcelOwnership-v1`: parcel P, owner wallet W, as of time T.
3. W signs `accept_with_attestations(P)` on Q, passing the member's ownership attestation and an
   optional payout key. The contract checks the member is in Q's lens, the ownership names P and W,
   and W signed. It records the acceptance.
5. When every parcel in Q has a recorded acceptance, the status is Executed. Markets resolve YES from
   that state exactly as they do today.
6. A lens member may also attest a verdict (`expired`, or `executed` for evidence kinds where
   per-parcel consent does not apply, such as a permit register). Anyone submits it; the status
   follows.

## On-chain changes

### parcel_nft v2 (WS-A)

- `mint_parcel(parcel_id, metadata_uri)`: `owner` set to `Pubkey::default()`; the payer is a separate
  signer. Instruction name and PDA seeds unchanged so every existing client keeps working.
- Remove `set_parcel_metadata_uri`; the URI is deterministic
  (`https://api.urbangametheory.xyz/parcels/parcelIds?ids=<id>`).
- Existing anchors keep whatever `owner` they have; nothing reads it any more. Layout unchanged.

### SAS schemas (WS-B)

One protocol schema per fact kind, versioned. Each lens member issues under its own credential;
the contract checks the credential's authority, not a registry.

```
ParcelOwnership-v1:     string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt
ProposalVerdict-v1:     string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt
```

`owner` is a base58 pubkey. `ownerCount` is how many owners the
member recognises for the parcel as of `sourceObservedAt`; a co-owned parcel gets one ownership
attestation per owner, all carrying the same count (decision 2026-10-01: one acceptance per attested
owner, no majority shortcuts). `evidenceRef` is opaque: a hash or the member's own case id, never a
name or OIB. `verdict` is `executed` or `expired`. There is no acceptance schema: the owner signs. Payloads use the borsh string layout already parsed for `CourtParcelOperationV2`
(`proposal_market/src/lib.rs:403-452`); JS parsers live beside `backend/oracle/sas-court-attestation.js`.
The court oracle's existing V2 schema stays as is; the court is simply a lens member whose verdicts
keep resolving external markets.

### proposal_nft v2 (WS-A)

`Proposal` layout is unchanged (`lib.rs:371-385`); `proposal_market`, the lifecycle oracle and the
frontend parser decode a prefix of it and must keep working.

- **Remove** `accept_proposal`, `withdraw_acceptance` and `validate_parcel_owner`. The old path is
  the hole; do not keep both.
- **Add** `accept_with_attestations(parcel_id, payout: Option<Pubkey>)`:
  - accounts: `proposal` (mut), `parcel` (anchor PDA, existence check only), `ownership`
    (SAS account), `ownership_credential` (SAS credential of the member), `tally` (init_if_needed, PDA
    `["consent", proposal, parcel_id]`), `record` (init, PDA `["acceptance", proposal, parcel_id,
    owner]`), `owner` (signer; must equal the ownership payload's `owner`), `payer` (signer, pays
    rent, may be the owner), system program.
  - checks, in order: status Active and `acceptance_possible`; `parcel_id ∈ parcel_ids` and not yet
    in `accepted_parcels`; the ownership attestation is SAS-owned, discriminator 2, unexpired, its
    `credential` field equals the passed credential account and that credential's authority equals
    the attestation's signing authority; that authority ∈ `proposal.lens`; payload
    `parcelUid == parcel_id` and `ownerCount ≥ 1`; `owner.key() == payload.owner`;
    `sourceObservedAt ≤ now`; no record exists for this owner; if the tally already exists,
    its `required` equals this attestation's `ownerCount` and its `member` equals this ownership
    authority (one member's view of the owner set per parcel; a different member starts nothing).
  - effect: the `record` stores owner, member, the ownership attestation key, its sha256 over the
    whole account bytes, `payout` (zero key when absent) and the clock time, so the evidence is
    permanent even if the SAS account later expires or closes. The `tally`
    (`proposal, parcel_id, member, required u8, accepted u8, bump`) gains one. When `accepted ==
    required`, push `parcel_id` to `accepted_parcels` and `acceptance_count += 1`. When that count
    equals `parcel_ids.len()`, `acceptance_possible = false`, `status = Executed`.
- **Add** `settle_with_verdict()`:
  - accounts: `proposal` (mut), `verdict` (SAS account), `verdict_credential`, `submitter` (signer).
  - checks: same attestation checks; authority ∈ `proposal.lens`; payload `proposalAccount ==
    proposal.key()`; `verdict ∈ {executed, expired}`; `executed` requires every parcel accepted (a
    verdict cannot skip consent) unless the proposal was minted with `verdict_may_execute` (a new
    mint argument, default false, for permit-style evidence).
  - effect: `Expired` (3) or `Executed` (1). Expired becomes the on-chain state the app currently only
    labels (HACKATHON.md item 16).
- `cancel_and_refund` unchanged: owner-only, Active only.
- **Add** `reclaim_expired_funds()`: owner-only, requires Expired and a positive `sol_balance`; returns the
  whole balance to the owner. Without it SOL escrowed on a proposal that a verdict expired had no exit.
- `distribute_funds` currently pays certificate owners (`lib.rs:170-231`). With ownerless anchors it
  pays the `payout` stored in each acceptance record instead (remaining accounts: per accepted parcel
  its tally, then record and recipient pairs); a proposal executed by verdict with no acceptance
  records returns the balance to the proposal owner, passed as the single remaining account.
  Records with an empty `payout` receive nothing. Owner compensation is an open question below.

### proposal_market (WS-A)

- `resolve` maps Expired → NO beside Cancelled → NO (`lib.rs:112-125`).
- `create_external_market` gains an optional `proposal` account: when present, `trusted_attester`
  must be in that proposal's lens. Existing market accounts and the legacy layout are untouched.

### Built state (2026-10-01)

All three programs are built with a shared `crates/sas_attestation` parser crate and pass 139 localnet
tests (proposal_nft 39, proposal_market 26, proposal_pledge 68, parcel_nft 6). The attestation's schema
must equal the SAS schema PDA for `ParcelOwnership` or `ProposalVerdict` version 1 under the member's
credential; attestations must carry a strictly future expiry (0 counts as expired). `verdict_may_execute`
is appended after `bump` inside the fixed account, which every existing prefix decoder tolerates; the
38 devnet proposals all carry a zero byte there. `mint_and_fund` gained the trailing bool, so v1 clients
must send it. The external market takes the optional proposal as remaining account 0. Not deployed.

### Space

Each acceptance record is its own PDA (about 8 + 32 + 4 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 1 ≈ 245
bytes) and each per-parcel tally about 8 + 32 + 4 + 32 + 32 + 1 + 1 + 1 ≈ 111 bytes, so the fixed
4096-byte proposal account (`lib.rs:265`) is unaffected; it still holds the lens and the accepted
parcel ids as today. `distribute_funds` iterates records, not parcels: each record's `payout`
receives an equal share of its parcel's share.

## Backend (WS-B, WS-C)

- **Attester directory.** `GET /lenses/members` and `GET /agent/lenses/members`: known attesters
  from `consensus.lens_member` (key, name, kind, description, coverage counts: ownership
  attestations issued, parcels covered, proposals executed), refreshed by the land-event job from
  attestations seen on chain. Purely informational; the contract never reads it. Machine-readable in
  `agents.json` and OpenAPI.
- **Recipe schema.** `lens: [pubkey]` becomes a documented field of the paid recipe
  (`backend/routes/agent-recipe-schema.json`); the paid route still writes the record only, minting
  stays with the agent.
- **Lens evaluator.** For proposal recipes, `trustedAttesters` derive from the proposal's on-chain
  lens; the `COURT_ATTESTER` constant and the fixed list in `court-parcel-operation.js:54-111` are
  removed and the court is looked up like any member.
- **Evidence log.** `consensus.land_event` gains `parcel_ownership`, `proposal_acceptance` and
  `proposal_verdict` events, materialised from acceptance records and verdict attestations by the
  same job that writes lifecycle events. Every attestation about a parcel is then queryable per
  anchor: the permanent per-parcel log the emergent-rwa registry pattern argues for.
- **Reference lens member (`backend/lens/`).** One process, one key, one credential. It issues
  `ParcelOwnership-v1` after its own identity check, through two adapters:
  - devnet stand-in: `consensus.lens_devnet_owner` maps a parcel to its owner wallets, owner count
    and the time ownership was established (`parcel_info` holds no wallets); the wallet signs a
    server challenge (ed25519) before the member attests. For a co-owned parcel every attestation
    carries the same count and the latest `established_at`, or the parcel is refused;
  - production: Certilia eOsobna OIDC with the OIB matched to the land-registry owner, exactly as the
    EVM oracle-voting draft specifies (`consensus-builder-oracle-voting/oracle-voting.md`), never
    writing the OIB anywhere.
  It exposes `GET /lens/status` (kind, credential, counts), `POST /lens/challenge`,
  `GET /lens/attestations`, an operator-only `POST /lens/verdict`, and prices `POST /lens/ownership`
  over x402 like the other agent routes (refusals happen before payment; an existing attestation is
  returned free), so running a lens member is a business anyone can enter. Attestation nonces are
  deterministic per fact, so retries are idempotent. Built in `backend/lens/`; live issuance needs
  `sas-lib` installed in `backend/`.
- **Owner acceptance.** `POST /proposals/:id/accept-transaction` builds the unsigned
  `accept_with_attestations` transaction (fetching the member's ownership attestation for the wallet
  and parcel) for a connected wallet or an agent key to sign and send.

## Frontend (WS-D)

- **Lens picker** in the create dialog replaces the free-text EVM modal on Solana: pick members from
  the directory (kind, name, coverage for the selected parcels) or paste any key. At least one
  member is required for parcel proposals. `chain-data-loader.js` decodes the lens back instead of
  returning `[]`.
- **Parcel coverage.** While choosing land, parcels show which known attesters have ownership
  attestations for them; a filter hides parcels no chosen member covers.
- **Details, Acceptance section.** Per parcel: ownership attested by which member, how many of the
  attested owners have signed, a Say yes button for an attested owner's wallet, evidence links. The old "mint missing certificates and accept" flow is
  removed.
- **Member console** (`/lens.html`): a lens member connects its wallet, sees ownership requests,
  runs the configured identity adapter and signs. This makes a notary or a cadastre office a visible
  actor in the demo.
- **Timeline and Activity.** New action types `attestOwnership`, `acceptance`, `verdict` with
  messages; the Actors explorer shows attesters as actors of kind `attester`.

## Agents and MCP (WS-E)

- `ugt_list_attesters`, `ugt_mint_proposal` (parcels, lens, image), `ugt_request_ownership`
  (calls a lens member), `ugt_accept_parcel` (owner key signs accept_with_attestations),
  `ugt_submit_verdict` (permissionless settle).
- Personas: a `notary-01` lens member running the reference process on devnet; the proposer persona
  picks lens members from the directory instead of naming itself; the supporter persona, holding the
  devnet-recorded owner wallets, signs acceptances after `notary-01` attests them.
- Canonical case v3: mint with `notary-01` in the lens, ownership attested for the recorded wallets,
  each of them signs its acceptance, the last signature executes, market pays YES. This replaces the
  certificate caveat in HACKATHON.md item 34 with a real consent chain.
- Daily loop: agent proposals that gather no acceptances are expired by a lifecycle verdict from a
  member in their lens after N days, instead of being cancelled by their author.

## Proof and audit (WS-F)

- Audit checks: `attested_execution` (a case executed only through attestations, with acceptance
  records and their hashes), `no_self_lens` (no agent proposal minted in the window lists only its
  own key), `attester_diversity` (ownership attestations from at least two distinct members).
- `docs/protocol.md`: rewrite the trust boundary around the vocabulary and principles above; state
  plainly that anchors carry no ownership and that legacy proposals whose lens is their own creator
  remain self-decidable on devnet.
- `HACKATHON.md`: the lens model becomes the headline of the "evidence and resolution" row.

## Migration

1. Register the two schemas on devnet; publish parsers.
2. Upgrade `proposal_market` (Expired → NO, optional proposal-bound external markets). Layouts
   unchanged; existing markets keep resolving.
3. Upgrade `parcel_nft` (ownerless mint, metadata update removed). Existing anchors untouched.
4. Upgrade `proposal_nft` (attested accept and settle, owner accept removed). Existing proposals keep
   their layout and status; those whose lens is their creator can still be executed by that creator
   attesting its own ownership, which the docs disclose.
5. Ship frontend and agents together with step 4, since the owner-accept UI must disappear the
   moment the instruction does.
6. Run canonical case v3, then flip the audit checks from advisory to required.

Deploy one program at a time (`anchor deploy --program-name <name> --provider.cluster devnet`) and
never `anchor keys sync` in `blockchain/solana` (the original deploy keypairs are not in the repo).

## Workstream contracts

| WS | Owns | Delivers | Depends on |
|---|---|---|---|
| A programs | `blockchain/solana/programs/{parcel_nft,proposal_nft,proposal_market}` | instructions above, IDLs, localnet suites incl. member-not-in-lens, signer-not-attested-owner, expired-attestation, double-acceptance, self-lens cases | schema layouts from B |
| B schemas and backend | `backend/oracle/*`, `backend/routes/{lenses,agent-recipe-schema,land-events,proposals}.js`, DDL | schema registration scripts, parsers, directory, acceptance issuance, evaluator wiring, evidence log | A for record layout |
| C lens member service | `backend/lens/` | reference member with two identity adapters, x402 pricing, status endpoint | B parsers |
| D frontend | `frontend/js/{lens,proposals/create,details-panel,solana/*}.js`, `frontend/lens.html` | picker, coverage filter, acceptance section, member console, decoding | B directory, A IDLs |
| E agents and MCP | `backend/agents/*` | tools, `notary-01` persona, canonical case v3, expiry by verdict | A, B, C |
| F proof | audit module, docs, HACKATHON.md | checks and disclosures | E for the live case |

Interfaces frozen by this document: the two schema strings, the `accept_with_attestations` and
`settle_with_verdict` account lists, the tally and acceptance record PDA seeds and fields, the directory
response shape (`{ members: [{ key, kind, name, description, coverage: { ownership, parcels,
executed } }] }`), and the three new event types.

## Open questions

- **Owner compensation.** Escrowed SOL or USDC goes to the `payout` an owner passes when it signs
  its acceptance. Needs a privacy review, since a payout key is linkable to the owner wallet.
- **Threshold semantics.** This design accepts one ownership attestation from any lens member.
  k-of-n members per parcel belongs in the evaluator and a later program version.
- **Lens mutability.** This document says immutable; forking is the way to change authorities.
- **Fees.** Lens members charge over x402; whether the protocol takes a cut is a product decision.
- **Legacy EVM lens entries.** The `0x` defaults in `frontend/js/lens.js` disappear from the Solana
  path; the EVM path keeps them until it is aligned.
