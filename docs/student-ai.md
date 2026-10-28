# Student AI assistance

The initial approach is an AI operating the student's existing map tab through the same visible
controls the student uses. The student and agent take turns. The browser workspace, active draft
and Undo history remain the app's existing ones; there is no separate AI draft to synchronize.

## Current boundaries

- Use the existing tab and browser profile. A separate profile has separate local work. A second
  tab in the same profile is intentionally blocked by the [saved workspace](saved-workspace.md)
  lock; do not weaken that protection to connect an agent.
- Browser connection, authorization, stopping the agent and manual takeover belong to the chosen
  AI product. The site does not grant an agent access or show a misleading connected status.
- Draft editing uses the existing local save paths. Publishing and sharing stay explicit actions.
- The hosted MCP remains useful for browser-independent authoring: inspect/edit a design, review
  its preview, import the result and continue manually. It does not mutate an already-open local
  editor. Its immutable artifacts are separate from local editor gestures.
- Shared backend drafts, concurrent editing, offline merging, an embedded assistant and WebMCP
  are deferred. Revisit them only after a concrete need emerges from the trial.

## First trial

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

No new authoring operation or record type is introduced. Human controls use the existing local
editor functions; `ugt_inspect_design` and `ugt_edit_design` already inspect and patch the same
canonical geometry, decorations and tree properties. `mcp-edit.test.js` exercises those operations.
The accessibility guide maps the controls to those primitives. Browser connection and takeover
are client capabilities, not new hosted MCP operations.
