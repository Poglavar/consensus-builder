# Schelling-point parcel plans

Where no parcel register can be loaded, a visitor is offered a third kind of ground besides a
register link and best-effort boundary recognition from satellite imagery: a parcel plan that
everybody derives on their own and still agrees on. A Schelling point is exactly that, a choice
people make independently because every input to it is already common knowledge. For a parcel plan the inputs have to be things nobody owns and anyone can
check: the graticule, a published rule of thumb, and arithmetic.

The screen that offers it is `frontend/js/parcels/ground-fallback.js`; the geometry is
`frontend/js/parcels/schelling-grid.js`, a pure module with no network, no Leaflet and no randomness,
so it runs the same in the browser and under node (`backend/test/schelling-grid.test.js`).

**Status (2026-10-16):** what follows the plan below describes what is built today, the fallback
ground. Work continues on branch `schelling-plan`, which turns it into a plan layer you can propose
from anywhere. This section is the living plan; update it as steps finish.

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

- **The intervention boundary is a set of cells.** Schelling fixes the lattice; where it applies is
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

1. **Layer.** Schelling plan layer in the layers panel with a settings panel: fixed values shown
   read-only with their reason; local street division, local street width and plot size
   adjustable; show arterials / local streets / blocks / plots. Settings in the address bar so a
   link shows what its author saw, remembered per viewer. Remove the parcel-source path.
2. **Propose roads.** Pick cells, then Propose: the bounding streets become an OSM form with
   arterial and local tags at exact widths (neither 30 m nor 12 m is a preset), through the corridor
   import (`recordsFromImport` → `createCorridorProposalAtomically`, as the block playground's
   Propose streets), one record per connected network, applied and ready to share as a plan.
   `UrbanBlocksPropose.importForm` takes one tag set today and needs per-way tags.
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

## When the visitor sees it

The official register is always attempted first. The fallback screen appears only when a viewport
fetch fails (`fetchParcelData` in `parcels/fetch.js` calls `ParcelGroundFallback.onGroundUnavailable`
and still rethrows) or when the city's config says there is no register at all
(`parcels.strategy: 'none'` raises a typed `no-register` error). The two cases are kept apart in the
wording, for the reason given in `unsurveyed-ground.md`: a failed request must never read as an empty
answer. Only a failure that looks temporary (network, 5xx, 408/429) gets a **Retry** button.

"Not now" closes the screen for the city for the rest of the session; the parcel refresh button asks
again. A choice made on the screen becomes the parcel source for that city for the browser tab
(`sessionStorage`), so a reload keeps the plan that proposals may already stand on, while a new visit
attempts the register afresh.

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

The four assumptions (arterial spacing and width, local street width, target block face) can be
adjusted on the screen; the plan code records them, e.g. `45x30-8x8-30-12@46N`.

### The tiling

Cell (i, j) lies between meridian lines L_i and L_{i+1} and parallel lines P_j and P_{j+1}. It is
covered by exactly three parcels, none overlapping:

| id | what | extent |
|---|---|---|
| `MP:<code>:B:i:j` | the block | the cell inset by the half right-of-way of each bounding line |
| `MP:<code>:EW:i:j` | the east–west street segment on P_j | from L_i − hw to L_{i+1} − hw, so it owns the intersection at its western end |
| `MP:<code>:NS:i:j` | the north–south street segment on L_i | between the two east–west strips |

Their union is the box [L_i − hw_i, L_{i+1} − hw_{i+1}] × [P_j − hw_j, P_{j+1} − hw_{j+1}], and those
boxes tile the plane as i and j run: all land is in some parcel and no two parcels overlap, which is
what the rest of the app assumes of ground. Street parcels carry `isRoad: true` and a `roadClass`
(`arterial` or `local`) and are registered with `addRoadParcel`, so block detection sees them as
corridors. Every feature is stamped `provenance: 'schelling-point'` and `estimated: true`.

Because the geometry is a pure function of indices, a parcel is identical whichever viewport asked
for it (the per-cell transport dedupes by id and would reject two versions of one parcel), and a
parcel can be rebuilt from its id alone (`featureForId`), which is how `ensureIds` is answered.

## What it is not

It is not a cadastre and is never labelled as one. Ownership lookups, minting and publishing to the
backend all assume real cadastral ids; the screen says so. The parcels live in the browser for the
session. Nothing here writes to the world-parcel registry.

## The second algorithm, planned

**Elevation contours (isohypses):** streets along contour lines at an agreed vertical interval,
cross-streets along lines of steepest descent, blocks between them. It needs a terrain source the
visitor can also obtain (a public DEM), so it waits on the terrain work in `elevation-realism.md`.
The screen lists it as planned. Adding it means a second module alongside `schelling-grid.js` with
the same contract (`planFor`, `featuresInBbox`, `featureForId`, `describe`) and a second
`schellingSource` in `ground-fallback.js`.
