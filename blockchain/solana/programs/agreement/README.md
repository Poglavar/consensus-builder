<!-- The agreement program: one Solana account per published agreement (its IPFS CID), an escrow in SOL, settled by the agreement's lens attestation. Short reference for its accounts, instructions, attestation schema and PDA. -->

# agreement

Design of record: [`plan-design-agreement.md`](../../../../plan-design-agreement.md) (decisions
"Consent and execution move to the agreement" and "What is minted", simplification 7, the M2
`agreement/v1` object and its CID). One program replaces proposal_nft's per-proposal consent
machinery: no parcels, owner lists, acceptance records, withdrawals or vote variants on chain. Owners
decide in signed off-chain documents, the approval engine counts them, the agreement's lens attests
the outcome, and this program checks that attestation plus the escrow. JS codec:
[`frontend/js/solana/agreement-client.js`](../../../../frontend/js/solana/agreement-client.js) (UMD:
`window.AgreementClient` in the browser, `require` in node); the browser drives it through
`frontend/js/solana/agreement-bridge.js`.

**Status (2026-10-21): written; `anchor build -p agreement` passes (anchor-lang 0.30.1, CLI 0.32.1);
not deployed, not tested** (M3 rule: all code first, then every test in one pass).
[`../../idl/agreement.json`](../../idl/agreement.json) is the generated IDL.

## Lifecycle

`create` → `fund` (the authority, any number of times) → `attest` (once) → `execute`; or `cancel`
(the authority, while no decision is recorded) or `expire` (anyone, after the deadline). Statuses
use proposal_nft's codes: 0 Active, 1 Executed, 2 Cancelled, 3 Expired. Decisions: 0 Pending,
1 Satisfied. The lens never refuses: it attests only a satisfied decision, so an agreement whose
rule is not satisfied by its deadline simply expires, and one without a deadline stays Active until
its authority cancels it (while no decision is recorded) or it executes. Every terminal state moves
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

8-byte discriminator + 288 bytes = 296. Fixed fields come first, so these offsets hold in every
account (memcmp filters on `authority`, `lens` or `status` work):

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `authority` | Pubkey | creator; paid the rent; the only key that may fund or cancel; receives refunds |
| 40 | `lens` | Pubkey | lens member key whose AgreementDecision attestation settles it |
| 72 | `payout` | Pubkey | receives the whole escrow at execution (the settlement account) |
| 104 | `deadline` | i64 | unix seconds; 0 = no deadline (never expires) |
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
| 228 | `cid` | string | u32 LE length + up to 64 ASCII letters and digits |

The escrow is held by the agreement account itself, on top of its rent (proposal_nft's pattern).
Only `escrow_lamports` is ever paid out; lamports sent to the account by a plain transfer stay there.
The account is never closed: it stays as the agreement's chain record.

## Instructions

| Instruction | Accounts (in order) | Requires | Effect |
|---|---|---|---|
| `create(cid: String, lens: Pubkey, deadline: i64, open_ground: bool, required_lamports: u64, payout: Pubkey)` | `agreement` (mut, init, PDA of `authority` and `cid`), `authority` (signer, mut: the sponsor), `system_program` | `cid` 1-64 ASCII alphanumerics; `lens` not the default key; `payout` neither the default key nor the agreement; `deadline` 0 or in the future | Active account; emits `AgreementCreated` |
| `fund(lamports: u64)` | `agreement` (mut), `authority` (signer, mut), `system_program` | the agreement's authority; `lamports` > 0; Active; deadline not passed (also after the decision) | system transfer into the agreement, `escrow_lamports += lamports`; emits `AgreementFunded` |
| `attest()` | `agreement` (mut), `attestation` (SAS AgreementDecision-v1), `credential` (its SAS credential) | Active; decision Pending; deadline not passed; the attestation checks below | records the satisfied decision, times, attestation key and hash; emits `AgreementAttested`. Permissionless |
| `execute()` | `agreement` (mut), `payout` (mut, = `agreement.payout`) | Active; decision Satisfied; deadline not passed; `escrow_lamports >= required_lamports` | whole escrow to `payout`; Executed, `executed_at`; emits `AgreementExecuted`. Permissionless |
| `cancel()` | `agreement` (mut), `authority` (signer, mut) | the agreement's authority; Active; no decision recorded | escrow back to the authority; Cancelled; emits `AgreementCancelled` |
| `expire()` | `agreement` (mut), `authority` (mut, = `agreement.authority`, need not sign) | Active; `deadline` set and passed | escrow back to the authority; Expired; emits `AgreementExpired`. Permissionless |

`payout` must be able to hold what it receives: an account with no lamports that receives less than
the rent-exempt minimum makes `execute` fail.

Events, all with `agreement` and `cid`: `AgreementCreated` (authority, lens, payout, deadline,
required_lamports, open_ground, created_at), `AgreementFunded` (lamports, escrow_lamports,
funded_at), `AgreementAttested` (lens, attestation, attestation_hash, evidence_ref,
source_observed_at, attested_at; it always records a satisfied decision), `AgreementExecuted` (payout, lamports, lens, decision_attestation,
executed_at: the one event parcel history is written from), `AgreementCancelled` and
`AgreementExpired` (refunded_lamports, cancelled_at / expired_at).

## AgreementDecision-v1, the attestation the lens issues

Issued by the agreement's `lens` key under its own SAS credential, the way it issues
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
its schema is that credential's AgreementDecision v1 PDA; the signer is `agreement.lens`;
`agreementCid` equals `agreement.cid`; `sponsor` is a base58 key equal to `agreement.authority`
(`WrongSponsor` otherwise; a malformed key is `InvalidAttestationPayload`); `decision` is
`satisfied` (`InvalidDecision` otherwise); `sourceObservedAt` is not in the future; and the payload
has no trailing bytes. The lens takes `sponsor` from the agreement object, never from whoever asks
for the attestation, and issues the attestation only once the rule is satisfied; the first accepted
attestation is final. The member's deterministic nonce, `factNonce(["AgreementDecision-v1",
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

`Agreement1111111111111111111111111111111111` is a readable placeholder (the convention of the first
programs), in `declare_id!`, both `Anchor.toml` sections and `frontend/js/solana/agreement-client.js`. It works for a
localnet `anchor test` (Anchor loads the program at that address at genesis), but nobody holds its
key, so it can never be deployed. Before the first devnet deploy, generate the program keypair, put
its public key in those four places by hand (never `anchor keys sync`; see `../../README.md`),
rebuild, copy `target/idl/agreement.json` to `idl/`, and deploy this program alone:
`anchor deploy --program-name agreement --provider.cluster devnet`.
