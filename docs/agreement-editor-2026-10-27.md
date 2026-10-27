<!-- Implementation contract and verification evidence for the plan-first agreement editor. -->
# Plan-first agreement editor

Agreement creation selects an independently saved immutable plan. Its designs are read-only in the Input parcels tab. Rules contains the decision scheme, compensation controls and buttons for the separate ownership-rights and lens dialogs. Output parcels assigns each piece to one input party or Public. Persons shows land and cash contributed/received, including the balancing sponsor, with no person-level cash edits.

Each unidentified input parcel has a stable abstract party, `parcel-owner:<parcelId>`. These parties support drafting and accounting; their generated rights snapshot remains incomplete. Plugged-in rights replace the input holders, and invalid recipient choices must be reviewed again.

Area compensation is `(contributed area × (1 − contribution ratio) − allocated area) × rate`, rounded to integer cents per party. The selected scheme caps the allowed contribution ratio. The sponsor supplies or receives the cash difference. No-cash rules generate no cash lines. Saving and HTTP publication reject unbalanced land, unknown input areas, incomplete input shares, missing or multiple output recipients, unknown input-party recipients and cash inconsistent with the rules.

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


## Input inspection and scheme copy follow-up

Input parcels and plan designs now share the same semantic button/list component and typography. Hover and keyboard focus draw temporary shared map outlines. Clicking (including Enter) keeps an inspection outline without opening another panel or changing the agreement; switching tabs, refreshing the plan or closing clears it. Parcel outlines use the immutable cadastral input even where the applied layout has replaced it. Parcel ownership rights is below the Input parcels plan selector; lens controls stay in Rules.

Research-template labels and legal/research disclaimers were removed from rendered agreement scheme controls and the approval card. A translated warning-colored Experimental pill sits beside the Rules control; scheme facts and sources remain visible.

MCP parity: these changes affect inspection and presentation only. Existing `ugt_inspect_agreement` still supplies input land, designs, output pieces, parties and rules; rights and lens edits use the existing agreement terms operations. No authored record, validation, schema or MCP mutation changed.

Verification: targeted headless unit runs passed (agreement store/accounting: 40 tests; approval setup/regimes/review and locale coverage: 60 tests). Two targeted headless Playwright cases passed for input inspection and rights/lens dialogs; one further case passed for the Experimental pill and absent English/Croatian disclaimers. The inspection-row case was rerun after aligning both row titles and passed again. None were stopped. Headed verification used real source parcel lookup and the same local frontend/API checkout.


## Proposer acquisition and bulk allocation follow-up

Output parcels offers Set individually, Proposer and Public land. The bulk choices write an explicit allocation for every output and disable/grey its individual selector. Switching to individual mode retains the assignments. Saved all-Proposer/all-Public allocations reopen in that bulk mode. Individual selectors also offer Proposer, supporting mixed private, owner and public allocations.

The shared contract adds `{kind: 'proposer'}`. It needs no input ownership or connected wallet. The ledger reports `proposerM2` separately from input parties and public land. Input owners retain scheme-derived compensation; the sponsor balances cash. Persons shows proposer land and balancing cash together; saved allocation/ledger views identify Proposer too. No existing record requires a migration.

MCP parity: `ugt_draft_agreement` and `ugt_edit_agreement` accept proposer allocations through their shared typed union; `ugt_inspect_agreement` reports proposer area and the derived cash schedule. Bulk assignment uses the existing explicit list of output hashes. Shared record normalization/settlement and HTTP validation accept the same recipient kind. Tool discovery copy and the public recipe JSON Schema describe it. Runtime and schema tests cover drafting, editing and inspecting proposer acquisition, with immutable prior agreement identity preserved.

Verification (targeted runs only, none stopped):

| Run | Result |
| --- | --- |
| Headless unit: accounting, store, panel, MCP, locale (5 files) | 111 passed, 1 failed: new MCP fixture lacked explicit output recipients |
| Headless unit: MCP, record, HTTP routes (3 files) | 96 passed, 21 failed; 20 route failures and 40 listen errors from sandbox socket binding; the MCP fixture correction had not applied |
| Headless unit: MCP and HTTP routes with local binding enabled (2 files) | 68 passed, 2 failed: incorrect inspection operation in the new test and one transient route HTTP 401 |
| Headless unit: MCP and panel after test corrections (2 files) | 48 passed, including the new saved-panel case |
| Headless HTTP unit: the single route case that returned 401 | 1 passed, 62 skipped |
| Headless Playwright: bulk proposer case | 1 passed |
| Headed Playwright: bulk proposer case in background Chrome | 1 passed; rendered screenshot confirms bulk selector and grey per-parcel selectors |

Across the seven unit files, all 223 distinct cases have a passing result. The new accounting case verifies HTTP validation of a published proposer allocation. Browser checks cover public/proposer bulk switching, disabled selectors, selective allocation, derived compensation, saving and reopening.


## Focused agreement authoring and shared lens follow-up

Agreement authoring now uses a native modal host around the existing dock. The map and all unrelated controls are inert, keyboard focus stays in the flow, and map highlighting still works from the input/design rows. Background clicks do not dismiss it. Ownership and shared lens dialogs are hosted in the same top layer. Create/Cancel restores the panel's original parent and normal page interaction; Escape remains owned by the modal router, and typing does not accidentally cancel the agreement.

The editor uses one spacing/type scale, a single tab treatment, shared parcel/design/allocation row padding, restrained section dividers and consistent field backgrounds. The redundant Agreement rules heading is removed. Footer buttons split the row equally: Cancel/Create agreement for a new record, Cancel/Save agreement for an existing one.

Lens is a small section with the same striped glasses button as agent details, centered in its own row. Profile buttons match the avatar's outer width, including on phones. Agreement authoring opens the same shared lens dialog and preserves its chain-specific EVM/Solana editor. Edits update the persisted default; future agreements copy it. An existing agreement's snapshot can be edited independently, and opening it does not silently replace the default. Saved agreement snapshots remain unchanged when the profile/default changes.

MCP parity: the authored field remains `rule.lens`, with no new serialized lens preference or record format. Existing `ugt_draft_agreement`/`ugt_edit_agreement` full rule editing accepts the same explicit member keys and preserves revisions; `ugt_inspect_agreement` and returned canonical agreement content expose that snapshot. Browser persistence is the existing local lens preference; MCP callers supply the desired explicit lens. The existing MCP rule/lens runtime tests passed in the targeted unit run. Modality, visual styling and button labels add no authored fields or MCP operations.

Verification: seven targeted headless unit files passed (91 tests). Six targeted headless Playwright agreement cases passed, covering blocked map/page input, focus containment, Create/Cancel restoration, footer equality, shared lens defaults and saved snapshots, ownership dialogs, phone layout, map-list inspection and removed rule heading. Two additional targeted headless Playwright profile/lens cases passed, verifying avatar-width alignment at desktop/phone sizes and default/scoped edits on both EVM and Solana paths. No tests were stopped.


Two targeted headed Playwright layout cases passed, followed by three targeted headed cases after saving screenshot artifacts and adding Escape assertions. The latter checks that Escape first closes the lens dialog and then the agreement, with full interaction restored. Desktop screenshots of all four tabs and a phone Rules screenshot were visually inspected. The real preview additionally confirmed equal 179px footer buttons, the 70px centered lens button and native modal blocking. Its explicit local API returned one real cadastral parcel and a complete one-parcel design binding (both HTTP 200); frontend and API listening process working directories matched this checkout.
