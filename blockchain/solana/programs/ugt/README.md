<!-- The ugt program: parcel anchors, design and plan records (Metaplex Core assets) and agreements in one Solana program. Short reference for its accounts, instructions, PDAs, the lens attestation and the program id. -->

# ugt

Design of record: [`blockchain-flows.md`](../../../../docs/blockchain-flows.md) ("The objects on
chain", "Chain contracts"); the agreement lifecycle comes from
[`plan-design-agreement.md`](../../../../docs/plan-design-agreement.md) (M3). One program replaces
`parcel_nft`, `agreement` and `proposal_nft`. `proposal_market` and `proposal_pledge` read its
agreements through `ugt::read_agreement_view` (they depend on this crate with `no-entrypoint`).

JS codecs (UMD, `window.*` in the browser, `require` in node): anchors and records
[`frontend/js/solana/ugt-client.js`](../../../../frontend/js/solana/ugt-client.js), agreements
[`frontend/js/solana/agreement-client.js`](../../../../frontend/js/solana/agreement-client.js). The
chain adapter of the mint checklist is
[`frontend/js/chain/solana-adapter.js`](../../../../frontend/js/chain/solana-adapter.js).
IDL: [`../../idl/ugt.json`](../../idl/ugt.json) (Anchor 0.30 leaves `ParcelAnchor` out of the IDL's
accounts because no instruction takes it as a typed account; its layout is below).

## Accounts

| Account | PDA | Purpose |
|---|---|---|
| `ParcelAnchor` | `["parcel", parcel_id]` | ownerless identity of a cadastral parcel; never transferred or closed |
| `Record` | `["record", kind, sha256(cid)]` | a design (kind 1) or plan (kind 2) published under its CID |
| Metaplex Core asset | `["asset", kind, sha256(cid)]` | the record's wallet-visible token, minted to the publisher, permanently frozen |
| `Agreement` | `["agreement", sponsor, sha256(cid)]` | escrow settled by the lens's AgreementDecision-v1 attestation |

A CID (59 bytes for `bafkrei…`) is longer than one 32-byte seed, so seeds use its sha256. CIDs are
1-64 ASCII letters and digits. Fixed fields come first in every account, so `getProgramAccounts`
filters work: a record's `kind` at byte 8, an anchor's `anchored_by` at byte 8, an agreement's
`status` at 136 and `plan_cid_hash` at 227.

**ParcelAnchor** (8-byte discriminator, then): `anchored_by` Pubkey (paid the rent, not an owner),
`anchored_at` i64, `bump` u8, `parcel_id` string (1-32 bytes, the seed), `metadata_uri` string
(1-200 bytes, the parcel's app page). Its size follows its strings.

**Record** (151 bytes): `kind` u8, `minter` Pubkey, `created_at` i64, `asset` Pubkey, `bump` u8,
`asset_bump` u8, `cid` string. The record confers nothing: not ownership of land or of the design.
Readers verify content by hashing what they fetch. Its asset's update authority is the record
account, so nobody can change the asset's name or URI.

**Agreement** (330 bytes):

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `authority` | Pubkey | the sponsor: paid the rent; the only key that may fund or cancel; receives refunds |
| 40 | `lens` | Pubkey | lens member key whose AgreementDecision attestation settles it |
| 72 | `payout` | Pubkey | receives the whole escrow at execution |
| 104 | `deadline` | i64 | unix seconds; 0 = no deadline (never expires) |
| 112 | `created_at` | i64 | chain time of create |
| 120 | `required_lamports` | u64 | escrow execution needs (0: none) |
| 128 | `escrow_lamports` | u64 | lamports `fund` brought in, not yet paid out or refunded |
| 136 | `status` | u8 | 0 Active, 1 Executed, 2 Cancelled, 3 Expired |
| 137 | `open_ground` | bool | the land includes open ground; recorded for readers |
| 138 | `decision` | u8 | 0 Pending, 1 Satisfied |
| 139 | `decision_attested_at` | i64 | chain time of `attest` |
| 147 | `decision_observed_at` | i64 | the attestation's `sourceObservedAt` |
| 155 | `decision_attestation` | Pubkey | the recorded SAS attestation |
| 187 | `decision_hash` | [u8; 32] | sha256 of that attestation's whole account bytes |
| 219 | `executed_at` | i64 | chain time of `execute` |
| 227 | `plan_cid_hash` | [u8; 32] | sha256 of the plan CID the agreement names (`planCid`) |
| 259 | `input_count` | u16 | the agreement's input parcels, for readers |
| 261 | `bump` | u8 | PDA bump |
| 262 | `cid` | string | u32 LE length + up to 64 bytes |

The escrow is held by the agreement account on top of its rent; only `escrow_lamports` is ever paid
out. The account is never closed.

## Instructions

| Instruction | Accounts | Checks | Effect |
|---|---|---|---|
| `anchor_parcels(parcel_ids, metadata_uris)` | `payer` (signer, mut), `system_program`, then one writable anchor PDA per id | 1-16 ids, as many URIs, each account the id's PDA | creates the anchors that do not exist, skips the rest; emits `ParcelAnchored` per new anchor |
| `create_record(kind, cid, name, uri)` | `record` (init), `asset` (mut, PDA), `minter` (signer, mut), `mpl_core_program`, `system_program` | kind 1 or 2; CID valid; name 1-100 bytes; URI 1-1000 bytes; the record and asset do not exist | writes the record; Metaplex Core `CreateV2` mints the asset to the minter with a PermanentFreezeDelegate (frozen, authority None); emits `RecordCreated` |
| `create(cid, plan_cid, input_count, lens, deadline, open_ground, required_lamports, payout)` | `agreement` (init, PDA of the signer and CID), `authority` (signer, mut), `system_program` | both CIDs valid; lens not default; payout neither default nor the agreement; deadline 0 or future | Active, Pending; emits `AgreementCreated` |
| `fund(lamports)` | `agreement`, `authority` (signer), `system_program` | the authority; lamports > 0; Active; deadline not passed | escrow += lamports; `AgreementFunded` |
| `attest()` | `agreement`, `attestation` (SAS), `credential` (SAS) | Active; Pending; deadline not passed; the attestation checks below | Satisfied; `AgreementAttested`. Permissionless |
| `execute()` | `agreement`, `payout` (= `agreement.payout`) | Active; Satisfied; deadline not passed; escrow ≥ required | escrow to payout; Executed; `AgreementExecuted` |
| `cancel()` | `agreement`, `authority` (signer) | the authority; Active; Pending | escrow back; Cancelled; `AgreementCancelled` |
| `expire()` | `agreement`, `authority` (= stored, need not sign) | Active; deadline set and passed | escrow back; Expired; `AgreementExpired`. Permissionless |

The client packs anchors by transaction size (at most 8 per transaction: each creates an account,
and a batch of 8 with app-page URIs stays well inside the default compute budget). A second
`create_record` of the same CID fails at the record's `init` ("already in use"), whoever sends it.

Metaplex Core is called by a hand-encoded `CreateV2` (`src/mpl_core.rs`, discriminator 20): the
`mpl-core` crate needs solana-program 2+ while the workspace is on anchor-lang 0.30.

## AgreementDecision-v1, the attestation the lens issues

```
schema name   AgreementDecision          version 1
schema PDA    ["schema", credential, "AgreementDecision", [1]] under SAS 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG
layout        string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt
SAS layout    [12, 12, 12, 12, 8]
```

`attest` accepts it when the account is owned by SAS with discriminator 2; its expiry is after the
chain time; it was issued under the passed credential, whose authority is its signer; its schema is
that credential's AgreementDecision v1 PDA; the signer is `agreement.lens`; `agreementCid` equals the
stored CID; `sponsor` is the base58 of `agreement.authority`; `decision` is `satisfied`;
`sourceObservedAt` is not in the future; and the payload has no trailing bytes. The first accepted
attestation is final.

## Program id

`95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9` on devnet (deployed 2026-11-13, upgrade authority the
deployer wallet `~/.config/solana/id.json`), in `declare_id!`, both `Anchor.toml` sections, the IDL,
the two JS codecs and `frontend/contracts/addresses.json` (`Ugt`). The program keypair is kept outside
the repo (`~/.config/solana/program-keys/ugt.json`). Upgrade with
`solana program deploy target/deploy/ugt.so --program-id <keypair> -u devnet`, never `anchor keys sync`.

## Tests

`tests/ugt-agreement.ts` (the agreement lifecycle and its refusals) and `tests/ugt-anchors-records.ts`
(anchors, records, the frozen asset), on a local validator that loads Metaplex Core from
`tests/fixtures/mpl_core.so` (gitignored; fetch it with `tests/fixtures/fetch-mpl-core.sh`).
