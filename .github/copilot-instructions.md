# Copilot Instructions for `consensus-builder`

- **Scope**: Thin Express/PostGIS backend (`backend/`), static Leaflet front-end (`frontend/`), and Solidity NFTs (`blockchain/`) on branch `add-blockchain`.

## Runbook

- `docker-compose up` launches nginx frontend (8080), API (3000), and PostGIS (`my-postgis:16-3.5-arm64`); bind mounts keep live reload.
- Backend dev loop: `cd backend && npm install && npm run dev`; relies on `.env` or docker defaults for PG connection and expects tables `parcel`, `building`, `planned_road`, `cadastral_municipality`.
- Frontend runs as plain static files; serve via `npx serve frontend` or any static host to avoid `file://` Worker restrictions.

## Frontend patterns

- for localized projects that use i18n, whenever adding a new string add it in a way that conforms to the i18n patterns, and also add a spanish translation for the string in the appropriate json file.
- `frontend/index.html` loads ES5 scripts sequentially; each module attaches to `window.*`. Add new logic by appending a `<script>` tag and exporting globals explicitly.
- `map-core.js` initializes Leaflet, performs HTRS96↔WGS84 conversions (`proj4`), throttles parcel fetches to zoom 17–19, and emits `parcelDataLoaded` / `buildingsLayerUpdated`.
- Parcel flow (`parcels.js`): choose data source via `data-source.js`, fetch in 500 m grid cells, merge server GeoJSON with `parcelCache.grid` and `localStorage` (`parcel_${CESTICA_ID}_*`, `modified_parcels`), then style `window.parcelLayer`.
- Proposals & roads: `proposal-manager.js` synthesizes child parcels using `_computeExistingMaxSubnumber`; `proposals.js` persists to `proposalStorage` and exposes helpers (`addProposal`, `updateProposalStatus`). Road tooling (`road-drawing.js`, `road-detection.js`, `road-analysis.js`) expects ProposalManager to own persistence.
- UI state persists through `PersistentStorage`; wait for `PersistentStorage.ready` before touching storage-backed modules. Reuse `updateStatus` for sidebar status and listen for existing DOM events instead of direct module calls.
- Do not run any tests for frontend and don't report that you have not run them either.
- Do not use !important in CSS, always find the root cause of the issue and fix it properly.

## Backend patterns

- Routes in `backend/routes/*.js` export `setup*Route(app, pool)` and return GeoJSON with consistent property casing. `/parcels` accepts exactly one of `bbox`, `coordinates`, or `parcel_number` and handles WGS84→3765 transforms server-side.
- `planned-roads.js` unions existing roads via `getExistingRoadUnion` before serving plans; keep subtraction logic intact when adjusting road tagging.
- `routes/docs.js` renders markdown from `routes/docs.md` using `marked` for API self-documentation.

## Blockchain additions

- Solidity contracts live in `blockchain/` and rely on OpenZeppelin. `ParcelNFT` mints OSM/parcel IDs as ERC721 tokenIds and prevents reuse; `ProposalNFT` links parcel IDs, tracks acceptances, and manages ETH/ERC20 balances (`cityToken` plus optional ERC20 via address parameter).
- `blockchain/TODO-blockchain.txt` defines current goals: mint parcel NFTs when parcel data loads, assign owners from a configured wallet list, surface ownership in UI (`My parcels`, parcel cards), and let proposal NFTs collect/redistribute funds (`acceptProposal`, `distributeFunds`). Integrate via existing proposal/parcels storage rather than creating parallel state.

## Cross-component coordination

- Initialization order (see bottom of `frontend/index.html`): persistent storage → versioning → environment → map → user management → sidebar → game. Maintain dependency order when inserting new scripts.
- Custom events (`parcelDataLoaded`, `buildingsLayerUpdated`, worker messages from `government-plan-worker.js`) are the supported extension points; dispatch new `CustomEvent`s for cross-module updates.
- Game loop in `game.js` drives agent actions through `gameState`; guard async work with `gameState.isRunning` and respect Play/Pause buttons.

## Data & styling conventions

- GeoJSON exposed to UI must be WGS84 `[lng, lat]`; only raw geometry caches remain in HTRS96 (`parcel_*_geometry`). Use `convertGeoJSON`, `htrs96ToWGS84`, and `wgs84ToHTRS96` helpers to convert.
- Sidebar UI follows `index.css` BEM-ish naming with accordion toggles and enable/disable guards. Add wallet/proposal controls within existing panels rather than new modals unless necessary.

Let me know if any section needs deeper detail or concrete flow diagrams.
