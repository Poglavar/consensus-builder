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
