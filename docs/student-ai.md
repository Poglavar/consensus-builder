# Student AI assistance

A student and an MCP agent can work on the same plan through a private server session. The
browser keeps its normal map and editors; the agent uses the hosted MCP. Completed, accepted
revisions are reflected in the browser. The two take turns rather than editing concurrently.

## What is shared

The session points to an ordinary immutable `plan/v1` revision and carries its exact `design/v1`
members. A published plan can be the starting point. Editing creates private revisions or forks
through the existing authoring operations; it never mutates the published source. There is no
second design format or special AI draft editor. A CID identifies content and does not require
an IPFS upload. Saving to the session is private server storage; Share remains explicit server-only
publication. Neither path uploads design or plan content to IPFS.

The mutable session holds only the current revision, a version counter and editing control.
Every save checks the expected version and the current controller atomically. Taking control
invalidates an agent request that was still computing its edit. Old snapshots remain ordinary
records; the session is not a public release or a shared global map.

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

The copied invitation is a private capability. Keep it out of public plan descriptions and links.
The owner capability remains in the browser's private workspace storage. Revoking the invitation
or disconnecting ends its access.

While connected, the browser checks for a new accepted revision every four seconds. A changed
revision replaces the connected members through the ordinary map transaction; it does not reload
the page or move the camera. Moved objects appear at their new positions without an interpolated
movement animation. The delay includes the next poll, network requests, ground binding and map
application. Intermediate revisions may be skipped when several edits finish between polls.
Background browser scheduling can delay checks; a synchronization failure pauses polling until
recovery. No intermediate mouse gestures or partially completed MCP operations are streamed.

## Boundaries

- One editor at a time; no concurrent or automatic offline merge.
- Finish local editing and save before handing control over. Network errors retain local work;
  they do not imply a successful shared save.
- A session is scoped to a plan. Camera position and unrelated local designs are not shared work.
- The existing single-tab browser workspace lock remains in force.
- The service stores sessions on disk across restarts, independently of expiring preview links.
  It runs with one writer per storage directory and rejects writes when storage is full.
- Sharing/publishing, wallet approval and blockchain actions keep their existing explicit flows.

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
operations, including granular design patches. Session version and control checks apply to both
browser and MCP saves. Existing standalone MCP authoring and preview/import remain available.
The [accessible editing guide](accessible-map-editing.md) maps geometry controls to the underlying
MCP primitives. Browser takeover remains a client capability, separate from this protocol.
