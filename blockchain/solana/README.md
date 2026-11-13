# Urban Game Theory - Solana Programs

Solana programs of the chain contracts ([`docs/blockchain-flows.md`](../../docs/blockchain-flows.md),
"Chain contracts"); the EVM counterparts are in `../contracts/`.

## Programs

- **ugt** (devnet `95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9`): ownerless parcel anchors, design
  and plan records (each with a soulbound Metaplex Core asset minted to the publisher) and
  agreements (a SOL escrow settled by the lens's AgreementDecision-v1 attestation). Replaces
  `parcel_nft`, `agreement` and `proposal_nft`. See [`programs/ugt/README.md`](programs/ugt/README.md).
- **proposal_market**: parimutuel and LMSR markets on an agreement's terminal state (Executed YES;
  Cancelled or Expired NO, LMSR kind 0 Cancelled VOID), and external markets resolved from SAS
  evidence, optionally bound to an agreement's lens
- **proposal_pledge**: USDC donations and soft pledges on an agreement; its authority (the sponsor)
  is the beneficiary
- The market and pledge programs read ugt Agreement accounts through `ugt::read_agreement_view`
  (owner, discriminator, status at byte 136). They keep their names, ids and the `proposal` account
  and field names; that word names the agreement account.
- **crates/sas_attestation**: byte-level SAS account readers shared by ugt and proposal_market (not
  a program)

The devnet deployments of `proposal_market` and `proposal_pledge` still run the build that reads
the retired `agreement` program (`GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ`), which keeps its
accounts and keeps working for the app on `main`. They are upgraded in place to the ugt-reading build
when this branch is deployed (blockchain-flows.md, R2).

### SAS layouts the programs read

Verified against sas-lib 1.0.10's generated codecs. Credential: `0 | authority 32 | name (u32 +
bytes) | authorized_signers (u32 + 32 each)`. Schema: `1 | credential 32 | name | description |
layout | field_names | is_paused u8 | version u8`. Attestation: `2 | nonce 32 | credential 32 |
schema 32 | data (u32 + bytes) | signer 32 | expiry i64 | token_account 32`. Payloads are borsh
(strings u32 LE length + utf8, uint8 one byte, int64 LE) and must be consumed exactly:

```
AgreementDecision-v1: string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt
MarketEvidence-v1:   string recipeHash, string subject, string value, int64 eventTime, int64 sourceObservedAt, string sourceRef
```

`MarketEvidence-v1` settles proposal_market's recipe-bound LMSR markets (`../../lmsr-market.md`):
`recipeHash` is `sha256:` plus the recipe digest in lowercase hex and must equal the market's
`recipe_hash`; `subject` and `value` are hashed against its committed subject and outcome hashes.

### Localnet tests

`anchor test` loads `tests/fixtures/mock_sas.so` at the SAS program id (`[[test.genesis]]`). It is
a test-only program (source `tests/mock_sas`, its own Cargo workspace) that writes raw bytes into
accounts it owns, so `tests/sas-mock.ts` can lay out credentials, schemas and attestations exactly
as SAS does. Rebuild it with `cargo build-sbf --manifest-path tests/mock_sas/Cargo.toml` and copy
`tests/mock_sas/target/deploy/mock_sas.so` to `tests/fixtures/`. Never deploy it. Tests read the
validator's clock (`chainNow`), never `Date.now()`, because the localnet clock drifts from the host.

`tests/ugt-agreement.ts` covers ugt's agreements and `tests/ugt-anchors-records.ts` its anchors and
records; Metaplex Core is loaded at genesis from `tests/fixtures/mpl_core.so` (gitignored, fetched
from devnet by `tests/fixtures/fetch-mpl-core.sh`). `tests/agreement-helpers.ts` creates, funds,
attests (an AgreementDecision-v1 attestation written through the mock SAS), executes, cancels and
expires agreements, for that suite and for the market and pledge suites, whose subject has been an
agreement since M3. Their Expired agreements are expired live by `expire` once a short deadline has
passed on the validator clock, so the pledge suite's only genesis fixture is the devnet USDC mint
(`tests/fixtures/generate-pledge-fixtures.mjs`).

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

Build with `anchor build`, which builds one program per cargo invocation. `proposal_market` and
`proposal_pledge` depend on the `ugt` crate with its `no-entrypoint` feature (they read its id and
Agreement layout), so a single `cargo build-sbf` over the whole workspace would unify that feature
into the `ugt` build itself and produce a `ugt.so` without an entrypoint.

## Deploy

One program at a time, with its keypair from `~/.config/solana/program-keys/`:

```bash
solana program deploy target/deploy/ugt.so --program-id ~/.config/solana/program-keys/ugt.json -u devnet
```

## Devnet program IDs

| Program | Address | IDL |
|---|---|---|
| `ugt` | `95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9` | [`idl/ugt.json`](idl/ugt.json) |
| `proposal_market` | `GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB` | [`idl/proposal_market.json`](idl/proposal_market.json) |
| `proposal_pledge` | `1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g` | [`idl/proposal_pledge.json`](idl/proposal_pledge.json) |

The same IDs are pinned in `Anchor.toml`, each program's `declare_id!()`, the generated IDLs, and
`frontend/contracts/addresses.json`. Backend contract tests fail when those copies diverge. See
[`docs/protocol.md`](../../docs/protocol.md) for roles, Explorer links, recipe schemas, and trust assumptions.

## Program ids and `anchor keys sync` — do NOT run it here

The deploy keypairs are not in this repo (they live in `~/.config/solana/program-keys/` on the
deploying machine). A fresh `anchor build` therefore generates NEW throwaway keypairs in
`target/deploy/` for programs whose keypair is not copied there, and `anchor keys sync` then rewrites
`declare_id!` in every program and `Anchor.toml` to those throwaway ids — which silently breaks the
deployed programs (a localnet
run fails with `DeclaredProgramIdMismatch`, a devnet deploy would create orphan programs). This
happened on 2026-09-16 and was caught by `backend/test/proposal-market-layout.test.js`, which pins
the ids. Set a new program's id by hand from `anchor keys list` instead, and deploy one program at a
time: `anchor deploy --program-name proposal_market --provider.cluster devnet`.

`proposal_market` (`GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB`) read `proposal_nft` accounts by a
mirrored prefix struct until 2026-10-22; its source now reads ugt Agreement accounts (see Programs);
`idl/proposal_market.json` is the checked-in copy of `target/idl/` after a build, like the others. The same program source now also defines `ExternalMarket`, which leaves
the legacy account layout untouched and verifies court-oracle SAS accounts owned by
`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`. That compatible upgrade went live on 2026-09-21;
the first two-sided court-resolved market and its transaction proof are linked from
[`HACKATHON.md`](../../docs/HACKATHON.md#live-external-market-proof).

Run `scripts/external-market-lifecycle.mjs` without arguments for a redacted, read-only validation
of the live SAS evidence. Pass `--live` only when intentionally creating another devnet market and
submitting the low-value two-sided settlement lifecycle. The runner never prints decoded legal
payload fields or a credential-bearing RPC URL.
