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
