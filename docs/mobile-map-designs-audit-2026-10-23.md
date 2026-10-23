# Mobile map, designs and agreement audit

## Current experience

- **Designs** opens authored changes and their local map application. Proposal remains the internal local-record name. The list distinguishes Draft / Published from Applied / Unapplied.
- **Share** is a labelled control on the main map. Opening it keeps the current view and needs no profile. Empty maps share their location; compositions share published design CIDs, location, view mode, camera and massing settings. An explicit backend override stays in preview links.
- All applied designs start selected. Published parcel layouts reuse their CID. An unpublished layout explicitly names the agreement publication requirement and offers Create agreement or deliberate deselection. The selected/excluded count exposes subset sharing. A map link creates no separate plan or agreement record.
- **Agreements** contains arrangements over designs and their decision rules. Its mobile panel identifies itself, attaches immediately above the map navigation and uses at most half the viewport. Its top handle closes it; the desktop close button is hidden on phones. Content scrolls inside the panel.
- **Remove from this device** removes a local agreement copy. It leaves designs applied and does not remove published bytes, the publication index record or an on-chain agreement. The confirmation states this explicitly.
- **Buildings and massing** remains available in 2D to compare footprints and massing. Permitted is the first row. Without a source it is disabled and dimmed, and empty source, coverage and status sections are hidden.
- The photorealistic city is the base of realistic 3D. Layers retains cadastral boundary controls and no longer offers a checkbox that removes that base.

## Rendering and identity defects

1. The model pavement was an uninterrupted plane at ground level, above recessed lake water. The pavement now subtracts the same lake, station and underpass openings used by parcel surfaces. Applying/unapplying designs rebuilds it. A failing individual subtraction preserves the rest of the ground and reports the clipping failure.
2. The ground-load progress event omitted `requested` and `cached`, although translations needed both. It now reports actual counts, including already cached parcels; progress text interpolates them.
3. Freshly imported MCP streets falsely made Digbeth's agreement stale. The store decodes `definition.osm` into drawing fields; design identity incorrectly hashed those fields. `DesignRecord` now re-encodes through the existing canonical road boundary before hashing. The three streets recover their exact published CIDs. A real edit still changes the CID.
4. A remembered map location written to `?at=` during boot could be mistaken for an explicit shared view. The route now uses the arrival parameters captured before map initialization. Plain design/agreement links frame their designs; map shares preserve their explicit view.
5. Published layouts were refused before their existing CID was considered. The share panel, individual share action, details button and publisher now check publication first.

## Observed verification

Dedicated headed Chrome at 390 × 844, using this checkout and an explicit production API override:

- Real Birmingham design and source responses returned successfully; permitted sources were empty.
- Opened `bafkreig2o7mfofimfnct7fe4xml4cg6p27mvzkrfpn2rnf47r4xqm52kre`. All 17 designs applied. The agreement says Matches the map and Before / after is enabled. Its panel measured 422 px in an 844 px viewport.
- Share showed 17 of 17 included, 0 excluded, all published, with a composition link and no republishing.
- In model 3D, streets and pavement were enabled. Both real lake centroids had water at −1.4 m and lake floor at −1.6 m, with no pavement hit. The only ray hit above water was an invisible selection overlay (opacity 0).
- In 2D, the real no-source panel showed Permitted first, disabled, with no source-information section.
- A plain agreement arrival without `at` framed Digbeth rather than a remembered location.

## Targeted automated verification

All browser executions below were headless Playwright; all unit executions were headless Vitest. No full suite was run. Iteration failures are retained here rather than hidden by final rechecks.

| Run | Scope and result |
| --- | --- |
| Initial unit iteration | 11 files: one stale contract assertion failed; corrected; 171/171 passed in the next recorded run. |
| Initial phone browser checks | 4 tests: 2 passed, 2 failed (fixture lacked cadastral ground; context paragraph reused source-note selector). Both corrected. |
| Sharing browser iteration | 7 tests: 4 passed, 3 failed (default list source; static server lacked route rewrites). Corrected source selection and used the supported preview server. |
| Sharing browser recheck | 7/7 passed: mobile layout, empty Share, published layout, absent permitted source, publishing and receiver application, blocked layout, invalid links. |
| Follow-up units | 5 files / 611 tests: 9 failed, then 8 failed, from VM browser stubs missing new DOM/location dependencies. Stubs corrected; affected 24-test import file passed. The other four files passed. |
| Follow-up browser setup | No tests ran: sandbox could not reach the local preview. Retried with local network permission. |
| Follow-up phone checks | 6 tests: 5 passed, 1 failed only because a read-only POST `/designs/batch` was counted as a publication. Receiver layout application passed. Corrected assertion; the test passed, then passed again with published-layout Details sharing verified. |
| Controls browser checks | 6 tests: 5 passed, 1 failed on an obsolete collapsed-tools helper. Updated helper; agreement create/compare/edit/list/local-removal test passed. Photo renderer, both planning-source variants, Designs 3D navigation and publication filters passed. |
| Final wider targeted units | 18 files / 872 tests: 869 passed, 3 failed. Share edit-lock expectation corrected and its 44-test file passed alongside 24 import tests (68/68). Two unrelated world-entry expectations remain stale against concurrent source and Activity changes: Explore expects Overture instead of OSM; palette expects removed `activity.explorer`. |
| Map-share final unit check | 12/12 passed, including explicit backend override retention. |
| Source control contract | Matches 864 source sites. Syntax checks and `git diff --check` pass. |

The new `e2e/tests/mobile-map-designs.spec.ts` covers list space, one-tap empty-map sharing, published-layout receiver application and Details sharing, missing permitted sources, creating/publishing an agreement and returning to Share, equal wrong-city action sizes, and mobile agreement identification/size/close behavior. Geometry tests use actual Turf subtraction and triangulation, including holes, islands, boundary cuts and complete surface removal.

## Claude review

Used the requested run-it-by workflow with explicit user authorization for repository context. Three rounds at maximum effort; reported models `claude-fable-5-1,claude-opus-5-5`, session `6beab329-43ec-4e5d-b631-401a59d0124b`. Final verdict: **AGREE**.

Accepted review changes included preserving 3D when opening design details, respecting edit locks for Share, publication-first handling, meaningful receiver tests and preserving ground geometry on an individual clipping failure. The initial recommendation to silently exclude unpublished layouts was rejected: the user asked to share what is on the map. Claude accepted selecting the whole composition, naming publication blockers and requiring explicit exclusions.

## Remaining findings

- Existing OSM asphalt/kerbs beneath a proposed lake are a separate surface-ownership issue. This fix removes the continuous pavement cover; it does not redesign road/lake arbitration.
- A thin line beneath the top controls was reported in mobile Brave in 2D, absent in Chrome. It was not reproduced. The user explicitly deferred it; no speculative styling change was made.
- Draft agreements whose street fingerprints were created from the old expanded drawing form may need recreation. No compatibility reader or migration was added to this experimental contract.
- Concurrent Activity and source work shares several files. Integrated changes in mixed files are left uncommitted per workspace instructions: index markup, translations, command registry, planning views, design sync, vocabulary and generated control contract. The local commit contains only files owned by this task. No push or deployment was performed.
