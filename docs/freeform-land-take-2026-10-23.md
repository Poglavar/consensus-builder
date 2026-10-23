# Freeform parcel land take

The global whole-parcel toggle is replaced by a Land take review for each touched current live
parcel. Footprint only is the default; Whole parcel adds that parcel's entire current outline.
The building remains narrow. Exact `geometry.landTake` is shared by binding, parcel formation,
owner remainders, demolition prefetch/replay and agreement derivation. Green/paved surroundings
use the taken ground minus the building footprint.

The review highlights taken land, retained ground and building removals, distinguishes full
removals from partial cuts, and identifies overlapping applied designs. Done refreshes the source
answer and requires acceptance of unchanged consequences. Missing, unsupported, truncated or
absent building answers cannot pass as empty ground. The model preview receives the same take
boundary and excluded building geometry. This is local design acceptance, separate from agreements.

Experimental records carrying only the retired `takeWholeParcels: true` setting must be reopened
and reviewed/recreated. Apply refuses them rather than silently dropping the intended yard.
Disconnected imported buildings continue to save independently; whole-parcel choices are available
when editing one connected building at a time.

UI names for follow-up: **Land take**, **Footprint only**, **Whole parcel**, **All footprint**,
**All whole**, **Retry review**, and the **land-take acceptance checkbox**.

## Verification log

All automated executions were targeted and headless. Browser runs used one worker and no retries.
No full unit or browser suite ran. No run was intentionally stopped. Earlier checks were repeated
only after failures or related source changes.

| Run | Type and scope | Result |
| --- | --- | --- |
| U1 | Headless unit, 3 collected files, 105 cases | 101 passed, 4 failed; formation file did not collect because a comment-range edit removed an apply-method tail. Restored that tail. The new test-file write had also used the wrong working directory. |
| U2 | Headless unit, 4 files, 125 cases | 124 passed, 1 failed; containment validation intercepted the existing deliberate clip-failure probe. Limited the additional check to authored larger takes. |
| U3 | Headless unit, 6 files, 153 cases | Passed. An additional requested footprint-parts filename did not exist and collected no file. |
| U4 | Headless unit, 3 files, 19 cases | 14 passed, 5 failed and one unhandled rejection; extraction harnesses needed the new review lifecycle, async Done, and concurrent model-outline stubs. |
| U5 | Headless unit, 3 files, 19 cases | Passed after harness updates. |
| U6 | Headless unit, 4 files, 54 cases | Passed after unifying stock reads. |
| U7 | Headless unit, 3 files, 102 cases | 101 passed, 1 failed; conversion fixture still expected the retired boolean. Updated to explicit take context. |
| U8 | Headless unit, 7 files, 159 cases | Passed. |
| U9 | Headless unit, 10 files, 184 cases | Passed; final affected-scope unit run. |
| B0 | Headless Playwright discovery | No tests collected: new file write used the wrong working directory. Corrected the write before execution. |
| B1 | Headless Playwright, 2 cases | Both failed on zero-size editor-root visibility assertions; scoped to its visible panel. |
| B2 | Headless Playwright, 2 cases | 1 passed, 1 failed because the assertion ran before asynchronous save completed. Added a save-state wait. |
| B3 | Headless Playwright, 2 cases | 1 passed, 1 failed: review and apply used different stock fetch paths. Unified complete source reads. |
| B4 | Headless Playwright, 2 cases | 1 passed, 1 failed on a parcel selector that also matched background UI. Scoped to the review rows. |
| B5 | Headless Playwright, 2 cases | Passed. |
| B6 | Headless Playwright, 4 cases | Passed: whole take, mixed take/Undo, incomplete stock and changed consequences. |
| B7 | Headless Playwright, 8 cases in 2 files | 7 passed, 1 failed: the existing GLB fixture answered a fixed single-region key while apply requested a different key. Aligned the single-region apply request with review. |
| B8 | Headless Playwright, 1 selected GLB/Duplicate case | Passed. |
| B9 | Headless Playwright, 5 land-review cases | Passed, including phone-size acceptance visibility above the fixed footer. |
| B10 | Headless Playwright discovery, surroundings filter | No tests collected: anchored filter included the file prefix. Corrected to the exact test-title substring. |
| B11 | Headless Playwright, 1 selected existing surroundings case | Passed: Freeform whole-parcel yard, furniture child-editor cancel/save, publication and reopen. |

Final affected-scope coverage: **184 headless unit cases in ten files and ten headless Playwright
cases in three files**, accumulated from their final passing affected runs. The five land-review
cases include the added mobile check. The four GLB/Duplicate cases passed as three cases in B7 plus
the corrected case in B8; B11 covers the existing surroundings flow. All earlier failed assertions
and the real source-read discrepancy were corrected.

Manual visual inspection used a dedicated background headed Chrome on the local preview, with
explicit two-parcel/source-stock fixtures at desktop and 390 × 844. Production parcel/building
availability was not inferred from those fixtures. The static production bundle builds successfully;
all four translation dictionaries parse with the same 15 land-review keys. One initial dictionary
check asserted an incorrect expected key count; comparing actual sets corrected the check.
| B12 | Headless Playwright, 1 untouched-review Cancel case | Passed after keeping automatic initial geometry loading out of the discardable-edit signature. |

The final browser total is **11 distinct targeted headless Playwright cases** across three files.
The final unit total remains 184 cases across ten files. Browser session cleanup reports no active
sessions. The local preview is available at http://localhost:8098.

The scoped checkpoint excludes `frontend/js/single-building.js`: that file also contains another
session's uncommitted GLB footprint-placement changes. The tested working tree includes both sets
of edits; the checkpoint alone is not the complete editor wiring. Translations and the vocabulary
contract were included by a concurrent inspection checkpoint while this task was running. Other
sessions' dirty files are preserved. No push or deployment was performed for this change.
