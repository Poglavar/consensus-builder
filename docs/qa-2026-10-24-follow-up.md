# Follow-up to the 24 October live QA and adversarial reports

Verified locally on 25 October 2026. This checks the current implementation; it does not change the original deploy-508 observations. The supplied `ugt-stress-evidence-20261024.zip` was read alongside the report. No production designs were modified or published.

## Findings and changes

| Finding | Verification and result |
| --- | --- |
| Height-only edit restores demolished stock | Reproduced before the fix: 250 → 249 m kept the footprint but emptied the applied demolition records. Demolition scanning now uses the transaction's proposal store and collections, rather than the committed source that is still visible until commit. Replacement review excludes the source's own removals while retaining removals from other applied designs. Browser checks cover both in-place edits and a counterproposal fork. |
| Share exclusions disappear between tabs | Confirmed. Explicit exclusions persist between Designs and Share; closing the whole panel resets the selection. Browser checks cover both transitions and the generated share link. |
| Freeform height and station rotation lack Undo | Confirmed. Numeric changes now use the shared history stack, grouping pointer drags and held adjustment keys. No-op values add no history step. Station platform-height input uses the same path. |
| Stale slider accessible names | Freeform height and station bearing now have stable accessible names; native range values expose the current measurement separately. |
| Irregular-site Row cannot apply | Confirmed an overhang fallback that contradicted application containment. Generation now searches interior positions and all connected components, and requires whole-footprint containment, including holes. Invalid geometry cannot finish. Search is bounded and deduplicated; collinear source vertices are removed only from cloned generator geometry. |
| Globe failure is silent | First-visit globe boot now uses the same visible failure message as explicitly opening the globe. A WebGL-disabled browser check verifies the cover disappears and the 2D map remains usable. |
| Road cross-section edits discard without confirmation | Confirmed. Dirty toolbar-close and Escape actions offer Keep editing / Discard; unchanged editors close directly. Internal teardown remains synchronous. |
| Deleting the last Freeform building silently does nothing | The control is now disabled with an explanation that the design must retain one building. |
| Old plots controls are inert but appear enabled | Edit controls now use native fieldset disabling and ARIA state. Keyboard history is disabled in Old plots; returning to New plots preserves each control's prior validity state. |
| Track speed/radius after gauge changes | The selected 250 km/h / 5,000 m targets survived gauge changes, but an unresolved tight bend was silently accepted. Finish now reviews actual rail-bearing polylines and offers Keep editing / Continue with the measured radius. Snapped and unsnapped authored positions are preserved. This is an explicit drawing diagnostic, not operating-speed or engineering certification. |

## Findings not reproduced or not classified as defects

- **F1 live resize:** the current UI passes the exact 1180 × 757 → 500 × 757 transition without reload. A regression checks profile and bottom-navigation bounds. A separate headed check also showed compact controls and an unclipped bottom bar at 500 px. No speculative layout patch was added.
- **DGU 2024 imagery:** discovery and a subsequent real map-tile request both returned successfully through the local backend. The tile was visually inspected and contains aerial imagery. This does not exclude an intermittent provider or deployment failure.
- **Park tree properties:** the existing interaction rerolls kind and height when the Tree tool is selected. Its focused browser regression passed, including saved height and glyph size. There is no dedicated property inspector in this flow.
- **Narrow parcel workspace:** the existing Hide controls action frees map space. The report describes a usability limitation, not a demonstrated creation failure; no broader editor redesign was included.
- **Negative plot counts:** the report explicitly withdrew this finding after ordinary keyboard entry correctly clamped the value. No validation change was made for it.

## Real-data headed verification

The dedicated local browser resolved the API to the local backend and loaded real cadastral and building data. On `HR-335649-414/1` plus `HR-335649-414/10` (about 3,448 m²), the new Row default was approximately 31.5 × 15.5 m and 488 m². It fit inside the irregular selected land, finished after the nonbinding parcel-similarity warning, and was verified applied. The local Share exclusion survived Designs → Share and resizing to 500 px. The dedicated browser was closed afterward.

## Targeted validation

Only focused headless runs were executed; no full unit or browser suite was run.

| Headless unit batch | Final result |
| --- | --- |
| `geometry-edit-history`, `single-building-map-editor`, `transit-stations`, `corridor-editor-lifecycle`, `road-drawing-empty-profile` | 5 files, 75 passed |
| `frontend-world-entry`, `share-plan-panel-contract`, `share-plan-ready-signal` | 3 files, 75 passed |
| `track-curvature-review`, `corridor-geometry`, `road-finalization-contract`, `road-drawing-snap-wiring` | 4 files, 76 passed; the 3 new review tests also passed after the warning-title addition |
| `demolition-replay-transaction`, `demolition-bulk-prefetch`, `corridor-tunnel` | 3 files, 50 passed, including other-design removal preservation |
| `row-rule-rerun-placement`, `building-family-placement`, `on-map-building-families` | Final 3-file run: 28 passed, including a 480-vertex concave ring and bounded-search assertions |
| `parcel-layout.characterization` filtered to Old plots | 1 passed, 31 skipped |
| `frontend-duplicate-globals`, `no-home-paths` | Both passed in the 3-file guard run |
| `i18n-locale-coverage` | 1 file, 15 passed; includes the registered Feedback dictionary as well as main JSON dictionaries |

Headless Chromium checks passed in these focused runs:

- `designs-panel`: 2 checks for live resize and Share selection lifecycle.
- `world-failure`: 1 check for WebGL-disabled globe boot.
- `editor-button-controls`: 2 checks for Freeform height and station geometry Undo; 3 checks for dirty cross-section close/cancel and lane controls.
- `road-editor-complete-controls`: 1 check for cross-section Escape without cancelling the road draft.
- `parcel-layout-button-controls`: 1 check for Old plots read-only behavior and restored New plots controls.
- `freeform-land-take`: 2 checks for retained demolition after height-only edits, including a locally marked published source that forks without external publication.
- `designer-controls`: 1 track gauge/radius review check, including refusal, continuation and persisted metadata.
- `structure-placement`: 1 existing tree-reroll/save check.

Intermediate failures were resolved: the demolition browser regression failed before the production fix; extracted-function harnesses needed their current dependencies; two Share selectors needed narrowing after the name input was added; and the dense Row fixture exposed excessive clipping work before search bounding and collinear cleanup. The first tree-browser attempt did not execute a test because the sandbox could not reach the running frontend; the retry passed. The translation guard initially treated the separately registered Feedback dictionary as missing JSON keys; coverage now loads its actual per-language entries and checks its dynamic prefix too.
