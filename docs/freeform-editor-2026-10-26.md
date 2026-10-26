<!-- Verification record for Freeform zoom, footprint movement and land-take controls. -->
# Freeform editor refinement — 26 October 2026

Freeform footprint drags move only the active building. The authored surroundings boundary and
its furniture remain anchored; the surface's footprint holes are recomputed. Imported collections
remain editable by selecting buildings on the map and save as separate Freeform designs. The
in-editor duplicate, delete, rename and numbered building picker have been retired. Existing
saved records are not rewritten.

Land-take rows have individual borders and highlight their source geometry on hover, click or
keyboard focus. Long parcel identifiers show their first and last five characters, retain the full
identifier in a tooltip and in the choice's accessible label, and stay on one line. The introduction
includes the touched-parcel count. “Only building footprint” and “Whole parcels” share the row
equally; both use the shared busy-control behavior. Retrying either choice or Done rechecks source
data, so there is no separate Retry button. The disconnected-buildings hint and color legend are
removed.

The map ceiling is 23. Basemaps and raster parcel overlays retain their native tile ceilings and
overzoom those tiles; no higher-resolution source request is introduced. The address parser retains
zoom 23 across reloads. This establishes request behavior, not a frame-time benchmark: the shared
host was heavily contended during verification.

## MCP parity

No new MCP tool or schema is needed. `ugt_inspect_design` reads the authored geometry;
`ugt_edit_design` transforms `/geometry/buildings/0/geometry` independently of ground and furniture,
and patches `/geometry/landTake` for footprint, whole-parcel and mixed choices. The targeted
`mcp-edit.test.js` regression exercises movement, independent land-take editing, retained furniture,
updated surface holes and source-record immutability. The authoring contract is documented in
[mcp-editing.md](mcp-editing.md).

## Verification

All browser test runs below are headless Playwright runs against this checkout's local frontend.
No full unit or full browser suite was run.

| Run | Scope | Result |
| --- | --- | --- |
| Headless unit | `single-building-map-editor`, `single-building-geometry`, `freeform-land-take`, `mcp-edit`, `road-editing-zoom`, `frontend-world-entry` | 6 files, 112 tests passed. |
| Headless unit | `mcp-edit`, `frontend-world-entry`, after parity/address assertions | 2 files, 64 tests passed. |
| Headless unit | `point-parcel-integration` | 1 file, 10 tests passed. |
| Headless unit | `i18n-locale-coverage`, `i18n-locale`, `frontend-duplicate-globals`, `no-home-paths` | 25 passed, 5 locale-coverage failures in unrelated plan/privacy/bets keys. A concurrent localization session subsequently changed those files. |
| Headless unit | `mcp-edit`, `single-building-map-editor`, `i18n-locale`, after cleanup | 3 files, 39 tests passed. |
| Headless Playwright | `freeform-land-take`, `freeform-upload-duplicate`, `single-building-placement`, `geojson-buildings` | 25 passed, 4 placement failures: an overall timeout and fixtures/expectations tied to the retired building controls and moving ground. |
| Headless Playwright | Attempted placement rerun before fixture edits landed | Stopped immediately: 1 interrupted, 6 not run. |
| Headless Playwright | Corrected `single-building-placement` | 6 passed, 1 expected destination-parcel fixture corrected for the new import setup. |
| Headless Playwright | Five checks selected from land-take, placement, editor-button and designer-controls files | 5 passed, including the final save, spinner lifetime and failure recovery checks. |

The control-inventory check (`node e2e/scripts/check-control-contract.mjs`) also reported existing
unrelated inventory/exemption mismatches. This change removes only the retired Freeform controls
from its contract.

A dedicated background Chrome was used for visual checks with real local API data in Saint
Petersburg. A pointer drag changed only the building footprint; its ground boundary remained
identical. Row hover highlighted the correct map parcel. At a 390-pixel viewport the bulk buttons
were each 188 pixels wide and the parcel ID remained on one line. Zoom 23 retained native OSM tile
zoom 19. The complete preview URL resolved the intended city, backend and source parcel; building
stock review completed. A small local GLB upload and retrieval both returned HTTP 200 and identical
bytes. The verification browser was closed afterward.

The four locale JSON files also received concurrent localization edits. Their Freeform copy changes
remain in the working tree; mixed files are excluded from this task's commit.
