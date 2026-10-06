# Schelling-point parcel plans

Where no parcel register can be loaded, a visitor is offered a third kind of ground besides a
register link and best-effort boundary recognition from satellite imagery: a parcel plan that
everybody derives on their own and still agrees on. A Schelling point is exactly that, a choice
people make independently because every input to it is already common knowledge. For a parcel plan the inputs have to be things nobody owns and anyone can
check: the graticule, a published rule of thumb, and arithmetic.

The screen that offers it is `frontend/js/parcels/ground-fallback.js`; the geometry is
`frontend/js/parcels/schelling-grid.js`, a pure module with no network, no Leaflet and no randomness,
so it runs the same in the browser and under node (`backend/test/schelling-grid.test.js`).

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
