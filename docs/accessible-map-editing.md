# Accessible map editing

The map editors provide labelled alternatives to pointer editing through the same authored
design and existing save/Undo paths. People and browser agents can use these controls.

## Controls and behavior

- **Objects**: search and select numbered furniture, including lamps and market stalls, planting, paths and water features. Edit a
  position, move by a stated distance, change tree kind/height, or remove an object. Native selects
  and buttons support keyboard and single-click operation.
- **Edit vertices**: select a numbered vertex, enter latitude/longitude, move north/east/south/west,
  add a point after it, or remove it. Building outlines and holes have distinct disclosure names.
- **Move area**: translate the complete park, square or lake and its authored contents.
- **Place at coordinates**: add furniture or successive path points using fields. Enter in those
  fields adds the point; it does not also finish the path. A rejected path remains open for correction.
- The shared editor focuses its heading on entry and restores the opener on exit. Native controls
  retain focus and expansion through building redraws. Movement, Undo, placement, errors and parcel
  loading have status announcements. The collapse action remains keyboard-operable on mobile.
- Design thumbnails identify their design in alt text, including after an asynchronous thumbnail
  update. Enlarged copies are decorative. Search controls expose their search purpose.

Presentation uses the existing field/action/disclosure categories and theme variables in external
CSS. New copy is present in all seven UI languages. No record schema, object identity, domain term
or publishing contract changes are introduced by the accessibility controls. Object numbers refer
to positions in existing authored arrays; they are not stable object IDs.

## Browser-readable interface

Use native controls and the rendered accessibility tree for browser automation. Account and help
controls are buttons; the account identifies its person and the avatar chooser includes its selected
avatar. Plan membership checkboxes are labelled by their design. Existing status and busy controls
continue to expose progress and disabled state.

The shared tab helper provides one tab stop, arrow-key activation, Home/End navigation and focus
restoration when an editor rebuilds its tabs. Tabs reference their panels and panels reference their
selected tab. Layout-hidden and disabled tabs are skipped. This applies to parcel, block, site,
road-analysis, parcel-layout, corridor, proposal, planning comparison, click-stack relation and bet
scope tabs. Existing agreement tabs retain their own keyboard handling.

Shared dialogs have accessible names, keep keyboard interaction inside and restore the opener.
The central modal registration also isolates older dialogs marked `aria-modal="true"`: background
branches become inert, including siblings added while open. Nested dialogs temporarily isolate their
parent's controls; closing restores the prior inert state. Escape-only registration of a nonmodal
surface does not make it modal. Native `<dialog>` surfaces retain browser-managed modality.

These changes affect navigation and presentation, not authored records or editing operations.
Existing MCP inspect/edit tools remain the agent equivalent of the editors; plan membership uses
`ugt_inspect_plan` and `ugt_edit_plan` with add/remove/replace operations and expected-CID checks.
No MCP schema or discovery change is needed for control names, tabs or dialog focus.

## MCP parity

The existing `ugt_inspect_design` and `ugt_edit_design` primitives expose these authored fields:

| Human edit | Existing agent operation |
| --- | --- |
| Move/add/remove polygon vertices | JSON Pointer patches into geometry coordinate arrays |
| Move an area or object | Coordinate replacement or the existing geometry transform operation |
| Place/remove furniture, planting or a path | Add/remove entries in `structureProposal.decorationDesign` |
| Change tree kind and height | Replace `kind` and `heightM` on the authored tree record |
| Edit a building outline or hole | Patch the corresponding building polygon ring |

The targeted `mcp-edit.test.js` checks valid park, square and lake vertex changes, tree properties,
invalid coordinates, and preservation of the source revision. Existing tests cover decoration edits,
building geometry and validation. Existing primitives are sufficient, so no new MCP tool, schema or
discovery entry is needed. The browser controls commit to the existing local editor draft. MCP still
uses expected-CID checks and returns immutable revisions. A [shared plan session](student-ai.md)
connects the agent conversation to the open map, with one editor at a time and live updates of
accepted revisions. Conversational editing and human–AI handover are the current accessibility
and ergonomics priority; human-to-human collaboration is deferred.

## Coverage and limits

Targeted tests live in `backend/test/geometry-edit-coordinates.test.js`,
`structure-editor-objects.test.js`, `polygon-geometry-editor.test.js`, `on-map-editor.test.js`,
`frontend-structure-edit-history.test.js`, and `mcp-edit.test.js`. Browser coverage lives in
`e2e/tests/accessible-map-editing.spec.ts` and `browser-semantics.spec.ts` (including native browser
accessibility-tree checks); ordinary pointer interactions remain covered by
`structure-placement.spec.ts` and the workspace lock by `browser-workspaces.spec.ts`.

Keyboard semantics, focus, saved state and narrow layout are testable independently of an AI
product. These checks do not establish VoiceOver, NVDA, voice-control or student usability.
Polygon controls do not establish complete keyboard coverage for every specialized map editor.
Thumbnail text identifies the design rather than describing every element of its scene.
The [student AI trial](student-ai.md) defines the separate existing-tab and human-takeover checks.

The existing Turf line-within-polygon check can accept a segment whose endpoints are inside a
concave boundary while its middle crosses outside. A U-shaped boundary reproduced that behavior
in the installed app geometry library. This change keeps the existing geometry validation contract;
its rejection-handling regression injects a rejecting validator to verify that Save and tool changes
retain pending points. Full segment containment remains a separate shared geometry finding.
