# 3D ground: streets and pavement in model mode

## Goal

The simplified 3D ("model") view had no ground between buildings: in a city without cadastral
parcels (New York, Belgrade, …) the buildings stood on the page background, and in Zagreb the
cadastral road parcels were uniform light slabs. Draw the streets so the schematic cars have an
asphalt roadbed to drive on and the people a pavement to walk on, from OSM, with nothing fancy:
no Station3D world, no textures, no per-frame work, so loading and frame time stay where they are.

## Design

The rule the user set: the OSM centreline anchors the roadbed; lanes and widths make the car part;
everything else is pavement up to the buildings.

- The carriageway list already exists: `frontend/js/life/life-graph.js` derives, per OSM street,
  the centreline and a half-width from `lanes`, `width` and the class defaults (`LANE_WIDTH_M`
  3.5 m, right-hand traffic, oneway respected), plus the applied corridors' carriageways. The
  ground is laid from that same list, so the asphalt is exactly the surface the vehicles drive on.
- `frontend/js/life/ground-geometry.js` (pure, vitest): one triangle list for the roadbed, a
  mitred ribbon per carriageway (split at bends sharper than 2 × half-width, a disc rounds them), a
  disc as wide as the widest way at every node where a way ends on another way (junction corners),
  square dead ends, every triangle wound counter-clockwise so a front-side material never culls an
  inner bend; and one quad for the pavement plane over the scene bounds (the building band plus
  the view). Typed arrays out.
- `frontend/js/three-ground.js`: `MeshLambertMaterial` meshes, no textures, mounted with scale
  (k, k, 1) in true metres like the life group. The pavement (+3 polygon offset) is coplanar with
  the parcel slabs and stays under them; park, square and proposal grounds (−2 and beyond), water
  (0.04) and corridor strips (z 0.05) stay on top of everything.
- Sunk roads: an OSM carriageway is sunk `KERB_M` = 0.15 m (life-graph.js; the corridor sidewalk height)
  below the pavement, so the parcel slabs and the pavement plane at z 0 need holes over it. No
  polygon booleans: the roadbed's *lid* (the same triangles at pavement level) is drawn first
  into the stencil buffer only (bit 0x02; the ghost-building pass owns ref 1 but runs in the
  transparent list, after every opaque surface), and the pavement material plus the two shared
  parcel-slab materials skip the pixels it marked (`cutHoles`). Depth does the rest: the kerb
  wall on the far side of a street is visible, the near pavement edge hides the trench behind
  it. The lid, not the sunk floor, defines the hole, so the floor's parallax overhang is hidden
  by the nearer pavement instead of punching through it.
- Kerb walls: vertical quads along every ribbon edge, dead-end cap and disc rim, sampled every
  1 m against an index of all asphalt (segment strips, join discs, junction discs); runs outside
  all other asphalt become walls and each run end is bisected onto the asphalt boundary (±3 cm),
  so a side street opens the main street's kerb exactly across its own width and its own kerb
  starts at the main street's edge. Sharp bends (mitre > 2 × half-width) split the ribbon
  and round the join with a disc instead of capping the mitre. Corridor carriageways keep drop 0 (their strips draw their own kerbs) and get no
  walls; a junction disc takes the deepest drop of the ways meeting there.
- Life follows: OSM drive lanes get `zLift` −0.15 so the vehicles sit on the asphalt, and the
  walkable grid paints OSM carriageways with `ZCODE.ROAD` (`Z_LEVELS` −0.15) so people step
  down to cross. The kerb colour is darker than asphalt and pavement: a sunlit vertical face
  renders brighter than a flat one and a light kerb read as a white line.
- Lane lines: the carriageway entry carries the life graph's lane layout (`lanes: [{offset, dir}]`, left-positive of the carriageway
  centre), and every boundary between two adjacent lanes gets a 12 cm line 1 cm above the
  asphalt: solid between opposing directions (the centre line), dashed 3 m on / 6 m off between
  lanes of one direction. The same run-finder that clips the kerb clips the lines, skipping the
  way's own asphalt, so lines stop at every junction disc and under every other street. A single
  lane paints nothing. Pulled forward by polygon offset so they never sink into the asphalt at
  distance. Fifth draw call.
- Asphalt 0x5b5d61 and a paving pattern on the sidewalks: no texture
  image, a shader patch (`paveTexture`) on the pavement material and on the cadastral road-parcel
  material (scaled back from scene units to metres by 1/k) draws 1.5 m slabs with a thin darker
  joint and a faint per-slab tint from the mesh's local XY. The joint is anti-aliased over one
  pixel and its weight shrinks once a pixel outgrows it, so distant pavement settles to a flat
  tone instead of moiré.
- three-mode.js: the ground rebuilds whenever the life layer rebuilds (same graph, one build), and
  builds its own graph when the life layer is off; the `/osm-road` fetch runs when either layer
  is on. Toggle "Streets and pavement" in the model-mode layer panel (`cb_3d_ground_enabled`,
  default on, `?ground=0|1` override), hidden in photo mode, disposed with the scene.
  `getThreeModeInternals().groundStats()` reports draw calls, ways, junctions, triangles, asphalt m².

| Budget | Value |
|---|---|
| Draw calls added | 5 (lid stencil, roadbed, kerb, lane lines, pavement) |
| Per-frame work | none |
| Build (Zagreb station, 183 carriageways, flat) | 10 ms |
| Build (Lower Manhattan, 429 carriageways, 9,082 triangles, flat) | 38 ms |
| Build with kerbs (Lower Manhattan z18, 61.7 km kerb, 10,140 wall triangles) | 60 ms |
| Build with kerbs (Zagreb station z19, 84 carriageways, 12.2 km kerb) | ~15 ms |
| Lane lines (Lower Manhattan z20, 305 carriageways) | 7.4 km, 3,536 triangles |
| Lane lines (Zagreb station z19) | 3.5 km, 1,618 triangles |

## Open

- User review of the kerb (0.15 m, colour), the line style (white only, dashed separators, solid
  centre line) and the slab size (1.5 m).

## Deferred

- Kerb corners are approximate: the asphalt index treats a mitred join as a disc of the
  half-width, so another way's kerb crossing a mitre wedge beyond that radius keeps a stub;
  junction discs are as wide as the widest way, so a wide side street on a narrow main street
  bulges past the far kerb (the roadbed already did). Where OSM and the cadastre disagree the
  trench cuts visibly through a plot slab's edge.
- The Zagreb WFS road-use polygons (z 0.3) share the road-parcel material, so they get the same
  stencil holes where OSM asphalt runs under them.
- Stencil holes are screen-space: a pavement sheet seen exactly edge-on has no thickness.
- Lines are one colour and one style per boundary: no yellow centre lines (US), no double lines,
  no stop lines or arrows, no edge lines (the kerb is the edge). A main street's centre line
  breaks across the junction disc at every side-street T, as the disc is as wide as the street.
- Zagreb's cadastral parcels load late and unevenly in this dev setup (0, 202 or 356 lot slabs on
  three loads of the same view); not touched here.
- `service` roads, parking aisles and footway paving: the carriageway list is only the driveable
  classes the vehicles use, so driveways and parking lots are pavement for now.
- Grade separation of OSM bridges and ramps: everything is at z 0 (the Brooklyn Bridge approaches
  draw flat). The corridor carriageways carry their grade-separation z already.
- Photo mode: the ground is hidden there; the tiles are the ground.
