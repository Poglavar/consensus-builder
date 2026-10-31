# Student AI assistance

A person and an MCP agent can work on the same plan through a private server session. The
browser keeps its normal map and editors; the agent uses the hosted MCP. Completed, accepted
revisions are reflected in the browser. The two take turns rather than editing concurrently.

## Product focus

The priority is accessible, ergonomic city editing through conversation with an AI agent:
"move the bench two metres north", "rotate this building", "make the path wider", or "undo that".
The person gives an instruction in their chosen agent application, the agent inspects and edits
through MCP, and the accepted change appears in the person's map. Editing remains scoped to an
ordinary plan and its designs. Text conversation is sufficient; spoken input depends on the chosen
agent application's capabilities.

The person should be able to understand what the agent is editing, follow the result without
relying on animation alone, correct a misunderstanding, undo a change and take control using the
normal editor. Improve the existing MCP operations and handover flow around those tasks. Browser
remote control is optional and is not required for this workflow.

Human-to-human collaboration, participant roles/presence and simultaneous multi-user editing are
deferred. They are not prerequisites for improving human–AI assistance or releasing this flow.

## What is shared

The session points to an ordinary immutable `plan/v1` revision and carries its exact `design/v1`
members. A published plan can be the starting point. Editing creates private revisions or forks
through the existing authoring operations; it never mutates the published source. There is no
second design format or special AI draft editor. A CID identifies content and does not require
an IPFS upload. Saving to the session is private server storage; Share remains explicit server-only
publication. Neither path uploads design or plan content to IPFS.

The session holds the current revision, a version counter, editing control, the last accepted
content-change receipt and one undo snapshot for the latest agent change. Every save checks the
expected version and current controller atomically. Taking control invalidates an agent request
still computing its edit. Undo restores the prior exact artifact as a new session version; it does
not mutate published content. An owner save clears the undo snapshot.

## Shared-plan trial

1. Open a saved plan containing an editable park and a bench, then choose **Collaborate**.
2. Copy the invitation to an agent connected to the same MCP service. The invitation grants access
   to this session; it does not connect or configure the AI application itself.
3. Choose **Let agent edit**. Ask the agent to inspect the current plan and move the bench two
   metres north using the shared-plan editing tool. Watch the accepted revision appear on the map.
4. Choose **Take control**, open the usual geometry editor and move the bench using **Objects** or
   the mouse. Finish the editor and choose **Save to shared plan**. The agent's next inspection
   must report that saved coordinate. Local member edits also create a pending plan revision, so the
   Plan section stays above the edited Design section and reopens Collaborate. The server keeps its
   previous accepted revision until Save to shared plan or handover.
5. Give control back, then take it during an agent edit. The late save must be refused; the agent
   must inspect the current version before trying another change.
6. Disconnect and confirm the retained local plan can still be edited normally. Reload while
   connected to check recovery. Repeat at a narrow viewport and with the student's own assistive
   technology.

The Collaborate dialog separates plan changes, editing control and agent access. It shows whether
local changes are pending or all changes are saved; Save is disabled when the accepted revision
already matches. Actions show a spinner while running, failures remain visible, and copying an
invitation confirms completion. Disconnect is separated from editing controls and keeps local work.

To allow the agent to publish, take control, finish editing and save the plan. Review that saved
revision, then choose **Approve publication** in Collaborate's **Publication** section. This permits
the agent to publish that revision and its member designs through `ugt_publish_plan` using its
shared-session reference. It does not grant another editing turn. **Revoke publication approval**
cancels future starts; saving changes or changing turns also cancels approval. Publication already
started can finish with the approved snapshot. Anonymous access remains available and no sign-in
is needed. The ordinary publication API remains open, so this workflow cannot prevent a reader
from copying the content elsewhere.

The copied invitation is a private capability. Keep it out of public plan descriptions and links.
The owner capability remains in the browser's private workspace storage. Revoking the invitation
ends agent access. Disconnect deletes the shared session and its private server state, closes both
participants' connections, and removes the browser credential after deletion is confirmed. Failed
deletion keeps the credential for a retry. Local plans remain editable. Sessions otherwise expire
24 hours after creation.

While connected, the browser receives authenticated event notifications when control, accepted
state or agent activity changes. It fetches the accepted artifact when the revision changes and
reconnects after a dropped connection. The activity indicator covers an actual agent edit, not
merely the agent holding control. A failed or superseded edit never announces a new revision.

The map transaction binds and applies changed or added members, releases removed or revised
members and retains unchanged ones, the camera and unrelated work. Recognizable single-building
and bench moves or rotations can animate; additions, removals and other changes receive a change
announcement. Ambiguous correspondence and other geometry changes are presented without a guessed
movement. Unchanged building visuals and unchanged park/square/lake families are retained when their rendering inputs match; a changed structure family still rebuilds as a unit. Reduced-motion settings are respected. Intermediate revisions can be skipped while the
browser is applying an update, and no partial agent work is shown.

After taking control, the owner can undo the most recent content-changing agent save while that
revision remains current. Save or reload local pending edits first. The agent can request the same
undo through `ugt_edit_shared_plan` while it holds control.

## Boundaries

- One editor at a time; no concurrent or automatic offline merge.
- Finish local editing and save before handing control over. Network errors retain local work;
  they do not imply a successful shared save.
- A session is scoped to a plan. Camera position and unrelated local designs are not shared work.
- The existing single-tab browser workspace lock remains in force.
- The API stores sessions in PostgreSQL across restarts, independently of expiring preview links.
  Transactional version/control checks prevent competing saves from overwriting one another.
  The MCP worker holds no database credentials. Session capability verifiers are hashed in storage.
  Experimental file-backed sessions must be recreated; they are no longer read.
- Sharing/publishing, wallet approval and blockchain actions keep their existing explicit flows.

## Remaining work

Prioritize the shared-plan trial before deployment. PostgreSQL session storage,
transactional version/control checks, hashed capabilities and protection of the private upload
path are part of the current implementation. The following work remains, in order:

1. **Complete the collaboration trial.** Exercise human-to-agent-to-human handover, pending local
   edits, undo, reconnect, service restart and stale-save rejection on the integrated code. Check
   movement and rotation in 2D and 3D, reduced motion, a narrow viewport and the student's actual
   input or assistive technology. Use independent clients to confirm both see the accepted revision.
2. **Merge and deploy the verified revision.** Apply the PostgreSQL schema before starting code
   that requires it, update the API and unbuffered nginx session routes, then update MCP and the
   frontend. Follow the [MCP deployment contract](mcp.md#deployment). Verify a real shared-session
   edit and notification through the public site, and retain the previous release for rollback.
   Recreate experimental file-backed sessions; their old links are not database sessions.
3. **Improve conversational MCP editing.** Make it straightforward for the agent to inspect the
   current plan, identify the intended design or object, apply a precise edit and read back the
   accepted result. Improve object descriptions, references, units, validation errors and recovery
   guidance using existing granular operations. Include relevant map selection/context explicitly
   where useful; do not assume the agent sees the person's screen. Ask for clarification when a
   target or instruction is ambiguous. Keep ordinary corrections within the current shared plan.
4. **Improve human–AI ergonomics.** Make connecting an agent, reopening a session, handing over,
   taking control, saving pending edits, undoing and disconnecting easy to find and understand.
   Distinguish agent activity, applying a revision, saved state and connection errors. Provide
   concise change summaries and accessible announcements alongside visual feedback. Preserve
   keyboard focus, the camera and unrelated work; respect reduced motion. Session management
   should serve the person's work with their agent, including ending or deleting finished sessions.
5. **Improve review and recovery.** Show what the agent changed and allow inspection and restoration
   of earlier revisions as new accepted versions. Extend beyond the current single agent-change
   undo without mutating prior content. Keep publication separate from accepting an edit.
6. **Evaluate complete conversational tasks.** Use representative instructions for moving and
   rotating buildings, editing paths, placing furniture, correcting mistakes and undoing changes.
   Check that the agent finds the intended object and that its description matches the saved map
   state. Include ambiguous requests, failed edits and interrupted connections. Evaluate task
   completion, required interventions and recovery with the student's actual input or assistive
   technology; tool success alone does not establish usability.

New human editing and session-management operations must have MCP parity through shared
operations and validation; update affected schemas and discovery alongside implementation.
Prefer improving existing inspect/edit primitives over adding a tool for every conversational task.
Human-to-human and simultaneous editing remain deferred outside this work plan.

## Optional browser-control trial

An AI can also operate the student's existing tab when its browser permissions allow it. That
connection, its permission prompts and stopping the agent belong to the AI product. It is separate
from the server session above.

Use the available computer and AI product, an ordinary existing map tab, and a disposable garden
draft containing a bench, tree and path. Keep any unpublished real work out of the trial. The
[accessible editing controls](accessible-map-editing.md) are the starting interface.

First establish that the AI can attach to that exact tab. The student must be able to understand
the permission prompt, stop the AI and use the page themselves. A fresh automation profile or a
scripted browser test does not pass this gate. If the connection is unavailable, stop this part
of the trial rather than treating a new browser as the student's existing workspace.

Then ask the agent, using only visible controls:

1. Find Bench 1 in Objects and move it two metres east. Confirm the position and Undo once.
2. Move it one metre north. Stop the agent; the student moves it one metre west. Resume the agent
   in the same tab and have it read the current position, then Undo the student's last change.
3. Change Tree 1's kind and height through its fields. Check the saved properties.
4. Open Edit vertices on a lake, change one coordinate, and Undo. Verify that an invalid shape
   is rejected without losing the last valid outline.
5. Save with Done and reopen the design; reload the tab and confirm the saved result. Keep the
   normal pointer drag, click-to-select and Undo interactions available throughout.
6. Repeat the controls at a narrow viewport and with the student's actual input or assistive
   technology. Check that required controls are reachable and focus is understandable.

Record the product/device, whether it reused the exact tab, completed tasks, mistaken actions,
student interventions and whether stopping/resuming was understandable. Every critical step must
work. Scripted regression checks support the trial but cannot establish the AI product's own
accessibility or the student's ability to take control.

## MCP parity

Human edits use the normal local editor and save ordinary plan/design content. The shared MCP
inspection and editing tools read the same accepted artifact; editing delegates to `ugt_edit_plan`
operations, including granular design patches. The existing `ugt_edit_shared_plan` tool also accepts
`undoLastAgentChange: true` with the inspected `expectedVersion` and `expectedCid`, separately from
content edits. Session version and control checks apply to browser and MCP saves and undo. Existing standalone MCP authoring and preview/import remain available.
The [accessible editing guide](accessible-map-editing.md) maps geometry controls to the underlying
MCP primitives. Browser takeover remains a client capability, separate from this protocol.
