<!-- Implementation contract and verification evidence for the plan-first agreement editor. -->
# Plan-first agreement editor

Agreement creation selects an independently saved immutable plan. Its designs are read-only in the Input parcels tab. Rules contains the decision scheme, compensation controls and buttons for the separate ownership-rights and lens dialogs. Output parcels assigns each piece to one input party or Public. Persons shows land and cash contributed/received, including the balancing sponsor, with no person-level cash edits.

Each unidentified input parcel has a stable abstract party, `parcel-owner:<parcelId>`. These parties support drafting and accounting; their generated rights snapshot remains incomplete. Plugged-in rights replace the input holders, and invalid recipient choices must be reviewed again.

Area compensation is `(contributed area × (1 − contribution ratio) − allocated area) × rate`, rounded to integer cents per party. The selected scheme caps the allowed contribution ratio. The sponsor supplies or receives the cash difference. No-cash rules generate no cash lines. Saving and HTTP publication reject unbalanced land, unknown input areas, incomplete input shares, missing or multiple output recipients, non-input recipients and cash inconsistent with the rules.

This intentionally retires joint output allocations, implicit carried-holder outputs and manually entered cash terms. Recreate affected experimental agreements. Input co-ownership remains supported.

## MCP parity

`ugt_draft_agreement` requires an existing named plan. `ugt_edit_agreement` accepts terms, allocations, ownership rights, full decision rules (including authority policies, scheme identity and lens members) and settlement controls. It can select another existing plan, but cannot edit designs or invent a plan. Shared `AgreementRecord` normalization, settlement and validation drive browser, MCP and HTTP accounting. Runtime checks cover German authority rules, lens/rights revisions, derived payments, retained plan identity and rejection of composition edits.

## Verification

Final targeted headless unit checks: 401 tests across 16 explicitly selected files passed, in separate runs. This is not a full suite. Final headless Playwright checks: four tab/editor cases and one private-plan application case passed. A dedicated headed browser also created a real Zagreb layout, saved a plan, opened its agreement, changed its German scheme and public allocation, and saved/read back a valid balanced agreement. The resolved API was the local checkout; exact input parcel lookup returned one feature, and invalid POSTs to the plan/agreement routes returned validation errors without publication.

Iteration record (all runs completed unless noted):

| Targeted headless check | Result during iteration |
| --- | --- |
| Initial record/store/ground/named-plan unit files | 81 passed, 49 failed; obsolete contracts and sandbox HTTP binding errors |
| New accounting unit file | 6 passed, 1 formatting assertion failed; corrected, then passed |
| Record unit file | 47 passed after explicit-allocation fixture updates |
| Ground unit file (worker) | Tool timeout; result unverified, covered by subsequent completed runs |
| Five shared unit files | 129 passed, 1 invalid ground fixture failed; corrected |
| Four shared unit files | 83 passed |
| Publication/rendering/locale/docs unit files | 141 passed, 45 failed; old fixtures and translation/discovery assertions corrected |
| Seven shared/locale unit files | 166 passed |
| Sync/panel unit files | 69 passed |
| MCP focused unit runs | Passed at each completed revision; final four files contain 40 passing tests |
| Route/docs unit runs | Alternate-input fixtures corrected; 3 route failures were traced to running from the repository root where proj4 could not resolve; correct backend working directory: 81 passed |
| Final accounting/record/MCP unit files | 94 passed |
| Product-guide unit file | 44 passed, 1 retired valuation-copy assertion failed; corrected: 45 passed |
| Initial four Playwright cases | 1 passed, 3 failed; tab overflow and a dialog-close locator corrected |
| Four Playwright cases after layout correction | 4 passed |
| Four Playwright cases after concurrent Plans-dialog integration | 4 passed |
| Private saved-plan application Playwright case | 1 passed |

Concurrent plan-editor work changed shared entry points and locale dictionaries during this task. Its changes were preserved. Agreement tests were switched to the new Plans dialog; mixed files are left uncommitted rather than attributing another session's edits to this change.
