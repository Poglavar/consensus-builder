# Browser behavior and control coverage

Run commands from `e2e/` after installing its dependencies and the backend dependencies. The source scanner uses the backend's existing `@babel/parser` dependency.

```sh
npm run check:features
npm run check:controls
UI_CONTROL_HEADLESS=1 npm run test:controls
npm run test:controls
npm run prove:controls
```

`check:features` checks the command-to-spec inventory. `check:controls` checks the instrumentation, coverage gate, current source inventory and guarded exclusions without a browser.

`test:controls` runs the complete behavioral suite in headed Chrome, one worker at a time, with background throttling disabled. Set `UI_CONTROL_HEADLESS=1` to run the same suite headlessly. Its temporary server serves the real frontend at `http://127.0.0.1:63941` with caching disabled. Tests use isolated browser storage and fixtures at network, wallet-provider and operating-system boundaries. They operate the actual UI and assert resulting dialogs, stored proposals, map geometry, navigation, clipboard values or submitted transactions. JavaScript page errors fail the test, including errors in extra contexts created for shared-link and mobile cases.

The test server adds source identities to authored buttons, button roles, links styled as buttons, editable inputs, selects, textareas and ARIA sliders. Buttons require a trusted click; editable fields require a value change from real input. Range inputs are operated with keyboard or pointer input. Building gap and wing handles require a trusted pointer drag that moves the handle, with the resulting boundary position checked in the saved proposal. Native file choosers, selects and date/time pickers use explicit Playwright boundaries: `setInputFiles` and the marked `selectNativeOption` and `fillNativeDateTime` helpers. An unmarked synthetic input/change event earns no coverage. An interaction counts only when its behavior test passes.

The macOS browser hook opens each headed page in its own window behind the active app. Pages in the same browser context still share storage, so multi-page protection is exercised without leaving the driven page in an inactive tab. It leaves headless launches untouched: creating headless targets with `background: true` stalls secondary pages even with the anti-throttling flags. Popup tests inspect and close the destination concurrently with the opener's click; waiting for the click first can stall its input or navigation acknowledgement in headed Chrome.

The checked-in `control-contract.json` also lists distinct actions made by shared helpers and interactive controls supplied by Leaflet. Shared factories may create buttons or fields, so their variants retain the appropriate interaction type. The gate rejects unexercised required controls, undeclared action variants, unrecognized runtime controls, changed or removed source controls, and failed tests. The live-devnet transaction test is an explicit opt-in: without `E2E_DEVNET=1`, its exact identity and skip reason must match the contract. It is reported separately and earns no coverage; any other skip fails the gate. Inactive code, read-only output fields, permanently disabled fields and a fixed single-option select have specific source guards; enabling them requires adding their behavior tests.

Results are written to:

- `playwright-report/index.html`: browsable test results, screenshots and failure traces.
- `test-results/control-results.json`: Playwright results with recorded control interactions.
- `test-results/control-coverage.json`: source inventory, separate button/field/factory counts, exclusion reasons, per-action clicks or changes and the tests that exercised them.
- `test-results/mutation-proofs.json`: deliberate regression checks.

`prove:controls` temporarily hides compact Edit, compact support and Actors, covers the mobile road mode buttons, and restores the old Bets page-load race. It changes only served responses. Each selected test must fail at the expected behavior assertion; a crash or browser launch failure does not count as proof. The normal suite must also pass without these mutations.

For a focused headed investigation:

```sh
npx playwright test --config playwright.controls.config.ts tests/mobile-road-reachability.spec.ts
node scripts/report-controls.mjs
```

A focused run leaves the rest of the control inventory uncovered. Start final verification with the complete `test:controls` run. If a failed case needs a focused recheck, preserve the original results and set `UI_CONTROL_RESULTS`, `UI_CONTROL_OUTPUT` and `UI_CONTROL_HTML_OUTPUT` to separate paths for its JSON, attachments and HTML report. Do not override the configured reporters: passing tests' coverage attachments are retained in the JSON report. Pass both JSON paths to `report-controls.mjs --check` in chronological order; the latest result for each test wins. The coverage report records its input files. Keep headless and headed result sets separate. Runs against older application revisions are diagnostic evidence and must not replace this complete baseline.

When adding or intentionally changing a control, write a behavior assertion for its user-visible effect, review its source identity in the coverage report, and update the contract. For a shared helper, add a stable action matcher such as `data-command`, an action class or a field name. Do not use a changing proposal ID, amount or translated display name when an action attribute is available. Avoid forced clicks and calls to the application handler being tested: an inaccessible or disconnected control must make the test fail.

## Validation and remaining gaps — 2026-10-16

The current catalog has 636 browser scenarios. The headless and headed baselines with focused rechecks each account for all current scenarios: 635 passed and one declared live-devnet case was skipped. Both mode-specific control gates pass. Six earlier test titles were replaced during the audit; the headless aggregate retains their identities and the original result files as provenance.

| Check | Result |
| --- | --- |
| Headless backend, including local database cases; full run plus focused rechecks | 12,317 passed, 1 live Walrus test skipped |
| Headless Solana programs on the local validator | 197 passed |
| Headless EVM contracts on the local chain | 32 passed |
| Headless Playwright, current catalog after focused rechecks | 635 passed, 1 live-devnet test skipped |
| Headed Playwright, full run plus focused rechecks | 635 passed, 1 live-devnet test skipped |
| Headless control instrumentation and reporting unit tests | 35 passed |
| Headless macOS browser background hook unit tests | 3 passed |

The backend total combines the DB-enabled full run, clean-environment rechecks of three files affected by application settings in the runner, and three added regressions. It is not a claim that the initial invocation passed unchanged. The 34.7-minute headed baseline finished with 629 passing cases, six popup or secondary-page failures, and one opt-in skip. All six focused headed rechecks passed after correcting the browser window and popup lifecycle. Original failure reports and traces remain available.

Each browser mode's final control gate records passing interactions for 652 button sites, 258 form-field sites and 19 shared factories, including all 291 declared action variants and 13 runtime controls. Gap and wing handles have real drag assertions. The final headless rechecks also refresh the two survey-picker cases recorded before checkbox-label attribution was completed.

The audit fixed shared road-junction metadata and undo, colliding proposal IDs, duplicate Marketplace popups, multipart building containment, lost proposal-save error messages, and browser parcel-bundle reproducibility across checkouts. It added coverage for the shared map editors, road scope and paving, building sliders and boundary handles, proposal fields, and moving 3D people and traffic.

Remaining gaps and scope limits:

- The external Walrus testnet round trip requires `WALRUS_LIVE_TEST=1`. The live minted-proposal ownership test requires `E2E_DEVNET=1`. Neither opt-in ran; local-chain tests and mocked wallet/service boundaries do not replace those live checks.
- The source inventory excludes 65 inactive or noninteractive sites. Each exclusion has a reason and checked source conditions in [control-contract.json](control-contract.json). Enabling an excluded control requires restoring its behavior coverage.
- Source review found that a shared-junction drag commits each affected road separately. If one road fails after another succeeds, the junction can be partially moved until undo. The successful move and undo paths are tested; an injected failure across several roads and atomic rollback are not covered by this browser audit.

Local artifacts: [headless coverage and input reports](test-results/cwf-full/headless-control-coverage.json), [headed full-run HTML report](playwright-report/cwf-full-headed/index.html), [passing headed rechecks](playwright-report/cwf-final-headed-recheck/index.html), and [headed coverage and input reports](test-results/cwf-full/headed-control-coverage.json). The [current coverage report](test-results/control-coverage.json) includes every source exclusion. These generated artifacts are kept locally and are not committed.
