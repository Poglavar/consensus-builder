<!-- Validation and implementation notes for the NGO consultation flow; definitions live in vocabulary.md. -->
# Community consultation validation — 2026-10-25

Implemented on `colosseum-worlds-fair`: community agreement creation and metadata, direct DID Web
checks, Solana message-signed result reports, immutable report pinning and append-only indexing,
participation/report links, history and live authorization badges. MCP drafts and revisions retain
the same metadata. No dependencies, chain programs, compatibility readers or migrations were added.
The additive report table is applied by the existing backend deployment DDL list.

## Headless unit checks

All commands below ran from `backend/`, with explicit test-file arguments and at most two workers.
No full headless unit suite or full browser suite ran.

| Targeted files | Outcome |
| --- | --- |
| `community-result`, `agreement-panel`, `agreement-record`, `agreement-store`, `agreement-sync`, `community-reports`, `agreements-route` | 7 files, 223 passed |
| `community-result`, `agreement-record`, `agreement-store`, after final validation and escaping coverage | 3 files, 91 passed |
| `agreement-record`, final overlong and non-text metadata cases | 1 file, 44 passed |
| `og-proposals-worker`, `well-known` | 2 files, 32 passed |
| `i18n-locale-coverage` | 1 file, 15 passed; final focused source-key check also found all 46 consultation keys in all 4 locales |
| `frontend-duplicate-globals`, `frontend-static-build` | 2 files, 16 passed |
| `agent-agreement-objects`, `mcp-ground`, `mcp-plan` | 3 files, 33 passed |
| `node --test test/community-did-web.node.test.js` | 5 passed |

The signature tests use real generated Ed25519 keys and verify altered content, wrong agreement
CIDs and organisers, bad signatures, changed DID snapshots, unsupported networks, future signing
times and website wallet removal. Reports after a deadline are explicitly accepted. The client
must reobserve the exact content-addressed report before showing publication success.

Earlier focused development runs found and corrected a changed record-key expectation, a DID URL
path separator, missing locale titles, a schema-edit syntax error and outdated financial community
fixtures. Rechecks of the editor's three unit files passed 106 and then 108 tests; the report API's
two files passed 67 and then 68 tests as coverage grew. One intermediate Supertest attempt was
blocked by sandbox HTTP-listener restrictions and rerun outside the sandbox. The first locale
scanner passed 11 checks and failed the four missing-title checks; all 15 passed after correction.
The initial DID checks and subsequent bounded-fetch/DID-path rechecks each passed their five checks.
No running test suite was stopped or expanded into a full suite.

## Headless Playwright checks

- Initial targeted run: 9 tests in `agreement-dialog.spec.ts`, `agreement-propose.spec.ts`,
  `agreement-readonly-route.spec.ts`, `community-consultation.spec.ts`: 7 passed, 2 failed. One
  expected the superseded community cash/allocation behavior; the other used a park fixture with no
  drawable geometry. Both test assumptions were corrected.
- Recheck of `agreement-dialog.spec.ts` and `community-consultation.spec.ts`: 5 passed.
- Recheck of the two consultation tests after final validation/UI changes: 2 passed.
- Control-instrumented consultation checks initially passed 1 and failed 1 because the external
  popup mock was registered on the original page. Moving those mocks to the browser context fixed
  the fixture. The final headless instrumented run passed both tests.
- All **10 newly added source controls**, including all four variants of the community action
  helper, have passing interactions. Tests open participation, detailed-report and signed-record
  links, connect the reporting wallet, cancel a report draft, publish two reports, read them back,
  retain history, remove website authorization and verify that another signature is never requested.
- `check-control-contract.mjs` matches 885 source sites and its exclusion guards pass.

The separate `check-feature-inventory.mjs` reports four missing commands and six retired command
names. Comparing its command inventory at `HEAD` confirms the same pre-existing mismatches; the
new consultation workflow references an existing, passing spec. Unrelated command mappings were
left unchanged.

## Live browser and local database

A dedicated headed Chrome window was checked at desktop and 390 × 844 mobile dimensions, with no
uncaught page errors. Consultation fields scroll within the mobile sheet and its actions remain
visible. The browser was closed afterward; other sessions' browsers were preserved.

The local preview's frontend and API listeners were verified to use this checkout. The browser
resolved its backend to port 4681. A real WGS84 parcel-coordinate lookup returned HTTP 200 and one
MultiPolygon parcel, and the actual agreement index and new report-history endpoint returned 200.
The local report table was created in a transaction, verified to be owned by `geo_user`, and read
through the running API. Static files serve `Cache-Control: no-store, must-revalidate`.

The wallet extension and external pinning provider are boundaries in the browser tests, and the API
tests inject the pinner. No live wallet extension was asked to sign or pay, and no real report was
published to IPFS during validation. The stored records nevertheless carry real cryptographic test
signatures. The nginx CSP source permits direct HTTPS DID fetches; installing that source and the
new table on production remains part of deployment, which was not requested here.
