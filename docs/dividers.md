<!-- Plan of record for reusing the land readjustment modal's before/after divider across the app. One milestone per surface, each with a verifiable "done"; decisions and parked items at the end. Started 2026-10-12. -->
# Dividers: before/after everywhere it helps

The land readjustment modal has a before/after tool: a second Leaflet map drawn in the same
container, clipped by a draggable divider, with the live map showing through as "after". Owners
and reviewers liked it. This file tracks lifting it out of the modal and putting it where a reader
decides something: the proposal details panel, the bet dialog, the road tool, replacement versions,
the owner's acceptance review.

Rules for this work, agreed 2026-10-12: one milestone at a time, every change tested as it lands
(headless tests for the logic, a headed Chrome for the look), the expensive 3D variant parked but
recorded, nothing deployed without a say-so.

## What the tool is

- `frontend/js/ui/map-compare-control.js`: the divider itself (pointer and keyboard, ARIA slider).
  Already shared and tested.
- `frontend/js/ui/map-before-after.js` (M1): the rest. A session over a Leaflet map: the second
  map, its tiles (cloned from the host's raster sources so the browser cache serves them), the
  clip, the labels, the gesture freeze, the view sync, the teardown. The host only draws the
  "before" content. CSS in `frontend/css/map.css` under `.map-compare__*`.
- The host decides what "before" means. In the readjustment modal it is the input parcels coloured
  by owner. On the main map it is the cadastre and the existing buildings as they stand, with
  nothing of the proposal: the question a reader asks is "what does this change in reality", not
  "what does this change relative to the other applied proposals".

## Milestones

| # | Surface | Done when | Status |
|---|---|---|---|
| M1 | Shared helper | The modal's compare runs through `map-before-after.js`; the before map uses the host's own tile source; node tests cover the clip, the tile cloning, the freeze and the teardown; the modal looks and behaves as before in a headed Chrome | done 2026-10-12 |
| M2 | Proposal details panel | A "Before / after" action on an applied proposal shows the cadastre and existing buildings on one side and the applied proposal on the other; works for buildings, roads, structures, readjustments and plans; keyboard-operable; leaves no trace on close | done 2026-10-12 |
| M3 | Bet dialog and bet links | The thumbnail renderer also writes a "before" image (same tiles, no plan); the bet dialog shows the pair under the divider; the bet link's social preview carries a two-panel image | done 2026-10-12 (prod needs the DDL + a `--before` backfill at deploy) |
| M4 | Road tool | Build-through and clearance compare the standing fabric against the corridor, the cut pieces and the demolished buildings | done 2026-10-12 |
| M5 | Replacement versions | For a plan with a newer version, before is the version currently applied and after the new one | done 2026-10-12 for proposal versions (`sourceProposalId`); plan versions (`ens_plan.supersedes`) are a follow-up, see Decisions |
| M6 | Owner acceptance review | An owner reading a readjustment in the details panel compares their parcel before with their plot after, without opening the editor | done 2026-10-12 |
| M7 | Model view | The Buildings and massing sheet's Compare tab splits the 3D canvas at a draggable divider; each side is any of Built today, Permitted massing, Proposed, one applied design or one plan (`three-compare.js`, two scissor passes in `three-mode.js`); the pure rules are unit tested; the divider and the passes are checked in a headed Chrome | done 2026-10-28 |
| M8 | 2D map | The same Compare tab splits the 2D map: buildings no side removes stay in their pane; the buildings applied designs demolish and the designs' buildings draw again per side into two panes clipped at the divider, and the permitted massing pane is clipped to the Permitted side (`compare-on-map.js`); parcels, roads and parks show on both halves; the pure rules are unit tested; the halves are checked in a headed Chrome | done 2026-10-29 |
| M9 | Any saved plan | A plan is a side whether or not it is applied: members an applied design stands for are that design; the rest are read as Plan stats reads a plan (`PlanAnalysis`, no apply) by `compare-unapplied.js` and drawn on that side alone, as buildings, road corridors and space grounds, with the standing buildings they clear taken off that side by the demolition scan's rule; Compare plans (Lists → Plans) opens the chosen pair, or one plan against Built today, on the map; the pure rules are unit tested; both views are checked in a headed Chrome | done 2026-10-29 |

## Parked

- **Applied roads, parks, squares and lakes in the model view (M7).** Their meshes carry no design
  id (corridors are built in one batched loop; the park, square and lake builders add untagged
  meshes), so `compareDescriptors` reads them as shared drawings: Proposed shows them, a design or
  plan side hides them, even its own. The 2D map is not affected (both halves show them). The fix
  is tagging per-feature meshes with their `proposalId` in `three-mode.js`: the park and square
  builders take a features list, so one call per feature can tag what it added; the lake builder
  needs that parameter first; the corridor loop needs per-road grouping before batching. An
  unapplied member's road and ground plates (M9) are tagged and switch correctly.
- **Unapplied members in the model view (M9)** are drawn from the record alone: a building is
  sliced by the live parcels, not the plan's own pieces; a road is a flat plate, not a laid
  corridor; a building two members of one plan cut keeps the first member's remainder. The scene's
  context (existing buildings, parcels) is loaded around applied work and the camera, so a plan far
  from both has nothing to clear until the view moves there.
- **Photo mode (Google tiles).** The model view's comparison (M7) draws two scissor passes of one
  scene and switches only the objects the two sides disagree on. In photo mode the tiles are the
  built state and the carve under a design is a GPU effect, so a side-aware carve is needed before
  the same two passes read right there. Figures labelled by side in the stack cards are a follow-up.

## Declined

- **Compare proposals here** (`proposals/parcel-compare-ui.js`). Two rival designs for one parcel
  read better side by side at one scale than overlaid under a divider. Left as is.

## Decisions

- 2026-10-12: generic class names (`map-compare__before`, `__handle`, `__grip`, `__label`), one
  CSS home (`map.css`), tokens only (a new `--cb-z-map-compare` for the overlay's place above the
  Leaflet panes), and the i18n strings moved from `reparcellization.modal.*` to `mapCompare.*` so
  every host uses the same words. The e2e specs were updated to the new selectors.
- 2026-10-12: the before map clones the host's raster tile layers instead of hardcoding
  OpenStreetMap, so the main map's basemap and the modal's both carry over.
- 2026-10-12: the host's gestures stay frozen while comparing, as in the modal. Programmatic moves
  of the host (a fly-to) still sync the before map.

- 2026-10-12 (M2): "before" on the main map = every parcel presented in the viewport as it is now,
  except those deriving from a parcel the proposal claims (the parcel itself, a plot of its
  readjustment, a piece a corridor cut), which are replaced by the claimed parcel's original
  cadastre feature from `CadastralParcelRepository`; plus the existing-building pool when the
  Layers sheet shows buildings. Drawn on one canvas. The host map is frozen while comparing, the
  divider takes focus, and the labels ride the divider (`labelPlacement: 'divider'`) because the
  main map's bottom corners sit under the tab bar. The comparison ends with the panel: closing it,
  switching proposal, unapplying, or entering 3D (which hides the panel).
- 2026-10-12 (M2): on a phone the expanded details panel covers the map, as it always did; the
  comparison shows once the card is minimised. Left as is.

- 2026-10-12 (M3): one tile fetch, three pictures. `renderProposalThumbnailSet` draws the thumbnail
  as it was ("after"), the same ground with only the parcel outlines ("before": no proposal
  polygon, no badge) and the two side by side with a white gap ("pair"). The queue stores all
  three at publish; `scripts/backfill-proposal-thumbnails.mjs --before` renders them for rows that
  have a thumbnail but no before picture (re-rendering the thumbnail so the three agree; writes
  only where `screenshot_before_url IS NULL`, so a rerun is a no-op). Two new nullable columns
  (`screenshot_before_url`, `screenshot_pair_url`) ship as an ALTER-only DDL in the deploy list;
  additive, so one deploy. The bet link's `og:image` prefers the pair. The bet dialog shows the
  two pictures under `attachDivider` (the divider without Leaflet), corner labels.
- 2026-10-12 (M3): the pair image carries no text, only the gap: an image cannot be translated
  and the bet page's title and description say what it is.
- 2026-10-12 (M4): the road tool is the cross-section editor, which only opens on a placed
  (applied) road, so the map already shows the corridor, the cut pieces and the building outcomes.
  The editor gets a "Before / after" chip in its header that runs the same session as the details
  panel (M2); a comparison the editor opened closes with the editor, one opened earlier stays.
  Nothing while drawing a new road: there is no road on the map yet to be "after".
- 2026-10-12 (M5): a record that replaces an earlier one (`sourceProposalId` /
  `replacementOfProposalId`, not a land fork) gets that version's footprint drawn on the before side
  as a dashed orange outline, so the two versions can be told apart while the new one stands on the
  after side. The replaced version is an outline over the ground, not a full render with its own
  cuts and demolitions; that would need a second apply engine run. Plan versions
  (`ens_plan.supersedes`, the Bets sheet's "older versions") link plans, not members, so a member
  of v3 has no recorded predecessor in v2; a geometric match (the v2 member on the same ground)
  is the follow-up, to be done with the plans work that owns `olderVersions`.
- 2026-10-12 (M6): each parcel row of an applied readjustment gets a small "Before / after" chip
  that opens the comparison for that parcel: its original shape in dashed amber on the before side,
  the plots that came out of it (`LiveParcelFabric.entriesForCadastre`) in solid blue on the after
  side, the modal's own colours. Asking for another parcel moves the focus; asking for the same one
  closes. The rows read "Removed" once the readjustment is applied, which is exactly the case.
- 2026-10-12 (observation, not changed): `?design=` (then `?focusProposal=`) shows a server proposal without
  importing it into local storage, so "Apply to map" on such a readjustment is silently skipped
  ("unsupported map apply action"); opening it from the Proposals list imports it and apply works.
  Pre-existing, outside this work.

## Log

- 2026-10-12: M1 built: helper + tests, modal refactored, CSS and i18n moved. Verified: the seven
  e2e tests that drive the modal's divider (desktop and 390 px drag/cleanup, keyboard, touch,
  per-owner review) pass; screenshot checked.
- 2026-10-12: M2 built: `proposals/before-after.js` + tests, button and lifecycle hooks in the
  details panel. Verified in a headed Chrome on the Borovje block M1-2 v2 (12 parcels): original
  strips on one side, the applied building on the other; keyboard Home/Arrow/PageUp move the
  divider; unapply and close leave nothing behind; checked at 1200 px and 390 px.
- 2026-10-12: M3 built: renderer set + queue + backfill pass + DDL + API fields + bet dialog, with
  tests (pixel checks on the three pictures, the queue's UPDATE, the API row, the preview tag, the
  DDL contract, the bare divider). Verified locally: the `--before` pass rendered one Zagreb row
  (dry run, apply, rerun no-op); the bet dialog shows the pair under the divider, keyboard moves
  it, closing tears it down (resize listener removed).
- 2026-10-12: M4 built: editor chip + CSS + test. Verified in a headed Chrome on the Podbrežje
  road reconstruction (55 parcels, lanes): the chip starts the comparison beside the docked
  editor, closing the editor ends it, unapply leaves nothing behind.
- 2026-10-12: M5 + M6 built in `proposals/before-after.js` (previous-version outline, parcel focus
  with a host-map layer, focus switching) and the details panel (per-parcel chip), with tests.
  Verified in a headed Chrome on UPU Borovje readjustment block 2/3 (4 parcels): the parcel chip
  outlines the input parcel and its plots, moves between parcels, closes on the same chip; with a
  previous version set in memory the before side shows v2's plots dashed. The modal's seven e2e
  tests pass again after the helper refactor.
- 2026-10-12: browser specs for the new surfaces in `e2e/tests/before-after.spec.ts` (seven
  tests: details panel with keyboard, freeze and unapply; replaced-version outline; one parcel of
  an applied readjustment with its blue plots; the editor chip opening and closing with the
  editor; the phone card with the divider inside the viewport; the bet dialog's two pictures and
  the plain fallback). The before map reports its layer counts in `data-layers` so a spec can read
  what a canvas cannot show. Shown to go red (labels moved back to the corners), green headless
  and headed. The modal's own seven specs stay the M1 coverage.
- 2026-10-12: full fast suite after everything: the three tests that pinned the queue's old
  two-parameter UPDATE and the pane-review list were updated; the before map's canvas is now
  named (`pane: 'overlayPane'`) and listed. What still fails belongs to the parcel-source and
  x402 work in flight in this worktree, plus one 20 s timeout under load.
