<!-- Behavior decisions and targeted verification for Freeform placement, land take, surroundings, upload and Duplicate. -->
# Freeform building interaction — 27 October 2026

How a new building is put down depends on the pointer (`FreeformPlacement.usesPointerPlacement`,
the `(hover: hover) and (pointer: fine)` media query):

- With a mouse or trackpad, choosing Freeform starts placement. A dashed 20 m outline
  follows the pointer; a click places it there, Enter or **Place on selected land** places
  it on the starting site, and Escape before placement leaves no saved design. Panning does
  not place. Model view uses its ground pick and a small outline in the same scene. The
  map keeps its chosen view.
- On a touch screen nothing can follow a finger, so the editor opens with the 20 m square
  already standing at a point inside the starting site. When the phone sheet would cover
  it, the map pans (never zooms) to centre it above the sheet. A finger on the building
  drags it; elsewhere it pans the map. Leaflet 1.9 gives map layers mouse events only, so
  the finger drag runs on pointer events caught on the map container.

Once placed, the editing controls are live: the building and its corners can be dragged, an
edge tapped to add a corner, and focus starts on the height slider. Saved designs and
imported geometry reopen at their authored positions.

## Model view handles

In the model view the building editors keep direct manipulation (`frontend/js/model-edit-handles.js`,
its geometry in `model-edit-handles-math.js`). Each editor declares its handles through the
on-map editor's `modelHandles` option and keeps geometry, history and saving to itself:

| Editor | Height arrow drives | Drag the building | Turn knob |
| --- | --- | --- | --- |
| Freeform | Height (m) | yes, the active building | yes |
| Row houses | Max storeys | yes, the whole terrace | yes |
| Urban rule | Max storeys, or Proposed height when raising existing buildings | yes, the Block (not raised existing buildings) | no |
| Detached houses | Max storeys, over the site | yes, all the houses | no |

- The arrow stands on the building's top and sets the editor's own slider, firing the same input and
  change events a slider drag does, so its undo step, autosave and Permitted check are the slider's.
  It follows the pointer along its axis on screen; when the camera looks steeply down the axis, a
  pixel counts as no more than at 35 % of the side-on view, so the height stays controllable.
  Hovering or dragging it shows the value beside it. Urban rule's Added storeys rule has no arrow:
  its buildings have no single top.
- Grabbing the building drags it on the horizontal plane at the height where it was grabbed, through
  the same move code as the map drag, so snapping, site lock and a Row's off-parcel drop dialog apply.
  A Block or Detached houses are built by their rule on their parcels, so, as on the map, the drop
  asks: convert to Freeform where it was dropped, run the same rule on the parcels there, or put it
  back.
- The knob on the ground ring turns the footprint in 5° steps (1° with Shift). A whole turn gesture
  is one undo step, like one press of a rotate button.
- Corners are reshaped on the map only. The photo view stays locked while an editor is open.
- The sliders, rotate buttons and keyboard controls remain the accessible path: the arrow's label is
  hidden from assistive technology because the slider carries the same value. Agents make the same
  edits through MCP (`ugt_modify_design` height, floors, rotation and movement).

The permanent building-name label inside the editor footprint has been removed,
including the unresolved generated “Building {{n}}” text. Explicit imported names
remain authored feature metadata.

## Land take review

Each current live parcel a Freeform building touches gets its own Land take choice: Footprint only
(the default) or Whole parcel, which adds that parcel's entire current outline; All footprint and
All whole set every row. The live parcels are those as they stood before the design under edit: a building on a parcel
layout's plot is offered that plot, not the cadastral parcel under the layout. For a design that is
applied, the review replays the other applied designs on its cadastral parcels, and on every parcel
those designs declare, on a private copy (`frontend/js/freeform-ground-before.js`, the
`AgreementHeadless.materialize` replay Plan stats uses), once when the editor opens and again only
when the building reaches a parcel outside that copy. A building across two plots therefore offers
each plot with its own outline. A replay that refuses leaves the review unavailable. The building itself stays narrow. The exact `geometry.landTake`
(`frontend/js/freeform-land-take.js`) is shared by binding, parcel formation, owner remainders,
demolition prefetch and replay, and agreement derivation.

The review (`frontend/js/freeform-land-take-review.js`) highlights taken land, retained ground and
building removals, separates full removals from partial cuts and names overlapping applied designs.
Done refreshes the source answer and requires the land-take acceptance checkbox for unchanged
consequences. A missing, unsupported, truncated or absent building answer never passes as empty
ground; Retry review asks again. The model preview receives the same take boundary and excluded
buildings. This is local design acceptance, separate from agreements. Apply refuses a record that
carries only the retired `takeWholeParcels: true` without `geometry.landTake`; reopen and review it.

## Land and surroundings

The user chose the following contract: footprint-only land has no surroundings.
Paving or green space occupies taken land outside the building footprints. Both the
Surroundings selector and Edit surroundings button are disabled when that surface
is empty. Choosing All footprint removes the surface and its furniture; choosing
whole parcels permits a surface again. Land-choice controls wait for the first
review instead of accepting a click before any parcels are known.

Follow-up correction: whole parcels remain taken only while a building overlaps
them. Moving the last building away releases that parcel, paving, planting and
removal effects, returning the parcel to its source state. Ground stays anchored
while its parcel is occupied. Undo restores the previous building and whole-parcel
choice. A moved fork that no longer overlaps its source can coexist with that
source; the published source geometry and CID remain unchanged. This supersedes
the earlier retention rule and its corresponding test expectation. An imported collection
saves separate footprint-only designs, each with its own building site.

This intentionally changes the earlier experimental behavior that allowed a
footprint-only take to carry paving over the starting parcel. No migration or
parallel reader is added. Editing such a record uses the current ground rule;
published source records remain immutable.

## Upload and Duplicate

Freeform offers Upload .glb beside Upload GeoJSON. The model importer replaces the selected
building in the active editor and keeps its siblings, surroundings and undo history. Escape closes
the importer without closing Freeform, and a closed importer ignores a late upload response.

Duplicate (`frontend/js/design-duplication.js`) copies the authored geometry of Freeform, park,
square and lake designs (`ProposalDesignGoals.canDuplicate`). The preview follows the pointer; a
click, not a drag, creates a fresh local design through the ordinary binding and application
pipeline, and Escape cancels without leaving a draft. The source and its agreements stay unchanged.
Imported mesh references and local model settings carry over; geographic geometry and decorations
move, model-local coordinates do not. Site-bound rules, layouts, corridors, attached stations and
rights acts cannot be duplicated. The editor shell has no Fork action.

## Map hover

The 2D planning overlay no longer binds hover tooltips to its massing or assumed
street-side lines. Pointer and keyboard inspection remain available. The renderer
was shared across cities: Zagreb's records supplied cadastral references and the
existing-stock-estimate assessment, which produced the reported text there.

## MCP parity

Existing `ugt_inspect_design` and `ugt_edit_design` operations expose the building,
land take, ground boundary, surface and furniture. No new field or tool is needed.
The browser and MCP editing share `BuildingGround.clipSurfaceToLandTake`; a patch
that makes the take equal the footprint removes its surroundings. The browser
adapter rejects surfaces outside the take. The editing guide and tool discovery
description document that restriction. Placement changes only how the browser
chooses coordinates; MCP already accepts and transforms exact building geometry.

The targeted MCP edit test verifies surface/furniture removal, unchanged building
geometry and source immutability. Other checks retain whole-parcel furniture during
movement. The vocabulary records the current relationship between land and surface.

## Verification

Only targeted headless unit and headless Playwright runs were used. All runs below
completed. A gpt-6-luna helper implemented and unit-checked the scoped hover removal;
the parent reviewed its click wiring and the real-data browser behavior.

| Run | Result |
| --- | --- |
| Headless unit: planning hover, delegated initial check | 1 passed. |
| Headless unit: initial five-file batch | 57 passed, 10 failed; exposed stale extraction harnesses and a land-take fixture shape. |
| Headless unit: repaired five-file batch | 67 passed, 3 failed; remaining harness declarations and an obsolete move-whole-building expectation. |
| Headless unit: eight relevant files | All 174 passed. |
| Headless unit: twelve files including geometry, MCP, adapters, loader and locale/identity/global guards | All 212 passed. |
| Headless unit: expanded twelve-file batch | 213 passed, 1 failed in a new validation fixture that omitted its site. |
| Headless unit: corrected adapter fixture | All 87 passed; all 214 distinct checks from the expanded batch now pass. |
| Headless unit: MCP server registration and canonical Freeform ground | 2 files, all 11 passed. |
| Headless Playwright: initial placement/land choices | All 5 passed. |
| Headless Playwright: related Freeform regressions | 25 passed, 7 failed across 9 files; obsolete controls/copy/close expectations plus the first-review button race. |
| Headless Playwright: seven repaired cases | 6 passed, 1 failed; moving away exposed dropped whole-parcel surroundings. |
| Headless Playwright: retained-ground case | Geometry passed; one application-state assertion failed because the overlapping published source was correctly unapplied. |
| Headless Playwright: corrected source-application expectation | 1 passed. |
| Headless Playwright: final five-file batch | All 14 passed, including desktop/touch/model placement, cancellation, land choices, demolition preservation, Undo, imported sites, authored surroundings and revision identity. |

Feature inventory passes: 106 current commands across 73 spec files. Runtime syntax
and whitespace checks pass. Seven locale dictionaries carry the new placement and
surroundings copy; the locale guard passes.

A dedicated background Chrome loaded real Zagreb parcels and permitted massing from
the production read-only API through the local frontend. The carried outline, placed
400 m² footprint, absent labels, whole-parcel surroundings and final footprint-only
disabled controls were checked visually, including at 500 px. The temporary local
design was discarded and the owned browser was closed. No production design was
published or changed.

Concurrent Atlas work also changed the hover renderer, all seven locale files and
the vocabulary. Their Freeform edits remain in the worktree together with the
scoped hover test, following the workspace rule against committing mixed files.
The local commit contains the remaining files owned by this task. The task's own
shared-file hunks are preserved separately in `/tmp/ugt-freeform-shared.patch`.


## Follow-up: release unoccupied parcels

The reported zero-overlap paved parcel was reproduced by the land planner's explicit
whole-parcel exception. Whole and recovered saved choices now require positive
footprint overlap, with the existing numerical edge-contact tolerance. Once dropped,
a parcel's whole choice is forgotten; moving back does not silently restore paving.
Undo restores the authored take and furniture from the history snapshot instead.
Review reads immutable source cadastral boundaries, including when reopening an
applied design whose own live fragments would otherwise hide its occupied yard.

The surroundings are clipped to the recomputed take; leaving the last whole parcel
also clears stale furniture. Save uses the same take for site, binding and demolition.
The pure regression checks edge contact, saved choices, source immutability, removal
preview and tiny genuine overlap that merely rounds to 0%. Browser checks cover
actual drag, Undo, save/reopen, source CID preservation and local edit identity.
MCP parity uses existing atomic edits to the building, land take and site; the
shared reconciler removes released ground/furniture. No new tool/schema is needed.

Targeted run ledger for this follow-up (no full suite was run):

| Type and scope | Result |
| --- | --- |
| Headless unit, 3 files, initial run | 42 passed, 1 failed: lifecycle fixture omitted the occupied-parcel flag. |
| Headless unit, same 3 files with MCP case | 43 passed, 1 failed: test fixture used cross-realm Turf options. |
| Headless unit, corrected fixtures | 44 passed. |
| Headed Playwright, 2 selected drag cases | Stopped after 1 pass; second case stalled during trace/failure collection, reported not run. |
| Headless Playwright, release case, first diagnostic | Failed: reopening queried the design's own live parcel fragments. |
| Headless Playwright, release case, source lookup corrected | Failed: test dragged before initial review completed. |
| Headless Playwright, release case, initial review awaited | Failed: saved absent surface is omitted, not serialized as null. |
| Headed Playwright, final 5 selected cases in 2 files, tracing off | All 5 passed; completed. |
| Headless unit, final 3 files | All 44 passed; completed. |

The headed capture `released-parcel.png` was visually inspected: the old parcel is
absent from review, land take is the 400 m² footprint, and removal counts are zero.
All owned Playwright browsers closed with their completed or stopped runs.
The vocabulary correction remains alongside another session's street-front glossary
edit and is intentionally left uncommitted under the shared-worktree rule.
