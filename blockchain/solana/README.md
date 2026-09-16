# Urban Game Theory - Solana Programs

Solana equivalents of the EVM ParcelNFT and ProposalNFT contracts.

## Programs

- **parcel_nft**: Mints parcel representations as on-chain certificates (PDA-based)
- **proposal_nft**: Proposals for parcel development with SOL funding and acceptance flow

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

## Program IDs

Update `Anchor.toml` and `declare_id!()` in each program after first deploy to use the actual program IDs.

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
build, like the other two.
