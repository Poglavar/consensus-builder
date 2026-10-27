# Proposal creation and editing matrix fixes

Follow-up to the 27 October 2026 proposal matrix, whose tested source was
`4c3f26e9b50d19c02899dfeaa6c45a2959f99430`. These are local source changes and
targeted checks, not a new live-deployment or full-regression verdict.

## Findings addressed

| Finding | Change |
| --- | --- |
| F1: generic Block, Row and Detached omit the authored site | Generic creation retains the selected land as the authored site, including all selected parcel references. It does not substitute generated building footprints. Saved designs reopen in their typed geometry editors. |
| F2: empty specific third-party recipient | Shared validation rejects empty or whitespace-only recipient names/addresses before saving and allows a corrected retry. |
| F3: dirty Park, Square and Lake close silently | Header close, Cancel and Escape use the shared Keep editing / Discard confirmation. Geometry, furniture and path changes participate in dirty detection; clean close and successful save close directly. |
| F4: generic Row bypasses eligibility | The generic route requires two selected parcels. MCP requires two distinct source parcels, or at least two frontage plots generated from an authored outline. |
| F5: Layers covers Block information | Choosing a block from the list closes the Layers sheet before presenting the block. |
| F6: Block parameters omitted from Undo | Height, setback, gap and wing parameters, variation and rule changes join the geometry history. Undo restores controls and generated preview together. Gap width and wing length persist across reopening. |
| F7: applied Subdivide conflicts with itself | Site-pool construction excludes only the edited design's own produced ground from holder conflicts. Other designs still block conflicting edits. Applied subdivision can be edited, saved and reopened after reload. |
| F8: initial drawn-site structure bypasses verified binding | Initial Park, Square and Lake placement uses the existing authoritative free-placement binding gate. Unknown coverage refuses application and retains a recoverable draft; a verified retry can succeed. |

An additional bounded import guard rejects more than 1,000 polygon features before
expensive parcel carving. It addresses the reported over-limit workload without
claiming a general large-file performance guarantee.

Existing generic records already missing their authored site are not reconstructed
from building footprints. Recreate those drafts. This follows the project's current
experimental contract rather than introducing a speculative compatibility reader.

## Editing and MCP parity

Row uses the same site-plot cutter for outline-based eligibility. MCP constructors,
discovery text, tests and the vocabulary describe the same minimum. Block parameters
already have MCP editing primitives; history and close confirmation are browser
interaction state. Binding and layout changes retain the existing shared authoring
and validation boundaries.

The browser's local ownership/recipient facets remain outside `design/v1` and cannot
be inspected or edited through MCP. This existing parity gap is recorded in
`mcp-editing.md`; recipient validation does not add a new editing surface or redefine
ownership/agreement records. The absent saved ownership/road-land metadata editor,
disabled algorithms and absent Detached Undo were not redesigned in this change.

GLB selection, the disconnected road-land fixture, world-wide source coverage,
actual publication, agreements and chain operations remain outside these checks.
The original report's qualified cases remain qualified.

## Verification

- Final targeted **headless Vitest** run: **356 passed**, 17 explicitly named files,
  no failures or skips. It includes generic creation, adapters, initial binding,
  Block history, structure history, parcel layout, MCP constructors/drafts/editing,
  discovery and server checks.
- **11 distinct browser scenarios passed** across three changed-flow spec files:
  generic Block/Row/Detached create-save-reopen; recipient refusal/retry; one-parcel
  Row refusal; Park/Square/Lake dirty close; Block parameter Undo; unknown-binding
  Park refusal/recovery; and applied subdivision edit-save-reload.
- The final targeted **headed Playwright** run passed **6/6** scenarios: the five
  generic-creation cases and applied subdivision. The other five distinct scenarios
  passed in targeted **headless Playwright** runs. Repeated passes are not added to
  the distinct total.
- Production static build passed. Feature inventory passed with 103 commands;
  control-contract checks passed with 905 source sites. Locale JSON and whitespace
  checks passed. Subdivision and discard-confirmation screenshots were inspected.

Earlier targeted trials were not all green. Stale unit fixtures were updated to the
current structure and named-plan contracts while retaining their assertions. Browser
trials exposed obsolete selectors, a furniture-hit test gesture and startup/reload
timeouts under heavy shared machine load. An initial compiled-preview server used
HTTP/1.0 with a small connection backlog and dropped script requests: its interrupted
11-case headless run recorded nine failures, one pass and one unexecuted case. It was
replaced with an HTTP/1.1 server with persistent connections and a larger backlog;
the corrected Square headless check and final six headed checks passed. Those failed,
stopped and repeated trials do not contribute extra successful coverage.

Only targeted suites ran. No full unit or browser suite, production publication,
wallet action, production-data mutation, push or deployment was performed for this
follow-up.
