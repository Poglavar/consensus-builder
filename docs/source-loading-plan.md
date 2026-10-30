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
- A concept's sources are an ordered list: the city's declared sources plus any the person adds,
  each in use or not; the sources in use stand in for each other in that order (step F).
- Every building carries its source, and a cell is answered by one source.
- Demolitions are derived from design geometry against whichever buildings are shown, never stored
  as building ids, so a source switch or a stand-in only redraws. No display-only guards.
- Switching sources is part of the data-source switching flow: the cells reload and derived
  demolitions are recomputed; buildings only another listed source has are surfaced.

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
- **Which zoom.** Layers that load by viewport read `LoadView.current()` (`frontend/js/load-view.js`):
  the 2D map's view and zoom in 2D; in 3D, the camera's distance as the 2D zoom showing the same
  width, around where the scene was entered (the camera's pan does not move it, as E2 is deferred).
  They reload on `loadviewchange` (the camera settling, or a mode change). Permitted massing and
  Explore's designs read it.
- **Permitted massing** loads by cells too (`planning/scene.js` `viewCells`, 0.0025°, about 280 m):
  nearest the centre first, two at a time, each drawn as it lands and cached on its own; a failed
  cell is asked once more, alone, after the rest. No view is refused for its size; below zoom 16
  the layer says "zoom in".
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

**Stand-ins.** The cell loader is the only place a source chain is resolved (the chain itself is
step F's source list):

- A cell is answered wholly by one source and records which. A stand-in answers a cell the source
  before it failed (outage, block, rate limit, timeout; an area limit splits the cell instead) or
  found empty (a city survey ends at its boundary). Cells are never merged across sources.
- A stand-in cell is not cached: once the failed source's back-off ends, the next load asks it
  again. The status line says how many areas came from a stand-in.

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

### F. Source lists, browser reads and derived demolitions

Buildings now; parcels and the other concepts adopt the same list and loader later (F7). Done in one
change: F1–F6 depend on each other.

#### F1. One source list per concept

City config (`frontend/data/city-configs.js`, regenerated by `scripts/build-city-files.mjs`):

```js
buildings: { sources: [
    { id: 'gdi-3d', name: 'GDI photogrammetric survey' },
    { id: 'dgu', name: 'DGU cadastre', use: false },
    { id: 'osm', name: 'OpenStreetMap', use: false }
] }
```

Bogotá lists its cadastre (`building.<base64url>`) then `osm`, both in use; New York `nyc-arcgis`
then `osm` (not in use); every OSM city `[{ id: 'osm' }]`. `source`, `sourceId`, `fallbacks`,
`defaultSource` and the single custom-choice override in `getCityConfig` go; their readers
(`city-config.js`, `map-credits`, `data-source.js`, `building-source-client.js`, the GDI request
builder) read the list.

The person's list is stored per backend and city (`cb_building_sources:<backend>:<city>`, entries
`{ id, use, outline }` in order) and can be given in the URL (`buildingSources=a,b`, the sources in
use, in order). One pure module, `frontend/js/source-list.js`, resolves city list + person list into
the effective list: unknown ids dropped, a city source the person never mentioned appended with the
city's default. The "Choose a building source" dialog becomes the list editor: each row has Use and
Outline switches and up/down order; user-added sources (the existing discovery flow) can be removed;
"Reset to the city's list" clears the person's list. The B-key layers dialog and the Layers panel
show the same list instead of the three fixed checkboxes.

#### F2. Each building carries its source; each cell has one

- A building's key is `<source>:<id>` everywhere: pool features, 3D records, derived demolitions,
  click stack, photoreal razed footprints, Compare. `corridorBuildingKey`/`buildingPoolFeatureKey`
  produce it; an id-less feature keeps `geom:` behind its source; proposed buildings keep
  `proposal:<pid>:<idx>`.
- A building belongs to the cell holding the first vertex of its outline, so a building straddling
  two cells is drawn once. The loader drops the rest of an answer.
- Where neighbouring cells came from different sources, a stand-in's building that overlaps, by more
  than half its area, a building of a source earlier in the list is dropped. This is the same overlap
  test as F5's "only in".
- The 2D pool tracks `cellKey → { source, keys }`. A new answer for a cell replaces the old one
  whole, and the 12,000 cap evicts the farthest cells whole.
- Zagreb's GDI moves onto the cells: `/buildings/cell` with `gdi-3d` answers footprints carrying the
  properties `GET /buildings` gives today. `fetchBuildings`' bbox path, its covered rectangles and
  `buildingsRetryAt` go.
- DGU becomes a cell source (`dgu`). Its heights come from the storey count, else the shared estimate
  (`building-heights.js`). `GET /buildings?source=dgu` and `GET /buildings/osm` go once nothing reads
  them.

#### F3. A URL source is read in the browser

- **The rule.** A source that is a public URL (ArcGIS, WFS, OGC API, Socrata, GeoJSON: every
  `building.<base64url>` descriptor, city-declared or added by the person) is read in the browser,
  by the parcel adapter worker (`frontend/assets/parcel-adapters/`). Our server answers
  `/buildings/cell` only for sources in our database: `gdi-3d`, `dgu` and `osm` (the staged table,
  else Overpass).
- **New York** stays a server source: `nyc-arcgis` keeps only `FEATURE_CODE = 2100` (buildings, not
  the layer's ~214k canopies, tanks and skybridges), and a `building.` descriptor has no attribute
  filter. Adding `attributeFilters` (which the ArcGIS adapter already supports) to the descriptor
  codec would let it move to the browser.
- **Shared module.** The adapter-feature → building mapping (`customBuildingFeature`,
  `footprintFeatureToBuilding`, the height rules) and `split-read.js` move into one module that both
  the worker bundle and the server import.
- **Routing.** `BuildingSourceClient.requestCell` sends a URL source to the worker and a database
  source to the server. The cell loader's back-off and cache stay where they are.
- **No relay.** A URL source without CORS cannot be read, and discovery says so when it is added.
  There is no server relay (Bogotá's service sends `access-control-allow-origin: *`).
- **Server-side reader stays.** The server keeps its reader of URL sources only for server-side
  consumers (MCP compare). The browser never sends a URL source to it.
- **Deploy consequence.** A city whose sources are all URLs, or OSM through the browser's own reader
  if one exists by then, works without our server.

#### F4. Demolitions derived from design geometry

- **The module.** One pure module, `frontend/js/demolition-derive.js` (UMD, loaded by the browser and
  by `backend/agents/mcp-compare.js`), maps (applied designs, shown buildings) to
  `Map<buildingKey, { outcome: 'razed'|'cut'|'tunnelled', demolishedPart, remainder, proposalIds }>`.
- **Takers.** Their regions are:
  - roads: `definition.polygon`;
  - buildings: `geometry.landTake`, else the cleared parcels plus the authored footprints
    (`buildingDemolitionGeometry`);
  - structures: their geometry carved by later corridors.

  A building is cut against the union of the takers, so order does not matter. The thresholds are
  the current ones (under 2 m² untouched; a remainder under max(10 m², 15 %) razed).
- **Tunnels.** A tunnel record keeps its authored span (`edgeKey`, `from`, `to`, `segmentId`) and
  loses `buildingIds`. A building whose overlap with the corridor lies within a tunnel span is
  tunnelled, not taken. Tunnel creation still finds the buildings over the corridor to propose a
  span, but stores only the span. This is a contract break; a span written by an older tunnel
  record still applies.
- **Where it runs.** A page-level `DemolitionIndex` derives incrementally:
  - when the applied set or a design's land changes, for the buildings under the old and the new
    land of the designs that changed (by the boxes of their polygon parts, so a long road edited at
    one end measures only the buildings near that end), loading only the cells under the new land;
    every other record is kept;
  - when the source list changes or an area did not load, for everything.

  The cells under every applied design's region are ensured through the cell loader, which replaces
  the replay's `/buildings/under` prefetch.
- **Readers.** All of them read the index instead of `demolishedBuildings`: the 2D outcome state,
  the 3D carve (by key; `structureClearanceCarve` folds in, structures being takers like any other),
  photoreal razed footprints, vacant plots, the click stack, Compare (each side derives its own
  index over the same buildings), the corridor detection pool, and plan stats and `present-state`
  clearance (against the shown buildings, no longer a separate `/buildings/under` read).
- **What stays separate.** A design over a proposed building parks that building
  (`demolishBuildingsUnderFootprint`'s proposal branch). That is a relation between designs and
  stays, split out of the existing-building path.
- **Roads raze again.** Applied roads raze and cut existing buildings in 2D and 3D again, consistent
  with plan stats. This is a visible change.
- **Out of scope.** The legacy server carve (`/buildings/carve`, `/buildings/near` with
  `proposals`, read by the walk sim from the frozen `proposal` table) is unchanged.

#### F5. Switching, and buildings only one source has

- **Applies live, no reload.** A change to the list keys new cells: the cache key already includes
  the list. The pool drops cells and reloads the view's cells nearest first. The `DemolitionIndex`
  re-derives as each cell lands, and the 3D scene rebuilds.
- **Status line.** It says how many areas each source answered.
- **Outlines.** A source with Outline on is drawn as reference outlines from its own cells, with no
  stand-ins, and is never cut against, as DGU and OSM are today. Its buildings that the shown
  buildings cover by at most half their area are drawn in an "only in <source>" style, and its status
  line counts them.
- **MCP compare** takes the ordered source list (`buildingSources`) instead of one `buildingSourceId`.
  On the server the land is asked of each source in turn and the first complete answer is measured
  (by the same derivation, `demolition-derive.js`); it is not resolved per cell.
- **What doesn't change.** Parcel and imagery sources keep their single choice and reload.

#### F6. Tests

**Headless unit tests:**
- `source-list` (resolve and reset).
- `demolition-derive`:
  - order independence;
  - the thresholds;
  - a tunnel span;
  - two sources' keys never colliding;
  - a road razing.
- `building-cells`: first-vertex ownership and the cross-source overlap drop.
- The worker's building reader against a fixture ArcGIS answer.
- `building-source-client` routing: URL to the worker, database to the server.
- The `demolition-replay` and characterization tests, updated to read the index.

**Headless Playwright:**
- Bogotá 3D and 2D load with no request to our server's building routes.
- A source switch redraws demolitions without a reload.
- A road razes a building.
- Zagreb's DGU outline counts "only in DGU".
- The existing building specs, updated.

**Docs updated in the same change:** `vocabulary.md` (building key, derived demolition, tunnel span),
`source-adapters.md`, `click-stack.md`, `frontend-source-configuration.md`, `rethink-proposals.md`.

#### F7. Later: parcels and the other concepts

The same list shape, editor and cell loader replace the single parcel choice and
`ParcelGroundFallback`'s session source, then imagery. Not part of this change.

### Removed

- **2026-10-30 stopgaps:** the 950 m `fitBox`, the 320 m tiling and the keep-truncated-footprints
  rule.
- **Fallback machinery:** `serverAnswerIsEmpty`, the provider path's covered rectangles and
  `buildings.fallback`.
- **With F:**
  - **Config:** `buildings.source`, `sourceId` and `fallbacks`, and the single building choice in
    `ParcelSourceSettings`.
  - **Zagreb's GDI loading:** `fetchBuildings`' GDI bbox path and `buildingsRetryAt`.
  - **Reference layers:** `#showBuildingsDgu` and `#showBuildingsOsm`, with their routes.
  - **Demolition records:** `demolishedBuildings`, `demolitionScanned` and `demolitionScanFailed`,
    `_deriveDemolishedBuildings`, `_prefetchDemolitionBuildings` and the `keepDemolition` carry.
  - **Tunnels:** tunnel `buildingIds`.
  - **3D:** `structureClearanceCarve`.
  - **Browser routes:** the browser's use of `/buildings/near`, `/buildings/footprints` and
    `/buildings/under`. The routes stay for server-side consumers only.

## Status

| Step | State |
|---|---|
| A. Area-limit error code | done: `areaLimitError` in `source-contract.js`, 52 sites in 26 adapters |
| B. Buildings on the parcel grid | done, except one 3D group per cell |
| C. View budget | distance and zoom rules done; 3D layers read the camera's zoom (not its pan); permitted massing by cells; camera-view loading and far-cell drawing open |
| D. Sources independent in the browser | done |
| E1. Cells with a view budget | as B and C |
| E2. Re-centre on demand | deferred (user decision 2026-10-30) |
| E3. Streaming with eviction | deferred |
| F. Source lists, browser reads, derived demolitions | done (F1–F6); F7 open |
