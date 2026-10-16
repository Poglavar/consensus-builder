# Schelling-point plans: roads, blocks and plots

A plan for streets, blocks and plots that everybody derives on their own and still agrees on. A
Schelling point is exactly that, a choice people make independently because every input to it is
already common knowledge. For a plan the inputs have to be things nobody owns and anyone can check:
the graticule, a published rule of thumb, and arithmetic.

The geometry is `frontend/js/parcels/schelling-grid.js`, a pure module with no network, no Leaflet
and no randomness, so it runs the same in the browser and under node
(`backend/test/schelling-grid.test.js`). The layer, its settings and the painting tool are in
`frontend/js/schelling/`.

**Status (2026-10-16, branch `schelling-plan`):** steps 1 and 2 below are built: the plan is a layer
in every city with its settings, and painted blocks become road proposals. Plots are drawn but not
yet proposable. This section is the living plan; update it as steps finish.

## Plan of record (2026-10-16)

### Decisions

- **A plan, not ground.** Schelling stops being a parcel source that replaces the register. It
  becomes a map layer in every city, drawn over the real map and real parcels, with defaults and
  its own settings (not an on/off toggle). The parcel-source path (`schellingSource`, its
  `installSource`/`sessionStorage` restore, `MP:` ids standing in as parcels) is removed: a proposal
  declared on `MP:` ids cannot publish, because the declaration must equal the server's binding
  against the real cadastre (`PARCEL-OPTIONAL.md` rule 3). Where there is no register, proposals
  bind as open ground, which is built. The fallback screen's Schelling option turns the layer on.
- **A Schelling grid is not a grid.** Both may exist, as separate tools on one pipeline, strictly
  apart:

  | | Schelling grid | Grid |
  |---|---|---|
  | Frame | the graticule: meridians and parallels, anchored at whole degrees | the author's: origin, rotation, spacings in metres |
  | Fixed | the arterial lattice: the arcsecond step nearest 1 km, 30 m arterials | nothing |
  | Settings | local street division, local street width, plot size | everything |
  | Moving | not possible; a moved Schelling network becomes a grid | free: drag, rotate |
  | Identity | every street, block and plot has an id anyone can derive from the plan code | the proposal's own |
  | Provenance | `schelling-point` | `grid` |

  Arterial spacing and width therefore leave the Schelling settings; they are settings of the grid.
- **Alignment is possible, not mandatory.** Two Schelling proposals always meet on the same
  arterials because the lattice is global; nothing enforces reuse of a shared street. Different
  proposals are aligned by hand (Move network, below) or not at all.
- **Roads first, blocks are what roads leave.** Roads are the only takers
  (`parcel-arrangement.js`), so blocks are never proposed; streets are road proposals and plots are
  a subdivision (open ground) or a land readjustment layout (real parcels).

### Proposed, to confirm

- **The intervention boundary is a set of cells** (user, 2026-10-16: "let's try first the painted
  cells and see how it goes"). Schelling fixes the lattice; where it applies is
  the proposal, the part people argue and bet about. The author paints Schelling blocks on and off;
  drawing a polygon is a quick way to paint (a block is in when its centre is inside); "this
  superblock" is the default selection; helpers may pre-clear blocks with existing buildings, roads
  or water. The output is the chosen blocks and every street that bounds one, so the edge of an
  intervention is always a street: no partial blocks, no streets ending mid-block. A cap on blocks
  per proposal (start at one superblock, 64 blocks) holds until a large network is measured.
- **Move network** for unpublished road proposals: drag moves the whole connected network, a handle
  rotates it about its centre, land and declared parcels re-derive as for a node drag. Only the
  proposal's own network, never existing city roads; a size cap applies. Moving a Schelling network
  switches its provenance to `grid`, with a notice, and Undo returns it.
- **Plot rule** (from the codex exploration of 2026-10-11): plots face the north and south streets
  of their block, the two rows meet on the block's middle parallel, and each row's frontage is halved
  k times. Every block has a street on both sides, so no tie-break is needed, corners included.
  Default 1/16 block (k = 3): about 13.6 × 52 m at 46°N. A larger plot is exactly two neighbours.
  Plot id: block id + row + halving path, e.g. `B:i:j/N/011`.

### Steps

1. **Layer. Built.** A "Schelling plan" section in the Layers sheet (`schelling-layer.js`): Show,
   the fixed arterials stated with their reason, local street spacing (block face 60–240 m) and
   width (8–20 m), plot size (whole blocks to 1/64), the plan code and "Why these numbers". The map
   draws arterials only below z15, streets and blocks from z15, plots from z17, in its own pane
   that never takes clicks. Settings live in the address bar as `?schelling=<block>-<street>-<plot
   denominator>` (`schelling-settings.js`, e.g. `120-12-16`) and are remembered per viewer. The
   parcel-source path is removed; the fallback screen's option is now "Use the Schelling plan",
   which turns the layer on.
2. **Propose roads. Built.** "Propose from this plan" opens an on-map tool (`schelling-propose.js`):
   the superblock at the map centre is chosen, a press or a drag over blocks adds or removes them
   (mouse and touch, from z15), "This superblock" and "Clear", a summary of blocks, streets and
   kilometres, and **Propose roads**. `schelling-streets.js` turns the chosen blocks into the
   streets that bound them (each lattice line's consecutive edges one way, every lattice node on
   it, so crossings share nodes), with exact-width cross-sections: a fixed 30 m arterial and a
   local street of the chosen width. The corridor import makes one record per connected network
   (`source: 'schelling-point'`), applied and ready to share as a plan. The create loop is shared
   with the file import and the block playground (`corridor-import.js createRoadRecords`), which now
   loads the ground under a road's land before declaring the parcels it reaches: proposed from
   below the parcel zoom, a road used to declare none of the parcels it took.
3. **Propose plots.** The plot rule as a layout: in Subdivide on open ground (pool = the site,
   plots to public land, execution through a lens verdict), and as a Layout option in land
   readjustment on real parcels, entered from the layer ("Subdivide / readjust this block") or from
   the LR editor.
4. **Move network** for draft road networks.
5. **Grid tool** on the same pipeline with a free frame.

### Open questions

- On real parcels a Schelling block cuts through parcels, while a readjustment reforms whole
  parcels: the pool must be every parcel the block touches, and what lies outside the block comes
  back as plots too.
- Whether a readjustment can pool the pieces left by a road proposal that has not executed.
- What a superblock's interior (about 49 crossings and 28 T junctions at 8 × 8) costs as one road
  record; measure before raising the cap.

## Where the visitor finds it

Layers → **Schelling plan**, in every city, or a link carrying `?schelling=`. Where no parcel
register can be loaded, the fallback screen (`parcels/ground-fallback.js`) offers **Use the
Schelling plan** beside a register link and boundary recognition from imagery; it turns the same
layer on, and what is proposed from it stands on open ground.

## Meridians and parallels

Three agreed inputs:

1. **The graticule.** Meridians and parallels are fixed by the Equator and Greenwich.
2. **Angel's arterial grid.** Shlomo Angel and colleagues (*Making Room for a Planet of Cities*,
   Lincoln Institute, 2011, and the urban-expansion programmes that followed in Ethiopia and
   Colombia) argue that a growing city should fix its arterial roads before the land is built on:
   about 30 m wide and about 1 km apart, so every point is within a ten-minute walk of a road that
   can carry public transport. The smaller streets are left to fill in the kilometre squares.
3. **Integer division.** Each superblock is cut into n × m equal cells by local streets.

The plan for a place is computed, not asserted, and the explainer shows the computation:

- The reference latitude is the map centre **rounded to a whole degree**. That rounding is itself a
  Schelling point: two people looking at different corners of the same city get the same plan. The
  cosine drift across half a degree changes a 12 m street by centimetres.
- One arcsecond of latitude and of longitude at that parallel is converted to metres on WGS84.
- Arterial spacing is the step on a **ladder of arcseconds that divide a degree evenly**
  (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 36, 40, 45, 60, …) whose length is closest, by ratio, to the
  1 km target. At the 46th parallel that is every 30″ of latitude (926 m) and every 45″ of longitude
  (968 m). The lines are anchored at whole degrees, so they are the same whichever degree you count from.
- The superblock is divided into the integer number of cells whose face is nearest the target
  block (120 m by default): 8 × 8 there, cells of 121 × 116 m, blocks of 109 × 104 m once the local
  streets (12 m) take their half-width from each side.
- The explainer also names the arterials nearest the map centre in degrees, minutes and seconds
  ("45° 48′ 30″ N", "15° 58′ 30″ E") and how far away they are.

The arterial lattice is fixed. The local street width and the target block face can be set; the
plan code records the lattice and the local streets, e.g. `45x30-8x8-30-12@46N`. A view across a
half-degree parallel draws each side from its own band's plan (`inBands`).

### The tiling

Cell (i, j) lies between meridian lines L_i and L_{i+1} and parallel lines P_j and P_{j+1}. It is
covered by exactly three parcels, none overlapping:

| id | what | extent |
|---|---|---|
| `MP:<code>:B:i:j` | the block | the cell inset by the half right-of-way of each bounding line |
| `MP:<code>:EW:i:j` | the east–west street segment on P_j | from L_i − hw to L_{i+1} − hw, so it owns the intersection at its western end |
| `MP:<code>:NS:i:j` | the north–south street segment on L_i | between the two east–west strips |

Their union is the box [L_i − hw_i, L_{i+1} − hw_{i+1}] × [P_j − hw_j, P_{j+1} − hw_{j+1}], and those
boxes tile the plane as i and j run: all land is in some piece and no two pieces overlap. Street
pieces carry `isRoad: true` and a `roadClass` (`arterial` or `local`). Every feature is stamped
`provenance: 'schelling-point'` and `estimated: true`.

Because the geometry is a pure function of indices, a piece is identical whichever viewport asked
for it, and it can be rebuilt from its id alone (`featureForId`). Plots extend the ids with the row
and the halving path (`MP:<code>:B:i:j/N/011`, `plotsOfBlock`).

## What it is not

It is not a cadastre and is never labelled as one, and its pieces are not ground: nothing is
proposed on `MP:` ids. What is proposed from it is ordinary road proposals on the real ground (the
register's parcels, or open ground where there is none). Nothing here writes to the world-parcel
registry.

## The second algorithm, planned

**Elevation contours (isohypses):** streets along contour lines at an agreed vertical interval,
cross-streets along lines of steepest descent, blocks between them. It needs a terrain source the
visitor can also obtain (a public DEM), so it waits on the terrain work in `elevation-realism.md`.
Adding it means a second module alongside `schelling-grid.js` with the same contract (`planFor`,
`featuresInBbox`, `cellsInBbox`, `describe`) and a choice of algorithm in the layer.
