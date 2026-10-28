# Road in a parcel: a corridor bounded by its site (plan)

Open plan, not started. The decisions it still needs are at the end.

## Problem

Some ground is already set aside for a road before any road is drawn: the street strips a Schelling
layout leaves between its plots (`parcel-layout-layouts.js`, plots of source `schelling-remainder`),
a road reservation in a land readjustment, a cadastral road parcel, any polygon a plan keeps for a
street. Drawing a road into such a parcel by hand is pointless and never fits exactly.

Today a road's land is what its lanes cut ([vocabulary](vocabulary.md), "Corridor"; [roads](../cadastre-data/roads.md)):
the author draws a centreline, picks a cross-section, and the footprint takes strips of whatever
parcels it crosses. This plan adds the inverse: **the land is given, the lanes are fitted into it, and
nothing outside the parcel is taken.**

## The model: a bounded road

A **bounded road** (or track) is an ordinary corridor record whose `site` is a given polygon:

- Its footprint **is** its site. It takes the site's parcel(s) whole; the parcel arrangement needs no
  cutting (piece = parcel) and consent comes from that parcel's owner only.
- The stored shape stays the OSM document (`definition.osm`, [road editor](road-editor.md) P6) plus the site.
  The relation `cb:bounded=yes` marks it; the footprint builder returns the site for such a definition
  instead of the lane cut.
- The chosen lanes must fit inside the site; the strips at the edges fill the rest to the boundary.
- A cross-section edit can never change the land. An edit whose core no longer fits is refused with
  the widest preset that does.
- Node edits move the centreline inside the site only; a node dragged out of the site is refused.
  Levels (`cb:level`) stay 0 in the first version.

The same record, footprint, junction, parcel-declaration, 2D, 3D, agreement and MCP machinery serve
it; the differences are one footprint rule, one derivation step (centreline from site) and one fill
rule (edge strips to the boundary).

## Cross-section: fixed core, elastic edges

Like a real street, the kerb-to-kerb width is constant and the building line wanders.

- **Core** = every strip the author chose: driving, bus, rail, cycleway, parking, median. One core per
  arm (graph edge); arms may differ, as one Schelling network already carries arterial and local ways
  with their own lane tags (`schelling-streets.js importForm`).
- **Edge strips** fill the remaining width on each side in a fixed order:

| Order | Strip | Rule |
| --- | --- | --- |
| 1 | Sidewalk | from a minimum of 1.5 m up to a cap of 4 m |
| 2 | Verge | takes everything beyond the cap; `grass` under 2.5 m, `trees` from 2.5 m |

  Without the cap a 25 m parcel with a 7 m carriageway gets 9 m pavements; with it, a tree verge.
- **Fit**: required width = core + 2 × sidewalk minimum. Available width per arm = the sustained
  minimum of the perpendicular samples from `corridor-clearance.js` run against the site boundary
  (samples within one width of a junction node are skipped: their rays run down the cross street).
  Measured per arm, not per parcel, so a grid's lanes never shrink its boulevard.
- **Presets** by available width generalise `localStrips(widthM)`: 2 lanes at 2.75 m under 10 m,
  3.25 m from 10 m, parking from 14 m, cycleways from 18 m, the arterial preset from 30 m. The author
  picks any preset or a custom core; the tool names the widest that fits.
- **Too narrow** for one lane plus sidewalks (under about 6 m): a shared surface (one `driving` lane,
  `highway=living_street`, no sidewalks) or a refusal.
- **Pinch** inside an arm (a notch, a narrowing): the first version refuses and marks the station,
  as the clearance tab marks its pinch point; the author splits the arm there in the node editor and
  the two arms fit separately.

## Centreline: ports first, shape second

A road parcel exists to connect things. Its orientation comes from its **ports**, the stretches of the
site boundary that touch another road (an OSM street within 1 m, an applied or proposed corridor's
footprint, another bounded road's site); the author may add or remove a port by clicking the
boundary. The shape of the parcel decides only when it has no ports.

Derivation, in the metric frame ([projections](projections.md)), as one pure module:

1. **Known axes short-circuit.** When the caller knows the centrelines (the Schelling lattice lines),
   clip them to the site and skip extraction. The arms, nodes and ports follow directly.
2. **Medial axis** otherwise: Voronoi of the densified boundary (add `delaunator`, 6 kB; Turf has no
   skeleton), keep the edges whose both vertices lie inside the polygon, prune leaves shorter than
   the local width (corner spurs), **collapse every node cluster smaller than the local width into one
   node** (the medial axis of a square crossing is its diagonals; collapsed, it is one junction node
   with four arms), extend each remaining leaf to the nearest port midpoint and on to the boundary so
   the outside junction snaps as today, straighten runs that bend under 2°, simplify at 0.3 m.
3. **Leaves that reach no port** stay as dead ends (a cul-de-sac; the fill rule makes its turning head)
   when they are longer than the local width, otherwise they are pruned.

What that gives:

| Site | Ports | Centreline |
| --- | --- | --- |
| Strip | both ends | one arm, centred |
| L or T strip | ends | arms with one bend or one node |
| Grid with holes | arms at the plan boundary | the arm graph with a node at every crossing; self-crossing is just a graph, as the corridor model already normalises |
| Square | two opposite sides | straight across |
| Square | two adjacent sides | one bend |
| Square | three or four sides | a junction: a cross with a centre node |
| Square | none | not a road: offer the long axis of the minimum bounding rectangle; a true square has none, so ask between the two orientations parallel to the nearest street. Never the diagonal: it leaves two triangles of verge the size of the road |

Fallback without the dependency, for strips only: the port-to-port straight line relaxed to the
middle with the clearance samples (shift each station by half the difference of its right and left
clearances, resample, repeat). It has no topology, so grids need the medial axis.

## Rendering

- 2D: the core strips draw as today along the arms. Sidewalk and verge are not offset strips but **one
  polygon: the site minus the union of the core buffers**, with the kerb at the core edge. For a grid
  that polygon wraps every block, corners and turning heads included, for free. For lane semantics
  (which side, which arm) the polygon is split by the arms; the drawing stays one multipolygon.
- 3D: the ground pipeline paves the core as today; the fill polygon gets sidewalk and verge material,
  the kerb at the core edge, trees where the verge is wide enough. People walk the fill polygon,
  vehicles the lanes, unchanged.
- Hover and selection use the site.

## Schelling: the first consumer

The two Schelling surfaces differ:

- **The standalone layer** ([schelling plans](schelling-parcels.md)) already proposes roads: painted
  blocks become the lattice streets that bound them, in OSM form (`schelling-streets.js`), through the
  corridor import. Their land is the lane cut of the plan widths (12 m local, 30 m arterial). This stays.
- **The parcel layout's "Schelling" algorithm** (`parcel-layout.js`, `parcel-layout-layouts.js
  schellingPlots`) makes plots only; the street strips are plots of source `schelling-remainder`,
  drawn as red-outlined slivers, and a layout drawn over road land can never apply.

The port: the layout's remainder becomes bounded roads. The streets are the lattice lines of the cells
the pool touches (`streetsOf`), clipped to the pool (step 1, known axes), the site is the union of the
remainder plots, the profiles come from `profileFor` and are fitted; the remainder is the plan width,
so the fit is immediate, and where the pool boundary clips a strip narrower, the fit narrows that arm.
Per the plan of record, roads come first and blocks are what roads leave: the road records replace
the remainder plots in the design, the plots stay. Both surfaces then share `schelling-streets.js`
for the streets and `corridor-import.js` for the records; only the footprint rule differs.

## MCP parity

- The road constructor accepts `site` (a polygon or parcel ids) with optional `axes`, and no points:
  the same pure module derives the centreline on the server (`mcp-geometry.js` already loads the
  proposal modules). The result reports the fit per arm (available width, preset chosen).
- Edits go through `ugt_modify_design` as today; a change that would alter the land of a bounded
  road is refused with the same message as in the browser.
- Discovery lists the presets and the fill rule. [MCP editing](mcp-editing.md) gains a section.

## Pure modules and tests

- `frontend/js/proposals/corridor-site-centreline.js`: ports, medial axis, pruning, cluster collapse,
  port extension, straightening. `backend/test/corridor-site-centreline.test.js`: strip, L, a 3 × 3 grid
  with holes (12 arms, 4 inner nodes, no diagonals), a square with two, three and four ports, a
  cul-de-sac, a notch that stays a leaf-free boundary.
- `frontend/js/proposals/corridor-site-fit.js`: available width per arm, preset ladder, fill strips.
  Tests: 12 m gives 2 × 3.25 m lanes and 2.75 m sidewalks; 30 m gives the arterial preset with verges;
  6 m gives the shared surface; 25 m with a 9 m pinch refuses and names the station.
- Footprint rule: `backend/test/corridor-footprint.test.js` gains the bounded case (footprint equals
  site, parcels declared are the site's, lane edits leave the polygon unchanged).
- Schelling layout port: `backend/test/schelling-layout-roads.test.js`: a pool over 2 × 2 cells yields
  one road network of 12 arms whose site equals the remainder union; a pool cut at a street edge yields
  a narrower boundary arm with a smaller preset.
- Headed check: lay out a Schelling pool, propose its roads, see the kerbs follow the plot corners,
  vehicles on the lanes, no parcel outside the pool declared.

## Decisions to take

1. Sidewalk cap with a verge for the overflow (recommended), or the sidewalk takes everything.
2. A pinch refuses (recommended first) or splits the arm automatically.
3. An isolated square refuses as "not a road" or asks for the orientation (recommended).
4. The Schelling layout emits its roads on a "Propose roads" action in the layout, or when the
   layout is saved as a design.
5. `delaunator` as a dependency for the medial axis, or the strip-only relaxation first.
