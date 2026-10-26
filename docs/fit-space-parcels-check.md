# Parcel fitting verification

The park, square and lake geometry editors fit their outline to the largest touched source parcel
by total area, or to the union of all touched source parcels. The edit uses the cadastral repository,
retains authored furniture coordinates, respects the starting-site lock, and adds one Undo entry.
Loading failures, cancelled sessions and intervening outline edits leave the newer state intact.
The shared busy control spans the choice and lookup. A disconnected lake fit is refused.

MCP parity uses the existing `ugt_parcel_context` with a new outline selector, followed by
`ugt_inspect_design` and `ugt_edit_design`. The same overlap floor and lake generator/validator
serve both editing paths. Tests exercise all six space-kind/fit-choice combinations, atomic union
patches, coupled site/graphics updates and source immutability. See [MCP editing](mcp-editing.md).

## Headless unit runs

All commands ran from `backend` with `./node_modules/.bin/vitest run`, explicit file paths and
`--pool=threads --maxWorkers=2` (the last run used one worker). No run was stopped and no full suite ran.

| Run | Explicit test files under `test/` | Result |
| --- | --- | --- |
| 1 | `frontend-structure-edit-history.test.js`, `structure-geometry-editor.test.js`, `mcp-edit.test.js` | 64 passed, 5 failed. New harness assertions needed the real Undo button callback and an awaited lookup start. |
| 2 | `frontend-structure-edit-history.test.js`, `structure-parcel-fit.test.js`, `mcp-space-parcel-fit.test.js`, `frontend-duplicate-globals.test.js`, `frontend-self-wrapping-global.test.js`, `frontend-undeclared-globals.test.js` | 62 passed, 9 failed. A wrong working-directory path prevented the harness correction from applying; four new assertions also expected input order instead of area order. |
| 3 | `frontend-structure-edit-history.test.js`, `structure-parcel-fit.test.js`, `mcp-space-parcel-fit.test.js`, `mcp-read-tools.test.js`, `mcp-ground.test.js` | 77 passed after correcting fixtures and aligning the public query overlap floor. |
| 4 | `clip-failure-proposals.test.js`, `generator-inside-site.test.js`, `mcp-space-parcel-fit.test.js`, `mcp-server.test.js` | 72 passed, 1 failed. The added atomic-union test lacked its source-binding transport fixture. |
| 5 | `mcp-space-parcel-fit.test.js` | 11 passed after supplying the fixture. |

The latest results cover 174 passing checks across 13 targeted headless unit test files.
The extracted lake generator retains the existing clip-failure reporting checks. Public MCP
registration, source reads, inspect/edit operations and immutable revisions are covered.

## Headed Chrome checks

An owned background Chrome used this branch’s no-cache frontend and loopback API. The browser
resolved the explicit backend URL, loaded real cadastral ground, and received 23 parcels and
49 buildings for the checked view. Its initial incomplete script load was a preview-server
connection-backlog issue; increasing that server’s backlog and reloading loaded the full editor.

Two real touched parcels had areas of about 663 m² and 320 m². The visible park chooser selected
the larger parcel, Undo restored the original outline, and All touched saved their 982 m² union.
The tree remained at its authored coordinate. The saved site uses canonical MultiPolygon wrapping
and has zero area difference from the saved outline. The lake saved the same union with matching
shore/water graphics and a connected boundary. The square saved the larger parcel and retained
its fountain position. The chooser was inspected at desktop size and at 390 × 844 pixels.

No headless or headed Playwright suite ran for this change. Temporary browser drafts stayed local.
