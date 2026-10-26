<!-- Behavior decisions and targeted verification for Freeform placement and taken surroundings. -->
# Freeform building interaction — 27 October 2026

Choosing Freeform now starts placement. A dashed outline follows the desktop pointer;
a click or mobile tap places it at that map position and opens its editing controls.
The map keeps its chosen view. Panning and pinch zoom do not place a building. Enter
places the carried outline, and Escape before placement leaves no saved design.
Model view uses its existing ground pick and a small outline in the same scene.
Saved designs and imported geometry reopen at their authored positions.

The permanent building-name label inside the editor footprint has been removed,
including the unresolved generated “Building {{n}}” text. Explicit imported names
remain authored feature metadata.

## Land and surroundings

The user chose the following contract: footprint-only land has no surroundings.
Paving or green space occupies taken land outside the building footprints. Both the
Surroundings selector and Edit surroundings button are disabled when that surface
is empty. Choosing All footprint removes the surface and its furniture; choosing
whole parcels permits a surface again. Land-choice controls wait for the first
review instead of accepting a click before any parcels are known.

Chosen whole parcels remain taken when a building moves away. Their surrounding
ground stays anchored, until the user changes that land choice. A replacement that
retains this ground overlaps its published source and unapplies that source locally;
the original published geometry and CID remain unchanged. An imported collection
saves separate footprint-only designs, each with its own building site.

This intentionally changes the earlier experimental behavior that allowed a
footprint-only take to carry paving over the starting parcel. No migration or
parallel reader is added. Editing such a record uses the current ground rule;
published source records remain immutable.

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
