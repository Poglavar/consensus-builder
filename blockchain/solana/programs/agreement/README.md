<!-- The agreement program: one Solana account per published agreement (its IPFS CID), an escrow in SOL, settled by its lens members' attestations and an optional contribution target. Short reference for its accounts, instructions, attestation schema and PDA. -->

# agreement

Design of record: [`plan-design-agreement.md`](../../../../docs/plan-design-agreement.md) (decisions
"Consent and execution move to the agreement" and "What is minted", simplification 7, the M2
`agreement/v1` object and its CID). One program replaces proposal_nft's per-proposal consent
machinery: no parcels, owner lists, acceptance records, withdrawals or vote variants on chain. Owners
decide in signed off-chain documents, the approval engine counts them, the agreement's lens members
attest the outcome, and this program checks those attestations, any contribution target and the
escrow. JS codec:
[`frontend/js/solana/agreement-client.js`](../../../../frontend/js/solana/agreement-client.js) (UMD:
`window.AgreementClient` in the browser, `require` in node); the browser drives it through
`frontend/js/solana/agreement-bridge.js`.

**Status: the lens-set layout (580-byte account, `confirm_funding`) is deployed on devnet** at the id
below, a new address (2026-11-25); agreements minted under the earlier one-lens program are not read
by this codec and are recreated. A lens member's `AgreementDecision-v1` may come from its service or
from its own wallet: the browser builds the member's SAS credential, schema and attestation
(`agreement-client.js` `buildCreateLensCredentialIx`, `buildCreateDecisionSchemaIx`,
`buildCreateDecisionAttestationIx`, byte-identical to sas-lib) and sends them with `attest` (and
`execute` when the lens completes) in one transaction.
[`../../idl/agreement.json`](../../idl/agreement.json) is the generated IDL.

## Lifecycle

`create` → `fund` (the authority, any number of times) → `attest` (once per lens member, until the
threshold) and `confirm_funding` (once, when the agreement has a contribution target) → `execute`;
or `cancel` (the authority, while no decision is recorded) or `expire` (anyone, after the deadline).
Statuses use proposal_nft's codes: 0 Active, 1 Executed, 2 Cancelled, 3 Expired. Decisions:
0 Pending, 1 Satisfied.

Two settlement conditions are frozen at `create`, and the decision becomes Satisfied in the
instruction that completes the last of them:

- **Lens.** `lens_threshold` distinct members of the lens (0-8 member keys) each record an
  AgreementDecision attestation with `attest`. Threshold 1, the default, means "any one of the
  listed keys". Any key may be a member, the sponsor's own included: the people who enter an
  agreement judge its lens.
- **Contribution target** (optional). The agreement's proposal_pledge donation escrow credits at
  least `required_funding` (donated less refunded, in `funding_mint`) and its vault holds that much.
  `confirm_funding` checks it from the escrow itself, so anyone may send it and "the money arrived"
  needs no lens. An agreement with a target may have no lens (threshold 0).

The lens never refuses: members attest only a satisfied decision, so an agreement whose conditions
are not met by its deadline simply expires. `create` requires a deadline in the future, so
every agreement can end: one decided but never funded or executed expires after its deadline. An
account created before the deadline became mandatory may hold none (0); it stays Active until its
authority cancels it (while no decision is recorded) or it executes. Every terminal state moves
the whole escrow exactly once: to `payout` when Executed, back to the authority when Cancelled or
Expired.

The authority is the only funder. A funder recorded at the first fund would let any stranger pay
first and lock the real sponsor out, and the sponsor cannot create the agreement twice (its address
is fixed by sponsor and CID), so that agreement would be lost.

## PDA

`Agreement`: `["agreement", authority, sha256(cid as UTF-8)]` under this program (decided
2026-10-21). The authority is the sponsor that publishes the agreement: `agreement/v1` carries its
wallet as `sponsor` (base58, from M2's publish step), so a reader derives the address from the
agreement object alone, and the index's `onchain` column is the usual lookup. A CID (59 bytes for
`bafkrei…`) is longer than the 32-byte seed limit, so the last seed is the sha256 of the CID string.
`create` derives the address from its signer and its `cid` argument; every other instruction
re-derives it from the account's stored `authority` and `cid` (`bump` from the account).

Only the sponsor can create its agreement's account, so nobody can squat a CID (the first-create-wins
problem of a CID-only address is closed). Another wallet can still create an account for the same
CID at its own address, but the lens attestation names the sponsor as well as the CID and `attest`
requires `sponsor == authority`, so that account can never record the decision or execute (closed on
chain, 2026-10-21). It can still emit `AgreementCreated`, `AgreementFunded`, `AgreementCancelled` and
`AgreementExpired` for that CID, so readers, markets and parcel history key on `PDA(sponsor, cid)`,
never on the CID inside an event.

## Agreement account

8-byte discriminator + 572 bytes = 580. Fixed fields come first, so these offsets hold in every
account (memcmp filters on `authority`, the first lens member `lens` or `status` work). The header up
to `bump` keeps the offsets `proposal_market` and `proposal_pledge` read; the lens set and the
contribution target follow it:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `authority` | Pubkey | creator; paid the rent; the only key that may fund or cancel; receives refunds |
| 40 | `lens` | Pubkey | the first lens member (the default key with no lens) |
| 72 | `payout` | Pubkey | receives the whole escrow at execution (the settlement account) |
| 104 | `deadline` | i64 | unix seconds, in the future at create; 0 (no deadline, never expires) only on accounts created before it became mandatory |
| 112 | `created_at` | i64 | chain time of create |
| 120 | `required_lamports` | u64 | escrow execution needs (0: none) |
| 128 | `escrow_lamports` | u64 | lamports `fund` brought in, not yet paid out or refunded |
| 136 | `status` | u8 | 0 Active, 1 Executed, 2 Cancelled, 3 Expired |
| 137 | `open_ground` | bool | the land includes open ground; recorded for readers, no effect here |
| 138 | `decision` | u8 | 0 Pending, 1 Satisfied |
| 139 | `decision_attested_at` | i64 | chain time of `attest` |
| 147 | `decision_observed_at` | i64 | the attestation's `sourceObservedAt` |
| 155 | `decision_attestation` | Pubkey | the recorded SAS attestation |
| 187 | `decision_hash` | [u8; 32] | sha256 of that attestation's whole account bytes |
| 219 | `executed_at` | i64 | chain time of `execute` |
| 227 | `bump` | u8 | PDA bump |
| 228 | `lens_count` | u8 | lens members, 0-8: `lens`, then the first `lens_count - 1` of `more_lenses` |
| 229 | `lens_threshold` | u8 | distinct members that must confirm: 1..`lens_count`, 0 with no lens |
| 230 | `lens_confirmed` | u8 | bit i set once member i (0 = `lens`, i = `more_lenses[i - 1]`) has attested |
| 231 | `more_lenses` | [Pubkey; 7] | the members after the first; unused slots hold the default key |
| 455 | `funding_mint` | Pubkey | token mint of the contribution target (default key with none) |
| 487 | `required_funding` | u64 | credited proposal_pledge contributions needed, in base units (0: no target) |
| 495 | `funding_met` | bool | `confirm_funding` found the target met |
| 496 | `funding_observed` | u64 | credited contributions it observed (0 until confirmed) |
| 504 | `funding_met_at` | i64 | chain time of that confirmation (0 until confirmed) |
| 512 | `cid` | string | u32 LE length + up to 64 ASCII letters and digits |

The escrow is held by the agreement account itself, on top of its rent (proposal_nft's pattern).
Only `escrow_lamports` is ever paid out; lamports sent to the account by a plain transfer stay there.
The account is never closed: it stays as the agreement's chain record.

## Instructions

| Instruction | Accounts (in order) | Requires | Effect |
|---|---|---|---|
| `create(cid: String, lenses: Vec<Pubkey>, lens_threshold: u8, deadline: i64, open_ground: bool, required_lamports: u64, payout: Pubkey, funding_mint: Pubkey, required_funding: u64)` | `agreement` (mut, init, PDA of `authority` and `cid`), `authority` (signer, mut: the sponsor), `system_program` | `cid` 1-64 ASCII alphanumerics; `lenses` 0-8 distinct keys, none the default key, with `lens_threshold` 1..members, or no members (threshold 0) only with a target (`NoLens`, `InvalidLens`); `funding_mint` set exactly when `required_funding` > 0 (`InvalidFundingTarget`); `payout` neither the default key nor the agreement; `deadline` in the future (0 is refused) | Active account; emits `AgreementCreated` |
| `fund(lamports: u64)` | `agreement` (mut), `authority` (signer, mut), `system_program` | the agreement's authority; `lamports` > 0; Active; deadline not passed (also after the decision) | system transfer into the agreement, `escrow_lamports += lamports`; emits `AgreementFunded` |
| `attest()` | `agreement` (mut), `attestation` (SAS AgreementDecision-v1), `credential` (its SAS credential) | Active; decision Pending; deadline not passed; lens threshold not yet met (`LensAlreadyConfirmed`); the signer a member not yet counted (`WrongLens`, `MemberAlreadyConfirmed`); the attestation checks below | sets the member's bit in `lens_confirmed`; the confirmation that reaches the threshold is kept as the decision's evidence (`decision_observed_at`, attestation key and hash); Satisfied once any target is also confirmed; emits `AgreementAttested`. Permissionless |
| `confirm_funding()` | `agreement` (mut), `escrow` (proposal_pledge DonationEscrow at `["donation_escrow", agreement]`), `vault` (the escrow's token account) | Active; decision Pending; deadline not passed; a target set (`NoFundingTarget`) and not yet confirmed (`FundingAlreadyConfirmed`); the escrow owned by proposal_pledge at that address, for this agreement and `funding_mint`, not released (`InvalidEscrow`); the vault the escrow's, an initialized SPL token account of that mint holding at least the credited amount (`InvalidVault`); credited contributions (donated less refunded) ≥ `required_funding` (`FundingTargetNotMet`) | `funding_met`, `funding_observed`, `funding_met_at`; Satisfied once the lens is also met; emits `AgreementFundingConfirmed`. Permissionless: the program reads the escrow, so no lens is needed. Contributions cannot be refunded while the agreement is Active, so a confirmed target stays met |
| `execute()` | `agreement` (mut), `payout` (mut, = `agreement.payout`) | Active; decision Satisfied; deadline not passed; `escrow_lamports >= required_lamports` | whole escrow to `payout`; Executed, `executed_at`; emits `AgreementExecuted`. Permissionless |
| `cancel()` | `agreement` (mut), `authority` (signer, mut) | the agreement's authority; Active; no decision recorded | escrow back to the authority; Cancelled; emits `AgreementCancelled` |
| `expire()` | `agreement` (mut), `authority` (mut, = `agreement.authority`, need not sign) | Active; `deadline` set and passed | escrow back to the authority; Expired; emits `AgreementExpired`. Permissionless |

`payout` must be able to hold what it receives: an account with no lamports that receives less than
the rent-exempt minimum makes `execute` fail.

Events, all with `agreement` and `cid`: `AgreementCreated` (authority, lenses, lens_threshold,
payout, deadline, required_lamports, funding_mint, required_funding, open_ground, created_at),
`AgreementFunded` (lamports, escrow_lamports, funded_at), `AgreementAttested` (lens: the attesting
member, attestation, attestation_hash, evidence_ref, source_observed_at, confirmations,
lens_threshold, satisfied, attested_at), `AgreementFundingConfirmed` (escrow, funding_mint,
required_funding, credited, vault_amount, satisfied, confirmed_at), `AgreementExecuted` (payout, lamports, lens, decision_attestation,
executed_at: the one event parcel history is written from), `AgreementCancelled` and
`AgreementExpired` (refunded_lamports, cancelled_at / expired_at).

## AgreementDecision-v1, the attestation a lens member issues

Issued by a lens member's key under its own SAS credential, the way it issues
ParcelOwnership-v1 and ProposalVerdict-v1 (`backend/lens/member.js`, `backend/oracle/lens-schemas.js`):

```
schema name   AgreementDecision          version 1
schema PDA    ["schema", credential, "AgreementDecision", [1]] under SAS 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG
layout        string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt
SAS layout    [12, 12, 12, 12, 8]        (borsh: u32 LE length + UTF-8 per string, i64 LE)

agreementCid      the agreement's CID, byte for byte as stored on chain (bafkrei…)
sponsor           base58 of the agreement's authority: agreement/v1's `sponsor`
decision          always "satisfied" (the lens never refuses; anything else is InvalidDecision)
evidenceRef       what the lens counted, e.g. "sha256:<hex>" over the admitted decision receipts
sourceObservedAt  unix seconds at which the counted decisions gave this outcome
```

`attest` accepts it when: the account is owned by SAS with discriminator 2; `expiry` is after the
chain time; it was issued under the passed credential, whose authority is the attestation's signer;
its schema is that credential's AgreementDecision v1 PDA; the signer is a lens member whose
confirmation is not yet recorded;
`agreementCid` equals `agreement.cid`; `sponsor` is a base58 key equal to `agreement.authority`
(`WrongSponsor` otherwise; a malformed key is `InvalidAttestationPayload`); `decision` is
`satisfied` (`InvalidDecision` otherwise); `sourceObservedAt` is not in the future; and the payload
has no trailing bytes. The lens takes `sponsor` from the agreement object, never from whoever asks
for the attestation, and issues the attestation only once the rule is satisfied; each member counts
once and a recorded confirmation is final. The member's deterministic nonce, `factNonce(["AgreementDecision-v1",
agreementCid, sponsor, decision, sourceObservedAt])` (`backend/lens/member.js`), keeps a retry on the
same attestation address.

The schema entry for `backend/oracle/lens-schemas.js` (its `sasLayout` comes out as `[12, 12, 12, 12, 8]`):

```js
decision: schemaDefinition(
    'decision',
    'AgreementDecision',
    'A lens member attests that the decision rule of an agreement is satisfied as of a source time.',
    'string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt'
)
```

## Program id

`ESJ1w3rpzXtUXcZFgRfzHYRBzcrT7HeCychLNXvdBeYH` on devnet (the lens-set layout deployed 2026-11-25 at a new address, upgrade authority the
deployer wallet `~/.config/solana/id.json`), in `declare_id!`, both `Anchor.toml` sections,
`frontend/js/solana/agreement-client.js` and `idl/agreement.json`. The program keypair is kept outside
the repo (`~/.config/solana/program-keys/`). `proposal_market` and `proposal_pledge` compile this id in
(they read agreement accounts), so a change of id means rebuilding and upgrading both as well. Upgrade
one program at a time, never with `anchor keys sync` (see `../../README.md`):
`solana program deploy target/deploy/agreement.so --program-id <id> --url devnet`.
