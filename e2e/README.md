# Browser behavior and button coverage

Run commands from `e2e/` after installing its dependencies and the backend dependencies. The source scanner uses the backend's existing `@babel/parser` dependency.

```sh
npm run check:features
npm run check:controls
npm run test:controls
npm run prove:controls
```

`check:features` checks the command-to-spec inventory. `check:controls` checks the instrumentation, coverage gate, current source inventory and guarded exclusions without a browser.

`test:controls` runs the complete behavioral suite in headed Chrome, one worker at a time, with background throttling disabled. Its temporary server serves the real frontend at `http://127.0.0.1:63941` with caching disabled. Tests use isolated browser storage and fixtures at network, wallet-provider and operating-system boundaries. They click the actual UI and assert resulting dialogs, stored proposals, map geometry, navigation, clipboard values or submitted transactions. JavaScript page errors fail the test, including errors in extra contexts created for shared-link and mobile cases.

The test server adds source identities to authored buttons, button roles and links styled as buttons. A trusted click counts only when its behavior test passes. The checked-in `control-contract.json` also lists distinct actions made by shared helpers and interactive controls supplied by Leaflet. The gate rejects unclicked required controls, undeclared action variants, unrecognized runtime buttons, changed or removed source controls, and failed tests. Intentionally inactive code has a specific source guard; wiring it back into the app requires adding its behavior test.

Results are written to:

- `playwright-report/index.html`: browsable test results, screenshots and failure traces.
- `test-results/control-results.json`: Playwright results with recorded button interactions.
- `test-results/control-coverage.json`: source inventory, required-button counts, exclusion reasons, per-action clicks and the tests that exercised them.
- `test-results/mutation-proofs.json`: deliberate regression checks.

`prove:controls` temporarily hides compact Edit, compact support and Actors, covers the mobile road mode buttons, and restores the old Bets page-load race. It changes only served responses. Each selected test must fail at the expected behavior assertion; a crash or browser launch failure does not count as proof. The normal suite must also pass without these mutations.

For a focused headed investigation:

```sh
npx playwright test --config playwright.controls.config.ts tests/mobile-road-reachability.spec.ts
node scripts/report-controls.mjs
```

A focused run leaves the rest of the button inventory uncovered. Start final verification with the complete `test:controls` run. If a failed case needs a focused recheck, preserve the original results and set `UI_CONTROL_RESULTS`, `UI_CONTROL_OUTPUT` and `UI_CONTROL_HTML_OUTPUT` to separate paths for its JSON, attachments and HTML report. Pass both JSON paths to `report-controls.mjs --check` in chronological order; the latest result for each test wins. The coverage report records its input files. Runs against older application revisions are diagnostic evidence and must not replace this complete baseline.

When adding or intentionally changing a button, write a behavior assertion for its user-visible effect, review its source identity in the coverage report, and update the contract. For a shared helper, add a stable action matcher such as `data-command` or an action class. Do not use a changing proposal ID, amount or translated display name when an action attribute is available. Avoid forced clicks and calls to the application handler being tested: an inaccessible or disconnected button must make the test fail.
