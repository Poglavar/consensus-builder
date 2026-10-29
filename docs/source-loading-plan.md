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
- Fallback sources stay, declared in city config as an ordered list and resolved per cell in one
  place, with the stand-in said in the layer status; no ad-hoc fallback branches in code.
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

- **Server.** `POST /buildings/cell` (`backend/routes/buildings.js`) answers one building cell
  (`kind: 'near'` for 3D records or `'footprints'` for the 2D pool, `bbox`, `source`) from one named
  source, cached per source, kind and cell for 15 minutes. `backend/buildings/split-read.js` reads a
  box whole or, while the source says it is capped (an area-limit error, or a provider's `truncated`
  answer such as Zagreb's 4,000-row cap), in quarters merged by id; one failed quarter makes the
  whole cell unavailable. The custom sources (`custom-source-3d.js`) read their adapter through the
  same splitter, so the 950 m shrink and the fixed 320 m tiles are gone. `/buildings/near` and
  `/buildings/footprints` stay for geometry callers (demolition scans, MCP) and read the primary
  source only.
- **Browser.** `frontend/js/building-cells.js` (pure) turns the parcel grid into building cells:
  aligned blocks of parcel cells about 300 m wide (Bogotá's 0.0025° grid is one parcel cell per
  building cell, a 100 m grid three by three), the cells over a view or within a radius of a 3D
  anchor, nearest first. Its loader keeps the per-cell cache, the in-flight set, six requests at a
  time, per-source back-off and the fallback chain. One loader per page
  (`window.BuildingCellLoader`) serves the 2D pool and the 3D scene.
- **2D pool** (`map-core.js` `fetchProviderBuildingCells`): every provider city loads the cells under
  the view and merges each into the pool as it lands; `ensureBuildingFootprintsForBounds` ensures
  cells. Zagreb's GDI survey keeps its own bbox path (`GET /buildings`, covered rectangles,
  `buildingsRetryAt`): it is our database, and its pool features carry GDI properties the corridor
  tools read.
- **3D scene** (`three-mode.js` `ensureNearbyProposalBuildings`): the cells within the radius of the
  anchor (or over a proposal plus its apron), nearest first; the scene rebuilds when the first cell
  lands and at each quarter, and keeps the buildings that reach into the radius. The previous
  buildings stay drawn until new cells replace them.
- **Completeness loads** (demolition checks, corridor building detection, X-ray's typical layouts)
  ensure the cells under their own geometry through the same loader, whatever is on screen.
- **Open:** one 3D group per cell, so a landing cell is added without rebuilding the rest; today a
  load rebuilds the existing buildings up to five times.

### C. A view budget

- **3D.** The radius slider (300 m by default) is the load distance; cells are loaded nearest
  first and only buildings reaching into the radius are kept (Bogotá: 1,835 at 300 m).
- **2D.** No footprints below zoom 17 (already the rule in `fetchBuildings`).
- **Open:** loading only the cells in the camera's view, and simpler drawing for far cells. Both
  need measurements on the laptop and a phone first, and view-dependent loading needs the camera
  to trigger loads, which is step E2.

### D. Sources independent in the browser

The server isolates sources (cooldown and concurrency per source). In the browser:

| Shared gate | Now |
|---|---|
| `serverAnswerIsEmpty` in `building-source-client.js` swapped a failed, empty or truncated city answer for OpenStreetMap inside one request, mixing identities | Removed: the client is transport only; the fallback chain is declared and resolved per cell (below) |
| `buildingsRetryAt` paused every building fetch after any building failure | Set by the GDI path only; provider cities back off per source in the cell loader |
| 3D water and green waited for the buildings fetch | They load alongside it (their own query area) |
| Building failures and parcel failures | Already separate banners (`ParcelSourceSettings.reportFailure` by kind), each with its own Retry; unchanged |
| `ThreeSceneReady` waits for existing buildings | Unchanged: each caller says whether it needs them (`requireExisting`), which is right for captures |

Rule for new code: a layer owns its loading, its failure state and its place in the status display;
a failure shows in that layer only, with its own retry, while the others load and draw as usual.

**Fallback sources.** Fallbacks stay, declared rather than coded: a city's building config names its
own source (`sourceId`) and an ordered list of stand-ins (`fallbacks: ['osm']`, Bogotá's only so
far). `osm` is the backend source (the staged copy in `overture_building_footprint` where a region is
staged, else Overpass through `backend/buildings/osm-reference.js`). The cell loader is the only
place the chain is resolved:

- A cell is answered wholly by one source and records which. A stand-in answers a cell the source
  before it failed (outage, block, rate limit, timeout; an area limit splits the cell instead) or
  found empty (a city survey ends at its boundary). Cells are never merged across sources.
- Building identities carry their source (`CUSTOM-B-…`, OSM ids), so a demolition record names the
  survey it was made against.
- A stand-in cell is not cached: once the failed source's back-off ends, the next load asks it
  again. The status line says how many areas came from a stand-in.
- Parcels keep their user-chosen sources ("choose another source"), not an automatic chain.

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

### Removed

The 950 m `fitBox`, the 320 m tiling and the keep-truncated-footprints rule (2026-10-30 stopgaps),
`serverAnswerIsEmpty`, the provider path's covered rectangles, and `buildings.fallback`.

## Status

| Step | State |
|---|---|
| A. Area-limit error code | done: `areaLimitError` in `source-contract.js`, 52 sites in 26 adapters |
| B. Buildings on the parcel grid | done, except one 3D group per cell |
| C. View budget | distance and zoom rules done; camera-view loading and far-cell drawing open |
| D. Sources independent in the browser | done |
| E1. Cells with a view budget | as B and C |
| E2. Re-centre on demand | deferred (user decision 2026-10-30) |
| E3. Streaming with eviction | deferred |
