# Freeform GLB import and explicit duplication

User decision: replace Fork with click-to-place Duplicate. Before the change, Freeform exposed
only GeoJSON import, and Fork opened a prefilled proposal form rather than placing a copy.

Freeform now exposes **Upload .glb** beside **Upload GeoJSON**. The existing model importer
replaces the selected building in the active editor, preserving siblings, surroundings and undo
history. Escape dismisses the importer without dismissing Freeform. A closed importer cannot
apply a late upload response to a later editor session.

Duplicate copies authored material geometry for Freeform, park, square and lake designs. The
preview follows the pointer; a click creates a fresh local design through the ordinary binding
and application pipeline. Dragging does not place it; Escape cancels without retaining a draft.
The source and its agreements stay unchanged. Imported mesh references and local model settings
remain intact. Geographic geometry and decorations move; model-local coordinate arrays do not.
Site-bound rules, layouts, corridors, attached stations and rights acts have no free-copy action.

The old Fork entry point is removed from the editor shell. This deletion, the matching
vocabulary section, four translation files and control inventory share files with another
session's changes and are intentionally left uncommitted until those files can be committed by
their owners. No push or deployment occurred.

## Verification log

All automated runs below were targeted and headless, with one browser worker and no retries.
No full suite was run. Earlier passing cases were rerun only after changes or failed checks.

| Run | Type and scope | Result |
| --- | --- | --- |
| Initial pure/runtime tests | Headless unit, 1 file | 6 passed |
| Initial new browser spec | Headless Playwright, 1 file | Did not collect: fixture used CommonJS-incompatible import metadata; corrected fixture path |
| New browser cases, second attempt | Headless Playwright, 4 cases | 4 failed on stale Design-tab and zero-size editor-root locators; corrected locators |
| New browser cases, third attempt | Headless Playwright, 4 cases | 3 passed, 1 failed because Freeform has no Redo; changed check to reimport after Undo |
| GLB case rerun | Headless Playwright, 1 case | Passed |
| Adjacent units | Headless unit, 5 files | 56 passed |
| Upload callback units added | Headless unit, 6 files | 60 passed |
| New flow and existing importer | Headless Playwright, 10 cases in 2 files | 5 passed, 5 failed: standalone fixture lacked UTF-8 and placement destination was outside the zoomed viewport |
| Model cases after fixture/viewport fixes | Headless Playwright, 5 cases in 2 files | 5 passed |
| Adjacent changed controls | Headless Playwright, 9 selected cases in 9 files | 5 passed, 4 failed on obsolete form setup, city alias, origin expectation and modal visibility assertion |
| Adjacent corrected fixtures | Headless Playwright, 4 cases | 3 passed, 1 failed because Similar requires selected ground |
| Similar navigation, first rerun | Headless Playwright, 1 case | Failed: source details covered the parcel click; selected ground before opening details instead |
| Final pure/runtime and renderer units | Headless unit, 7 files | 68 passed; one preceding invocation from the wrong working directory did not launch tests |
| Final browser attempt within sandbox | Headless Playwright, 4 cases | Browser launch aborted under the sandbox; no application checks ran |
| Final new flow verification | Headless Playwright, 4 cases in 1 file | 4 passed, 21.7 seconds |
| Final Similar navigation | Headless Playwright, 1 selected case | Passed, 10.9 seconds |
| Accessible Duplicate label refinement | Headless unit, 2 files | 28 passed |

Final passing affected-scope coverage totals 68 headless unit tests in seven files and 19 headless
Playwright cases in eleven files, accumulated across the final affected-scope runs. The final
details-label check repeats 28 of those unit tests. No run was intentionally stopped.

Unit files under `backend/test/`: `design-duplication`, `building-upload-callback`,
`proposal-panel-actions`, `proposal-details-readonly`, `single-building-map-editor`,
`optional-tools-loader`, and `three-mode-on-map-editor-preview`, all ending in `.test.js`.

Browser files under `e2e/tests/`: `freeform-upload-duplicate`, `building-upload`,
`proposal-compact-actions`, `proposal-browsing`, `proposal-editor`, `proposal-form-controls`,
`editor-button-controls`, `proposal-button-controls-sixth`, `remaining-ui-controls`,
`simulation-log-controls`, and `parcel-layout-editor`, all ending in `.spec.ts`.

The control inventory matches all 857 source sites. Translation JSON, JavaScript syntax and
diff whitespace are checked separately. Dedicated headed Chrome was used for visual inspection
at 390 × 844; actual placement and binding are covered by the mocked headless browser cases.
An unmocked local preview cannot prove production model-upload or cadastre availability.

The earlier menu integration remains separately recorded at `84e302d91` on
`integrate/menu-user-flows-20261023`; concurrent overlapping target edits prevented its merge.
