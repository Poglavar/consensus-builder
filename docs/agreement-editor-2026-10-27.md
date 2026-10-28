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


## Plan click-stack layout and return context

Plan section actions now share a two-column row with equal-sized Share plan and Create agreement buttons. Agreements and included designs use full-width rows with matching group insets and spacing, in both stack renderers. Creating an agreement from this section retains the caller behind the native modal. Header close, Cancel and Escape return to the same expanded plan, map point and selection, with map focus restored. Creating successfully returns to that section and refreshes its agreement list instead of opening a different dock. Other entry points retain their existing post-save behavior. Phone dismissal uses the shared sheet handle, Cancel and Escape; its header X is intentionally hidden by the shared mobile sheet style.

MCP parity: these changes affect navigation, focus and presentation only. The authored plan and agreement formats and editing fields are unchanged. Existing plan inspection and agreement draft/edit operations still edit the same content; no new MCP mutation or schema is needed.

Targeted verification: five headless unit files passed (110 tests: memberships, stack sharing/panel, optional tool loading and agreement store). The initial three-case headless Playwright run had one pass and two failures: the creation assertion needed an explicit recipient selection, and the phone test tried to click the intentionally hidden header X. The creation check now selects Proposer and the phone check uses its visible sheet dismissal controls. No runs were stopped.

A two-case targeted headed Playwright run passed desktop return/create/list refresh; the phone case repeated the hidden-X locator issue before the phone test was corrected.

Final verification: the corrected phone case passed in a targeted headed Playwright run; its screenshot and the desktop screenshot were visually inspected. All three targeted headless Playwright cases then passed, covering both viewport widths and the independent-agreement list. The verified preview still resolved the local API; real parcel lookup and complete design binding both returned HTTP 200. No tests were stopped.


## Agreement stack section and Plan navigation

User decision: Agreements belongs above Plans in the click stack, scoped to the selected exact Plan revision. Multiple agreements use the shared instance selector. The section shows decision terms and owner allocations, with Agreement details opening the full record. Community agreements do not display allocation terms. The same controller serves map and model-view stacks, refreshes local saves, paginates the public index and rejects stale responses after a plan switch.

Agreement details now renders its Plan entry as a button for both saved and published records. It reads the exact plan/design snapshots, then selects/expands Plan in the current view. It does not navigate to a `/plans/` route, import/apply designs, replace the workspace or move the camera. Read-only agreement inspection can use the button too. Plan snapshots opened this way remain in the stack while reverse membership queries complete.

MCP parity: no authored field, schema or editing operation changed. Agreements still name one exact `planCid`. Existing `ugt_get_plan` and `ugt_inspect_agreement` inspect those revisions, and `ugt_parcel_context` supplies contextual agreements. The new stack section is read-only navigation over the same records. Exact-plan index filtering and cancellation are verified through the shared membership unit tests; no new MCP mutation is required.

Targeted verification runs (none stopped):

| Type and scope | Result |
| --- | --- |
| Headless unit: memberships, map model/panel, 3D stack, agreement panel, sharing (6 files) | Initially 120 passed, 8 failed: obsolete link/list assertions and incomplete module/translation fixtures |
| Same six headless unit files after fixture/API updates | 130 passed |
| Headless Playwright: Plan navigation and phone agreement section (2 cases) | 2 passed |
| Headless unit: memberships, locales, optional loader (3 matching files) | 60 passed, 1 failed on in-progress voting translations from another session |
| Headless Playwright: plan switching, return/create and 3D scope (5 cases) | 3 passed; 2 3D cases exposed missing scope initialization on direct plan opening |
| Headless Playwright: 3D scope at desktop/phone widths after initialization fix | 2 passed |
| Headless unit: memberships (including stale response), 3D stack and map model (3 files) | 51 passed |
| Headed Playwright: Plan navigation and phone layout | 2 passed; screenshots reviewed |
| Headless unit: locale coverage after concurrent translations completed | 22 passed |

Concurrent voting edits share agreement-panel.js, index.html, locale dictionaries and vocabulary.md. Their edits are preserved; mixed files are left uncommitted according to the workspace rule. The navigation hunks in agreement-panel.js replace the Plan link, allow the action in read-only inspection and call ClickStack.showPlan; locale hunks add clickStackRelations.chooseAgreement; vocabulary updates the plan/stack relationship.

A final targeted headless Playwright Plan-navigation case passed after omitting allocation terms for community agreements. The final case checks the shared selector/terms layout; the earlier headed screenshots were visually reviewed. The broader locale-coverage check is green after the concurrent voting translations were completed.

Preview verification: the frontend/API listening processes belong to this checkout; the browser resolved the explicit local backend. Real cadastral lookup returned one feature and a complete design-binding response (both HTTP 200). The 3D checks exercise the real stack DOM/CSS without booting the scene renderer. The changed Plan-button assertion in agreement-panel.test.js stays with its uncommitted mixed implementation file.

## Adjacent levels and integrated agreement properties

The stack now displays the selected level and its nearest available neighbour on either side in both views. The complete hit inventory remains intact, and clicking a neighbour moves the visible window. The raw-coordinate footer is removed. The expanded Agreements section hosts the existing full properties renderer and actions, replacing the compact summary and separate details surface. Published read-only records use the same surface without importing designs or agreements. Local edits return to the same section; changing the referenced plan reopens the agreement in its new context. Membership refreshes preserve the hosted body, its controls and current selection while updating pagination and selectors.

Phone properties scroll within the shared sheet. Long 3D source cards shrink within their available height so adjacent headings remain reachable. The duplicate agreement panel header is hidden when hosted; a single agreement retains its name in the stack heading.

MCP parity: no authored field or operation changed. The same AgreementDialog, AgreementStore and AgreementPanel controllers edit and display the existing record contract. Existing `ugt_draft_agreement`, `ugt_edit_agreement` and `ugt_inspect_agreement` cover the authored content; the targeted headless `mcp-plan` and `mcp-ground` checks passed (17 tests). No new tool or schema is needed for this navigation change.

Targeted verification runs:

| Type and scope | Result |
| --- | --- |
| Headless unit: model, map panel, 3D stack, relations, agreement panel and sync (6 files) | 154 passed |
| Headless Playwright: adjacent levels and full properties (1 case) | Passed |
| Headless Playwright: navigation, switching, mobile, read-only and 3D scope (7 cases) | Stopped after 3 failures: a noncanonical read-only fixture and 2 initial park-setup timeouts; 4 cases did not run |
| Headless Playwright: isolated Plan navigation with trace (1 case) | Passed |
| Headless Playwright: switching, mobile, read-only, 3D scope and editing (6 cases) | 5 passed; editing failed during initial page navigation before feature setup |
| Headless Playwright: isolated editing with a longer navigation allowance (1 case) | Passed |
| Headless unit: the six controller files plus memberships (7 files) | 177 passed, 2 stale action-button assertions failed after a concurrent action layout change |
| Headless unit: agreement panel after updating those assertions (1 file) | 41 passed |
| Headless Playwright: 3D stack sizing (10 cases) | 7 passed, 3 failed: 2 hardcoded padding expectations and 1 phone card-shrinking defect |
| Headed Playwright: phone agreement layout plus desktop/phone short and long cards (5 cases) | 5 passed after padding assertions and shrinking correction |
| Headed Playwright: phone agreement scroll reachability (1 case) | Passed; top and scrolled-bottom screenshots visually reviewed |

The read-only fixture now uses canonical PlanRecord creation. The 3D checks exercise stack DOM/CSS without starting the scene renderer. Browser source verification used the explicitly selected local API: one real cadastral parcel and complete design binding returned HTTP 200, and both listening processes belonged to this checkout. Dedicated verification Chrome was closed. Mixed files containing concurrent semantic, voting and layout changes remain uncommitted; their edits are preserved.

## Plan creation opens the stack

Creating a plan or saving a revision now opens that exact saved snapshot in the current view's
expanded Plan section through ClickStack.showPlan, replacing the small post-save action dialog.
The section retains Share plan and Create agreement. Existing explicit PlanDialog.details callers
are unchanged. Creation still saves locally without publishing or applying designs.

MCP parity: only the post-save navigation changed; the same PlanComposition and PlanWorkspace
contracts create and validate the snapshot. Existing draft/edit/inspect/publish plan operations
remain sufficient, with no new field or schema. Two targeted headless unit files passed
(share-plan-panel-contract and mcp-plan, 11 tests). Three targeted headed Playwright named-plan
cases passed: desktop and phone creation opened the exact expanded Plan section without a details
dialog or premature publication, sharing retained the saved revision after a member's local edit,
and failed publication remained retryable. No full suites were run and no runs were stopped.

Related agreement, list and 3D-camera browser assertions now use the stack after creation; those
specs were updated but not executed in this pass. Mixed index.html, Lists spec, development guide
and memory changes remain uncommitted alongside concurrent work.

## Formed parcels when inspecting a plan member

The Plan stack was seeded with its members but no ground hits. Expanding its Design row or changing
the design selector only hosted the design panel, so no Formed parcel section appeared. Directly
opening the same design from Lists resolved ground at its geometry and exposed the inconsistency.

Design inspection now reads all current live outputs through LiveParcelFabric.producedBy and reads
the selected record's cadastral inputs from the immutable source repository. Expanding or switching
a plan member rebuilds that ground context while retaining peer designs and plan selection. Direct
design inspection uses the same lookup. It does not apply designs, create parcels, change authored
records or move the camera. Unapplied/missing designs do not acquire invented formed outputs.

MCP parity: only read-only navigation changed. Produced parcel geometry and cadastral provenance
retain their existing sources of truth and MCP inspection contracts; no editing field, operation,
tool or schema changed. Two targeted headless unit files passed (53 tests), covering all outputs,
missing/unapplied records and design-selector ground replacement. One targeted headed Playwright
case passed: Plan → Design exposes formed ground without another map click, retains stored records
and camera, and can expand the output to reveal its cadastral source. Its screenshot was reviewed.
No full suites were run and no runs were stopped. The original browser tab was inspected using
its saved records; a later browser connection timeout prevented final verification on that exact
tab. The automated check uses the real application with mocked source responses. Temporary
diagnostic logging was removed. Mixed stack-panel and entry-point changes remain uncommitted.

## Value-basis settlement and scheme distribution rules (2026-10-28)

Rules offers three compensations. By area (as before): a rate per m² and a land contribution the
scheme caps. By value: a whole-cent value per m² for every input parcel (before the designs) and
every resulting piece (after them), entered in Input parcels and Output parcels, one field per row
plus a field that sets them all, prefilled with the city's land price. Each party is entitled to
the share of the value of the land distributed to parties and the proposer that matches the value
it put in; it receives the entitlement minus the value it got and pays the scheme's share of its
value gain (all of it under a German Umlegung, half under the Gujarat scheme, none otherwise). No
cash: no money lines. Persons shows land and value side by side with each entitlement.

The record stores `valuation: { inputs: [{ parcelId, unitValueCents }], outputs: [{ output,
unitValueCents }] }` only when the settlement is by value; it is part of the published object and
its CID. `rule.settlement.method` is `area`, `value` or `none`; by value the rate and contribution
are 0. Schemes carry their distribution rules as data (`approval-regimes.js`): a cap per owner or per
pool with its basis, the share of a value gain settled in money (`valueGain`), the fewest parties
(`minParties`), and the family. A scheme whose rules changed got a second version dated 2026-10-28
beside its 2026-10-11 version; agreements that pinned the older version keep reading as before.

One shared judgement, `AgreementRecord.settlementIssues`, lists the settlement terms, the land
values, the named scheme's rules (per-owner and pool caps, area or value basis, party count, no
proposer acquisition under an authority-led scheme) and the derived cash against the stored lines.
The dialog, the HTTP index (`validateAgreementContent`) and MCP (`agreementObject`) refuse the same
agreements with the same message. The dropdown marks every scheme the current plan does not meet
("— not met by this plan"), the scheme card lists the check line by line, and a broken rule is a
save-blocking error; the selection itself is never refused, because the outputs are allocated
after the rule is chosen and an agent has no dropdown to refuse.

MCP parity: `ugt_draft_agreement` and `ugt_edit_agreement` take `settlement.method: 'value'` and
`valuation`; `ugt_inspect_agreement` reports `valuation`, the value ledger and the scheme check
(`scheme`); the help topic `schemes` lists every scheme with its rules and sources so an agent can
pin one; the recipe JSON Schema and `docs-agents.md` describe `valuation`. The runtime test drafts,
edits and inspects a value agreement, has an over-cap German edit and an area deal under a value
scheme refused, and reads the catalogue.

### Scheme guide

The scheme card's "How this scheme works…" opens a dialog generated from the template's data
(`ProposalApprovalSetup.schemeGuideHtml`, `openSchemeGuide`): who decides and what the support
is for; how land is distributed, with a before/after schematic drawn from the scheme's cap and
basis (the plan's own parties when one is open, else three example owners); this agreement against
the scheme, with the parties' land and what would meet a broken rule, in the editor's own controls;
how to set the scheme up here (Compensation, Land contribution, Output parcels, Parcel ownership
rights, Authority, Persons); and the sources. Colours and type come from `proposal-editor.css`.

### Verification (2026-10-28)

Targeted headless unit runs, typed file paths from `backend/`, none stopped:

| Run | Result |
| --- | --- |
| 9 agreement/scheme/route/MCP files | 214 tests, 8 failed: fixtures that gave all land away under Umlegung (now refused), a keptTerms shape, and 4 route failures from running 9 files at once |
| `agreements-route` alone | 63 passed |
| accounting, store, regimes, setup | 82 tests, 2 failed on the dialog's English wording in node (require fallback added) |
| accounting, mcp-plan, mcp-discovery, agreement-objects | 43 tests, 2 failed: catalogue wrapper, a one-cent rounding of a single owner's entitlement (now rounded once from exact sums) |
| 8 files after the fixes | 152 tests, 1 failed on a help call the plan tools do not expose (assertion moved to the discovery file) |
| mcp-plan, mcp-discovery, sync, boundary, repository, lens registry, setup | all passed (8, 5, 48 and 15 tests) |
| i18n style | Title Case 31 against a ceiling of 30 and duplicate groups 236 against 227, both failing at HEAD before this change; this change adds none |

Targeted headless Playwright (`agreement-editor-map.spec.ts`): three existing cases passed with the
new one, which checks the German scheme against the plan (met, then broken by a public allocation:
card, dropdown mark, disabled save and error line), opens the guide and reads its check, fix and
schematic, then settles by value (bulk and per-row values, Persons with values and entitlements,
saved valuation and derived cash, reopening). Its screenshots of the Rules card, the guide, the
input values and Persons were reviewed. The control contract gained the two value fields and the
guide button. The preview `http://localhost:5680/?backend=http://localhost:4680&city=zagreb&at=45.8,15.96,17`
resolved the local API, city zagreb, EUR, and returned one real cadastral parcel.
