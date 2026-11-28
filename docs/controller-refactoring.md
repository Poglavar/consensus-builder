# Controller refactoring candidates

Extract one operation when a feature change next touches it. The 3D scenery calculation is the
smallest first step. The proposal operations affect the parcels a saved plan produces.

## 1. Calculate the area to load for 3D scenery

`sceneryQuery()` decides which ground cover and green areas to request. Its test currently extracts
the private function from the controller's source. Give the calculation a direct export and pass it
the loaded buildings' bounds, the previous area, the current view, the scene origin and the fallback
geometry and radius. Let the controller retain the previous area and issue requests. Load the
calculation with the 3D view. [3D controller](../frontend/js/three-mode.js) · [Map mode loader](../frontend/js/map-mode-loader.js)

Test that zooming in retains the requested area, the camera contributes at most 2.5 km on each side
of the scene origin, and entering another scene clears the previous extent. With no usable bounds,
the query uses the anchor and its radius. Keep the check that a view expansion during a request
gets another read. [3D lifecycle tests](../backend/test/three-mode-lifecycle.test.js)

## 2. Assign identities to newly formed parcels

Building, structure and parcel-layout edits call `_assignSyntheticChildIdentities`. When changing
how a split numbers its pieces, extract the assignment using the proposal ID, the child features
and the starting indices for each root. Callers expect newly split pieces in the same input array.
Reuse the existing identity formatting and the rule that lets a surviving piece keep its ID.
[Proposal manager](../frontend/js/proposal-manager.js) · [Parcel identity](../frontend/js/proposal-parcel-identity.js) · [Formation edits](../frontend/js/proposals/formation-edit.js)

Shuffle the input and compare IDs **by geometry**. A carried ID can go to only one piece.
New siblings get distinct IDs. A piece spanning cadastral and open ground keeps both references.
[Parcel identity tests](../backend/test/proposal-manager-ids.test.js) · [Open-ground application tests](../backend/test/open-ground-apply.test.js)

## 3. Choose which proposals a local edit must replay

When changing which neighbours an apply or unapply affects, extract `_localFormationClosure`.
It returns the records and cadastral parcels that need to be replayed. Its caller,
`_rematerializeResolvedScope`, owns rebuilding that ground inside the active mutation.
[Proposal manager](../frontend/js/proposal-manager.js)

Test a layout spanning two cadastral parcels, an unrelated parcel, and two proposals meeting on
open ground. Check the selected IDs as well as the final geometry. A layout can widen the scope
across its anchors. A road crossing them is recomputed over the affected area. Proposals on open
ground can interact through geometry alone. [Local replay tests](../backend/test/incremental-unapply.test.js) · [Open-ground application tests](../backend/test/open-ground-apply.test.js)

## Check a proposal extraction in both runtimes

The map can rebuild just the affected area. MCP calculates ground from the supplied designs and
source parcels in a fresh runtime. If shared code moves into a new script, wire it into both
loaders. Run the same fixtures through the map's Apply operation and the MCP calculation.
Compare parcel IDs, geometry and source references against the pre-extraction results.
[Browser entry point](../frontend/index.html) · [MCP ground loader](../backend/agents/mcp-ground-runtime.js) · [MCP ground tests](../backend/test/mcp-ground.test.js)

Include a case where a later design fails. After rollback, compare the browser's applied records
and parcel geometry with their values before the edit. In MCP, verify that the private draft
produces an error and exposes no partial ground. [Parcel mutation tests](../backend/test/parcel-mutation.test.js) · [Shared-plan replacement tests](../backend/test/open-ground-apply.test.js) · [MCP ground calculation](../frontend/js/agreement-headless.js)
