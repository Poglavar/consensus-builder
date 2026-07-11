# OSM 3D world as a shared base layer — research notes

Investigation from 2026-07-10 into whether `zagreb-isochrone-main`'s OSM-driven 3D renderer should be
modularized and reused as consensus-builder's 3D base layer. No code was changed. Conclusions and the
recommended sequence are at the bottom.

## Two corrections to the starting assumption

**The yellow-man button is not a 3D mode.** It is a launcher. It raycasts the click onto the ground
plane, converts to lat/lng, and opens an *external* site in a new tab:

    zagreb.lol/prijevoz/?st3d=walk&lat=..&lon=..&proposals=<serial ids>

See `frontend/js/three-mode.js:2945-3176` (`buildWalkUrl`, `openWalkAt`, `startWalkPick`). No OSM world
exists inside consensus-builder. The button is hidden for every city that has no `walk.url`, and only
Zagreb has one (`frontend/js/city-config.js:125`).

**The two apps are already integrated**, via a URL and the public API.
`zagreb-isochrone-main/website/station-3d/world/proposals.js` (1374 lines) fetches proposals from
`https://api.urbangametheory.xyz` by serial id, renders each by goal (buildings extruded, road-track as
asphalt, park/square/lake), and builds a unified footprint mask so the cadastre buildings layer skips
existing buildings whose centroid falls under a proposal.

So the open question is not "should we integrate" but "should the OSM world move in-process, as a base
layer beneath the 3D mode".

## What station-3d actually is

`zagreb-isochrone-main/website/station-3d/` — ~70 files, ~27,600 lines, ESM with an importmap and
**no build step**. Three.js r184.

- `scene/setup.js:237` builds scene/camera/renderer/controls; render loop in `scene/animate.js`.
- Public API `window.Station3D = { open, openCab, openWalk, close, setGrade }` (`index.js:108`).
- A documented import hierarchy (`station-3d/README.md`): `core/*` is pure (no THREE, no DOM);
  `scene/*` may not import `ui`/`world`; `world`/`vehicles` import only `scene/setup.js`; `modes/*`
  orchestrates.
- Every world layer implements the same protocol — `{ beginSession(ctx), onFrame(pose, local, dt),
  endSession() }` — registered in one array (`modes/cab.js:242-267`). Adding a layer is one entry.
- Streaming: `core/tile-stream.js` (200 m tiles, ring-based eviction, AbortController) plus
  `core/shared-tile-session.js` so buildings/roads/cars/curbs/lamps fetch each tile once.
- Perf: frame-budgeted chunked geometry build (`core/frame-chunk-queue.js`), InstancedMesh/merged
  geometry for decor, deferred heavy layers, no workers.
- Coordinates: **local equirectangular anchored on a session origin** (`core/math.js:8`), +X east,
  −Z north, metres. City-agnostic. No HTRS96 in the renderer at all.

Consensus-builder's `three-mode.js` instead uses EPSG:3857 with an origin subtraction
(`getOrigin3857`, `latLngToXY`). Also city-agnostic. Neither needs projection rework.

## The gate is data, not rendering

Runtime data comes from the cadastre-data API (`/api/roads`, `/api/roads/curbs`, `/api/buildings-3d`,
`/api/facade-openings`) plus a handful of pre-baked Zagreb JSON files. There is no live Overpass.

The lock-in is one layer below the renderer, in the table:

```
osm_road.geom           geometry(LineString, 3765)   -- Croatian SRID, single table, no city column
osm_road.geom_buffered  geometry(Polygon,    3765)   -- pre-buffered server-side
osm_road.tags           jsonb                        -- the raw OSM way tags
```

`GET /api/roads?bbox=...` (`cadastre-data/api/src/domains/roads/routes.js`) is *shaped* city-agnostically
— a plain bbox query. It returns nothing for New York only because the table holds a Croatia extract in
EPSG:3765.

Per data source:

| Source | State | Work to generalize |
|---|---|---|
| Roads (`osm_road`) | Croatia-only, EPSG:3765 | store 4326 (or per-city SRID + `city` column), re-derive `geom_buffered`, ingest NY |
| Curbs (`/roads/curbs`) | derived from `osm_road` via `ST_Union` | follows roads for free |
| 3D buildings | DGU/GDI mesh table | **already solved** in consensus-builder: `backend/buildings/` provider registry (Zagreb mesh, NYC ArcGIS/Socrata, generic Overture) |
| Decor (trees, hedges, benches, crossings) | pre-baked `zagreb_tram_*.json`, built offline from `croatia-latest.osm.pbf` with a hardcoded bbox `15.87,45.74,16.07,45.87` | needs a generic per-city source |

**Generalising `osm_road` to multiple cities is the whole unlock, and it is independent of any
extraction work.** It is also independently useful — a multi-city `osm_road` with its `tags` jsonb
serves several other projects.

## Synergy with the corridor profile

station-3d composes a street from three *independent* layers — buffered road polygons
(`world/roads.js`), extruded kerbs (`world/curbs.js`: 0.18 m top, 0.30 m stone band, 1 m back-ramp), and
lane markings (`world/lane-markings.js`, reading `lanes` / `lanes:forward` / `lanes:backward` at a fixed
3.5 m). It has **no unified cross-section object**.

That is exactly what `frontend/js/corridor-profile.js` (branch `corridor-model`) now is: an ordered lane
list with a two-way OSM tag bridge. `corridorProfileFromOsmTags()` eats precisely what `osm_road.tags`
holds; `corridorProfileToOsmTags()` emits precisely what `lane-markings.js` reads.

One profile could drive the 2D map, the abstract 3D view, and the OSM world — which argues for the
profile model living in the shared layer rather than in consensus-builder's frontend.

## Costs to name before committing

- **Three.js version skew.** consensus-builder is pinned to `three@0.147` as classic UMD scripts,
  because it is the last release shipping `examples/js` (see the comment in `frontend/index.html`).
  station-3d is `three@0.184` ESM. Adopting the world means consensus-builder's 3D goes ESM. Bounded —
  `three-mode.js` is one file — but real.
- **Photoreal's lifecycle contract.** Cesium does not replace the 3D scene, it layers on top of a live
  one, and auto-deactivates via a MutationObserver on `body.three-mode-active`
  (`photoreal-mode.js:425`). Swapping the scene underneath breaks that.
- **Abstraction is a feature.** consensus-builder's 3D is deliberately abstract (grey slabs, legible
  massing). A full OSM world with facades, cars and streetlamps is a different job. The base world
  should be a *toggleable layer under* the parcel/proposal layers, not a replacement.

## Coupling points to sever when extracting

1. `window.__ZAGREB_RUNTIME_CONFIG__` + `core/api.js getApiBase()` → inject a **source adapter**
   (base URL + endpoint schema).
2. Feature schemas: `world/buildings.js` expects DGU `object_id`/`z_min`/`z_delta` MultiPolygon-with-Z.
3. Hardcoded static filenames in `world/decor.js`, `world/elevated-rail.js`, `core/road-index.js`.
4. `window.Station3D` global, `#station3DContainer`/`#station3DModal` DOM ids, and the transit-shaped
   `openCab(train, line, poseFn)` entry API.
5. `modes/cab.js`'s single `layers` array interleaves the reusable world (buildings, roads, curbs,
   rails, decor, water) with app/game logic (proposals, cars, weapon, boarding, tram).
6. **The real entanglement:** `world/proposals.js` calls into `pruneBuildingsByMask`,
   `rebuildRoadsForProposalMask`, `rebuildDecorForProposalMask`, `rebuildRailsForProposalMask`, and
   buildings/roads import `isFeatureMaskedByProposals` back. This must become a **mask hook** the base
   world exposes and app layers register against.

`core/*`, `scene/*` and the tile scheduler are reusable as-is.

## Recommended sequence

1. **Make `osm_road` multi-city.** Nothing else is blocked on anything else, and this alone turns a
   Zagreb-only feature into a New York one. Consider deriving the buffered geometry from the corridor
   profile rather than reproducing a separate buffering rule.
2. **Extract the base world in place**, keeping `zagreb-isochrone` as its only consumer — extracting
   with an existing consumer is the only way to know the seam is real. Sever the coupling points above,
   in that order.
3. **consensus-builder mounts it as a base layer**, with parcels and proposals as app layers on top.
   Parcels have no counterpart in station-3d; they stay ours.
4. **Walk becomes a camera mode of that same scene**, not a tab launcher. This is the UX payoff, and it
   comes last.

### The cheaper alternative

Leave the split-brain alone: generalize the walk URL contract and stand up a station-3d instance per
city, still launching a new tab. It gets New York walking for a fraction of the effort, and it keeps two
Three.js worlds, two road models and two definitions of "a street" indefinitely. Take it only if the
answer to *"will we want proposals editable inside the OSM world"* is a firm no.
