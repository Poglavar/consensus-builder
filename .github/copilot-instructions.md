# Copilot Instructions for `consensus-builder`

## Architecture overview

- Thin Express/PostGIS backend in `backend/index.js` supplies `/parcels`, `/buildings`, and `/planned-road` in EPSG:3765, while the Leaflet front-end lives in `frontend/` as a static single page (`index.html`).
- The front-end is split across many plain ES5 scripts loaded in order near the end of `index.html`; each file attaches functions to `window.*` for cross-module access. Adding a new script usually means appending another `<script>` tag and exporting globals explicitly.
- Geometry work relies on Leaflet, Turf.js, and Proj4. `map-core.js` bootstraps the map, handles coordinate conversions between HTRS96/TM (EPSG:3765) and WGS84, debounces parcel fetches, and raises custom DOM events (`parcelDataLoaded`, `buildingsLayerUpdated`).

## Parcel data flow & persistence

- `parcels.js` orchestrates parcel fetching in 500 m grid cells, using `data-source.js` to choose between OSS WFS and the backend. Respect the zoom guard (`isZoomWithinParcelRange`) before triggering `fetchParcelData`.
- Local state is merged from multiple sources: server GeoJSON, cached `parcelCache.grid`, and edits persisted under `parcel_${CESTICA_ID}_*` keys in `localStorage`. Modified parcels are tracked via `modified_parcels`; when creating new parcels/roads be sure to update these stores.
- After fetch, features are converted to WGS84 via `convertGeoJSON`, rendered into `parcelLayer`, and styling is controlled by `getParcelBaseStyle` plus proposal or road flags. Any cross-module updates should listen for `parcelDataLoaded` instead of patching `fetchParcelData`.

## Proposals, structures, and roads

- `proposals.js` is the authoritative proposal registry (`proposalStorage`). Each proposal gets a deterministic `proposalHash`, tracks dependencies, and serialises to `localStorage`. Reuse its helpers (`addProposal`, `updateProposalStatus`, `getProposalsForParcel`) rather than rolling custom storage.
- `proposal-manager.js` handles the heavy geometry lifting for road proposals: it splits parent parcels, assigns new `BROJ_CESTICE`/`CESTICA_ID` values, and builds child features. If you alter parcel geometry rules (numbering, parent tracking) keep `_computeExistingMaxSubnumber`, `_geometryHash`, and the number allocator logic in sync.
- `structures.js` manages park/square proposals with pre-generated decorations, stored under `cb_parks` / `cb_squares`. It emits Leaflet layers (`parksLayer`, `squaresLayer`) and relies on Turf for randomised ornamentation.
- Manual road drawing, road detection, and analysis live in `road-drawing.js`, `road-detection.js`, and `road-analysis.js`; they expect `ProposalManager` and `proposalStorage` to stay in charge of persistence.

## Government road plans

- `plan.js` ships a catalog (`window.government_plans`) of plan metadata. `government-roads.js` picks the best-matching plan for the current view, fetches GeoJSON (catalog or backend), subtracts existing roads (union of parcels flagged by `isRoad`), and renders the remainder as a dashed overlay. Keep subtraction logic (`subtractExistingRoadsFromCollection`) intact when changing parcel/road tagging.

## Agents, gameplay, and user-as-agent

- `user-management.js`, `agents.js`, and `game.js` turn the user into an agent, track avatars, and drive the turn-based simulation. Agent data is persisted with `agentStorage`, parcel ownership lives in `parcel_${id}_owner`, and notifications for unseen proposals are maintained via `userNotifications`.
- The game loop (`game.js`) updates UI via `gameState.updateGameUI`, writes to `consensus_game_state`, and triggers agent actions. Guard any new async behaviour so it respects `gameState.isRunning` and the Play/Pause controls.

## Backend expectations

- The backend assumes PostGIS tables `parcel`, `building`, and `planned_road` with `geom` in SRID 3765 plus metadata columns (`current`, `is_road`, `category`, etc.). `/planned-road` unions existing roads via `getExistingRoadUnion` to avoid duplicating current infrastructure before returning plan polygons.
- Run the stack with Docker (`docker-compose up`) or locally: `npm install && npm run dev` in `backend/` (uses nodemon), and serve `frontend/` via any static file server (`npm install -g serve && serve frontend`).

## Working conventions

- Reuse `updateStatus` for user-facing progress, and prefer raising DOM `CustomEvent`s for cross-module coordination instead of direct calls (e.g., listen for `parcelDataLoaded`, `buildingsLayerUpdated`).
- When touching CSS, note that `index.css` holds most styling; follow existing BEM-ish class names and consider future extraction into topic-specific files.
- Geometry arrays are expected in WGS84 `[[lng, lat], ...]` inside GeoJSON; only raw data storage (`parcel_*_geometry`) stays in HTRS96. Conversions happen through `convertGeoJSON`, `htrs96ToWGS84`, and `wgs84ToHTRS96` helpers.
- New button actions should slot into the sidebar accordion structure (`sidebar-management.js`) and respect the enable/disable guards that depend on selection or zoom.

## External services & credentials

- Default OSS WFS access uses a baked-in demo token in `data-source.js`; switch to `localhost` to consume the Express API, or `api.urbangametheory.xyz` (stub) in production.
- Pay attention to retry logic: `fetchWithRetry` (parcels) and `government-roads.js` both debounce network calls. Honour these utilities to keep the UI responsive.
