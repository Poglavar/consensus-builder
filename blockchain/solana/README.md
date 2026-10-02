# Urban Game Theory - Solana Programs

Solana equivalents of the EVM ParcelNFT and ProposalNFT contracts.

## Programs

- **parcel_nft**: ownerless parcel anchors, the on-chain identity of a cadastral parcel (PDA-based)
- **proposal_nft**: proposals for parcel development with SOL funding, a lens of trusted SAS
  attesters, attested owner acceptance and verdict settlement
- **proposal_market**: parimutuel markets on a proposal's terminal state, and external markets
  resolved from SAS court evidence
- **proposal_pledge**: USDC donations and soft pledges on a proposal
- **crates/sas_attestation**: byte-level SAS account readers shared by proposal_nft and
  proposal_market (not a program)

## Lens model v2 — deployed to devnet; verified 2026-10-02

Design of record: [`lens-model.md`](../../lens-model.md). The checked-in IDLs describe the deployed
source: ParcelNFT v2, ProposalMarket v2 and ProposalNFT v3 (v3 includes the v2 lens acceptance and
verdict behavior). Their current executable bytes were fetched from devnet and matched the builds;
transaction signatures and hashes are in [`docs/protocol.md`](../../docs/protocol.md). This verifies
program deployment, not registration of the lens SAS schemas or a complete human-owner journey.

### What changed

| Program | Change |
|---|---|
| `parcel_nft` | `mint_parcel` writes `owner = Pubkey::default()`; the second account is now `payer` (same position as v1's `owner`, so raw-built instructions still work). `set_parcel_metadata_uri` removed. Layout and seeds unchanged. |
| `proposal_nft` | `accept_proposal`, `withdraw_acceptance` and the certificate-owner check removed. New `accept_with_attestations`, `settle_with_verdict` (writes a `VerdictRecord` PDA), `reclaim_expired_funds`; `distribute_funds` pays acceptance records (or the owner when a verdict executed a proposal without any). `mint_and_fund` takes a trailing `verdict_may_execute: bool` (clients must now send it; `false` is the normal value). |
| `proposal_market` | `resolve` maps Expired (3) to NO. `create_external_market` takes an optional proposal as remaining account 0: when passed, `trusted_attester` must be in that proposal's lens. No instruction or account layout changed. |

### proposal_nft instructions

`accept_with_attestations(parcel_id: String, payout: Option<Pubkey>)`

Accounts: `proposal` (mut), `parcel` (parcel_nft anchor PDA, must exist), `ownership` (SAS
ParcelOwnership-v1 attestation), `ownership_credential` (SAS credential it was issued under),
`tally` (init_if_needed), `record` (init), `owner` (signer: the attested owner), `payer` (signer,
mut, pays rent; may be the owner), `system_program`.

Checks in order: proposal Active and `acceptance_possible`; `parcel_id` in `parcel_ids` and not
yet accepted; parcel anchor exists; the attestation is SAS-owned, discriminator 2, `expiry > now`,
its credential field is the passed credential, that credential's authority is the attestation's
signer, and its schema is PDA(["schema", credential, "ParcelOwnership", [1]]) under SAS; the
signer is in `proposal.lens`; payload `parcelUid == parcel_id`, `ownerCount >= 1`,
`owner == owner.key()`, `sourceObservedAt <= now`; an existing tally has the same `required` and
`member`. A second acceptance by the same owner fails earlier, at the `record` init ("already in
use"), because Anchor creates init accounts before the handler runs.

Effect: writes the record, `tally.accepted += 1`; when `accepted == required` the parcel joins
`accepted_parcels`; when every parcel has, the proposal is Executed.

`settle_with_verdict()` — accounts `proposal` (mut), `verdict` (SAS ProposalVerdict-v1),
`verdict_credential`, `verdict_record` (init), `submitter` (signer, mut, pays the record's rent),
`system_program`. Same attestation checks (schema name `ProposalVerdict`), signer in the lens,
`proposalAccount == proposal`, `sourceObservedAt <= now`, proposal Active. `expired` sets Expired
(3); `executed` sets Executed (1) only when the proposal was minted with `verdict_may_execute` (a
verdict cannot skip per-parcel consent). Writes a permanent `VerdictRecord` and emits
`VerdictSettled { proposal, verdict_attestation, verdict_hash, member, status, settled_at }`.
Submitting the same attestation twice fails at the `verdict_record` init ("already in use").

Per-parcel history is assembled off-chain from the permanent PDAs: `AcceptanceRecord`s (who
accepted, under which ownership attestation), `ConsentTally`s and the proposal's `VerdictRecord`s.
The program has no log account of its own.

`distribute_funds()` — accounts `proposal` (mut). Remaining accounts, per accepted parcel in
`accepted_parcels` order: its tally, then `tally.accepted` pairs of (acceptance record, recipient).
Each parcel gets an equal share of the balance, split equally between its records; the recipient
is the record's `payout`, or the proposal owner when the record has none. Dust goes to the first
recipient. A proposal Executed by verdict (`verdict_may_execute`) with no accepted parcel has no
records: pass the proposal owner as the only remaining account (writable) and the whole balance
returns to it. Proposals executed by v1 `accept_proposal` have no records but do have accepted
parcels, so they cannot be distributed.

`reclaim_expired_funds()` — accounts `proposal` (mut, `has_one = owner`), `owner` (signer, mut).
Requires status Expired and `sol_balance > 0`; moves the whole balance to the owner and zeroes it.
`cancel_and_refund` stays Active-only, so this is the exit for funds on an expired proposal.

### PDAs and accounts

| Account | Seeds (program) | Fields |
|---|---|---|
| `ConsentTally` | `["consent", proposal, parcel_id]` (proposal_nft) | `proposal, parcel_id (≤32), member, required u8, accepted u8, bump` — 111 bytes |
| `AcceptanceRecord` | `["acceptance", proposal, parcel_id, owner]` (proposal_nft) | `proposal, parcel_id (≤32), owner, member, ownership_attestation, ownership_hash [u8;32] (sha256 of the whole SAS account), payout (default key = none), accepted_at i64, bump` — 245 bytes |
| `VerdictRecord` | `["verdict", proposal, verdict_attestation]` (proposal_nft) | `proposal, member, verdict_attestation, verdict_hash [u8;32] (sha256 of the whole SAS account), verdict u8 (status set: 1 Executed, 3 Expired), settled_at i64, bump` — 146 bytes |
| `Parcel` | `["parcel", parcel_id]` (parcel_nft) | unchanged |
| `Proposal` | `["proposal", counter u64 LE]` (proposal_nft) | unchanged prefix; `verdict_may_execute: bool` appended after `bump`; v3 appends `site_hash [u8;32], open_ground, open_ground_cleared, layout_version u8` |

`verdict_may_execute` lives in the fixed 4096-byte Proposal account after `bump`. proposal_market,
proposal_pledge, `backend/oracle/proposal-lifecycle.js` and `frontend/js/solana/chain-data-loader.js`
decode a prefix that ends at or before `bump` and ignore the rest, so they are unaffected. Existing accounts read it as
`false`: all 38 devnet Proposal accounts were checked on 2026-10-01 and have a zero byte after
`bump` (v1 zero-initialised the 4096 bytes, and no v2 instruction shrinks the account's content).

### SAS layouts the programs read

Verified against sas-lib 1.0.10's generated codecs. Credential: `0 | authority 32 | name (u32 +
bytes) | authorized_signers (u32 + 32 each)`. Schema: `1 | credential 32 | name | description |
layout | field_names | is_paused u8 | version u8`. Attestation: `2 | nonce 32 | credential 32 |
schema 32 | data (u32 + bytes) | signer 32 | expiry i64 | token_account 32`. Payloads are borsh
(strings u32 LE length + utf8, uint8 one byte, int64 LE) and must be consumed exactly:

```
ParcelOwnership-v1:  string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt
ProposalVerdict-v1:  string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt
```

### Localnet tests

`anchor test` loads `tests/fixtures/mock_sas.so` at the SAS program id (`[[test.genesis]]`). It is
a test-only program (source `tests/mock_sas`, its own Cargo workspace) that writes raw bytes into
accounts it owns, so `tests/sas-mock.ts` can lay out credentials, schemas and attestations exactly
as SAS does. Rebuild it with `cargo build-sbf --manifest-path tests/mock_sas/Cargo.toml` and copy
`tests/mock_sas/target/deploy/mock_sas.so` to `tests/fixtures/`. Never deploy it. Tests read the
validator's clock (`chainNow`), never `Date.now()`, because the localnet clock drifts from the host.

## proposal_nft v3, parcel-optional proposals — deployed to devnet; verified 2026-10-02

Design: [`PARCEL-OPTIONAL.md`](../../PARCEL-OPTIONAL.md) (Chain, phase 5) and
[`lens-model.md`](../../lens-model.md) ("proposal_nft v3"). A proposal is about a site; its parcel
list is the site's cadastral binding and may be empty. `idl/proposal_nft.json` is v3;
`idl/legacy/proposal_nft.v2.json` is the v2 interface it replaces (the tx decoder tries v3, v2, v1).

- `Proposal` appends `site_hash: [u8; 32]`, `open_ground: bool`, `open_ground_cleared: bool`,
  `layout_version: u8` after `verdict_may_execute`. Prefix readers (proposal_market, proposal_pledge,
  the lifecycle oracle) are unaffected. v1/v2 accounts hold zero bytes there and read as no site,
  closed ground: their behaviour is exactly v2's (proven against a v2-layout genesis fixture,
  `tests/fixtures/v2-proposal.json`).
- `layout_version` is `PROPOSAL_LAYOUT_VERSION` (3) on every v3 mint and 0 on a v1/v2 account, which
  keeps 0 when the v3 program rewrites it (no instruction but the mint sets it). It is what tells a
  legacy account from a v3 mint without a site, since both hold a zero `site_hash`
  (`backend/oracle/open-ground-audit.js` skips layout 0 as legacy).
- `mint_and_fund(parcel_ids, is_conditional, image_uri, sol_amount, lens, verdict_may_execute,
  site_hash, open_ground)`: an empty `parcel_ids` needs a non-zero `site_hash` (else `NoParcels`) and
  `open_ground` (`EmptyBindingIsOpenGround`); `open_ground` needs a `site_hash` (`OpenGroundNeedsSite`).
  `site_hash` is the sha256 of the canonical site encoding in `frontend/js/proposals/site-hash.js`.
- Execution: by consent ⇔ parcels non-empty ∧ every parcel accepted ∧ (¬open_ground ∨
  open_ground_cleared); an `executed` verdict always needs `verdict_may_execute` (the v2
  `acceptance_count == parcel_ids.len()` alternative, which read 0 == 0 for an empty list, is gone).
  The verdict executes the proposal, except on open ground with parcels, where it sets
  `open_ground_cleared` and the proposal executes at the last acceptance (or at once, if consent was
  already complete). Consent complete on open ground leaves the proposal Active, still open to
  contributions, until that verdict arrives.
- `VerdictRecord.verdict` and the new trailing `VerdictSettled.verdict` say what the verdict said (1
  executed, 3 expired); `VerdictSettled.status` is the proposal's status after the settlement (0 for
  an open-ground clearance).
- Funds: Active → `cancel_and_refund`; Expired → `reclaim_expired_funds`; Executed →
  `distribute_funds` (records of accepted parcels, or the owner when there are none). Every terminal
  state has an exit, tested per path.
- The 4096-byte account always has room: one mint transaction caps the variable data at about 1.1 KB,
  so the proposal plus a full `accepted_parcels` copy stays under about 2.4 KB.

## Build

Requires [Anchor](https://www.anchor-lang.com/) and Rust:

```bash
# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest

# Build
anchor build
```

## Deploy

```bash
# Configure cluster in Anchor.toml (devnet/mainnet)
anchor deploy

# Initialize proposal counter (one-time, after deploy)
# Call proposal_nft::initialize with program authority
```

## Devnet program IDs

| Program | Address | IDL |
|---|---|---|
| `parcel_nft` | `4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1` | [`idl/parcel_nft.json`](idl/parcel_nft.json) |
| `proposal_nft` | `3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg` | [`idl/proposal_nft.json`](idl/proposal_nft.json) |
| `proposal_market` | `GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB` | [`idl/proposal_market.json`](idl/proposal_market.json) |
| `proposal_pledge` | `1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g` | [`idl/proposal_pledge.json`](idl/proposal_pledge.json) |

The same IDs are pinned in `Anchor.toml`, each program's `declare_id!()`, the generated IDLs, and
`frontend/contracts/addresses.json`. Backend contract tests fail when those copies diverge. See
[`docs/protocol.md`](../../docs/protocol.md) for roles, Explorer links, recipe schemas, and trust assumptions.

Current devnet versions are ParcelNFT v2, ProposalMarket v2 and ProposalNFT v3. Earlier transaction
proofs describe the prior v1 behavior and must not be read as proof of lens-based owner consent.

## Program ids and `anchor keys sync` — do NOT run it here

The deploy keypairs of `parcel_nft` and `proposal_nft` are not in this repo (they were generated on
the machine that first deployed to devnet). A fresh `anchor build` therefore generates NEW throwaway
keypairs in `target/deploy/`, and `anchor keys sync` then rewrites `declare_id!` in every program and
`Anchor.toml` to those throwaway ids — which silently breaks the two deployed programs (a localnet
run fails with `DeclaredProgramIdMismatch`, a devnet deploy would create orphan programs). This
happened on 2026-09-16 and was caught by `backend/test/proposal-market-layout.test.js`, which pins
the ids. Set a new program's id by hand from `anchor keys list` instead, and deploy one program at a
time: `anchor deploy --program-name proposal_market --provider.cluster devnet`.

`proposal_market` (`GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB`) reads `proposal_nft` accounts by a
mirrored prefix struct; `idl/proposal_market.json` is the checked-in copy of `target/idl/` after a
build, like the other two. The same program source now also defines `ExternalMarket`, which leaves
the legacy account layout untouched and verifies court-oracle SAS accounts owned by
`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`. That compatible upgrade went live on 2026-09-21;
the first two-sided court-resolved market and its transaction proof are linked from
[`HACKATHON.md`](../../HACKATHON.md#live-external-market-proof).

Run `scripts/external-market-lifecycle.mjs` without arguments for a redacted, read-only validation
of the live SAS evidence. Pass `--live` only when intentionally creating another devnet market and
submitting the low-value two-sided settlement lifecycle. The runner never prints decoded legal
payload fields or a credential-bearing RPC URL.
