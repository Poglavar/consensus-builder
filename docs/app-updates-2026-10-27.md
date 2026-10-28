# App update checks

Settings → Information shows the running build, its deployment time, a Check for updates button,
the check result and the last attempt time. The existing deployment-stamped `__BUILD_INFO` is the
running identity; the hand-maintained release notes are not used for comparisons.

The checker reads the existing frontend `release.json` on the same origin, with a fresh query
parameter, no-store fetch policy and a 15-second timeout. It validates the component, schema,
deployment counter, matching build ID and deployment date. A larger deployment counter identifies
an update, including a newly deployed rollback. Invalid or older responses report a failed check.
Overlapping manual/automatic checks share one request. Failure never claims the tab is current
or removes an update already discovered. Local development templates are labelled Development
build and do not poll; the manual check explains that it requires a deployed build.

Deployed tabs check on startup, every five minutes while visible, and on returning to the tab or
window. Checks do not move focus or change running code. A notice in the existing feedback stack
offers Reload and Later. Dismissal lasts for that release in the current tab; a subsequent release
can show another notice. Settings retains its Reload action, and a manual check can show the notice
again. The feedback stack remains visible when the notice is its only content and participates in
the existing right-column collision clearance.

Reload is explicit and uses the ordinary browser reload, preserving existing unload/flush handlers.
The existing map edit lock, road drawing state, map editor, design draft editor, blocking dialogs
and aria-busy controls prevent that action while editing or work is pending. A blocked action
explains how to proceed and leaves the editor intact. No automatic reload or code replacement occurs.

All seven locale dictionaries include the UI copy. The manual action is registered as
`settings.checkUpdates`; four new buttons and the workflow have control/feature inventory entries.
`AppUpdates.check()` and `snapshot()` expose the same read-only inspection to browser agents.
MCP parity: no editable field, authored record, validator or authoring operation changes. Existing
MCP editing primitives remain unchanged; no new MCP tool or schema is needed for release inspection.

Targeted verification:

| Type and scope | Result |
| --- | --- |
| Headless unit: release comparison, page wiring, release artifacts and locale coverage | 41 passed across four files |
| Final headless unit: same four files with stricter metadata validation | 43 passed |
| Headed Playwright: desktop, phone and editor protection | Two passed; one assertion targeted the editor's zero-height wrapper |
| Final headed Playwright: corrected visible-panel assertion | Three passed |
| Headed Playwright: explicit Settings Reload variant | One passed |
| Manual headed Chrome: development metadata and real local API | Development label and disabled release check confirmed; seven parcel features and five building footprints returned |

No full suite ran and no run was stopped. Screenshots were visually reviewed on desktop and phone.
The browser scenarios simulate deploy-stamped builds and manifest responses while using the real
app UI. Unit checks cover hidden-tab polling, returning to the tab, interval timing, shared requests,
invalid/older manifests, local development and busy/editing reload guards.

The global control-contract check still reports pre-existing drift in agreement-panel controls.
The feature inventory check reports an existing missing proposals.agreements mapping and retired
planStats/grainScore/clearLocal mappings. The four update controls and update-command mapping are
present; unrelated inventory repairs are outside this change.

The deployment pipeline already stamps the required metadata. Tabs loaded before this checker
ships need one reload to acquire it; they can then discover subsequent deployments. No deployment
was performed in this task. Concurrent edits still share index.html, locale dictionaries and some
map files, so mixed files remain uncommitted.
