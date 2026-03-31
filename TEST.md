# Test Plan

This document outlines the current automated test coverage and the remaining testing strategy for the Consensus Builder application.

## Architecture Overview

| Layer           | Stack                           | Location                      |
| --------------- | ------------------------------- | ----------------------------- |
| Frontend        | Vanilla JS, Leaflet, Turf.js    | `frontend/`                   |
| Backend         | Express, PostgreSQL             | `backend/`                    |
| EVM Contracts   | Solidity, Hardhat, OpenZeppelin | `blockchain/contracts/`       |
| Solana Programs | Anchor, Rust                    | `blockchain/solana/programs/` |

---

## Current Automated Coverage

### Backend API

Tooling: Vitest + Supertest in `backend/`

Current coverage:

- `backend/test/proposals.test.js` covers 14 proposal route tests
- proposal creation success and DB error handling
- duplicate `proposal_id` conflict handling
- city code normalization
- alternate proposal id field resolution
- proposal fetch, HEAD metadata, count, summary, and parcel containment queries

Run with:

- `cd backend && npm test`
- `cd backend && npm run smoke:prod:parcels` for a read-only production smoke check of `/health` and `/parcels?bbox=...`

### EVM Contracts

Tooling: Foundry in `blockchain/`

Current coverage:

- existing Foundry suite plus `forge-test/ProposalFlows.t.sol`
- proposal acceptance, withdrawal, contribution, expiry/cancellation, and fund distribution flows

Run with:

- `cd blockchain && forge test`

### Solana Programs

Tooling: Anchor + TypeScript tests in `blockchain/solana/`

Current coverage:

- `tests/parcel_nft.ts`
- `tests/proposal_nft.ts`
- parcel minting, proposal creation, acceptance, withdrawal, and SOL contribution flows

Run with:

- `cd blockchain/solana && yarn test`

### Frontend E2E

Tooling: Playwright in `e2e/`

Current coverage (107 tests across 24 spec files, 91 passing / 16 skipped):

Core (14 files):
- `smoke.spec.ts` — app loads without critical JS errors, map visible, globals initialized, no 5xx
- `map-navigation.spec.ts` — basemap tiles, zoom in/out, pan, parcel fetch at zoom ≥17
- `city-switching.spec.ts` — default city, city API, setCurrentCityId event dispatch, persistence
- `parcels.spec.ts` — parcel loading, polygon rendering, click interaction
- `parcel-selection.spec.ts` — ownership highlighting, classification functions
- `proposals-create.spec.ts` — ProposalManager init, programmatic creation, storage functions
- `proposals-lifecycle.spec.ts` — apply/unapply functions, PersistentStorage round-trip
- `proposals-sharing.spec.ts` — sharing utilities, base64 round-trip, escapeHtml, backend URL
- `road-tools.spec.ts` — lineIntersection, isPointInPolygon, road detection module
- `i18n.spec.ts` — language switching (en/es/sr/hr), persistence, translation function
- `sidebar.spec.ts` — sidebar element, toggle button, toggling, init function
- `wallet.spec.ts` — wallet module loaded, mock EVM provider, Solana web3 library
- `data-source.spec.ts` — data source functions, default resolution, storage
- `3d-mode.spec.ts` — Three.js loaded, 3D functions, scene creation

Extended (10 files):
- `share-roundtrip.spec.ts` — base64url encode/decode, compress/inflate, full payload round-trip, deepClone, buildCityQueryParam
- `persistent-storage.spec.ts` — IndexedDB set/get, JSON round-trip, removeItem, forEach, length, reload persistence
- `deep-links.spec.ts` — ?city= params for all cities, invalid param fallback, stored preference override
- `game-mode.spec.ts` — gameState, control functions, save/load round-trip, executeGameTurn
- `multi-city.spec.ts` — all 6 cities available, per-city config validation, distinct centers, backend URL resolution
- `area-monitor.spec.ts` — Draw/Map/UI/Routing modules, drawing activation, event dispatch
- `measurement.spec.ts` — measureMode flag, toggle on/off, clearAllMeasurements
- `reparcellization.spec.ts` — ProposalManager, ensureParcelId format, ID input handling
- `gov-roads.spec.ts` — worker functions, CustomEvent dispatch, Web Worker API
- `reload-persistence.spec.ts` — proposals, city, and language survive browser reload

Run with:

- `cd e2e && npm test` (uses `npx serve` for static frontend, or reuses running server)
- `cd e2e && npm run test:headed` (visible browser)
- `cd e2e && npm run test:smoke` (smoke tests only)
- `cd e2e && npm run test:core` (core tests only)
- `cd e2e && npm run test:features` (feature tests only)

Recent gap coverage added:

- `e2e/tests/area-monitor.spec.ts` now also verifies the area monitor detail panel DOM and list modal behavior against mocked `/area-monitors` API responses
- `backend/scripts/smoke-production-bbox.mjs` checks live production `/parcels?bbox=...` response shape, CORS header presence, sequential timings, and a small concurrent burst

---

## Layer 1: Smart Contract Tests

Highest value, most critical to get right — bugs here can lose funds.

### EVM (Hardhat + Chai)

Hardhat tooling still exists in `blockchain/package.json` (`hardhat test`), but the active contract regression coverage currently lives in Foundry.

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

Test script is configured in `Anchor.toml` and branch-local tests now exist under `blockchain/solana/tests/`. Programs deployed to devnet:

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

**Tooling:** Vitest + Supertest in `backend/package.json`

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

1. **Frontend Playwright tests** — most setup effort, but covers the user-facing flows
2. **Frontend unit tests** — requires refactoring globals into modules, do incrementally
3. **Expand backend API coverage** — proposals are covered first; add parcels and supporting routes next
4. **Expand EVM coverage if Hardhat remains in use** — otherwise keep Foundry as the primary Solidity test runner
5. **Expand Solana program coverage** — keep adding state-transition and failure-path tests as programs evolve
