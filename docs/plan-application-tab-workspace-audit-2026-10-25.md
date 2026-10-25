# Plan application and tab workspace audit

The application had two independent problems: inconsistent occupied-ground handling between an explicit Apply and confirmed replacement, and multiple documents writing stale snapshots into the same browser store. Tab isolation addresses persistence interference; it does not relax geometric coverage checks.

## Findings and changes

- Direct Apply now releases occupied corridor ground using the same rule as confirmed replacement. Replay does not choose alternatives. A regression verifies successful replacement and restoration of the previous application flags when derivation fails.
- The former BroadcastChannel guard had a simultaneous-start race: two tabs could both conclude that they were writable after the same quiet window. A diagnostic against the real guard reproduced two writable tabs. Unsupported BroadcastChannel also left it inactive.
- IndexedDB was partitioned by city, while each document retained a private, unrefreshed in-memory cache. Separate caches therefore wrote into the same rows. Editor drafts used one origin-wide localStorage envelope, including its active draft ID. Secondary tabs shared one recovery slot, so they could overwrite each other's recovery too.
- Every map tab now owns an opaque durable workspace, with separate city databases. A sessionStorage identity survives reload. An exclusive Web Lock prevents a duplicated session identity from becoming a second writer; that duplicate forks instead. Without Web Locks, document entry forks the prior saved state, including on reload, preserving the work without sharing a writer.
- New tabs snapshot the most recently active saved workspace. Duplicated tabs snapshot their inherited workspace. All saved cities are copied at fork time, so visiting another city later does not inherit subsequent edits from a different tab. No automatic merge occurs.
- Drafts, active draft identity, source selections, estimated parcels, modeling settings, remembered authoring epoch and geographic navigation pointers and local backend overrides use workspace-local storage. General display preferences remain shared. An imagery reset also uses the scoped adapter.
- Copying uses committed IndexedDB snapshots. Each city's records and initialization marker commit together; the workspace manifest completes after the saved cities are copied. Failed reads or copies reject startup rather than substituting an empty composition. Clear retains initialization state so reload cannot resurrect a parent snapshot. Writes arriving before initialization are queued behind it.
- The secondary-tab warning, write suppression, special agreement route and shared recovery-slot flow are removed. Agreements and mutations use their normal persistence paths in every independent tab.

The existing current per-city stores seed the first workspace and remain untouched. The pre-city unscoped migration and automatic old secondary-recovery reader are intentionally retired; this is one current write contract, with no parallel legacy application path. Saved bytes in older stores are not deleted by the change.

## Application and unapply boundaries reviewed

Recorded cadastral scope, local formation closure, producer-owned output removal, keyed runtime collection replacement and transaction publication were reviewed. I found no source-supported additional loss of unrelated outputs in those paths. Failed derivation prevents transaction publication. This is bounded code and regression evidence, not proof that every possible geometry is valid.

One product distinction remains: a fresh shared link imports/applies designs individually and can report failed members while keeping successful ones. Confirmed replacement is an atomic change of the chosen composition. Those are different semantics; this audit does not claim that all link loading is all-or-nothing. No change to that policy was inferred from the tab-isolation decision.

For the earlier reproducible seven-member Borongaj failure and its occupied-road fix, see [the replacement audit](borongaj-plan-replacement-audit-2026-10-25.md). Its description of secondary-tab recovery records behavior before this workspace change.

## Verification record

All runs below were targeted; no full unit or browser suite ran. Browser runs used headed Chrome through the background-window wrapper and disposable contexts.

| Type | Scope | Result |
| --- | --- | --- |
| Headless unit | Initial application/fabric/tab baseline, 7 files | 153 passed; guard/recovery tests later retired with their implementation |
| Headless unit | Direct Apply transaction regression, 1 file | 19 passed |
| Headless unit | Source adapters, 3 files | 45 passed, 1 stale default-source assertion failed |
| Headless unit | Parcel source assertion alone, 1 file | 35 passed, same 1 failure; corrected to the configured building-source default |
| Headless unit | Source adapters, same 3 files | 46 passed |
| Headless unit | Removed recovery branches, 5 files | First run failed on a stray brace; corrected rerun: 97 passed |
| Headless unit | Workspace lease tests, 1 file | 7 passed |
| Headless unit | Workspace lease and snapshot tests, 2 files | 14 passed |
| Headless unit | Drafts, atomic storage, corridor drafts and Apply, 4 files | 57 passed |
| Headless unit | Workspace and atomic storage, 3 files | 17 passed |
| Headless unit | Workspace tests including the multi-city snapshot regression, 2 files | 15 passed |
| Headless unit | Final touched modules and their dependencies, 19 files | 380 passed |
| Headed Playwright | First attempted targeted run | 0 tests started; sandbox denied localhost access/server startup |
| Headed Playwright | Duplicate tabs, plan replacement, same-city edits; 3 spec files, 7 cases | 6 passed, 1 setup failure: attempted to build on an already consumed cadastral parcel |
| Headed Playwright | Same-city/cross-city edits, 2 selected cases | 1 passed, 1 setup failure: used a fixture parcel from another city |
| Headed Playwright | Corrected cross-city setup, 1 selected case | 1 passed |
| Headed Playwright | Final cross-city assertions, 1 selected case | 1 passed |
| Headless unit | Estimated-ground caller regression, 3 files | Initial fixture lacked its required estimated marker; corrected rerun: 25 passed |
| Headless unit | Backend override, workspace ownership and estimated ground, 5 files | 43 passed |
| Headed Playwright | Final mobile/desktop duplicate-tab recheck after source scoping, 1 spec file, 2 cases | 2 passed |

The eight distinct relevant headed cases all passed after fixing those two test setups. They cover mobile/desktop duplicate identity collisions, independent drafts and active draft selection, reload identity and persistence, same-city editing, cross-city storage, and replacing an old plan without altering the original tab's composition.

The source control-inventory check still reports three unrelated missing registrations in the current shared checkout: a bets control, a sharing control, and a privacy-page control. The retired tab-warning control was removed from its contract. Unrelated concurrent changes were not included in this work.

Review workers used `gpt-6-luna` at low reasoning for bounded audits, mechanical cleanup and focused unit tests; the primary agent owned architecture, browser verification and Git. No push or deployment was performed.
