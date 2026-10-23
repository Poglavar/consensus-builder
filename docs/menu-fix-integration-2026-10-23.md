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
