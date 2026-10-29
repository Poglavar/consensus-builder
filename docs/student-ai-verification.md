# Shared student/agent plan verification

The implementation uses ordinary plan and design revisions, private hosted-session storage,
and one editing turn at a time. Browser saves and MCP edits share canonical validation and
compare the accepted session version at commit. No private save uploads to IPFS.

## Live browser and MCP checks

A dedicated headed Chrome, opened behind the active application, used the student-ai frontend,
a local hosted MCP process and the production API for source-data reads and cadastral binding.
No publication, wallet operation or external message was performed.

Verified on 2026-10-29:

- A garden and bench drafted through real MCP operations materialized through normal plan import.
- Collaborate created a private session. Copy invitation and Let agent edit worked through the UI.
- The agent moved the bench two metres north through `ugt_edit_shared_plan`. With the dialog
  closed, the browser showed the accepted revision, retained exactly one applied garden, kept
  the camera unchanged and refused local editing while the agent held control.
- Take control restored the ordinary geometry editor. Objects → Bench → East 1 m → Done, followed
  by Save to shared plan, produced exactly the coordinate returned by the agent's next inspection.
- At 390 px, the controls remained reachable. Reload restored the agent editing gate. Take control
  worked after reload. Disconnect invalidated the old invitation and retained editable local work.
- The real student's assistive technology and AI application's browser takeover were not tested.

## Headless test runs

Only exact file paths or a bounded explicit Playwright name filter were intended. The accidental
full unit invocation below was stopped and has no complete result.

| Run | Scope | Result |
| --- | --- | --- |
| Merge regression | Four unit files: structure objects, structure geometry, structure edit history, MCP editing | 94 passed |
| Playground accessibility | Structure object unit file | 5 passed |
| Scheduled plan recovery | Plan workspace unit file | Regression first failed, then 6 passed |
| Initial browser checks | Three Playwright files, 15 intended scenarios | Stopped after 9 passed, 2 reload timeouts and 4 not run |
| Browser remainder | Six explicit Playwright scenarios: mobile workspace, park/square/lake boundaries, station movement, narrow editor sheet | 6 passed; all 15 intended scenarios have passed across the two runs |
| Session persistence | Shared-session store unit file | 3 passed initially, then 4 passed with capacity/writer checks |
| Hosted transport | MCP HTTP unit file | 11 passed initially, then 12 passed with the real park/session path |
| MCP boundary | MCP server unit file | 10 passed |
| Backend integration | Five unit files: shared sessions, shared tools, HTTP, server, discovery | 33 passed |
| Early browser client | Primitive browser client unit file | 2 passed; superseded by fuller coverage |
| Accidental full unit invocation | A worker used the package test wrapper, which ignored its intended three-file filter | Stopped; no complete verdict |
| Browser integration review | Browser session, shared import, click-stack unit files | 83 passed, 4 failed and one unhandled rejection; defects subsequently fixed |
| Transaction regression | Proposal transaction boundary unit file | 19 passed, then 21 passed after adding moved-member release and late-edit rollback cases |
| Focused feature and locale review | Seven exact unit files | 148 passed, 9 failed and one unhandled rejection; three feature failures fixed, six locale checks identified as pre-existing |
| Browser synchronization recheck | Browser session and shared import unit files | 49 passed |
| Startup ordering | Browser session unit file | 8 passed |
| Final core recheck | Instant-create feedback, browser session and MCP HTTP unit files | 44 passed |
| Local plan revisions | Browser session and plan workspace unit files | 15 passed |
| Composed member identity | Browser session unit file | 10 passed, including exact-content identity recovery and ambiguous-instance refusal |

The locale audit was compared with the committed branch: both had 20 case conflicts and 232
identical-translation groups. Both lacked the same three planning-view keys in Croatian and
French. The unlisted dynamic `structureEditor.tools.` prefix also preceded this change. The new
shared-session keys are present in all seven locale files and its dynamic namespace is registered.

## Regression boundaries

The focused tests exercise persisted ownership before a reload request finishes, no background
requests without an active session, exact session request paths, delayed map-swap acceptance,
failed-swap retry, unrelated design protection, ordinary applied fork selection, plan revision
tracking, and rollback of a local edit when editing control changes before commit. Backend race
tests suspend the actual edit promise and verify that takeover or a competing save rejects its
late commit. Hosted contract checks probe private-tool capability refusal without creating a
session or publishing records.

## Final metadata check

The normal title and construction-schedule editors saved their local revisions, but the first
live shared-save readback retained the old title. The composer supplied temporary member IDs
that the shared save could not resolve. The fix resolves a unique applied design by its exact
content CID, and refuses ambiguous instances. Handover also compares against the accepted
session revision so pending metadata is saved before granting control. The focused headless
unit file passed all ten tests after this fix.

The later headed title/schedule recheck passed on 2026-10-29. Normal UI edits saved the title
“Shared garden with a schedule” and the January–March 2027 construction window into the same
local shared session; real MCP inspection returned both exactly. Earlier attempts had been
blocked by automatic permission-review timeouts and provider-capacity errors.

A subsequent local test in the visible 3D browser also passed: the owner granted agent control,
the agent moved the bench two metres north through the local shared-plan MCP tool, and the
same page automatically applied the exact returned design CID. The collaboration panel remained
open with Take control available. No preview navigation, publication or deployment was needed
for that update. A new private preview was generated; opening that final link in a fresh browser
profile remains separate from the verified live session.

## Owner edit retains the Plan section

The live local trial exposed a navigation gap: editing a member changed its content CID, so
exact membership lookup no longer found the previously saved plan. The browser now captures a
pending ordinary plan revision from committed local members, follows applied revision forks,
and retains construction windows. Both click stacks identify private revisions by their content
CID as well as published revisions. Previous plans and the accepted server revision stay fixed.

Targeted headless unit runs: the two initial files passed 35 tests; after adding regressions,
the same two files passed 38 tests; the final four files (`shared-plan-browser`,
`design-memberships`, `click-stack-panel`, `three-click-stack`) passed all 98 tests. No full suite
was run for this fix.

In the user's local browser, the saved design was backed up before reloading the corrected
frontend. Its complete canonical content, four benches and edited boundary matched exactly
after reload. The collapsed Plan section appeared above Design, and Collaborate exposed Save
to shared plan. MCP inspection before and after confirmed the accepted server revision and
version had not changed and still contained one bench. The user's four-bench revision remained
pending locally for their explicit save.

## Save feedback and collaboration layout

The reported unresponsive Save action returned HTTP 200: the missing behavior was visible
confirmation. A real local MCP inspection confirmed version 12 contains the exact current
four-bench design CID. The revised dialog now shows pending/saved status, disables redundant saves,
keeps failures visible across polling, and preserves invitation-copy feedback. The click-stack
Collaborate button opens a dedicated dialog with grouped actions and 44-pixel minimum buttons.

Targeted headless unit runs: the initial two files passed 38 tests; after adding mounted-dialog
save regressions, the same two files passed 40 tests; a final shared-plan-browser run passed
14 tests after the polling/announcement refinement. No full suite was run.

The first live visual check reloaded the page but timed out waiting for DOMContentLoaded under
heavy host load. A continuation was temporarily blocked by approval-service capacity, and the
browser access host/native computer-use permission were unavailable. The existing browser CLI
provided the desktop check. After automatic browser cleanup closed the window, the same profile
was restored and the complete live check passed: MCP returned the exact four-bench design CID,
canonical local content was unchanged, saved status appeared, and redundant Save was disabled.
Desktop and 390-pixel mobile screenshots were inspected; all four mobile buttons measured
358 by 44 pixels and stayed within the viewport. The window was returned to its original desktop
size with Collaborate open for the user.
