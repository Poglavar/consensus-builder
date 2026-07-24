# 3D Terrain Fitting — Photoreal Mode

> Living record of the effort to make proposal geometry sit correctly on Google's Photorealistic
> 3D Tiles in `rw` (realistic/photoreal) mode. The chronology records several failed flat/drape
> approaches; the current road path is the obstacle-filtered Google/DGU station formation and
> exterior-union ruled/seam interface in §5.8. Read this
> before touching the carve/seal/drape code again — most "obvious" fixes have already been tried.

---

## 1. The problem in one sentence

Our proposal content (roads, parks, buildings) is modelled **flat at z ≈ 0**, but Google's mesh is
**real rolling terrain with trees and buildings**. Where the two meet, you get artifacts:
light-blue sky slivers through seams, olive earth "walls", floating roads, sliced vegetation.

Everything below is the fight to make the two surfaces meet cleanly.

---

## 2. How photoreal mode works (the setup you must understand)

- **Renderer:** `frontend/js/photoreal-mode.js` streams Google Photorealistic 3D Tiles
  (`3d-tiles-renderer` + Cesium ion asset 2275207) **into three-mode's own Three.js scene** — one
  canvas, one renderer. There is no second engine. See `[[project_photoreal_three_port]]` memory.
- **Frame:** three-mode's scene is EPSG:3857 — XY inflated by `1/cos(lat)`, **Z is true metres,
  Z-up**, origin `origin3857`. The proposal content is built by three-mode at **z ≈ 0** (a flat
  table): parks at z≈0.06, sidewalks at 0.15, buildings extruded 0→height, etc.
- **Tiles arrive at ellipsoid scale.** `ReorientationPlugin` anchors the tileset so the origin
  lat/lng is at (0,0,0) in an ENU frame; the tiles' real terrain height there is still ~+120 m
  (terrain above the ellipsoid). A **seating** step (`tryLockGround`, port of the sim's
  `lockTrackHeightOnce`) raycasts the tiles at a 13-point spread near the origin, takes the **p25**
  hit (roofs/canopy bias high, so p25 ≈ street level; pure `min` over-corrects into pits like
  Zagreb's rail trench), and shifts a `seatNode.position.z` so the **tile ground at the origin ≈ 0**,
  aligned with our flat content. This shift is ~−120 m. If seating fails, tiles float ~120 m above
  the content (buildings appear as blue holes with the boxes far below — see §9 mobile note).
- **The carve:** the tiles are a **hollow shell of one fused skin** (ground = trees = buildings, no
  separate terrain layer). To show our content, a fragment shader on every tile material **discards**
  fragments that fall inside our footprints. The footprints are rasterised into a sliding 4096²
  top-down RGBA mask (0.25 scene-metre texels); the shader samples it and `discard`s. Three discard
  classes now exist:
  - **RED = floor-bounded discard** (razed & proposed buildings): remove everything above a floor.
  - **GREEN = keep-vegetation** (parks): discard only the **ground layer** — below
    `localGroundHeight + band(~1 m)` — so hedges/trees stand instead of being sliced (see §5).
  - **BLUE = height-aware road discard:** alpha encodes the local road floor over blue coverage;
    Google is removed only above a quantisation-safe cutoff bounded below the opaque foundation
    cover. Lower source mesh remains intact beneath an elevated road.
- **The seal:** because a cut edge and replacement edge can differ in both plan and height, generic
  proposals retain the terrain-conforming curtain history in §5. Roads now use a stricter ownership
  contract: the exact mask quilt, an opaque paired foundation, and a depth-tested station-ruled
  collar generated from the same profile (§5.8).

Key files: `frontend/js/photoreal-mode.js` (carve/seal/seat/grid), `frontend/js/three-mode.js`
(content, drape hooks), `frontend/js/photoreal-frame.js` (frame math, unit-tested).

---

## 3. The core tension

> **A single-point seat aligns the whole flat plan to the terrain at exactly ONE point (the
> origin). Everywhere else, the plan is off the ground by `localTerrain − originTerrain`.**

On a plan hundreds of metres across, even "flat" Zagreb drifts several metres corner-to-corner. So:
- Where terrain sits **below** the plan → the plan edge floats over a gap.
- Where terrain sits **above** the plan → the plan sits in a notch, ground rims above it.

Every artifact class traces back to this. The seal (apron/curtain) trades one artifact for another;
the true fix is to stop pretending the ground is flat.

---

## 4. Artifact classes seen (the enemy list)

1. **Light-blue slivers / scallops** at cut edges = the **sky background** (`#87ceeb`, installed
   while photoreal is active) seen through a seam. *Nothing else in the scene is that colour, so
   "blue" always means a ray reached the background through a gap.*
2. **Olive-grey vertical "walls/sheets"** beside roads & proposals = the earth **curtain**
   (`0x6e7563`) standing up where content is above terrain (or where it walled to the canopy — §7).
3. **Transparent "window-down" cuts through shrubs** = the carve slicing Google's hollow vegetation
   shells, whose cut faces open to the sky.
4. **Floating roads with sky underneath** = the drape lifting roads to the **tree canopy** height
   instead of the ground (§6, §7).
5. **Buildings as blue holes with boxes far below** (mobile) = seating failed / stale cache, tiles
   ~120 m above content (§9). Believed to have been **stale cache**; resolved on hard-refresh.

---

## 5. Chronology of everything tried

Deploys are `deploy-N` build tokens; commits are on `main` unless noted.

### 5.1 Light-blue edges — the hollow-shell saga
- **Aprons / slabs / two-zone ring / below-ground backstop** (`dc945ea`): all FAILED. Root reasons
  discovered later: (a) the sim's `material.side = FrontSide` was ported — with backfaces culled,
  **any** hole lets a grazing ray travel *inside* the hollow shell and out to the sky; (b) trimming
  canopy partially manufactures unsealable skylights — **under a tree the canopy IS the surface**.
- **Seal the shell by construction** (`8b4917c`, build 282): the two axioms that ended most of it —
  (1) leave tile materials **DOUBLE-SIDED** as Google ships them (worst case a cut shows mirrored
  terrain texture, never sky); (2) cut **only** the exact footprints our surfaces cover, never trim
  canopy. Net −42 lines. Edge trees now lean over proposals like real trees.

### 5.2 The plinth (a fixed earth skirt)
- **Solid 4 m plinth under every cut** (`77c0992`, build 283): the plan is a flat z≈0 table on
  rolling terrain; without sides, daylight passed under one rim and out the other. The plinth gives
  each cut earth walls (cut-and-fill embankment) + doubles as the razed-lot pad. Helped, not enough.
- **Plinth walls must be DOUBLE-SIDED** (`9666388`, build 284): the residual blue was a real bug —
  `ExtrudeGeometry` orients side walls by ring winding; turf/GeoJSON give clockwise ~half the time,
  so single-sided (MeshBasicMaterial default = FrontSide) walls were **back-face culled for half of
  all footprints** → camera looked straight through the embankment to the sky. **Diagnostic
  signature: blue at grazing angles but NOT top-down ⇒ winding-culled walls** (the extrude *cap*
  winding is auto-corrected, so top-down always sealed). Necessary but still not sufficient.

### 5.3 The terrain-conforming curtain (replaced the fixed plinth)
- **Curtain** (`1996c94`, build 286): the real residual cause is §3 — a fixed-depth skirt seals only
  **downhill** edges; **uphill** (ground above the plan) leaves a gap ABOVE the content a downward
  wall can't reach. Fix: sample the tile mesh's real height along every cut edge (a coarse grid
  raycast once per seating, cached, bilinear-interpolated per wall vertex — tiles have **no BVH** so
  per-vertex casting each rebuild would hitch) and build the earth wall from content **up OR down**
  to that height. Flat earth cap keeps the top-down seal + razed pad. This remains the generic
  non-road seal on `main`; roads use §5.8 instead. **It works but produces the olive walls** (it's
  an earth wall, and — see §7 — it walled to the canopy, so the walls were tall).

### 5.4 Keep-vegetation (don't slice shrubs)
- **Parks keep vegetation** (`006d3ef`, build 288): cutting Google's hedgerows at park edges opened
  "window-down" cuts (class 3). Fix: a **second (green) mask channel** for `structureProposal.kind
  === 'park'`, and in green regions the shader discards **only the ground layer** — `z <
  groundHeight(xy) + ~1 m` — where groundHeight comes from the terrain grid uploaded as an **R32F
  DataTexture** (`uGroundTex`, NearestFilter, WebGL2). Lawn goes (our park shows), taller greenery
  stays. Full discard wins overlaps (renderOrder). The ~1 m band IS the grass/shrub line.
- **Roads keep vegetation** (`0ecb8c8`, build 290): same green mode for corridors, so roadside
  hedges stand instead of being sliced.

### 5.5 The road apron ring
- **Drop the road carve buffer** (`0e25ca9`, build 291): the olive strips *beside* roads (NOT
  parcels — `flatGroup` is hidden in realistic mode; NOT sidewalks `#c2beb4` — those are the road
  cross-section) were the carve's **1.2 m anti-comb dilation ring** showing the earth cap. That
  dilation is for building **facades**; a flat keep-veg road has none, so corridors carve at
  `buffer: 0` — the road mesh covers its own cut. Per-entry `buffer` field.

### 5.6 The terrain drape (worktree `terrain-drape`, NOT on main) — FAILED so far
- Idea: stop sealing the gap; **remove it** by lifting the flat content onto the ground so it
  FOLLOWS the terrain. `1a3c49f`: `three-mode.drapeContentOnTerrain(heightFn)/undrapeContent()` lift
  each corridor vertex by the local ground height (flat Z stashed per-mesh for exact restore);
  photoreal calls it at seat with `terrainZAt`; corridors get `apron:false` (draped → no curtain).
- **Result: roads FLOAT in the air with sky underneath.** Cause (§7): the grid sampled the **tree
  canopy**, not the ground.

### 5.7 Historical canopy-contamination failure
- `sampleTileGroundZ` took the **first** ray hit going down. Over vegetation that's the **canopy
  top**, so both the drape (roads lifted to treetops → float) AND the curtain (walls to canopy →
  tall olive sheets) were built to the wrong height.
- **Uncommitted worktree change:** take the **lowest** valid hit in the column (ground under
  canopy). User reports **"still not good"** after this. So min-hit alone does not fix it — likely a
  mix of: coarse grid (~18 m) faceting a draped road, min over-correcting into low mesh points, grid
  holes (NaN→0) warping vertices, and/or roads extending beyond the sampled grid bbox.

### 5.8 Obstacle-filtered Google/DGU station formation and exterior-union interface on `main`

- The coarse grid was the source of the false broad sag: its 22-sample cap meant a long road could
  use 25–30 m cells, and bilinear interpolation spread one bad low cell across tens of metres.
- Roads densify their centreline to **≤4 m stations** and raycast the **seated Google mesh
  directly** at every station. Each station samples the centre plus two probes outside the actual
  road half-width. This is the immediate/fallback formation and the local-scene anchor.
- In Zagreb, `POST /api/terrain/profile` supplies a DGU 20 m EVRF2000 bare-earth reference. Google
  remains the visible/local-scene anchor: a coherent **observed lower residual band** between Google
  and DGU fits one additive datum offset, never a vertical scale. The DGU shape is substituted only
  inside contiguous stations where Google sits at least 1.5 m above calibrated DGU **and** an
  independent 20% maximum-ground-grade envelope proves the visible surface rose too abruptly to be
  plausible ground. The corrected run is continuously anchored back to trusted Google ground and
  the hybrid profile is filtered again, so the approach/departure ramps into a canopy do not survive.
  Smooth Google ground over a low DGU pit remains Google; a route with no trustworthy lower anchors
  fails closed to Google rather than guessing through an all-canopy/all-building span.
- The longitudinal filter is conditional, not a low-pass: it replaces only locally unsupported
  excursions of at least 0.45 m. Genuine broad Google terrain hollows and steady grades remain
  unchanged. Only short bounded NoData gaps interpolate; missing edge/long regions disable the
  formation instead of becoming z=0.
- Centre, outside-left and outside-right probes keep roofs, cars and canopy from becoming the road
  datum. When those three hits form a plausible cross-section plane, exact left/right sidewalk-edge
  probes raise the shared station only to the predicted high edge. This clears normal terrain
  crossfall without treating a facade or parked car as ground.
- Every lateral strip at a station shares one formation Z. Roads are explicit ruled quads between
  adjacent stations, so Earcut cannot discard densification vertices and turn a 399 m road into a
  few long tilted triangles. Kerbs, markings, junctions and decorations add their semantic offsets
  to the same profile. An upper vertical-curve envelope removes only short concave photogrammetry
  kinks (it never lowers accepted Google support), while preserving sustained terrain grades.
- Sampling snapshots current visible Google tile meshes once per carve rebuild, caches XY probes,
  ignores the tiles-root reveal flag during the first hidden composition, and performs up to three
  quiet-burst refits as finer visible LODs arrive. A refit is built off-scene and swapped only after
  every applied corridor entry has a complete profile; a close camera that unloads any distant road
  therefore retains the last complete road/mask/foundation set atomically. The old cleaned grid
  remains for parks and non-road curtain support only.
- The road cut is height-aware. Its alpha channel carries the same explicit 4 m formation quilt as
  the visible deck. Google ground remains intact below the proposal as a permanent no-sky backstop;
  only fragments high enough to protrude through the opaque underlay are removed. The RGBA8 height
  cutoff subtracts its measured half-quantisation error so retained Google can never decode above
  the solid cover.
- The raster mask is the **exact semantic station quilt**, linearly filtered at 0.25 scene-metre
  texels. A paired station-derived foundation extends only the complete half-texel diagonal plus a
  10 cm guard (0.193 true m in the tested Zagreb view), rises to formation + 0.04 m and has a 0.6 m
  downward skirt. A depth-tested sidewalk-coloured collar is made from explicit ruled quads at the
  same stations and continues each actual outer lane/sidewalk top height through that narrow band;
  a tiny polygon bias resolves only coplanar precision fights, so the collar cannot paint through
  nearer terrain, trees or facades. Non-road mask classes use an explicit alpha-zero shader so
  linear filtering cannot contaminate the road-height channel. Mask and foundation share a unique
  replacement key and publish fail-closed; generic Turf road cuts are forbidden.
- Road closure is generated around the **exterior union of all padded foundation roofs**, not around
  every road patch. That avoids walls through T-junctions and overlaps. One neutral, depth-tested
  clearance curtain is emitted only where the original Google top is more than 0.5 m above accepted
  formation. Its top is the maximum of the stored longitudinal Google support and a cached direct
  boundary hit: the first covers canopy wholly inside the footprint, while the second catches a
  local tree/facade that did not contaminate the nearest road station. Retained Google hides the
  earth-green curtain wherever real source surface exists. **Road source-textured per-triangle
  fascias remain disabled**: high disconnected canopy intersections stretch into floating textured
  fins and may sit outside the actual unpadded shader cut. Other proposal families keep their
  established seam treatment; generic Turf road cuts remain forbidden.
- Browser check, the 22-proposal Borovje set (`63..85`, excluding 81): six complete corridor
  profiles and six paired road replacements, 1,941 cached visible-mesh probe hits, zero misses, four
  DGU profiles, no formation failures, **zero source-textured road-seam segments** and 160 conditional
  neutral-clearance segments. Worst adjacent grades are 3.5–13.5%; the canopy-crossing road that
  previously climbed to 5–8 m now follows roughly 0.57–1.70 m local formation. Close and wide
  inspection shows the road below the tree crown, the intersecting canopy cut, and no floating
  textured fins from the rejected source-cap path.

---

## 6. Root causes / durable learnings

1. **Single-point seating + flat content ⇒ guaranteed mismatch away from the origin.** This remains
   the parent of generic flat-proposal artifacts; roads avoid it with their explicit station
   formation. No fixed-geometry seal fully fixes ordinary flat content.
2. **Google tiles are a hollow, double-sided, fused shell.** Keep them double-sided. Never trim
   canopy partially. The only clean cut is the exact footprint of a surface you're replacing.
3. **Blue = the sky background through a gap.** Always. Diagnose by *where* it shows (top-down vs
   grazing) — grazing-only ⇒ a wall/winding issue; top-down ⇒ a real hole/coverage gap.
4. **The Google mesh has no "ground" layer** — a top-down raycast returns **canopy/roof first**.
   Any height field built from first-hit raycasts is canopy-contaminated. Corridors now bridge only
   independently proven obstacle runs with a datum-fitted DGU bare-earth shape; generic proposals
   still do not have a complete bare-ground heightfield.
5. **Winding-dependent culling is a real, subtle bug.** Any single-sided extruded seal is culled for
   ~half of footprints. Make seals `DoubleSide`.
6. **No BVH on the tiles** ⇒ raycasting is brute-force; a per-vertex height query per rebuild
   hitches. Roads therefore cache a bounded set of direct station probes; the coarse grid remains
   only for parks and generic non-road curtain support.
7. **A cut-plane intersection is not automatically the visible cut rim.** Copying every source
   triangle crossed by a padded boundary duplicates retained canopy/roof geometry and stretches its
   UVs down to formation. Roads use one neutral exterior-union curtain, never per-triangle textures.

---

## 7. Current state

### On `main` (current working tree; not automatically deployed)
- Road formation = direct Google mesh sampling plus obstacle-only, datum-fitted DGU bare-earth
  bridging at explicit ≤4 m ruled stations (§5.8).
- Road carve = a paired, fail-closed replacement contract. An exact, linearly filtered height mask
  removes protruding Google surface; a matching foundation and depth-tested, station-ruled 0.193 m
  vector collar own the full raster uncertainty with real end walls and a downward skirt. The collar
  continues the authored exterior strip height instead of flattening the draped profile. Google
  remains below the road as a no-sky backstop. The exterior union owns only a conditional neutral
  clearance curtain, so tree/building shell cuts are closed without manufacturing internal walls at
  road intersections or source-textured canopy fins. Generic Turf fallback cuts are disabled.
- Park/non-road ground support = the cleaned coarse grid. It is deliberately **not** a road profile
  source anymore.
- The original abstract-3D corridor group remains untouched. Photoreal mode builds a temporary
  terrain corridor group and removes it on exit, giving exact restoration.
- Remaining hard case: an entire route covered by canopy/building surface has no trustworthy Google
  ground anchors with which to calibrate DGU. That case deliberately falls back to visible Google
  rather than risking a datum-sized jump. Ordinary bounded canopy/building crossings are handled.

### Historical `terrain-drape` branch/worktree
- Commit `1a3c49f` and its min-hit experiment are superseded, not the current implementation.
- It mutated generic corridor vertices against the coarse grid, warped cross-sections, and could
  lift roads onto canopy. Do not merge or revive it as the basis of the current formation.

---

## 8. Remaining terrain-source question

Google does not publish a guarantee that Photorealistic 3D Tiles and the Elevation API share one
source surface. The Elevation API returns metres relative to **local mean sea level** and reports a
per-result resolution; multi-point/path requests can be coarser. 3D Tiles commonly occupy WGS84
ECEF/ellipsoidal space, then this app adds an arbitrary local seating shift. They are therefore not
drop-in absolute-height equivalents.

The Elevation API is still a useful independent comparison/fallback candidate: sample the road path,
subtract the API height at a local anchor, then add the seated Google-mesh Z at that anchor. The
constant datum offset largely cancels over a city-scale road. Before substituting it, compare the
*shape after fitting that constant offset* and retain the API's returned resolution. The current
implementation uses DGU EVRF2000 as a **relative shape only inside independently detected obstacle
runs**. It fits one additive offset from a coherent low Google/DGU residual band, keeps direct Google
support everywhere else, and rejects the DGU substitution when it lacks trustworthy Google ground
anchors. DGU therefore removes tree/building elevation from a road without becoming the route's
unconditional vertical datum.

---

## 9. Constraints & gotchas for whoever continues

- The in-app browser can verify Google tiles when the tab is focused and the proposal is framed
  before entering realistic mode. Entering at Zagreb's default centre while the road is several
  kilometres away correctly yields no road samples because those tiles have not streamed yet.
- **`?seat` on-screen diagnostic** (build 292+): shows `grounded / seatZ / ground@0 / tiles / lp` as
  a fixed bottom pill. `ground@0 ≈ 0` = seated correctly; `≈ +120` = seating failed (tiles at
  ellipsoid height). Captured in an inline `<head>` script → sessionStorage because the share flow
  rewrites `/proposals/…` and drops the query before JS reads it.
- **Testing the worktree on mobile is hard** (tunnel + backend + SPA + CORS). Laptop localhost +
  prod backend works (CORS reflects origin). For mobile verification, prefer a **flag-gated change on
  `main`** (inert by default, testable on real prod) over the worktree.
- **Deploys:** `frontend/deploy-frontend.sh` server-side `git pull origin/main` → commit + push
  before deploying. Verify from the served artifact, not the deploy log.
- Frame math is pinned by `backend/test/photoreal-frame.test.js`. The seat/carve constants live at
  the top of `photoreal-mode.js`.

---

*Last updated: 2026-07-20, after obstacle-filtered DGU ground bridging and the neutral exterior-union
road clearance interface were browser-verified on the 22-proposal Borovje set. Start from §5.8, not
the historical generic drape or source-textured road-cap experiments.*
