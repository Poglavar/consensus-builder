# Test Plan

This document outlines the testing strategy for the Consensus Builder application. The app currently has no automated tests.

## Architecture Overview

| Layer | Stack | Location |
|-------|-------|----------|
| Frontend | Vanilla JS, Leaflet, Turf.js | `frontend/` |
| Backend | Express, PostgreSQL | `backend/` |
| EVM Contracts | Solidity, Hardhat, OpenZeppelin | `blockchain/contracts/` |
| Solana Programs | Anchor, Rust | `blockchain/solana/programs/` |

---

## Layer 1: Smart Contract Tests

Highest value, most critical to get right — bugs here can lose funds.

### EVM (Hardhat + Chai)

Already has tooling in `blockchain/package.json` (`hardhat test`). No test files written yet.

**ProposalNFT.sol**
- Create a proposal (conditional and unconditional variants)
- Fund a proposal with ETH and ERC20
- Accept a proposal as parcel owner
- Withdraw acceptance (conditional proposals only)
- Reject acceptance from non-owner
- Execute a fully-accepted proposal
- Cancel / expire a proposal
- Lens address management

**ParcelNFT.sol**
- Mint a single parcel
- Batch mint parcels
- Prevent double-minting the same parcelId
- Verify tokenId <-> parcelId mapping
- Metadata URI storage

**CityMemeToken.sol / USDT.sol**
- Basic ERC20 mint/transfer/approve

### Solana (Anchor test framework)

Test script configured in `Anchor.toml`. Programs deployed to devnet:
- `parcel_nft`: `4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1`
- `proposal_nft`: `3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg`

**proposal_nft program**
- Initialize proposal counter
- Mint and fund a proposal with SOL
- Contribute additional funds
- Accept proposal as parcel owner
- Withdraw acceptance
- PDA derivation correctness (`[b"parcel", parcel_id]`, proposal counter PDA)

**parcel_nft program**
- Mint a parcel NFT
- Prevent duplicate parcel minting
- PDA ownership and data verification

---

## Layer 2: Backend API Tests

**Tooling:** Vitest + Supertest (add to `backend/package.json`)

Use a dedicated test PostgreSQL database. Seed with fixture data before each suite.

**Proposals routes** (`/proposals`)
- `POST /proposals` — create proposal, verify DB state
- `GET /proposals` — list proposals, filter by city/status
- Accept/reject proposal endpoints
- Validation: missing fields, invalid parcel IDs, duplicate proposals

**Parcels routes** (`/parcels`, `/parcel-*`)
- Fetch parcels by bounding box
- City-specific parcel endpoints
- Parcel metadata retrieval

**Other routes**
- `/health` — returns 200
- `/buildings`, `/streets`, `/government-roads` — return valid GeoJSON
- `/urban-rules`, `/land-uses` — return valid data
- `/city-stats` — aggregated statistics correctness
- Error handling: 404 for unknown routes, 400 for malformed requests

---

## Layer 3: Frontend E2E Tests (Playwright)

**Tooling:** Playwright

Requires backend + frontend running. Mock blockchain interactions (wallet providers, RPC calls) to avoid real chain dependency.

### Priority flows

**1. Proposal creation**
- Select parcels on the map
- Open proposal form, fill details
- Submit proposal
- Verify proposal appears in sidebar list

**2. Proposal viewing**
- Open an existing proposal
- Verify parcel highlighting on map
- Verify acceptance status display
- Verify proposal metadata (image, description, funding)

**3. Proposal acceptance**
- Connect wallet (mock provider)
- Own a parcel included in a proposal
- Accept the proposal
- Verify acceptance state updates in UI

**4. Wallet connection**
- Connect EVM wallet (MetaMask mock)
- Connect Solana wallet (Phantom mock)
- Switch between wallets
- Verify currency display changes (ETH <-> SOL)
- Auto-reconnect on page reload

**5. Map interaction**
- Pan and zoom
- Parcels load as tiles come into view
- Click parcel, verify info panel opens
- Parcel selection/deselection

**6. Game mode**
- Start a new game
- Advance turns
- Verify agent actions generate proposals
- Verify game log entries

---

## Layer 4: Frontend Unit Tests

**Tooling:** Vitest

Target pure logic that can be tested without DOM or network. Will require extracting some logic into importable modules (currently loaded as global scripts).

**Candidates:**
- Coordinate transformations (proj4 wrappers)
- Parcel grid spatial indexing
- Proposal state calculations (acceptance percentage, status derivation)
- Currency formatting and ETH/SOL display logic
- i18n string resolution
- Borsh encoding/decoding helpers (Solana)
- PDA derivation utilities

---

## What we skip (for now)

- **Visual regression testing** — overkill given the current stage
- **Load/stress testing** — backend traffic is low
- **Full E2E with real chains** — use local nodes (Hardhat, solana-test-validator) or mocks instead
- **Accessibility testing** — can add later

---

## Implementation order

1. **Solana program tests** — newest code, highest risk, Anchor has built-in test support
2. **EVM contract tests** — extend existing Hardhat setup, write test files in `blockchain/test/`
3. **Backend API tests** — fast to write with Supertest, good regression coverage
4. **Frontend Playwright tests** — most setup effort, but covers the user-facing flows
5. **Frontend unit tests** — requires refactoring globals into modules, do incrementally
