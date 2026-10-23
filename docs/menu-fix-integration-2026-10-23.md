# Menu fix integration — 23 October 2026

Review of `fix/menu-user-flows-20261022` at `727d5fbc8` against
`colosseum-worlds-fair`, initially `11b191578`, then `a7d99fecd` after concurrent commits.

## Integration choice

Reimplemented the reviewed patch on the current target rather than merging the old audit
report and its environment-specific fixture assumptions. The existing design/agreement,
source-ground, ownership-evidence and lifecycle contracts remain the basis of the fixes.

The confirmed fixes cover NYC coverage units and modal sizing; profile translations;
source/city capability gates and OSM block commands; Activity filters, counts and stale run
responses; explicit consent for a foreign-city download; permitted-massing click precedence
and editor placement; proposal lifecycle filters; assumption input normalization; terminal
agreement badges and action gates; accurate hackathon evidence/navigation copy; reachable
proposal cards; preservation of authored form text and truthful area/owner summaries;
explicit World view failure feedback; and read-only consumed-source guidance.

The target advanced during review. Its selection commit referenced `syncMultiSelectControls`
and `#parcel-manual-selection` while the helper and HTML still used checkboxes. Browser
failures reproduced this separately. Completed that committed control contract and updated
two stale unit assertions to verify the current click-stack routing. A new regression checks
that the Manual button reflects selection state. No compatibility helper was added.

Discarded the source branch's Ljubljana recovery-dialog fixture change: the dialog no longer
appears in the current fixture. The source audit's separate-app blocker, provider availability
and unverified Schelling-plot performance finding receive no speculative application changes.

## Verification log

Every automated run was targeted and headless. No full unit or browser suite was run.
Browser checks used installed Chrome, one worker, no retries, a no-cache local frontend,
shared API/chain fixtures and an isolated temporary Playwright configuration.

| Run | Scope | Result |
| --- | --- | --- |
| Baseline Node unit | `node --test backend/test/menu-audit-regressions.node.test.js`, 13 cases | 12 failed, 1 passed; reported logic defects reproduced |
| Initial baseline Playwright | 18 selected cases in 7 files | Stopped after 4 failures, 14 unrun: Python preview reset parallel asset connections; not evidence of application defects |
| Corrected baseline Playwright | Same 18 selected cases | 18 failed; 17 reached the reported failures, one reached an obsolete click-stack dismissal assertion, subsequently adapted to Escape |
| Fixed Node unit | Same 13 cases | 13 passed |
| Existing Vitest unit | 10 explicit files listed below | 230 passed |
| Initial fixed Playwright | 24 selected cases in 7 files | 17 passed, 7 failed on the target's missing selection helper |
| Selection Vitest unit | `test/frontend-parcel-menu.test.js`, 34 cases | 32 passed, 2 stale direct-selection assertions failed |
| Updated selection Vitest unit | Same file | 34 passed after asserting the committed click-stack route |
| Final Node unit | Imported regressions plus selection-control regression | 14 passed |
| Blocked-flow Playwright rerun | 7 failed cases plus changed geolocation fixture | 6 passed, 2 failed: missing target Manual button and obsolete recovery-dialog fixture |
| Final Playwright rerun | Multi-parcel selection and geolocation | 2 passed after completing markup and discarding the obsolete fixture change |

Final targeted coverage: **278 passing headless unit tests across 12 files and 25 passing
headless Playwright cases across 8 files**, with the passing browser cases accumulated across
the final affected-scope runs. JavaScript syntax, translation JSON and diff whitespace were
also checked.

Vitest files: `agreement-panel`, `actor-explorer`, `map-edit-lock`, `frontend-ui-commands`,
`plan-stats-wiring`, `plan-stats-render`, `proposal-area`, `frontend-world-entry`,
`click-stack-panel`, `ownership-flow`, and `frontend-parcel-menu` under `backend/test/`,
all with the `.test.js` suffix. The native Node regression file is listed above.

Playwright files under `e2e/tests/`: `menu-audit-regressions`, `agreement-state-audit`,
`planning-view-controls`, `plan-stats`, `proposal-form-controls`, `context-actions`,
`supporting-pages`, and the unchanged geolocation case in `settings-maintenance`, all with
the `.spec.ts` suffix. Only affected tests and adjacent actor, source-evidence, filter and
selection flows were selected.

Headed visual inspection used a dedicated background Chrome, then closed it. Spanish profile
history and the accessible close label changed in place. At 390 × 844, both proposal control
groups remained expanded while the card list retained 149 px and Details scrolled into view.
Manual examples were browser-local; no wallet, publication, production mutation or deployment
was performed. Provider warnings in the unmocked local preview were dismissed for inspection.


## Revisit against the completed concurrent work

Rechecked the current target after its design, selection, MCP and menu work. The target advanced
through `6386f0a6e`, `7433152ef` and `69c17ce4d` during this review. The generated inventory was
checkpointed separately as `700dc72ae`. Only reproduced defects are retained in the integration.

The old selection fix is already implemented in the target. Conflict resolution preserves its
Manual/Done contract, existing selected land, plain Detect block action and current click-stack
tests. The final patch has no change to `frontend/index.html`,
`frontend/js/proposals/list-ui.js` or `backend/test/frontend-parcel-menu.test.js` relative to the
latest target. The current Schelling icon, collapsed Layers sections, profile-first welcome
layout, save/apply preview handoff and explicit Duplicate behavior are retained.

A fresh baseline read the current target's actual source rather than assuming the older failures
still applied. Twelve of fourteen headless Node regressions and sixteen of twenty-two targeted
headless Playwright cases failed before integration. Passing selection, lifecycle-filter,
permitted-inspection and adjacent navigation cases remain regression coverage, without restoring
obsolete selection code. The source-gate DOM unit case passes already; the actual NYC browser
case still fails because the city source gate does not mark the hidden row for the palette.

| Revisit run | Type and scope | Result |
| --- | --- | --- |
| Current target baseline | Headless Node unit, 14 cases in one imported regression file | 12 failed, 2 passed; original source was read through a temporary test wrapper |
| Resolved integration | Headless Node unit, same 14 cases | 14 passed |
| Resolved integration | Headless Vitest unit, the 11 explicit files listed above | 265 passed |
| Current target baseline | Headless Playwright, 22 selected cases in 9 files | 16 failed, 6 passed |
| Resolved integration | Headless Playwright, same 22 selected cases | 21 passed, 1 failed: the permitted-massing fixture tried to check a control in the newly collapsed Layers section |
| Premature fixture rerun | Headless Playwright, 2 permitted-massing cases | 1 passed, 1 failed; its preceding edit used the wrong working directory, so the fixture had not changed. A stop attempt found the run had already finished |
| Corrected fixture and recent authoring flows | Headless Playwright, 6 cases in 2 files | 6 passed; uses the current Layers helper and covers the four GLB/Duplicate cases |
| Latest completed source-warning work | Headless Vitest unit, `parcel-source-settings.test.js` | 35 passed |
| Latest welcome/source-warning work | Headless Playwright, 4 cases in `profile.spec.ts` and `data-sources.spec.ts` | 4 passed |

Final affected-scope passing coverage is **314 headless unit tests in 13 files and 30 headless
Playwright cases in 12 files**, accumulated across the final scoped runs. No full suite ran.
No automated run was stopped. The browser baseline used the current target preview while the
independent source-warning commit completed; final verification includes that completed commit.

The 22-case browser selection covers the earlier eight files plus
`multi-parcel-selection.spec.ts`; the final checks add `freeform-upload-duplicate.spec.ts`,
`profile.spec.ts` and `data-sources.spec.ts`. The only browser fixture adjustment needed for the
new menu contract opens the collapsed Blocks section with the existing `openLayerSection` helper.
The localized profile-close markup remaps one generated inventory entry; all 857 source sites
match after regeneration. JavaScript syntax, all four translation dictionaries and diff whitespace
are checked. An initial inventory write outside the writable root was blocked by the filesystem
sandbox; rerunning it with the authorized worktree access completed normally.

A dedicated headed background Chrome was used for a fresh mobile visual check, then closed.
Collapsed Layers order and the current icon are intact. At 390 × 844, expanded Filters and
Proposal tools leave 149 px of card-list space. Browser examples were local and disposable;
there was no wallet action, production write, push or deployment. The target's unrelated dirty
`MEMORY.md` and `mcp.md` edits are outside this merge and remain untouched.
