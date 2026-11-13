#!/usr/bin/env bash
# Dumps the Metaplex Core program from devnet into tests/fixtures/mpl_core.so, which Anchor.toml
# loads at genesis for the ugt record tests (the file is gitignored). Run from blockchain/solana.
set -euo pipefail
cd "$(dirname "$0")"
solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so -u devnet
ls -la mpl_core.so
