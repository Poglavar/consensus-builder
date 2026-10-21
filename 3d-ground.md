# 3D ground: streets and pavement in model mode

Living plan for branch `3d-ground` (worktree `consensus-builder-3d-ground`, off `colosseum-worlds-fair`
f45d064b, 2026-10-21). Update the status marks as steps land.

## Goal

The simplified 3D ("model") view had no ground between buildings: in a city without cadastral
parcels (New York, Belgrade, …) the buildings stood on the page background, and in Zagreb the
cadastral road parcels were uniform light slabs. Draw the streets so the schematic cars have an
asphalt roadbed to drive on and the people a pavement to walk on, from OSM, with nothing fancy:
no Station3D world, no textures, no per-frame work, so loading and frame time stay where they are.

## Design (built 2026-10-21)

The rule the user set: the OSM centreline anchors the roadbed; lanes and widths make the car part;
everything else is pavement up to the buildings.

- The carriageway list already exists: `frontend/js/life/life-graph.js` derives, per OSM street,
  the centreline and a half-width from `lanes`, `width` and the class defaults (`LANE_WIDTH_M`
  3.5 m, right-hand traffic, oneway respected), plus the applied corridors' carriageways. The
  ground is laid from that same list, so the asphalt is exactly the surface the vehicles drive on.
- `frontend/js/life/ground-geometry.js` (pure, vitest): one triangle list for the roadbed, a
  mitred ribbon per carriageway (mitres capped at 2 × half-width, a disc rounds sharper bends), a
  disc as wide as the widest way at every node where a way ends on another way (junction corners),
  square dead ends, every triangle wound counter-clockwise so a front-side material never culls an
  inner bend; and one quad for the pavement plane over the scene bounds (the building band plus
  the view). Typed arrays out.
- `frontend/js/three-ground.js`: two `MeshLambertMaterial` meshes at z 0, no textures. Depth order
  by polygon offset: asphalt (−1) draws over the parcel slabs (0), so a cadastral road parcel shows
  its carriageway and the rest of it reads as sidewalk; park, square and proposal grounds (−2 and
  beyond), water (0.04) and corridor strips (z 0.05) stay on top; the pavement (+3) stays under
  everything and only shows where no parcel is drawn. Mounted with scale (k, k, 1) in true metres
  like the life group.
- three-mode.js: the ground rebuilds whenever the life layer rebuilds (same graph, one build), and
  builds its own graph when the life layer is off; the `/osm-road` fetch now runs when either layer
  is on. Toggle "Streets and pavement" in the model-mode layer panel (`cb_3d_ground_enabled`,
  default on, `?ground=0|1` override), hidden in photo mode, disposed with the scene.
  `getThreeModeInternals().groundStats()` reports draw calls, ways, junctions, triangles, asphalt m².

| Budget | Value |
|---|---|
| Draw calls added | 2 |
| Per-frame work | none |
| Build (Zagreb station, 183 carriageways) | 10 ms |
| Build (Lower Manhattan, 429 carriageways, 9,082 triangles) | 38 ms |

## Phases

- [x] P1 Pure geometry module + renderer with tests (14 tests).
- [x] P2 Wired into model mode with the toggle, i18n (en/hr/sr/es) and the OSM fetch gate.
- [x] P3 Browser check in a launched Chrome: New York (streets between the PLUTO blocks) and Zagreb
      (asphalt inside the cadastral road parcels); no page errors.
- [ ] P4 User review of colours and the draw order (asphalt over parcel slabs).

## Deferred

- Kerbs. A raised pavement needs holes in the plane (stencil) and a kerb skirt, and the parcel
  slabs at z 0 would have to move with it; a dark kerb strip along the ribbon edge would cross
  junctions unless clipped. Two flat colours first.
- `service` roads, parking aisles and footway paving: the carriageway list is only the driveable
  classes the vehicles use, so driveways and parking lots are pavement for now.
- Grade separation of OSM bridges and ramps: everything is at z 0 (the Brooklyn Bridge approaches
  draw flat). The corridor carriageways carry their grade-separation z already.
- Photo mode: the ground is hidden there; the tiles are the ground.
