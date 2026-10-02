# Test Plan

This document records current automated coverage and the remaining verification boundaries for the Consensus Builder application.

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

Current audited results:

- **Fast suite:** 6,366 passed, 6 skipped. This count is from the complete fast test run recorded for
  this revision; use the commands below to rerun it.
- **Headed browser coverage:** 253 distinct collected cases across 64 spec files. The full headed
  run passed 250/250 cases; 30 affected checks across focused headed runs passed the added circle, SEO, and
  localization flows. Those runs overlap, so do not add their pass counts as unique tests.
- **Feature inventory:** 99 UI command IDs are mapped to specs in `e2e/feature-inventory.json`.
  The inventory checker verifies that the registry and index agree; it does not establish that a
  command works. Only behavioral assertions in a passing headed run provide that evidence.
- **Recent regressions:** real map/layer controls and dataset actions; parcel and proposal journeys;
  proposal editor and readjustment controls; road/area-monitor workflows; 3D, photo and walking
  controls; search, localization, responsive map UI, SEO publication metadata, and persistence.

The browser suite uses Playwright with local frontend serving and fixture-backed API responses. It
checks user actions and observable UI, map-layer, storage, geometry, and request effects. Fixture
responses do not prove that live production APIs or datasets return the same content. Wallet/RPC
providers are mocked for browser coverage, so these tests do not verify real wallet signing, RPC
availability, or live devnet transaction completion. Refer to the blockchain test sections and
`docs/hackathon-build.md` for the separate local-validator and explicitly opt-in live transaction
paths.

Run with:

- `cd backend && npm test` (fast backend and frontend characterization suite)
- `cd e2e && npm test` (headless Playwright; configured local frontend/API fixtures)
- `cd e2e && npm run test:headed` (headed Playwright)
- `cd e2e && npm run check:features` (check 99 command IDs are represented in the feature inventory)
- `cd e2e && npm run test:smoke` (smoke tests only)
- `cd e2e && npm run test:core` (core tests only)
- `cd e2e && npm run test:features` (feature tests only)

The e2e spec directory is the current coverage index; the old pre-redesign spec list has been
removed because its filenames and assertions no longer match the suite. For live read-only parcel
API smoke coverage, `backend/scripts/smoke-production-bbox.mjs` checks the production
`/parcels?bbox=...` response shape, CORS header, timings, and a small concurrent burst. That single
smoke check does not replace fixture-backed UI coverage or establish broad production API parity.

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

### Remaining verification priorities

The headed suite now covers these flows against deterministic local fixtures. The following are
still distinct live/integration gaps; do not infer their completion from UI coverage:

**1. Proposal creation**

- Select parcels on the map
- Open proposal form, fill details
- Submit proposal
- Verify proposal appears in the proposals list (Proposals button, bottom right)

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

## Deliberate limits and outstanding coverage

- **Visual regression testing** — overkill given the current stage
- **Load/stress testing** — backend traffic is low
- **Full E2E with real chains** — browser specs mock wallet providers and RPC. Use local nodes
  (`solana-test-validator`, or Hardhat if retained) for contract integration, and the documented
  explicitly opted-in devnet path only when live transaction verification is intended.
- **Accessibility testing** — can add later

---

## Implementation order

1. **Production API parity** — add read-only live checks for critical endpoints beyond parcel bbox,
   while keeping fixture-backed UI tests deterministic.
2. **Opt-in wallet/RPC integration** — verify one real, low-value devnet transaction lifecycle
   separately from browser tests that use mocked providers.
3. **Review skipped cases** — document their prerequisites or restore the relevant runtime coverage.
4. **Pure frontend logic** — extract and test browser-global calculations incrementally where the
   current characterization tests still depend on DOM or script globals.
5. **Contract state transitions** — keep Foundry and Anchor tests aligned with deployed program
   behavior; retain Hardhat only if that toolchain remains active.
