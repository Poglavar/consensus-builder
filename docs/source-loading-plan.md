# Source loading plan: buildings on the parcel grid, independent sources, 3D panning

Open plan. Buildings and other scene layers move to the cell-based loading parcels already use, every
source loads and fails on its own, and the 3D scene stops being one snapshot around a centre. The
status table at the end is kept current as steps land; evidence goes in commits and tests.

## Current state

**Parcels (keep).** The city defines a grid of square cells in its metric CRS (`parcels.gridSize`,
500 m unless configured; live ArcGIS and similar sources are capped at 100 m, `city-config.js`).
`getRequiredGridCells` (`frontend/js/parcels/storage.js`) names the cells under a view; the
repository (`frontend/js/parcels/ground-service.js`, `ensureBounds`) asks for one cell per request,
six in flight, commits each cell to the live fabric as its own mutation, and caches by cell key, so
ground already loaded is never asked for again. This is the model everything else adopts.

**Source adapters (server).** `backend/parcels/*-source.js` know how to query one kind of service
(ArcGIS, WFS, OGC API, Socrata, GeoJSON, vector tiles); `createParcelSource` in
`backend/parcels/sources.js` picks one from a descriptor ([source adapters](source-adapters.md)).
Limits are per descriptor: the ArcGIS defaults are 2,000 per page, 10,000 features and 25 km²
(`arcgis-source.js`); every user-chosen `building.`/`parcel.` source is set to 250 per page, 5,000
features and 1 km² (`custom-source-config.js`). `withSourceControls` (`source-controls.js`) adds a
per-source cooldown of 30 s (60 s when blocked) on `parcel-source-blocked`, `-rate-limited` and
`-unavailable`, and a per-source concurrency budget. Every adapter raises its "too many features /
use a smaller area / incomplete pagination" errors through `upstreamError`, whose default code is
`parcel-source-unavailable`: an area-limit error starts the outage cooldown (38 sites in 17 files).

**Buildings (change).** Four endpoints answer by geometry, not by cell: `/buildings/near` (the 3D
scene, one radius `buildingLoadRadiusM` around a centre, 300 m unless the slider moves it),
`/buildings/footprints` (the 2D pool, the viewport box padded, merged by id into
`window.buildingFeaturePool` up to 12,000 with a list of covered rectangles, `map-core.js`
`fetchBuildings`), `/buildings/under` (demolition scans) and `/buildings/carve`. The city building
provider for a custom source (`backend/buildings/custom-source-3d.js`) shrinks a box to 950 m and
reads it in 320 m tiles; `building-source-client.js` swaps a failed or empty city answer for
OpenStreetMap when the city configures that fallback. X-ray's typical layouts ask the pool to cover
the 3D radius once. All of this is superseded below.

**3D scene.** Entering 3D builds one snapshot for the radius: existing and proposed buildings,
flat parcels, trees, water, green, ground and roads, people and traffic, shadows and planning
overlays. Moving the radius slider rebuilds it. The camera can move within the snapshot; ground
outside it is empty.

## Decisions

User decisions, 2026-10-30:

- Load what will be displayed, and do not display too much. The screen decides how many buildings
  load; the per-source feature and area limits become a safety net, not something normal use meets.
- Buildings adopt the parcel cell grid rather than a tile scheme of their own.
- Parcels are not reworked. The only parcel-side change is the error classification in step A.
- Each source loads and displays independently; an error in one never degrades another.
- 3D free panning comes in steps (E), after the cell grid exists, and only as far as it proves
  worth it.

## Steps

### A. Area-limit errors get their own code

Add `parcel-source-area-limit` (status 422) to `backend/parcels/source-contract.js` and use it at
every "too many features / use a smaller area / incomplete pagination" site through one shared
helper. `COOLDOWN_CODES` keeps blocked, rate-limited and unavailable; an area-limit error is answered
at once and never cools the source down. `unavailableFrom` and the routes pass the new code through
as `truncated: true` without `unavailable`. Parcel reads are unchanged in what they return; the
existing parcel tests (`live-parcel-fabric`, `parcel-mutation`, `parcel-presenter-atomic`) and the
per-adapter tests cover that nothing else moved.

### B. Buildings on the parcel grid

- **Server.** `/buildings/cell` answers one cell of the city grid (`city`, `gridE,gridN` key, the
  cell's box, `source`), in the same shape `/buildings/footprints` uses, with the building's height
  fields, cached per source and cell. A cell over the source's limit is split into its four
  quarters server-side, so no city needs a hand-tuned tile size. `/buildings/near` and
  `/buildings/footprints` become readers of cells; `fitBox`, the 320 m tiling and the
  padded-box shrink in `custom-source-3d.js` go.
- **Browser.** One building loader (`frontend/js/buildings/cell-loader.js`, a pure module) owns the
  per-cell cache, the in-flight set, nearest-first ordering around a point, a concurrency of six,
  and a `k of N` progress figure. The 2D pool is keyed by cells instead of covered rectangles;
  `ensureBuildingFootprintsForBounds` becomes "ensure these cells". The 3D scene gets one group per
  cell, so a cell that lands is added without rebuilding the rest, and a demolition carve touches
  only the cell groups it intersects.
- **Completeness loads stay separate.** Demolition checks, corridor building detection and X-ray's
  typical layouts must see every building in their own area whatever is on screen; they ensure the
  cells under their geometry through the same loader and are never limited by the display budget.

### C. A view budget

The screen decides what loads, starting values measured on the laptop and a phone before they are
fixed:

- **3D.** Cells inside the camera's view out to about 500 m, nearest first; cells behind the
  camera or beyond the distance are not loaded. Near cells draw full buildings; far cells draw
  simple extrusions; beyond the distance nothing. The radius slider becomes this distance.
- **2D.** Individual buildings from about zoom 16; below it, no footprints (the parcel layer
  already behaves this way for small parcels).

### D. Sources independent in the browser

The server already isolates sources: cooldown and concurrency are per source. The browser has shared
gates, each replaced by per-layer state:

| Shared gate today | Replacement |
|---|---|
| `serverAnswerIsEmpty` in `building-source-client.js` swaps a failed, empty or truncated city answer for OpenStreetMap, mixing identities in one pool | A city source answers from its own cells or reports its own failure; the OSM fallback applies only when the city has no source of its own, never as a repair of a failed one |
| `getSceneReadiness({ requireExisting })` in `three-mode.js` holds the 3D scene as not ready while existing buildings have not loaded | Readiness is per layer; the scene is ready when its own geometry is, and each layer reports loading, loaded, partial or failed on its own |
| `reportBuildingsUnavailable` routes building failures into `ParcelSourceSettings.reportFailure`, one banner for parcels and buildings | One status line per layer in the Layers panel (parcels, buildings, trees, water, roads, planning), each with its own Retry; the banner stays for parcels only |
| `buildingsRetryAt` in `map-core.js` stops every building fetch for the upstream's retry time | The back-off lives in the cell loader, per source, and other layers never read it |

Rule for new code: a layer owns its loading, its failure state and its place in the status display;
a failure shows in that layer only, with its own retry, while the others load and draw as usual.

### E. 3D panning, in order

1. **Cells with a view budget** (B and C): the prerequisite, since streaming needs the same cells,
   ordering and per-cell groups.
2. **Re-centre on demand.** When the camera target drifts past the loaded distance, rebuild around
   the new centre, keeping the camera, nearest cells first, the old scene visible until replaced.
   Automatic first; a "Load here" button if automatic proves distracting.
3. **Full streaming with eviction** only if step 2 feels clunky in use. By then every layer is
   cell-based; what remains is eviction of far cells and the features that assume a stable scene
   (click stack, compare split, isolation, build-out timeline, X-ray) coping with cells appearing
   and disappearing.

### Removed when superseded

The 950 m `fitBox`, the 320 m tiling and the keep-truncated-footprints rule in
`building-source-client.js` (all 2026-10-30 stopgaps), the pool's covered-rectangle list and its
12,000 cap, X-ray's one-off radius request, `buildingsRetryAt`.

## Status

| Step | State |
|---|---|
| A. Area-limit error code | open |
| B. Buildings on the parcel grid | open |
| C. View budget | open |
| D. Sources independent in the browser | open |
| E1. Cells with a view budget | open (same as B and C) |
| E2. Re-centre on demand | open |
| E3. Streaming with eviction | not started; decided after E2 |
