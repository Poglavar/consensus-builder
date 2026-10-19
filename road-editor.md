# Road editor: junctions, transitions, connections

Living plan for the 2026-10-15 road-editor work. The audit that produced it (illustrated, with
screenshots) is a private artifact; its conclusions are summarised here so the plan stands on its
own. Vocabulary follows `../cadastre-data/roads.md` (segment = stretch, node, arm, profile).
Update the status column as pieces land.

## What the audit found

- The corridor model is sound: one centre line, an ordered lane list as the cross-section (OSM
  compatible), presets, per-stretch profiles, a real graph with cross-record nodes, derived parcel
  cuts, one renderer for 2D and 3D. What is missing is a **junction object** and a **transition
  object**. Every visible defect at a connection follows from that.
- Junctions were render-only per-arm asphalt patches plus zebras (`junctionTreatmentPerArm`): no
  corner geometry, patch length sized by the arm's own profile (so a 7.5 m branch's patch never
  reached a 26 m through road's sidewalk), zebras inside the box, lane lines through the box, and
  which road's sidewalk paints across a T mouth was canvas insertion order.
- Width changes only tapered the painted dividers (28 m smoothstep, per corridor); kerbs, strips
  and the land take stepped. A profile could change only at a stretch boundary and stretches
  split only at junctions.
- Drawing snapped only to applied proposals of the same kind (never to the city's own streets,
  never road↔track), tier-first rather than nearest-first, Escape wiped the stroke in progress
  with no undo, the pen could not lift in a fresh session, and every conflict was a modal per edge.
- The editor gave no affected-parcel disclosure on widening, silently dropped per-stretch
  profiles on a road-scope save, refused silently, imported OSM lanes mirrored relative to the
  presets, and node drags were not undoable.

## Decisions

1. **A junction is a node-owned object** (`frontend/js/corridor-junction.js`, pure planar): arms
   sorted by angle, a kerb-return fillet between every pair of angular neighbours less than ~170°
   apart, radius by the narrower arm's class (≤12 m total width → 6 m, ≤30 m → 9 m, wider → 12 m).
   Outputs: the carriageway surface (arm boxes to each arm's cut distance ∪ fillet pieces), one
   sidewalk corner band per fillet, a land corner per fillet (what the kerb return needs beyond the
   straight land edges), stop lines across inbound lanes, zebras beyond the stop line, and per-arm
   cut distances so markings stop at the stop line and 3D strips end where the junction begins.
   Degree-2 nodes between different stretches are bends (outer bevel), not junctions.
2. **The land take includes the junction's land corners** (`corridor-footprint/3`). The algorithm
   name is bumped, so records built with `/2` stay authoritative and are never re-derived with the
   new recipe (`backend/proposals/prepare.js` only re-derives when the algorithm matches).
3. **A width change is a transition zone on the wider stretch**: at every degree-2 boundary where
   the two stretches' profiles differ, the wider stretch's last `clamp(10, 60, 8 × Δwidth)` metres
   taper to the narrower profile. Strips, land, markings and 3D are all built from the same taper
   pieces (`corridorRenderPieces`). A stretch can be split at any interior node from the node
   editor ("Split the stretch here"), which is the minimum form of roads.md §9 stations.
4. **Drawing connects to what exists**: nearest-first snapping with a vertex preference, existing
   streets (the `/osm-road` centre lines) as snap targets with the street named, roads and tracks
   node with each other, Alt suppresses snapping, junctions preview live while drawing.
5. **The pen can lift**: Escape lifts the pen and keeps what was placed, Escape again asks
   (build / discard / keep), double-click finishes, conflicts (buildings, plots, structures,
   pedestrian crossings) are collected while drawing and reviewed once at Finish.
6. **The editor is honest**: a footprint-changing save lists the parcels it adds or frees and asks
   first; every refusal says why; a road-scope save keeps per-stretch cross-sections unless told
   otherwise; OSM import puts backward lanes on the left like the presets; node drags are undoable;
   ⌥-click cannot empty a stretch.

Deferred on purpose: curves, turn-lane solving and guide lines, roundabouts, signals, a full
stations editor, junction treatments against existing streets that are not records.

## Work packages

| # | Package | Files | Status |
|---|---------|-------|--------|
| P0 | Dead code and stale comments in the drawing tool | road-drawing.js | done |
| P1 | Junction geometry module + 2D + 3D + footprint + markings trimmed | corridor-junction.js (new), corridor-junction-paint.js (new), corridor-profile.js, corridor-render.js, three-mode.js, corridor-footprint.js | done; a definition's `junctions` (nodes shared with other records, with their arms' profiles) are read by the land and the transition planner — authoring writes them at Finish (P3). 2D paints the junction at the strips' own opacity over a planar partition (the arms' strips and the edge fill are clipped to what the junction paints, its pieces are united and overlap by design) — it used to be an opaque patch over the strips and read darker than the lanes |
| P2 | Transition zones + split stretch at a node | corridor-transition.js (new), corridor-profile.js, corridor-footprint.js, three-mode.js, corridor-terrain-formation.js, corridor-geometry.js, road-node-edit.js | done (2D, 3D, land, drawing preview, split at a node) |
| P3 | Snapping: nearest-first, existing streets, road↔track, Alt, live junction preview | corridor-geometry.js, road-drawing.js, legacy-road-centerlines.js, proposals/corridor-authoring.js | done; Finish also writes `definition.junctions` into both joined records |
| P4 | Pen lift, Escape, double-click, conflicts reviewed at Finish | road-drawing.js, road-stroke-state.js | done |
| P6 | The record as an OSM document + import adapters (roads.md §11) | corridor-osm-form.js (`toRecord`/`toView`), corridor-import.js (format chooser), corridor-import-osm.js (new), corridor-import-opendrive.js, formation-depth.js, proposals/data.js, backend/proposals/prepare.js, routes/proposals.js, serializer.js, footprint.js, plans/plan-hash.js, scripts/migrate-corridor-osm-form.mjs | done, both steps: a stored road is its OSM document alone (no stretch fields); the store, the publish body and the server row hold the record, every load decodes it into the view the readers consume; the API serves record and view side by side. Plan member hashes are content hashes (stretches + cross-sections), re-stamped by the migration, minted plans keep their chain hash. Import chooser in the road panel: OpenStreetMap (.osm/.json) and OpenDRIVE (.xodr) live; LandXML, Streetmix, GeoJSON, Shapefile named and greyed until someone asks |
| P5 | Editor honesty | corridor-editor.js, road-node-edit.js, corridor-profile.js | done; also: an in-place road edit and a Finish-time join now declare the parcels the new land reaches (road-drawing.js `declareParcelsUnderRoadLand`, proposal-manager.js), and a road-scope preview respects kept per-stretch cross-sections |

Tests: `cd backend && npx vitest run` (fast, headless). Browser checks are done by hand in a
launched Chrome, not by a suite.
