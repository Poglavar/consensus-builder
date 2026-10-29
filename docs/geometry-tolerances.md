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
| `NOISE_M` | The noise threshold, measured after the grid is in place. |
| Edge model | Straight in WGS84 longitude/latitude, in every stage, because every stage runs the same functions. |

A design's own `toleranceM` is a per-record allowance: it is an argument to `reachesInto`, so binding
and applying honour it alike.

Values that look alike but answer other questions stay separate: authoring minimums (smallest plot,
generator defaults), the ownership share floor, display-only drift and rounding (map previews, 3D
simplification, URL and bounding-box keys), the existing-building carve remainder, and the on-chain
site hash (`site-hash.js`, versioned; changing its rounding is a new version).

## Rules

- **A formed piece is the footprint cut to the parcels it consumes**, and carries their provenance.
  No vertex can then lie outside the piece's own parcels, and no two pieces can cover the same ground.
- **Applying on the map checks the result as a private read does.** The pieces a design forms must
  tile the ground they replace (the fabric's partition check). A design that fails is refused and
  named; it stays saved, unapplied.
- **The server binds with the browser's function.** The database finds candidate parcels (an indexed
  search) and serves them on the grid; `site-binding.js` decides. No second implementation in SQL.
- **Editors and MCP check with the apply's functions.**

## Plan

| Step | | Status |
| --- | --- | --- |
| 1 | `geometry-tolerances.js`: the grid and `snap()`; parcels snapped on arrival (`ground-service.js`, fabric seed), so server and DGU parcels are identical | done |
| 2 | Every clip that decides ground runs through the one shared clip (`parcel-arrangement.js` `clipWith`, inputs on the grid, coarser retries deterministic so every stage gets the same answer): binding, ancestry, land take, plot, site and pool cuts, layout and footprint validation, the per-parcel split, demolition regions, MCP's geometry runtime included. Display-only clips stay raw | done |
| 3 | Measure the remaining cutting noise on real designs; set `NOISE_M`; `reachesInto` in the module | open |
| 4 | Every "does it reach / is it debris" decision calls `reachesInto`: apply hosts and provenance (buildings, structures, layouts), plot ownership, sliver drops and the identity explode, re-basing, road crossings, plot edit, layout validation, MCP ground effects; the vertex patch in `apply/parcels.js` goes | open |
| 5 | Pieces cut to their consumed hosts; the map's apply runs the fabric's partition check | open |
| 6 | Apply honours a design's `toleranceM` as binding does | open |
| 7 | Server binding runs `site-binding.js` over candidates the database finds; the PostGIS binding statements and their decision bands go; measured on the largest bound sites (the 662-parcel railway) | open |
