<!-- Implementation plan for corridor levels (−1/0/+1 with ramps) in UGT, drawn up 2026-10-28 from the decisions in corridor-elevation.md and the then-current code; not yet implemented. -->

# Corridor levels in UGT: −1 / 0 / +1 with ramps

Branch `colosseum-worlds-fair`. Design of record: [corridor-elevation.md](corridor-elevation.md).

## Context

Road and track centrelines already carry an optional per-point `level` (−1 underground, 0 surface,
+1 elevated, fractional = inside a ramp; `proposals/corridor-levels.js`, stored as the OSM node tag
`cb:level`). The substrate consumes it in places: the footprint skips fully underground edges, the
crossing pass refuses junctions between different levels and never nodes a ramp, node insertion
refuses ramps, junction keys include the level. But nothing lets a person set a level, nothing checks
ramp lengths, the drawing session and Finish drop the field, and 2D/3D draw a −1 run exactly like a
surface road. The detailed vertical editing (terrain, grades, structures) stays in
`universal-transit-planner`; UGT gets the basics.

Decisions (user, 2026-10-28):
- **Levels** are integers −1/0/+1 authored in UGT; fractional levels are only read (imports).
  One level = **6 m** (`LEVEL_HEIGHT_M`, configuration).
- **A ramp is one edge** whose two ends differ in level. Minimum ramp length = `6 m × |Δlevel| / max
  grade`, max grade by mode: **road 8 % → 75 m**, **rail 4 % → 150 m** ("rail" = a cross-section with
  rails and no traffic/bus lanes; a tram in a street is a road). Hard limits, not warnings.
- **Junctions exist only at level 0.** Two +1 (or two −1) stretches crossing do not node; snapping a
  new road onto a ±1 node or edge is refused; a junction node cannot be raised or lowered.
- **Land:** 0 and +1 take land (unchanged); −1 edges take none; ramps take land. A corridor may be
  entirely −1 (no land, no parcels; ramps can be added later). A corridor entirely at +1 takes land.
- **3D:** +1 on a viaduct deck with piers, 0 as today, −1 not drawn except its ramps and portals.
- **Where set:** node editor (click a node → raise/lower) and a −1/0/+1 picker in the drawing panel
  for the next placed point. A too-short ramp is refused with the shortfall in the message.

Reference implementation for the ramp rules: `~/Code/universal-transit-planner/web/transit.js`
(`getMinLevelChangeMeters`, `getTrackSegmentLevelProfile`) and `web/route-edit.js`
(`spliceTrackVertex`, `reflowTrackRampShapeSpan`). UGT keeps only the explicit-edge ramp.

## Step 1: pure rules module (no DOM)

Extend `frontend/js/proposals/corridor-levels.js` (UMD, `window.__corridorLevels`, already loaded by
`index.html` and `backend/agents/mcp-geometry.js`):

- `LEVEL_HEIGHT_M = 6`, `RAMP_MAX_GRADE = { road: 0.08, rail: 0.04 }`, `LEVELS = [-1, 0, 1]`.
- `rampKindOf(profile)`: `'rail'` when the normalized profile has a `rail` strip and no `driving`/`bus`
  strip, else `'road'` (move `corridorProfileHoldsRadiusTarget` from road-drawing.js into
  corridor-profile.js as `corridorProfileIsRailOnly` and reuse it).
- `minRampLengthM(kind, levelDelta)` = `LEVEL_HEIGHT_M * |levelDelta| / RAMP_MAX_GRADE[kind]`.
- `rampIssue(from, to, kind, distanceM)` → `null` or `{ requiredM, actualM, shortfallM }` for one
  edge (`distanceM` is injected: `polylineLengthMeters`/metric frame in the browser, haversine in
  tests).
- `levelChangeIssues(segments, segIndex, pointIndex, level, { kind, distanceM, sharedNodes })` →
  the first refusal, as `{ code: 'junction' | 'ramp-too-short', ... }`. `junction` when the point is
  shared with another stretch or record (caller passes the node's target count).
- `isRamp(from, to)`, `edgeKindOf(from, to)` → `'surface' | 'elevated' | 'underground' | 'ramp'`
  (reuse `summarizeLevels`' classification), `levelAt(from, to, t)` (linear interpolation, for cut
  points). Heights in metres and formation offsets live in the 3D helper of step 8
  (`corridor-level-geometry.js`), which reads `LEVEL_HEIGHT_M` from here.
- Refusal copy lives with the callers (i18n), the module returns numbers only.

Tests: `backend/test/corridor-levels.test.js` (extend): 74 m refused / 75 m accepted at road,
149/150 at rail, |Δ|=2 doubles, junction refusal, `edgeKindOf`, `levelAt`.

## Step 2: level survives every path (the hazard list)

Make the field unconditional wherever points are rebuilt. Each is a one-to-three line change:

- `frontend/js/corridor-profile.js:1936–1941` (`corridorRenderPieces` cut points): interpolate with
  `levelAt` from the piece's neighbouring ORIGINAL points instead of requiring equal levels (today a
  cut point in a −1 run gets no level and the transition piece acquires land).
- `frontend/js/road-drawing.js`: the drawing session's `L.LatLng` points carry `level` as a plain
  property. `normalizeSeedSegments` (1782) copies it; `finishRoadDrawingOnce` `centerlineWithIds`
  (4515–4525) and `draftLatLng`/`saveCurrentCorridorDrawingDraft` (1602–1615) write it;
  `handleRoadClick` stamps the picker's level on each placed point; `insertRoadNodeOnEdge` (1945) and
  `findRoadSnapTarget` results copy the edge/vertex level; `resumeRoadSegment` keeps it (array
  reversal keeps objects); `snapshotRoadDrawingGeometry` also saves/restores `level`.
- `frontend/js/road-stroke-state.js:261–337` (`applyRoadConflictAnswers`): inserted portal and
  ramp-end points take the edge's level (building tunnels and pedestrian grade separations are only
  offered on level-0 edges; see step 5).
- `frontend/js/corridor-tunnel.js` `clipCorridorEdgeThroughBuildings` (452) / `makeBuildingTunnelRecord`
  (430) and `corridor-grade-separation.js` `buildGradeSeparationRecords` (123): carry the source
  edge's level onto the points they create.
- `frontend/js/proposals/create.js` 510–523 and 589–598: keep `level` when building points.
- `frontend/js/corridor-editor.js` `corridorEditorApplyFitShift` (1304) and
  `corridorEditorWriteScopedSegmentPoints` (1406): keep `level` per point.
- `frontend/js/corridor-geometry.js` `normalizeCorridorDefinitionTopology` (702): keep `level`
  (test-only caller, but it is exported).
- Finish stores the land through the level-aware builder: `finishRoadDrawingOnce` replaces its
  `buildRoadUnionPolygonWithWidths` result for the STORED polygon with
  `corridorSurfaceFootprintForDefinition(roadDrawingContext-like definition)` (the drawing preview can
  keep the union, but the record's land must skip −1 edges). Simplest: build the definition first,
  then `rebuildRoadDefinitionFootprint(definition)` as the edit path does, and use its polygon for
  `polygon`/`latLngPairs`; `recomputeLockedParcelsFromPolygon` reads the same polygon so the panel's
  parcel count matches the record.
- `backend/proposals/corridor-reconstruction-geojson.js` export (56–74): write `level` as a third
  coordinate? No: keep the OSM record as the carrier (import already prefers it). Leave as is.

Test: extend `backend/test/corridor-level-survival.test.js` with a drawing round trip through the
node harness (`backend/test/helpers/road-drawing-env.js`): seed a −1/0/+1 corridor, continue it, Finish,
assert `pendingRoadDrawingProposal.centerline` levels and that the stored polygon excludes the −1
edge; and a `corridorRenderPieces` taper on a −1 run whose cut points carry −1.

## Step 3: junctions only on the surface

- `frontend/js/corridor-geometry.js`: `insertCorridorCrossingNodes` `flatLevelOf` (60–65) returns a
  level only when both ends are 0 (currently "equal"); `snapDanglingCorridorEndpoints` (394–395)
  same; `canonicalizeCloseCorridorVertices` buckets stay per level (fine).
- `frontend/js/corridor-profile.js` `corridorJunctionsIn` (1749–1763): render-only T nodes only on
  level-0 spans; `junctionNeedsTreatment`/`buildCorridorJunctionSet` get only level-0 arms (cut entries
  with `corridorSurfaceRuns`-like splitting by `edgeKindOf === 'surface'`).
- `frontend/js/proposals/corridor-authoring.js` `sharedNodes` (230): a shared node counts only at
  level 0 (`pointLevel === 0`).
- `frontend/js/road-drawing.js` `findRoadSnapTarget` (1205): applied-corridor vertex/edge candidates at
  level ≠ 0 are skipped (filter in `corridorSnapSegmentsOf`/`appliedCorridorSnapSegments` by edge
  kind), and a local snap onto the drawing's own ±1 vertex/edge is allowed only as a RESUME of a
  stretch end (`atStart`/end), never as a branch or T: refuse with status
  `panel.road.junctionNeedsSurface` ("Junctions stay on the surface: this stretch is elevated/underground").
- `frontend/js/road-node-edit.js` `findNodeSnap` (469): drag-merge onto another road's node only when
  both are level 0; `edgeInsertionBlocked` unchanged (ramps already blocked).
- `frontend/js/corridor-network-nodes.js` / `appliedArmsMeetingDrawing` (road-drawing.js:1384): arms
  only at level 0.

Tests: `backend/test/corridor-geometry.test.js` (two +1 edges crossing → no node; +1 over 0 → no
node; 0 × 0 → node), `backend/test/corridor-authoring.test.js` (a +1 end touching a +1 road records
no junction), characterization test (snap onto an applied +1 node is refused with the status).

## Step 4: node editor: raise / lower

`frontend/js/road-node-edit.js`:
- Handle icons by level: `road-node-handle--elevated` (amber) and `--underground` (violet) classes
  (`handleIcon`, `junctionIcon`; CSS in `frontend/css/proposal-editor.css` next to 537–639).
- Plain click (853–868) on any node of the selected road that is NOT a junction (interior, loose end,
  boundary) opens `offerNodeChoice`; the choice list gains the level actions that apply: "Raise to +1"
  / "Lower to −1" / "Back to the surface" (keys `panel.road.raiseNode`, `lowerNode`,
  `surfaceNode`). Junction nodes keep no click action; their tooltip says junctions stay on the
  surface.
- `setNodeLevel(proposalKey, target, level)`: validates with `levelChangeIssues` (kind from the
  stretch's profile, `distanceM` = `polylineLengthMeters` of the two adjacent edges; junction = node has
  more than one target), refuses with `updateStatus(editHint('panel.road.rampTooShort', …,
  { required, actual, missing }))`; otherwise `mutateGeometry(key, def => set point.level)` so history
  (`recordHistory`) and `updateLocalCorridorGeometry` (footprint rebuild, parcel re-declaration, junction
  re-planning, revision of a published road) all run as for a drag.
- Drag commit: `commitNodeMove` adds the same ramp check for the moved node's adjacent edges
  (`levelChangeIssues` with the node's own level) BEFORE `updateLocalCorridorGeometry`; refuse → status +
  `discardLast()` + `refresh()` (fix the missing refresh on the early return at 675–678 while there).

Tests: `backend/test/road-node-edit.test.js` (choice 'raise' sets level and is undoable; refused on a
junction node; refused when the adjacent edge is 60 m at road grade with the shortfall in the status;
drag that shortens a ramp below 75 m is refused and the handle returns).

## Step 5: drawing panel picker and preview

- `frontend/index.html` `#road-drawing-controls` (1702–1710): a `.cb-segmented` row of three
  `aria-pressed` buttons `[data-road-level="-1|0|1"]`, labels `panel.road.levelUnderground` /
  `levelSurface` / `levelElevated` (−1 / 0 / +1 with a word), before the Undo/Done/Cancel actions.
- `road-drawing.js`: session field `roadDrawingLevel` (default 0, reset per session, bound in the
  test session). `setRoadDrawingLevel(level)` updates the buttons and the status hint.
  `handleRoadClick`: the new point gets `level = roadDrawingLevel`; before committing an edge, run
  `rampIssue(last, candidate, rampKindOf(activeProfile), distance)`; refuse with status
  `panel.road.rampTooShort` (same key as the node editor) and no point placed. A first point of a new
  stroke simply takes the level. Snapping onto an applied level-0 node while the picker is ±1 places
  the point at 0 (the snap target's level wins; status says so) so junctions stay on the surface.
- `handleRoadMouseMove`: the rubber band turns red (`#dc2626`, class `road-preview--refused`) when the
  pending edge would be a too-short ramp; the status shows "needs N m more".
- Building-tunnel and pedestrian-crossing detection (`detectRoadEdgeConflicts`) run only for level-0
  edges: a −1 edge is already under everything and a +1 edge over it. `applyRoadConflictAnswers` keeps
  portals/ramp ends at level 0.
- Seeded corridors: `seedRoadDrawing` keeps levels; `resumeRoadSegment` sets the picker to the resumed
  end's level (the next click continues flat unless the picker is changed).

Tests: characterization (`backend/test/road-drawing.characterization.test.js`): picker at +1 → 60 m
click refused with the shortfall, 80 m click accepted and the point carries `level: 1`; a −1 run's
land is excluded from the stored polygon and its parcels from the panel count; the rubber band class.

## Step 6: fully underground corridors (no land)

- `frontend/js/corridor-footprint.js` `footprintIn` (378): return `null` instead of throwing when no
  edge acquires. `rebuildRoadDefinitionFootprint` (road-drawing.js:723) stores `polygon: null`,
  `latLngPairs: null`; `corridor-authoring.js writeDefinition` (169) deletes `record.site` when the
  polygon is null; `runLocalCorridorGeometryUpdate` 891/922/1036 accept a null polygon when
  `acquiringSpans` is empty for that definition (helper `corridorTakesLand(definition)`); Finish
  (4465) accepts null the same way; `proposal-editor-shell.js:2197` guards null; `_takingFootprintOf`
  already returns null → takes nothing; `declareParcelsUnderRoadLand` already returns [] on null.
- 2D hover/selection: `corridor-render.js` hover outline (806) falls back to a centreline buffer
  (`buildRoadUnionPolygonWithWidths` of the whole centreline, not stored) when `polygon` is null.
- Server: `frontend/js/proposals/footprint-parts.js` (99–103) and `backend/routes/designs.js` (186–197):
  a road whose every edge is underground (`acquiringSpans` over the view's segments is empty) is
  neither `corridorUnprepared` nor `siteRequired`; its binding is empty with `coverage: 'none'`.
  `backend/proposals/footprint.js` reads the same rule. (Published fully-underground design = no land,
  no parcels, no owner consent needed.)
- MCP: `backend/agents/mcp-constructors.js validateTrackDesign` and `designObject` canonical checks
  accept the null polygon for such a corridor.

Tests: `backend/test/corridor-footprint.test.js` (null, not throw), `backend/test/road-edit-save.test.js`
(lowering the last surface node to −1 saves a record with no site and no parcels; raising it back
restores land), a `backend/test/designs-route*.test.js` case for the site-less underground design.

## Step 7: 2D rendering by level

`frontend/js/corridor-render.js` `buildCorridorRender` (1022) / `renderCorridorStrips` (491): split each
entry's points into runs by `edgeKindOf`:
- `surface`: as today.
- `elevated`: strips as today plus an amber (`#d97706`) outline polyline on both kerbs and short pier
  ticks every 30 m (reuse the overpass deck styling from `renderCorridorGradeSeparations`, 229).
- `ramp`: strips as today plus a dashed outline in the colour of the non-zero end (amber up, violet
  down) and a small ▲/▼ glyph marker at the midpoint.
- `underground`: NO strips; a dashed violet (`#6d28d9`, `8 7`) centreline at the corridor width, as
  `renderCorridorBuildingTunnels` (209) draws tunnels, with portal circle markers where a ramp meets
  the −1 run. Hit target stays the buffered centreline so the tunnel remains clickable.
While drawing (`road-drawing.js` `redrawRoadStrips`/`rebuildRoadGeometryFromSegments`): the same
split, so a −1 stretch is drawn dashed as it is placed.

Tests: `backend/test/corridor-render*.test.js` with the fake Leaflet (classes per run kind; no strip
polygons for an underground run; portal markers at the ramp ends).

## Step 8: 3D rendering

Principle: no second renderer. The level is a **deck offset layered on the existing ground
formation**. The terrain pipeline (`corridorFormationForPoints` → `buildFormation` →
`buildRuledStripPositions`/`heightAt`, `corridor-terrain-formation.js`) stays ground-only and
unchanged; a levelled run gets a derived copy of its formation with `station.z += 6 × level(s)`, and
every consumer that already takes a formation or `heightAt` (strips, `buildSurfaceRail3D` `zAt`,
decorations, markings, cut patches) is lifted at once. Registered terrain profiles
(`terrainProfilesOut`, junction heights, tunnel liners) stay at ground. Corridors without levels keep
today's flat path byte for byte.

- New pure module `frontend/js/proposals/corridor-level-geometry.js` (UMD `window.__corridorLevelGeometry`,
  loaded in `index.html` right after `proposals/corridor-levels.js`): `levelZ(level)`,
  `undergroundEdgeRecords(points, edgeKeyOf)` / `aboveGroundEdgeRecords(points, edgeKeyOf)` →
  `[{ edgeKey }]` (edgeKeyOf = `corridorTunnelEdgeKey`, injected), `offsetFormationByLevels(formation,
  points)` (clone stations, lerp the level between source-vertex anchors by station `s`; fallback to
  cumulative XY × `distanceScale`; returns the input when `!hasLevels`), `levelZAtXY(lineXYL, x, y)`.
- `three-mode.js buildCorridorStrips3D` (5250–5556): split runs with
  `gradeSpanRecords.concat(undergroundEdgeRecords(...))` via the existing `corridorSurfaceRuns`
  (5396–5398 and the junction-set entries 5315–5316) so underground edges are never drawn and never
  junction arms. Per record: `groundFormation = record.formation`, or in model mode, for levelled
  runs only, `corridorFormationForPoints(points, () => 0, …)` (add the `mercatorScale = lifeMercatorK()`
  fallback at 4209–4213 so model-mode ruled strips keep their width); `deckFormation =
  offsetFormationByLevels(groundFormation, points)`; use `deckFormation` for the strip (5485), rails
  (5482 → `zAt`), decorations (5496), markings (5504) and the `runTerrainHeightAt` closure (5475).
- Cut patches (5509–5521): split with `protectedRecords.concat(aboveGroundEdgeRecords(...))` and derive
  the cut formation from the deck, so level-0 runs carve as today, a descending ramp carves a trough,
  and viaducts carve nothing. `decideTerrainCorridorCommit` already accepts a zero-patch build.
- Viaduct: in `elevated-rail-3d.js` add pure `planCorridorViaduct(pointsXY, deckZAt, groundZAt,
  { widthM })` → `{ bays, piers }` (resample at 30 m; a bay where deck − ground ≥ 0.3 m; a pier where
  ≥ 3 m) and `buildCorridorViaduct3D(plan, { widthM })` → one Group of four `InstancedMesh`es (deck
  slab, pier shaft, cap, parapets ±(width/2 + 0.08)); instance rotation `(0, pitch, yaw, 'ZYX')`.
  In `three-mode.js` `addCorridorViaduct3D(group, points, deckFormation, groundFormation, profile)` and
  `addCorridorPortals3D(...)` (posts + lintel at each run end that `isUnderground`, the frame from
  `addBuildingTunnelLiners3D` 4970–4977); register instanced meshes for disposal (`ownInstances`,
  `markOwnedGeometry`) since `disposeTerrainCorridorGeometry` skips them.
- Model-mode trough: `groundCutFootprintFeatures` (3899) adds a buffered edge feature for each
  descending-ramp edge (`minLevel < 0`, not fully underground) so the parcel slab opens where the
  ramp dives; fully underground edges cut nothing.
- Life: `buildLifeGraph` (6646–6666): `zAt` adds `levelZAtXY` of the nearest levelled line; segments
  are split with `undergroundEdgeRecords` so no agent walks a tunnel; `life-graph.js addCorridor`
  (176) takes `offGround` runs as lanes only (no pedestrian bands: the walk surface has discrete Z).
- Edge fills (`buildCorridorEdgeFills3D` 5196): skip definitions with levels.
- Photo mode: carve stays on `definition.polygon` (already surface-only); trough side curtains for
  descending ramps are a known gap, deferred.
- Cache-bust `three-mode.js` and `elevated-rail-3d.js` `?v=` in `map-mode-loader.js`.

Tests: `backend/test/corridor-level-geometry.test.js` (levelZ, edge records on `[0,0,−1,−1,0]` and
`[0,1,1,0]`, `offsetFormationByLevels` over `buildFormation` with a zero sampler: z=3 at mid-ramp,
input untouched), `elevated-rail-3d.test.js` (`planCorridorViaduct`: 100 m flat +1 → 4 bays, 5 piers of
height 6 − deck − cap; 0→+1 ramp → piers only past the half-height point; level 0 → empty),
`life-graph.test.js` (`offGround` run has lanes, no bands), `corridor-level-survival.test.js`
(`corridorSurfaceRuns` with `undergroundEdgeRecords` equals `acquiringSpans` on the tunnel fixture).
Headed browser: a 0→+1→+1→0 road shows a linear ramp, slab, piers every 30 m from the half-height
point, parapets, markings and rails riding the deck, vehicles climbing it; a 0→−1→−1→0 road shows two
ramps into openings with portal frames and nothing between; an unlevelled road is unchanged.

## Step 9: MCP parity

- `backend/agents/mcp-companion.mjs` (15): point schema becomes `[lng, lat]` or `[lng, lat, level]`
  with `level ∈ {−1, 0, 1}`; `frontend/js/intent-design.js buildRoad` (52–62) carries the level onto
  the points; `modify` `streetPoints()` (133–149) carries it; a new `ugt_modify_design` change
  `{ type: 'set_level', nodeIndex | at: [lng, lat], level }`.
- Validation shared with the browser: `backend/agents/mcp-edit.js editedDesign` →
  `intent-editing.reconcile` (or `validateTrackDesign`) runs the ramp rule per edge and the
  surface-only junction rule, returning the same shortfall numbers as the UI
  (`corridor-levels.js levelChangeIssues` over the view).
- `docs/mcp-editing.md` and `mcp.md`: levels (`cb:level`), ramp presets, junction rule, `set_level`.
- Record how parity was verified in the handoff (`backend/test/mcp-edit.test.js`, `mcp-road-network.test.js`
  cases: a 3-point track with levels 0/1/1 and a 60 m first edge is refused; 100 m accepted).

## Step 10: docs and vocabulary

- `vocabulary.md` "Road junction": junctions only at level 0; new entries "Corridor level" (−1/0/+1,
  6 m, who takes land) and "Ramp" (one edge between levels, minimum length by mode).
- `corridor-elevation.md`: a dated status section recording these decisions and what shipped
  (slices 1, 2, 4 in the doc's order; vertical curves, grade presets table, spatial-rights components
  stay future).
- `MEMORY.md`: one line per decision (level height, ramp grades, surface-only junctions, −1 takes no
  land, fully underground allowed).
- Locales: every new `panel.road.*` key in en, es, sr, hr, fr, pt, ar (`backend/test/i18n-locale-coverage.test.js`).

## Verification

- Headless unit tests (targeted, typed paths): the files named per step plus
  `backend/test/road-drawing.characterization.test.js`, `road-node-edit.test.js`, `corridor-geometry.test.js`,
  `corridor-authoring.test.js`, `corridor-levels.test.js`, `corridor-level-survival.test.js`,
  `corridor-footprint.test.js`, `corridor-osm-form.test.js`, `mcp-edit.test.js`, `i18n-locale-coverage.test.js`.
  Each new test is checked red against a mutant of its fix (as done for the previous commit).
- Headed browser (own `agent-browser` session, backend `:4680`, frontend `:5680`,
  `?backend=http://localhost:4680&city=zagreb&at=45.8130,15.9770,18`):
  1. draw a road: 0 → picker +1 → short click refused (red band, status), long click accepted, +1 run,
     picker 0 → ramp down; Finish; the record's land excludes nothing (+1 takes land) and 3D shows the
     deck and piers; vehicles ride it.
  2. draw 0 → −1 → −1 → 0: 2D dashed tunnel with portals, parcels under the −1 run not declared, 3D
     shows only the two ramps.
  3. node editor: raise an interior node of an applied road, undo, lower the whole road to −1 (no site),
     raise one end back.
  4. draw a new road across the +1 run: no junction, no snap; across the 0 run: junction as before.
  5. MCP: `ugt_draft_track` with a `[lng, lat, 1]` point and a too-short first edge → refusal text.
- No full suites without a yes; report every run.
