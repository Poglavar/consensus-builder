# Combined Designs panel

The map navigation has one Designs button. It opens a right-side panel on desktop and the shared
resizable sheet on phones. Its Designs tab retains browsing, filtering, applying, importing and
plan actions; its Share tab retains selection, publication, links and agreement creation. Empty
maps share their location in the same panel. Map exploration leaves the panel open; its close
control or Escape dismisses it. Leaving Share releases its map-picking mode.

Pending Share opens are cancelled when the panel closes or another tab is chosen. Tabs retain
keyboard focus while loading and support arrow keys, Home and End. Sharing has no second modal,
header or phone resize handle. No design, agreement or publication format changed.

## Verification

Only targeted checks ran; no full suite ran and no run was stopped.

| Run | Type and scope | Result |
| --- | --- | --- |
| 1 | Headless unit: share-plan-panel-contract, share-plan-map-link, share-plan-spinner, frontend-dock-sheets, frontend-proposal-list-navigation, proposal-list-close-selection, mobile-dock-sheet; 7 files | 52 passed, 2 failed, 2 files failed to load: an edited source-marker comma, stale body-mount marker, missing test stubs and an existing Activity stylesheet exception |
| 2 | Headless unit: same 7 files | Same result: correction command used the wrong working directory and did not apply |
| 3 | Headless unit: same 7 files after correcting fixtures | 106 passed |
| 4 | Headed Playwright: designs-panel; 3 scenarios | 3 failed: hidden dialog templates counted as open, incorrect profile helper call, and a real keyboard-focus loss while disabling the loading Share tab |
| 5 | Headless unit: share-plan-spinner, proposal-list-close-selection, frontend-ui-commands; 3 files | 81 passed, including keyboard-focus and deferred-open cancellation regressions |
| 6 | Headed Playwright: designs-panel; 3 scenarios | 3 passed: desktop browsing/empty share, publishing/link creation/tab cleanup, phone sizing and keyboard tabs |
| 7 | Headless unit: designs-panel, share-plan-panel-contract, share-plan-spinner; 3 files | 49 passed, including awaiting list mounting and invalidating deferred Share opens |
| 8 | Headed Playwright: designs-panel, empty-map scenario after final empty-list cleanup; 1 scenario | 1 passed |
| 9 | Headed Playwright: dock-sheets; 3 scenarios | 3 passed: right-side placement, phone navigation geometry, design-row context opening |

Desktop browsing, desktop publication and phone sharing screenshots were inspected. The real
publication check used the test server fixture: it sent one design publication and exposed its
CID link in the panel. Browser output directories were isolated from concurrent local runs.

The shared working files `frontend/index.html`, `frontend/css/map-shell.css`,
`frontend/js/ui/map-shell.js`, `frontend/js/proposals/dialog-share.js` and
`backend/test/share-plan-panel-contract.test.js` also contain another session's edits. Their
combined-panel changes remain in the worktree rather than sweeping that session's work into this
commit. Ground-treatment locale and vocabulary changes likewise remain in shared working files.
