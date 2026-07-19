# 3D Terrain Fitting — Photoreal Mode

> Living record of the effort to make our flat proposal geometry sit correctly on Google's
> Photorealistic 3D Tiles in `rw` (realistic/photoreal) mode. Written after a long session that
> tried many approaches; **the core problem is not fully solved.** Read this before touching the
> carve/seal/drape code again — most "obvious" fixes have already been tried and are recorded here
> with *why they failed*.

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
  fragments that fall inside our footprints. The footprints are rasterised into a sliding 1024²
  top-down R/G mask; the shader samples it and `discard`s. Two discard modes now exist:
  - **RED = full discard** (roads' old mode, razed & proposed buildings): remove everything above a
    floor plane.
  - **GREEN = keep-vegetation** (parks, and now roads): discard only the **ground layer** — below
    `localGroundHeight + band(~1 m)` — so hedges/trees stand instead of being sliced (see §5).
- **The seal:** because the cut edge (real terrain height) ≠ our fill edge (flat z≈0), the gap has
  been sealed by, in sequence, aprons → plinth → **terrain-conforming curtain** (§4). This is the
  part that keeps producing artifacts.

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
  to that height. Flat earth cap keeps the top-down seal + razed pad. This is the current seal on
  `main`. **It works but produces the olive walls** (it's an earth wall, and — see §7 — it walled to
  the canopy, so the walls were tall).

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

### 5.7 Canopy contamination (the current frontier) — still not good
- `sampleTileGroundZ` took the **first** ray hit going down. Over vegetation that's the **canopy
  top**, so both the drape (roads lifted to treetops → float) AND the curtain (walls to canopy →
  tall olive sheets) were built to the wrong height.
- **Uncommitted worktree change:** take the **lowest** valid hit in the column (ground under
  canopy). User reports **"still not good"** after this. So min-hit alone does not fix it — likely a
  mix of: coarse grid (~18 m) faceting a draped road, min over-correcting into low mesh points, grid
  holes (NaN→0) warping vertices, and/or roads extending beyond the sampled grid bbox.

---

## 6. Root causes / durable learnings

1. **Single-point seating + flat content ⇒ guaranteed mismatch away from the origin.** This is the
   parent of every artifact. No fixed-geometry seal fully fixes it.
2. **Google tiles are a hollow, double-sided, fused shell.** Keep them double-sided. Never trim
   canopy partially. The only clean cut is the exact footprint of a surface you're replacing.
3. **Blue = the sky background through a gap.** Always. Diagnose by *where* it shows (top-down vs
   grazing) — grazing-only ⇒ a wall/winding issue; top-down ⇒ a real hole/coverage gap.
4. **The Google mesh has no "ground" layer** — a top-down raycast returns **canopy/roof first**.
   Any height field built from first-hit raycasts is canopy-contaminated. The seat avoids this with
   a p25 spread; a full ground *heightfield* is the unsolved hard part.
5. **Winding-dependent culling is a real, subtle bug.** Any single-sided extruded seal is culled for
   ~half of footprints. Make seals `DoubleSide`.
6. **No BVH on the tiles** ⇒ raycasting is brute-force; a per-vertex height query per rebuild
   hitches. Hence the cached coarse grid (and its coarseness is now a problem for draping).

---

## 7. Current state

### On `main` (deployed, build ~299)
- Carve = double-sided tiles + single clean cut.
- Seal = **terrain-conforming curtain** (grid-sampled earth walls up/down to terrain) + flat cap.
- **Keep-vegetation** for parks AND roads (green mask channel + ground-band discard via `uGroundTex`
  R32F heightfield).
- Roads carve at `buffer: 0` (no apron ring).
- **Known remaining issues on main:** olive curtain walls where terrain rises above the plan and,
  crucially, **tall** where the grid sampled the canopy (the min-hit fix in §5.7 is NOT on main
  yet); occasional blue scallops.
- Adjacent UX shipped this session (not terrain, but in the same builds): `?seat` on-screen seating
  diagnostic (§9), `rw` loading cover (2D→loading→composed), mobile-collapsible 3D controls panel.

### In worktree `../consensus-builder-terrain-drape` (branch `terrain-drape`, NOT merged)
- Commit `1a3c49f` = drape v1 (corridors) + apron:false for roads.
- **Uncommitted** = `sampleTileGroundZ` min-hit (lowest hit = ground under canopy).
- **Status: not working** — roads float / warp; user rejected it twice.
- Served for laptop testing at `http://localhost:5099` pointed at the prod backend
  (`?backend=https://api.urbangametheory.xyz`, CORS allows localhost). `serve … --single` for the
  `/proposals/…` SPA route.

---

## 8. The open problem + candidate next steps

**The unsolved crux: getting a clean GROUND heightfield out of Google's noisy photogrammetric mesh**
(no ground layer, canopy/roofs/buildings on top, no BVH). Every current artifact needs it.

Candidate directions, roughly ordered by effort:

1. **Keep the curtain; just feed it clean ground heights (min-hit or a robust percentile).** Lowest
   risk, one-file change on `main`. Should collapse the tall olive walls to small lips **without any
   drape**. Min-hit alone "still not good" per the user, so needs a better ground estimator: e.g.
   per-grid-point take a small spread and use a low percentile (like the seat's p25) to reject both
   canopy (high) and spurious low hits; or median-filter the grid; or reject hits that sit far above
   the neighbourhood minimum (canopy) and far below it (mesh underside).
2. **Drape with a smooth, dense, de-noised heightfield.** The coarse 18 m grid facets a draped road.
   Needs a finer grid (cost — no BVH), plus smoothing, plus draping the *whole* corridor
   cross-section consistently (not per-vertex independently) so the ribbon stays planar across its
   width. Buildings must offset by their **footing** height (whole-object), not per-vertex, or they
   shear.
3. **External DEM (Croatian DGU, used in `zagreb-isochrone`).** Clean bare-earth ground, but ~20 m
   resolution and a **different datum/surface than Google's mesh** — so it would MISMATCH the tiles
   (fresh gaps) unless only used to *drape our content* while the *curtain still seals to Google's
   own mesh height*. Possibly: DGU for draping content, Google-raycast (ground percentile) only for
   the thin seal. Untested.
4. **Accept the curtain as the seal and stop draping.** With clean ground heights (option 1) the
   walls become minor earth lips — arguably acceptable. This is the pragmatic fallback the session
   was heading toward when it stopped.

**Recommendation:** try option 1 with a proper ground estimator first (cheap, safe, on `main`); only
pursue draping (option 2) if the lips are still unacceptable. Treat this whole area as the natural
first customer of a future shared `sim-3d` engine — it's the same terrain-conformance problem the
osm-3d and photoreal engines both have.

---

## 9. Constraints & gotchas for whoever continues

- **Cannot be verified by the AI agent directly.** The automation browser can't stream Google tiles
  (an unfocused tab throttles rAF/timers → `tiles.update` starves → `loadProgress 1, 0 children`).
  It is **NOT an ion quota throttle** — driving `update()` by hand starts loading. So **every
  photoreal fix must be verified in a real focused browser session** (the user's).
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

*Last updated: 2026-07-19, after the drape/min-hit attempt was rejected. The terrain fitting is
still open; start from §8 option 1.*
