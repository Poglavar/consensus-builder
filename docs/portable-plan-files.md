# Portable plan files

The public [format and use guide](../frontend/plan-files.html) documents `ugt-plan-file/v1`,
its [JSON Schema](../frontend/schemas/plan-file-v1.schema.json), GIS limits and media behavior.
`frontend/js/plan-file.js` is the shared, dependency-light reference implementation.

The envelope carries exactly `schema`, `plan`, `designs` and `designSources`. `plan` obeys
`PlanRecord`; its lexically sorted CIDs exactly match the ordered `{cid, content}` members.
`content` obeys `DesignRecord`, with the existing canonical CID scheme. Source descriptors
contain only `sourceId` and nullable `snapshotId`. Imported sources are retained observations,
not active credentials, source configuration, binding evidence or ownership.

Export uses `DesignRecord.published`, not a browser-storage dump or the publication API.
No URL is changed and nothing is pinned or indexed. Self-contained model data changes the
exported canonical content, so it has a new CID. Otherwise design CIDs are retained.
Origin CIDs record lineage, not rendering dependencies that must be fetched. Model downloads use
the same backend asset resolver as rendering, including the selected local backend and stored
development origins; absolute public model URLs retain their origin.

Import validates the entire envelope before mutation. `PlanFileUI.commitImport` uses
`ProposalManager.runParcelMutation` with `_mapMutation:false`. Draft definitions and
`ugt-imported-plan:<plan CID>` membership/view are saved in the same staged storage transaction.
Identical authored content is reused, regardless of publication or map application; existing
records are never rewritten. New keys use UUIDs. The store's real normalizer is checked for
CID equivalence before commit. A failure rolls back the batch. There is no automatic apply,
source fetch, city switch, signing, agreement import or publication.

The share panel supplies the same explicit selected set to both downloads, preserving exclusions
and agreement-scoped membership. Individual design download uses a one-member plan. Opening an
imported plan supplies its saved view; subsequent view edits intentionally produce a new snapshot.

## MCP parity

Existing `ugt_get_plan`, `ugt_inspect_plan` and `ugt_edit_plan` accept the parsed portable
envelope as `plan`. The resolver uses the same codec and carries canonical members into the
existing granular authoring primitives; no new high-level editing tool or browser-state mutation
is needed. `expectedCid` and publication confirmation retain their existing meanings. `ugt_export_draft`
continues to retain exact private artifacts; it is a different transport from the browser download.
The named-plan test covers importing the portable envelope, inspecting members and revising its title
without network writes. Shared authoring operations preserve their existing validation. Portable
binding namespaces pass through the existing MCP source resolver before becoming API selectors
(`hr-cadastre` uses the `oss-wfs` gateway). Regression coverage exports a browser record, opens and
edits it through MCP, then checks the source passed to publication; other source IDs stay unchanged.
The envelope and its retained source observations are not rewritten, so no schema or discovery
change is needed.

## Verification

From `backend`, run the focused Vitest suites for `plan-file`, `proposal-storage-authored-log`,
`mcp-named-plans`, `share-plan-panel-contract`, `share-plan-map-link`, `design-sync`,
`proposal-import-normalizer`, `proposals-sharing-utils` and `busy-control`.
The isolated browser fixture in `e2e/tests/plan-file.spec.ts` exercises download, preview/cancel,
malformed and repeated selection, busy restoration and import confirmation. Its fake mutation
boundary tests UI behavior, not production datasets or a live database. Model-download checks use
the real browser asset resolver with a different API origin, a stored development origin and an
absolute public URL. They verify the downloaded embedded bytes and busy-control recovery, and all
file flows fail on uncaught page errors.

The focused `Portable plan files` pull-request workflow runs these unit/integration suites and
the isolated Chromium file flows using the repository lockfiles.
It also runs the existing page-header/chrome checks for the new format guide.
Run the browser fixture with `cd e2e && npx playwright test --config=playwright.plan-file.config.ts`;
it needs no frontend or source-data server.

## Deferred composed GLB export

`getThreeModeInternals()` exposes a live scene, but this is not a proposal-only metric model.
`three-mode.js` mixes proposal/context groups, Z-up local Mercator coordinates, terrain formation,
instancing and custom shader display effects. Passing that scene directly to GLTFExporter would
misstate scope and metre scale. A follow-up needs semantic extraction of selected visible proposals,
instancing/visibility tests, a documented local georeference, latitude scale correction and a Z-up
to glTF Y-up conversion. This change does not advertise a composed GLB download.
