# Accessible map editing

Verification record, 2026-10-27. This change adds alternatives to pointer-only map editing while
retaining the authored design and existing save/Undo paths.

## Controls and behavior

- **Objects**: search and select numbered furniture, planting, paths and water features. Edit a
  position, move by a stated distance, change tree kind/height, or remove an object. Native selects
  and buttons support keyboard and single-click operation.
- **Edit vertices**: select a numbered vertex, enter latitude/longitude, move north/east/south/west,
  add a point after it, or remove it. Building outlines and holes have distinct disclosure names.
- **Move area**: translate the complete park, square or lake and its authored contents.
- **Place at coordinates**: add furniture or successive path points using fields. Enter in those
  fields adds the point; it does not also finish the path. A rejected path remains open for correction.
- The shared editor focuses its heading on entry and restores the opener on exit. Native controls
  retain focus and expansion through building redraws. Movement, Undo, placement, errors and parcel
  loading have status announcements. The collapse action remains keyboard-operable on mobile.
- Design thumbnails identify their design in alt text, including after an asynchronous thumbnail
  update. Enlarged copies are decorative. Search controls expose their search purpose.

Presentation uses the existing field/action/disclosure categories and theme variables in external
CSS. New copy is present in all seven UI languages. No record schema, object identity, domain term
or publishing contract changes are introduced by the accessibility controls. Object numbers refer
to positions in existing authored arrays; they are not stable object IDs.

## MCP parity

The existing `ugt_inspect_design` and `ugt_edit_design` primitives expose these authored fields:

| Human edit | Existing agent operation |
| --- | --- |
| Move/add/remove polygon vertices | JSON Pointer patches into geometry coordinate arrays |
| Move an area or object | Coordinate replacement or the existing geometry transform operation |
| Place/remove furniture, planting or a path | Add/remove entries in `structureProposal.decorationDesign` |
| Change tree kind and height | Replace `kind` and `heightM` on the authored tree record |
| Edit a building outline or hole | Patch the corresponding building polygon ring |

The targeted `mcp-edit.test.js` checks valid park, square and lake vertex changes, tree properties,
invalid coordinates, and preservation of the source revision. Existing tests cover decoration edits,
building geometry and validation. Existing primitives are sufficient, so no new MCP tool, schema or
discovery entry is needed. The browser controls commit to the existing local editor draft. MCP still
uses expected-CID checks and returns immutable revisions; live synchronization between an already
open map and an agent conversation is not implemented by this change.

## Verification

The final state passes the targeted headless unit files for coordinate math, object movement,
polygon editing, the map shell, structure history, structure editing and MCP edits, plus three
shared-script/identity guards. Integration with Fit to parcels also passed its three focused files.
The four headless Playwright scenarios passed across the final complete run and the focused retry:

1. Search, two-metre movement, validation, tree properties, removal, Undo and saved state.
2. Lake vertex movement/addition/removal, invalid-shape rejection and regenerated saved graphics.
3. Courtyard building redraw with the same focused input retained and the hole unchanged.
4. Coordinate-based path placement at 390 px, keyboard collapse, visible Done action, saved path and
   thumbnail descriptions surviving the asynchronous update.

A dedicated headed Chrome was also driven manually against the local API. It resolved the intended
backend and city and returned 14 real parcels and 12 building footprints without truncation. A
native keyboard move changed a bench by one metre, retained button focus, and Undo restored the
stored position and bearing before Done. A 390 px visual review confirmed the scrolling object list,
visible Done action and a 44 px Cancel control revealed on keyboard focus, with no horizontal overflow
or page errors. Both dedicated test browsers were closed. The headless browser fixtures mock API
responses; the separate manual source checks verify the preview's real data route.

### Run ledger

All runs below completed; none were stopped. No full headless unit suite or full browser suite ran.
Repeated runs were limited to changed files or previously failing scenarios.

| Type | Scope | Result |
| --- | --- | --- |
| Headless unit | 3 Fit-to-parcels integration files, 26 tests | 25 passed, 1 failed; adjusted expectation for current decoration pruning |
| Headless unit | Same 3 integration files, 26 tests | 26 passed |
| Headless unit | 7 accessibility/geometry/MCP files, 121 tests | 98 passed, 23 failed in an older structure-history fixture |
| Headless unit | Structure history, 46 tests | 40 passed, 6 failed; corrected fixture geometry/touch expectations |
| Headless unit | Structure history, 46 tests | 44 passed, 2 failed; fixture referenced a replaced path layer |
| Headless unit | Structure history, 46 tests | 46 passed |
| Headless unit | Polygon editor and map shell, 41 tests | 41 passed |
| Headless Playwright | Accessibility spec, 3 scenarios | 3 failed; corrected field association, narrow-screen collapse and option locator |
| Headless Playwright | Accessibility spec, 4 scenarios | 3 passed, 1 failed; thumbnail description lacked its translation helper |
| Headless Playwright | Phone path/thumbnail scenario only | 1 passed |
| Headless unit | Structure history plus 3 shared-script guards, 54 tests | 53 passed, 1 failed; the new rejection fixture exposed a separate containment limitation |
| Headless unit | Structure history, 47 tests | 47 passed; rejection handling checked with a rejecting validator |

Headless unit files: `geometry-edit-coordinates.test.js`, `structure-editor-objects.test.js`,
`polygon-geometry-editor.test.js`, `on-map-editor.test.js`, `frontend-structure-edit-history.test.js`,
`structure-geometry-editor.test.js`, `mcp-edit.test.js`, `frontend-duplicate-globals.test.js`,
`frontend-undeclared-globals.test.js`, `no-home-paths.test.js`. Integration additionally uses
`structure-parcel-fit.test.js` and `mcp-space-parcel-fit.test.js`. All are under `backend/test/`.
The browser spec is `e2e/tests/accessible-map-editing.spec.ts`; it uses the shared page-error fixture.

## Limits and observed follow-up

Keyboard operation, native semantics, focus, saved state and narrow layout were verified. VoiceOver,
NVDA and voice-control software were not exercised; this is not a WCAG conformance assessment.
Polygon control coverage does not establish complete keyboard coverage for every specialized map
editor. Thumbnail alt text identifies the design, rather than generating a scene description.

The existing Turf line-within-polygon check can accept a segment whose endpoints are inside a
concave boundary while its middle crosses outside. A U-shaped boundary reproduced that behavior
in the installed app geometry library. This change keeps the existing geometry validation contract;
its rejection-handling regression injects a rejecting validator to verify that Save and tool changes
retain pending points. Full segment containment remains a separate shared geometry finding.
