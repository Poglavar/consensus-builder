<!-- One function per geometric question, one coordinate grid, and no tolerance where a shared rule makes one unnecessary: the contract and the open plan to reach it. -->
# Geometry tolerances

A design is drawn, saved, bound to parcels, applied on the map, replayed, read privately for Plan
stats, Compare and agreements, and drafted by agents through MCP. Every one of those stages answers
the same few geometric questions. **Each question is answered by one function, in one module, run by
every stage** — the browser, the server and MCP alike. Two stages then cannot disagree, and a shape
that passes when it is drawn passes when it is applied.

## Why (almost) no tolerance

The same geometry run through the same function gives the same answer, so stages never need a
tolerance to agree with each other: they need the same function. A design applied on ground that
other designs have cut first is cut differently from how it was drawn, and that is correct: the cut
is deterministic and has nothing to do with rounding.

What remains is arithmetic. A cut computes where two edges cross and rounds that point to the
nearest representable number, so a piece cut from a parcel can sit a few nanometres outside it.
Every coordinate is snapped to one grid (`GRID_DECIMALS`), and pieces are cut from the parcels they
stand on, so they lie inside them by construction. One noise threshold, sized to that arithmetic and
measured rather than chosen, tells a real reach into a parcel from cutting debris.

The cadastre itself shares edges exactly at full precision: the slivers older floors (0.25 m², 1 m²)
were meant to absorb came from reading geometry back through the map library's 6-decimal rounding.
The two real overlaps in the source (1,577 and 1,855 m²) are data defects, not noise.

## The shared module

`frontend/js/geometry-tolerances.js` (UMD; the backend requires it):

| | |
| --- | --- |
| `GRID_DECIMALS` = 9 (~0.1 mm) and `snap()` | Parcels are snapped when they arrive (server or DGU fallback alike, so both deliver identical coordinates), every clip runs on the grid, and authored geometry is saved on it. Integer rounding (`Math.round(v·1e9)/1e9`), never `toFixed`. |
| `reachesInto(shape, parcel)` | The one answer to "does this shape take, stand on, consume or anchor to this parcel", and, negated, "is this piece debris". The intersection must be wider than the noise threshold (the inward-buffer rule `site-binding.js` already uses). Binding, apply hosts and provenance, plot ownership, re-basing, road crossings, sliver drops and editor checks all call it. |
| `NOISE_M` = 1 mm and `isGround(feature, toleranceM)` | The noise value, measured (step 3), and the test that uses it: ground is anything wider than max(toleranceM, NOISE_M) (a circle that wide fits inside). Debris is the rest. A shape whose area exceeds the stadiums around its edges (2rP + nπr²) is ground without the buffer. |
| `uncoveredBy(shape, covers)` | The part of a shape its covers leave, by the shared clip. "Does it stand wholly on these" (a footprint on its parcels or site, a parcel taken whole, a piece on its host) is `!isGround(uncoveredBy(...))`. |
| `cutTo(shape, hosts)` | A formed piece: the shape minus what `uncoveredBy` leaves, so it lies on its hosts. Buildings, structures and layout plots are minted through it. |
| `designToleranceM(record)` | A design's own `toleranceM`, normalized as binding normalizes it (`site-binding.js normalizeTolerance`). |
| Edge model | Straight in WGS84 longitude/latitude, in every stage, because every stage runs the same functions. |

A design's own `toleranceM` is a per-record allowance: it is an argument to `reachesInto`, so binding
and applying honour it alike.

Values that look alike but answer other questions stay separate: authoring minimums (smallest plot,
generator defaults), the ownership share floor, display-only drift and rounding (map previews, 3D
simplification, URL and bounding-box keys), the existing-building carve remainder, and the on-chain
site hash (`site-hash.js`, versioned; changing its rounding is a new version).

## Rules

- **A formed piece is the footprint cut to the parcels it consumes** (`cutTo`), and carries their
  provenance. What is cut off is the debris the "stands wholly on its hosts" gate let pass. No vertex
  can then lie outside the piece's own parcels, and no two pieces can cover the same ground. A
  structure takes a parcel it covers whole entirely: a strip its own `toleranceM` let the footprint
  stop short of joins the body rather than being lost.
- **Applying on the map checks the result as a private read does.** Every formation (building,
  structure, layout) runs the fabric's partition check (`live-fabric.js` `checkCadastreScope`, the
  same `validateReplacementSteps` a private read and a reset run) over the pieces as they will stand,
  before it writes; the scope widens to every parcel a piece in it also occupies. The new pieces'
  vertices are tested; the standing ones were tested when they were written and count by area. Two
  new pieces under one id are refused too (the later would replace the earlier). A design that fails
  is refused and named (`formation-partition-invalid`); nothing was written, and it stays saved,
  unapplied. The private read (`agreement-headless.js`) runs the same formations, so it gives the same
  verdict, and closes with the same check over the whole partition. A piece partly on open ground is
  counted by its part on its parcels.
- **The server binds with the browser's function.** The database finds candidate parcels (an indexed
  search) and serves them on the grid; `site-binding.js` decides. No second implementation in SQL.
  `POST /parcels/under` and the DGU fallback answer candidates only (every parcel that meets the
  footprint); what the footprint takes is decided by the client, and whether a footprint already held
  locally needs no request is `!isGround(uncoveredBy(footprint, retained parcels))`
  (`ground-service.js`).
- **Editors and MCP check with the apply's functions.**

## Plan

| Step | | Status |
| --- | --- | --- |
| 1 | `geometry-tolerances.js`: the grid and `snap()`; parcels snapped on arrival (`ground-service.js`, fabric seed), so server and DGU parcels are identical | done |
| 2 | Every clip that decides ground runs through the one shared clip (`parcel-arrangement.js` `clipWith`, inputs on the grid, coarser retries deterministic so every stage gets the same answer): binding, ancestry, land take, plot, site and pool cuts, layout and footprint validation, the per-parcel split, demolition regions, MCP's geometry runtime included | done |
| 3 | `NOISE_M` = 1 mm, measured: on the grid neighbouring parcels share edges exactly, cutting debris is at most 0.4 mm wide, and the narrowest real reach of a published Zagreb design into a parcel is 39 mm. `isGround` and `reachesInto` in the module; binding runs them | done |
| 4 | Every "does it reach / is it debris" decision calls `reachesInto` / `isGround`: apply hosts, coverage and provenance (buildings, structures, layouts, roads), the flat and live-parent coverage gates and double-cover refusal, plot ownership, sliver drops and the identity explode, re-basing and declarations, road crossings, plot edit, layout and readjustment validation, freeform land take, MCP ground effects, hover and Compare, apply rivals and edit dependents (`claims.js`); the fabric's vertex tolerance is `NOISE_M` and its area budget `NOISE_M` × the group's boundary length. Merging layout plots runs the shared clip's union | done |
| 5 | Buildings, structures and layout plots are minted by `cutTo` over their consumed hosts; every formation runs `checkCadastreScope` on its would-be pieces before it writes, on the map and in the private read alike; the vertex patch in `apply/parcels.js` (`cadastreIdsHolding`) is gone | done |
| 6 | Apply honours a design's `toleranceM` as binding does: hosts, anchors, coverage and road-overlap checks of buildings, structures and layouts, re-basing and road declarations pass it (step 4); remainders and pieces never do, since dropping one would lose land | done |
| 7 | Server binding runs `site-binding.js` over candidates the database finds (`oss-binding-source.js`: parcels within 5 cm and the cadastral municipalities, on the grid), through the same `computeSourceBinding` as every other source; the site is `siteOf`, the footprint-inside-site test `uncoveredBy` + `isGround`, the parcel act's site a shared-clip union. The PostGIS binding statements, their decision bands and the `unresolved` outcome are gone, and `/parcels/under` lost its SQL take and coverage (`taken_m2`, a 0.25 m² floor); it and the DGU fallback answer candidates, and the ground service's "already held" check is `uncoveredBy` + `isGround`, not a 0.999 coverage ratio. The 661-parcel Šibenik railway binds in 2.0 s (was 1.5 s) to the same 661 parcels | done |
| 8 | Every other polygon clip runs through the shared clip too, display included, so the same geometry draws the same way on every load and a shape that unites while it is drawn unites when it is applied or read: raw turf refused a junction whose arm boxes meet at vertices 4e-8° apart, which the grid unites. Junction paint (`corridor-junction-paint.js`) is moved; about 120 direct `union`/`intersect`/`difference` calls in about 50 frontend files remain | open |
