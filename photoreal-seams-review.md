# Photoreal (photo/rw) Mode — Expert Review

Reviewed 2026-07-22, immediately after the zagreb-isochrone station-3d portal-sliver campaign
(same tile stack: `3d-tiles-renderer` + Google Photorealistic 3D Tiles via Cesium ion, streamed
into three-mode's own scene). Scope: `photoreal-mode.js`, `photoreal-seam.js`,
`photoreal-ground.js`, `photoreal-frame.js`, carve/tunnel touchpoints, renderer config.
Focus: **why seams are imperfect and what to improve**, plus latent-correctness and perf.

## Verdict on the architecture

Genuinely strong — in several places ahead of the station-3d sibling:

- **Coverage-normalized payload decode** (alpha ÷ blue after linear filtering) and the
  **adaptive road-floor encoding with a quantization-aware cut offset**
  (`roadFloorEncodingRange` + `quantizationSafeRoadCutOffset`) are exactly right; station-3d
  still runs a fixed cut floor.
- **Paired mask/envelope contract** (`pairRoadReplacementPatches`): a cut publishes only with
  its opaque cover, else the source stays intact. Fail-closed is the correct polarity for a
  hollow-shell source.
- **Morphological bare-earth** (`cleanGroundGrid`: gap-fill → grayscale opening → selective
  adoption → median) is a textbook DSM→DTM estimate at this budget.
- **Session reuse by anchor key** (quota + HTTP-cache aware) and the seat-probe design
  (p25-of-round, far-earth rejection, famine reporting) are battle-hardened.
- **No join-disc-class bug**: masks are exact polygon/station-quilt triangulations — no
  radius fills that can bleed a class past a region end (the bug that ate station-3d).

The seam imperfections are not one flaw but a stack of small, independent mechanisms below.

## Seam-critical findings (ranked by expected visible impact)

### 1. Depth-precision budget vs the centimetre seam stack

The seal is layered within ~4 cm: asphalt at z≈0, seam flange clamped to −0.03
(`MESH_SEAM_INWARD_TOP_OFFSET_M − 0.01`, photoreal-mode.js:1080), foundation top −0.04
(`ROAD_FOUNDATION_TOP_OFFSET_M`), apron cap −0.02, collar separated by polygonOffset only
(photoreal-mode.js:684–695). The camera runs `near = max(1, dist·0.001)`
(three-mode.js:5205; base near 0.5, far up to `FAR_CLAMP` ≈ 2 km·k). With a 24-bit depth
buffer the depth quantum at 300–600 m viewing distance is **~0.5–1.5 cm — the same order as
the layer separations**. That is the classic recipe for intermittent seam shimmer/sparkle at
exactly the ranges an overview camera uses.

Fixes (cheap, pick both):
- Raise the dynamic-near factor to `dist·0.002` (still conservative for walk-level views).
- Widen the physical separations to ≥3 cm (flange −0.05, foundation −0.07, keep asphalt at 0);
  invisible from >10 m, doubles the z-fight margin. PolygonOffset should remain the
  tie-breaker, not the primary separator.

### 2. Civil geometry freezes while the crust keeps refining

`TERRAIN_REFRESH_MAX_REFITS = 3` (photoreal-mode.js:31): after three quiet-period refits the
foundations, curtains, collars and fascia stay built on earlier-LOD samples, while Google
keeps swapping in finer meshes (and keeps doing so as the camera moves). Every later
refinement can open a hairline between the frozen seal and the new crust. The budget exists
because a refit is expensive — every rebuild re-raycasts the whole tile tree brute-force.
Fix the cost (below) and the budget can rise; also scope invalidation to the loaded tile's
bbox (station-3d's `wallHeightCache` pattern) instead of rebuilding everything, and allow one
rate-limited extra refit when a tile intersecting a road bbox loads after budget exhaustion.

### 3. No BVH on tile meshes — the structural bottleneck under everything

`sampleTileSurfaceZ` raycasts `intersectObjects(..)` against raw tile geometry
(photoreal-mode.js:1401 comment admits it: "The tile mesh has no BVH"). Every seat probe,
terrain-grid cell, road station, edge/seam/curtain probe pays a full triangle scan.
`three-mesh-bvh` integrates trivially with this stack (compute `boundsTree` per geometry in
`onTileModelLoad`, ideally in the existing `requestIdleCallback` path; dispose with the tile).
Expected 10–100× raycast speedup, which unlocks: denser station spacing (tighter formation →
tighter fascia fit), a higher refit budget (finding #2), and cheaper seam-cap builds. This is
the single highest-leverage change for seam quality per engineering hour.

### 4. `errorTarget = 24` streams a coarser crust than the seams deserve

photoreal-mode.js:2182 (library default is 6). Fascia quads are exact intersections with
*whatever triangles are loaded* — at error 24 they are cut against coarse geometry, then the
visual crust refines underneath them. Suggest 12–16 on desktop, keep 24 for mobile
(`devicePixelRatio`/`navigator.deviceMemory` branch), leaving `?prq` as override. Cost is
tile traffic, mitigated by the session-reuse design.

### 5. Patch marker is a `userData` flag — the clone hazard station-3d already paid for

`patchTileMaterial` guards on `material.userData.__corridorPatched`
(photoreal-mode.js:1778). `Material.clone()/copy()` JSON-copies `userData` but **not**
`onBeforeCompile` — a cloned/replaced material claims patched while carving nothing (whole
tile un-carved through the footprint). station-3d hit this in production and moved to
function-identity checks plus a periodic repair traversal (`revisioned-material-compile-patch`).
Cheap hardening here: name the injected callback and test identity instead of userData; add a
repair `tiles.group.traverse` to the already-throttled `scheduleSettledTerrainRefresh` path.

### 6. DoubleSide on every tile material — keep the axiom, scope its cost

The double-sided axiom (photoreal-mode.js:337–345, 1781) is sound and documented: cut holes
show mirrored texture, never sky. But it disables backface culling for the *entire city* —
roughly a third to a half of all fragments shaded for nothing on dense views (a real mobile
cost). The axiom is only needed where holes can exist: **within carve footprints**. Cheap
scoping: at patch time, set `DoubleSide` only for materials of tile scenes whose world bbox
intersects the carve bounds (recheck on `rebuildCarveMask`), `FrontSide` elsewhere. Same
visual guarantee near cuts; culling restored for the other ~99% of tiles.

### 7. Curtain rim clamp can under-reach on steep uphill edges

`CURTAIN_MAX_RISE_M = 8` (photoreal-mode.js:373): where the true rim stands more than 8 m
above the content plane (steep hillside cuts), the curtain stops short and a lit gap can
appear above it. Same lesson as station-3d's crown saturation: replace the fixed clamp with a
consensus-of-samples bound (e.g. cleaned-grid p90 within the ring's neighbourhood + margin),
so real slopes are followed while a stray roof/tree hit still cannot mint a wall.

### 8. Mask economics on mobile

4096² RGBA8 ≈ **64 MB of VRAM** plus a full mask-scene render per 150 m slide
(photoreal-mode.js:335–336). Desktop fine; on phones drop to 2048² (0.5 m texels) — the
`maskEdgeContract` helper already parameterizes texel size, so collars/overlaps scale
automatically. Gate by the same mobile branch as finding #4.

## Correctness nits

- `maskEdgeContract`'s comment says "nearest-filtered" but the RT uses `LinearFilter`
  (photoreal-mode.js:604). The half-diagonal ownership math is a conservative superset either
  way — fix the comment, keep the margin.
- Keep-veg shader branch + `uGroundTex` machinery is dead weight now that parks full-cut
  (kept deliberately? one texture bind + branch per fragment; consider compiling out).
- Seam caps set `frustumCulled = false` (photoreal-mode.js:1181) though they carry bounding
  spheres — children of tile meshes cull fine; flipping this back is free fill-rate on
  off-screen tiles.
- The ion token rotation TODO (photoreal-mode.js:13) still stands.

## Port the instrument (from today's station-3d campaign)

The portal-sliver hunt proved that mask systems cannot be debugged by reasoning: five
correct-in-model fixes missed a mask-writer bug that three probes then located. Port
`__photorealDebug` (adapted to this Z-up frame): crosshair sweep that **walks hit chains past
shader-discarded ghost crust** (raycasters hit invisible carved geometry — the first hit is
almost never what the eye sees), **GPU mask pixel readback** with self-calibration against a
known texel, and per-entry frame coordinates. CB already exposes good aggregate stats
(`document.body.dataset.photorealSampling`, `?seat`, `?seam=debug`); this adds the per-pixel
ground truth those can't give. See `google-reality-mesh` skill → engineering playbook, case
study of 2026-07-22.

## Suggested order of work

1. #1 depth separations + dynamic near (hour-scale, kills the shimmer class).
2. #3 BVH (day-scale, unlocks #2 and #4).
3. #2 refit budget + scoped invalidation (after BVH).
4. #5 patch identity hardening + #6 DoubleSide scoping (independent, hour-scale each).
5. #4 errorTarget tiering, #7 curtain consensus clamp, #8 mobile mask tier.
6. Instrument port alongside any of the above.
