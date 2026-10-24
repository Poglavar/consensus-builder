# Named plan snapshots — 2026-10-24

Designs → Share → **Name this plan** saves the selected published designs and the view
captured when Share opened. **Plan name** is the text field; **Save plan link** publishes the
snapshot; **Copy URL** copies its compact link. A matching saved snapshot shows **Rename plan**.
Changing its name, members or view creates another CID and leaves previous links intact.

`plan/v1` is a new immutable record with `title`, sorted unique `designCids`, and `view`
(location, city, language, display settings, 2D/model/photo mode and optional camera).
It does not create agreement terms or rewrite a design. Backend overrides are transport
configuration and are excluded from the hashed record. There are no expiring preview tokens.

`POST /plans` validates the record and indexed design references, pins its canonical bytes,
and indexes the result in `consensus.plan`. The browser verifies the returned CID and reads the
record back with `GET /plans/:cid` before presenting the saved link. Repeated identical saves
reuse the record. A save failure keeps the ordinary design-selection link available.

Opening `/plans/:cid` restores missing saved view parameters through the normal URL bootstrap
and uses the existing shared-design conflict/application flow. Explicit view parameters in the
arrival URL take precedence. Capturing that arrival URL before map creation prevents a remembered
local map position from overriding the saved view. The name appears in the page title and Share
header. Social previews use the name and the existing combined design image service.

## Release and local verification

The backend deployment includes the new `backend/db/plan-ddl.sql`; frontend scripts and the
social-preview worker must also be released. The worker configuration adds `/plans/*`.
No production deployment was performed for this task.

Commit scope: `frontend/index.html`, the four locale JSON files and `vocabulary.md` contain
concurrent economic-source edits as well as this task's edits. Per workspace rules they remain
uncommitted in the shared worktree. Their named-plan script-loading, translations and glossary
changes are part of the verified local implementation and must be committed before release.

The local frontend on port 8097 serves this worktree, branch `colosseum-worlds-fair`.
An isolated API on port 4401 serves the new route without restarting the shared API on 4398.
The local database received the new table and the exact 17 already-published Digbeth designs.
The UI saved **Digbeth Green Quarter** as
`bafkreialwke7lbw3wjnccsb3iwwudmwzyk3bvxckxwg5dvgt2w3rel4rva`.
The plan was pinned and read back from the local API; its public API index was not populated.
The local review path is `/plans/<that CID>?backend=http%3A%2F%2Flocalhost%3A4401`.

A dedicated headed Chrome opened that compact link and reported 17 applied designs, Birmingham,
center `52.47935,-1.87943`, zoom 18 and the saved page title. Desktop and 390px mobile screenshots
confirmed that the name, link and copy control fit above the scrolling list. This was manual
headed browser verification, not a headed Playwright suite.

## Targeted test runs

Only targeted suites were run. Commands below run from `backend` for headless unit tests and
from `e2e` for headless Playwright tests.

1. Headless unit tests: `npx vitest run test/named-plans.test.js test/app-routes.test.js
   test/map-share.test.js test/og-proposals-worker.test.js --maxWorkers=2`: 4 files, 78 passed.
2. Headless Playwright: `tests/named-plans.spec.ts tests/share-panel-scrolling.spec.ts`,
   Chromium, intended 6 tests: did not start because the new spec had a syntax error. Fixed.
3. Headless Playwright, same 2 specs: 1 failed, 5 did not run; stopped after trace-write errors.
4. Headless Playwright, same 2 specs with isolated `/tmp` output: 1 failed, 1 interrupted,
   4 did not run; stopped after disk exhaustion caused trace and IndexedDB failures. This also
   exposed an early API-helper lookup in the new route; the request now runs at route startup.
5. Headless unit tests: the 4 files from run 1 plus `test/i18n-locale-coverage.test.js` and
   `test/frontend-world-entry.test.js`: 6 files, 133 passed, 7 failed, completed.
   One failure was an overly broad new `/plans/` world-entry pattern; fixed. Two pre-existing
   world-entry expectations referenced the retired Overture source and an old activity command.
   Four locale checks reported missing feedback-page strings plus an existing Share fallback
   key. The Share fallback now uses an existing translated key. Feedback strings and those two
   unrelated expectations remain outside this change.
6. Headless Playwright, same 2 specs, isolated output: 4 passed, 2 failed, completed.
   All 3 scrolling/highlight checks and the save-error check passed. The two cross-device checks
   caught the remembered map position overriding the saved center; fixed by capturing the
   arrival URL before map creation.
7. Headless Playwright: `BASE_URL=http://localhost:8097 npx playwright test
   tests/named-plans.spec.ts --project=chromium --output=/tmp/ugt-named-plan-e2e-ready
   --reporter=list`: 3 passed, completed. Desktop and mobile saves, renames, original-link
   preservation, cross-device restoration and visible/retryable save failure pass.
8. Final headless unit tests: the 4 files from run 1, now 79 tests: all passed, completed.
9. Final headless unit tests: `npx vitest run test/frontend-world-entry.test.js
   -t 'shared routes and first visit' --maxWorkers=2`: 4 passed, 42 skipped, completed.
10. Headless unit tests after tightening the app route to reject former nested score paths:
    `npx vitest run test/app-routes.test.js --maxWorkers=2`: 36 passed, completed.

The completed final checks cover canonical identity, validation, persistence, pin/hash failure,
membership validation, explicit URL overrides, camera/mode serialization, startup timing,
social metadata and saved-name UI. No full unit or browser suite was run.
