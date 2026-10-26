# Freeform acceptance removal — 2026-10-26

The user requested removal of the land-take disclaimer and acceptance checkbox. The Freeform editor now saves through Done without a separate acknowledgment. Parcel choices, land and demolition previews, fresh source reads on Done and geometry validation remain part of the existing save flow.

Removed the checkbox markup, acceptance state/signatures, acceptance-specific errors, CSS and translation keys. Updated the glossary, guides, captions and affected browser tests. Missing source data still produces the existing retry error; it no longer refers to accepting anything.

## MCP parity

This changes an editor-only confirmation, not an authored field or geometry operation. MCP already authors Freeform buildings through `buildTypedDesign` and edits `/geometry/landTake`, `/geometry/groundSurface`, `/geometry/groundBoundary` and `/site`; there is no acceptance field in that contract. The existing `mcp-headless-freeform.test.js` verifies canonical authoring, land take and ground derivation without browser confirmation. No MCP schema, tool or deployment change is needed.

## Verification

- Targeted headless unit tests: `freeform-land-take.test.js` and `single-building-map-editor.test.js`, **2 files, 21 passed**.
- Targeted MCP parity headless tests: `mcp-headless-freeform.test.js`, **1 file, 2 passed**.
- First targeted headed Playwright run: `freeform-land-take.spec.ts`, **9 cases; 7 passed, 1 timed out, 1 interrupted**. The host load exceeded 350 and the test output also contained missing-artifact errors in the shared output directory. The primary agent stopped this run with SIGINT; the complete result appeared when output finished flushing. Mobile direct saving was among the passing cases.
- Targeted headed recheck of only `narrow building|imported GLB`, with a separate temporary output directory: **2 passed**. Thus every one of the nine affected cases passed across the two runs. The captured editor screenshot was visually inspected: the land choices and Done button remain, with no acceptance checkbox or disclaimer.
- The other nine E2E specs were mechanically updated to wait for the land summary rather than the removed checkbox. They were not executed as a broad suite.
- A dedicated real-data browser opened Freeform on Birmingham parcel source `gb-hmlr-browser-v1` using the production API. The land/building summary loaded (399 m², one parcel), the acceptance-control count was zero, and the editor screenshot was visually inspected. The preview server was verified against this checkout with no-store asset headers. Point lookup is unavailable on this source; verification used its supported viewport records.

No full suite was run. No push or deployment was requested. The bounded E2E selector cleanup used `gpt-6-luna` at low reasoning; the primary agent owned runtime edits, verification and Git.

The shared checkout also contains another session's camera changes in `single-building.js` and `vocabulary.md`, plus parcel-guidance changes in the four translation files. Those mixed files are left uncommitted under the repository's collaboration rule.
