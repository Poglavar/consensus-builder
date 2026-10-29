<!-- Open plan: permitted massing for parcels a plan made (readjustment plots, road and track remainders), the fabric-driven refresh and the Bogotá block index. -->
# Permitted massing for parcels a plan made (land readjustment, road and track cuts)

## Context

The Permitted layer draws one outer bound per parcel from the planning source's rules
(`backend/planning/parcel-envelopes.js`, shared evaluator `frontend/js/planning/parcel-assessment.js`).
It reads its parcels from the city's cadastral parcel source only. A plan that readjusts a block into
one plot, or a road or track that cuts lots, changes the live parcel fabric, but the layer keeps
showing the source lots' envelopes under it. For Bogotá this hides the point of assembly (index 5.0
per lot, 6.0 with a corner and cession, 7.0 for a whole block); every city whose rules depend on lot
size or frontage has the same gap.

Bogotá and the Atlas sources are shape-based (a parcel is a polygon plus the zoning records under it
and per-lot reads by overlap) and run the envelope pipeline. Zagreb GUP and the NYC pilot draw their
Permitted items from per-lot records (a cached solver table, a PLUTO row) and never enter that
pipeline, so they need their own plot path. The work: (1) plan plots through the envelope pipeline,
(2) a fabric-driven dirty refresh, (3) Bogotá's block-assembly index, (4) Zagreb and NYC plot paths,
(5) MCP parity.

Decisions: all four sources, including the Zagreb and NYC plot paths; the Bogotá cession is derived
from the layout's public-owner pieces.

## What exists (verified in code)

- **Live fabric** `frontend/js/parcels/live-fabric.js` (`window.LiveParcelFabric`): frozen Polygon
  pieces keyed by id, `byCadastreId`, `byProducerId`. Pieces carry `cadastreParcelIds`,
  `producedByProposalId`, `formedByProposalIds`, `isCorridor` (road/track), `readjustmentPiece
  {role:'plot'|'remainder', plotFingerprint}`, `liveParcelDerivation`. Derived ids contain `#`:
  `${root}#${token}-${n}` (layout plots), `${id}#r<hash>` / `#p<hash>` (road pieces and
  remainders), `${id}#cadastre-${n}` (multi-part cadastral parcels, not plan output, no producer).
  `ParcelMenuModel.parcelIdentityKind` names a piece `plotPiece`, `remainder` or `formed`.
- **Change notification**: `LiveParcelFabric.subscribe(fn)` runs synchronously inside `publish`
  with `{revision, fromRevision, addedIds, updatedIds, removedIds, changedCadastreIds}`.
  `changedCadastreIds` also lists lots a viewport seed or a release touched, so it cannot drive
  recomputation by itself. Helpers: `peek(id)`, `peekBounds(bbox, {includeCorridors})`,
  `entriesForCadastre`, `producedBy(proposalId)`. Removed pieces' geometry is gone after commit.
- **Permitted layer** `frontend/js/planning/views.js`: `refresh()` on `moveend` (300 ms), source or
  city change; `viewCache = createViewportCache` (`frontend/js/planning/scene.js` 124-171) keyed
  `${scope}|${bbox}`, `find` by containment, `load` joins an in-flight request with the same key,
  no per-area eviction; items keyed `envelope:<source>:<cadastralId>`; `drawMap` redraws only
  items whose object changed; `notifyGeometry()` → `planninggeometrychange` → 3D rebuild.
  `PlanningScene.parcelItemOf` already matches on `source.parcel`; `plannedMetrics`
  (`three-mode.js`) returns null for `#` ids only because no item carries one. `showParcelEvidence`
  skips `#` ids on purpose (saved results are cadastral) and keeps doing so.
  `PlanningFeed.loadViewport` (`frontend/js/planning/feed.js`) is GET-only with cursor paging.
- **Server** `GET /planning/envelopes` (`backend/routes/planning.js`): `validateBounds(bbox, 0.5)`,
  every 400 is reported as `envelope-area-too-large` (the client shows "zoom in"), 10-minute
  promise cache keyed `[city, source, scenario, bbox]`. `loadParcelEnvelopes` reads lots by
  `queryBounds(expand(bbox, 45 m))`; the 45 m margin supplies obstacles for `streetWidthAcross`
  (`backend/planning/street-width.js`); `parcelOverlapProblems` makes overlapping lots unavailable;
  providers refine per lot through `parcelRecords(parcel, records, context)`; only descriptors with
  `parcelStudy: 'direct-dimensions.v1'` (Bogotá, the 17 Atlas sources) enter; `views.js` only
  requests envelopes for such sources.
- **Study rule**: `backend/planning/parcel-study.js` never accepts client geometry, because a study's
  `parcelReference.revision` hashes the provider's exact record. Plan plots get their own
  provenance (§1); the rule stays.
- **Readjustment records** store no public-land number. A public strip is a plot whose owner is the
  generic "Public land" label (`frontend/js/proposals/subdivision.js`,
  `reparcellization-ui-state.js`); `publicLandM2` exists only in Plan Stats, from `splitLand()` in
  `frontend/js/proposals/present-state.js` (corridors, `PUBLIC_STRUCTURES` pieces, road parcels,
  OSM parks). Block membership is a live flood fill, `detectBlockParcelIdsForParcel` in
  `frontend/js/parcel-blocks.js`, which needs the whole block loaded in Leaflet.
- **Zagreb GUP** (`backend/planning/providers/zagreb-gup.js`) reads `public.parcel_build_envelope`
  by parcel id. The solver behind it takes geometry: `solveMaxBuilding(parcelGeomText, variables,
  context)` (`cadastre-data/api/src/domains/parcels/solver.js`) and `resolveRuleContextForGeometry`
  (`cadastre-data/lib/zagreb-rule-context.mjs`); no route exposes them for one arbitrary geometry.
  `docs/gup-scenario-integration.md` keeps the citywide evaluation on existing cadastral parcels; a
  plan plot is the user's own what-if, outside that decision, and must say so.
- **NYC pilot** (`backend/zoning/`): `computeEnvelope(pluto, review)` screens one PLUTO row
  (`screenPluto`: R6A, interior lot type 5, regular, front 18–40 ft, depth 95–110 ft) and models a
  reviewed rectangle. A merged plot has no BBL and no row.
- **MCP**: `ugt_draft_building {permitted}` and `ugt_modify_design fit_to_permitted`
  (`backend/agents/mcp-companion.mjs`, `mcp-drafts.js`, named plans in `mcp-named-plans.js` via
  `deriveWithApp`, which returns a headless fabric) read `/planning/envelopes` over the site's bbox
  and match `item.source.parcel`. None reaches a `#` piece. Parity rules:
  `docs/development.md#mcp-parity-check`.
- **Client-polygon endpoints** exist with `validateGeometry` and `validateBounds` from
  `backend/parcels/source-contract.js`; body limit 15 MB.

## Design

### 1. Plots as parcels: one pipeline, two parcel origins

New shared UMD module `frontend/js/planning/plan-plots.js` (browser and server, like
`parcel-assessment.js`), holding `PLAN_PLOT_REACH_M = 45` and the pure helpers below.

**Request.** `POST /planning/envelopes` with `{ city, source, scenario?, bbox, plots }`; GET stays
and equals `plots: []`. A plot is `{ id, kind: 'plot'|'remainder'|'formed'|'part'|'road'|'track',
geometry (Polygon), label?, cadastreParcelIds[], producedByProposalId?, cessionM2? }`.
`validatePlanPlots` (new `backend/planning/plan-plots.js`): ids `^[A-Za-z0-9][A-Za-z0-9_./~:#-]{0,249}$`
and unique; `validateGeometry` and Polygon; each bbox intersects `expand(bbox, 46 m)`; at most
2,000 pieces and 200,000 vertices; `cessionM2` finite 0–1e7; label ≤ 120 chars. Failure is 422
`invalid-plan-plots`, and the route passes `error.code` through instead of mapping every 4xx to
`envelope-area-too-large`. `PlanningFeed.loadViewport(url, { …, body })` POSTs when a body is given.

**Replacement** in `loadParcelEnvelopes`: the union of all `cadastreParcelIds` names the source lots
that leave both the in-view set and the obstacle set; non-corridor plots join both as
`{ id, geometry, properties: { parcelNumber: label, planPlot: true } }`. Road and track pieces are
public space: neither parcels nor obstacles, and their outer rings join the frontage street index
as `highway: 'plan-road'` so a remainder can front the new road. Guards: a plot overlapping a lot
it does not replace trips `parcelOverlapProblems` (both unavailable, never two bounds on one
ground); a plot id equal to an unreplaced lot is 422; the 1,000-lot cap applies to the final set.
`cadastreParcelIds` must be the provider's ids (true for Bogotá's `CO-BOGOTA-…`); the summary
reports `planPlots: { received, replacedLots, unmatchedCadastreIds }`.

**Identity.** Item `envelope:<source>:<plotId>`, `source.parcel = plotId`,
`sourceEvidence.parcelReference = { sourceId: 'plan', parcelId, revision: sourceRevision({ id,
geometry }), kind, cadastreParcelIds, producedByProposalId }`; `derivation.parcel` is the plot.

**Server cache key** `[city, source, scenario, bbox, digest]`, digest = SHA-256 of the validated
plots' JSON or null; content-hashed, so a reused piece id never collides; in-flight dedupe as now.

### 2. Dirty parcels: fabric revision drives the layer

`plan-plots.js` helpers: `isPlanPiece(piece)` (identity kind `plotPiece`, `remainder`, `formed`, or
a corridor; seeds and `#cadastre-n` parts are not plan pieces); `forBox(fabric, box)` = the plan
pieces in `expand(box, 45 m)` from `peekBounds(…, { includeCorridors: true })` plus every other
live piece standing on the same cadastral ids (`entriesForCadastre`), so a replaced lot is always
replaced by its whole live cover, `#cadastre-n` parts included; `cessionM2(fabric, piece)` = on
the ground of `producedBy(producer)` (a road remainder: its own ids), the area of corridor pieces,
`PresentState.PUBLIC_STRUCTURES` pieces and plots whose holders are all public (`genericOwnerKind
=== 'public'` or the `public-land` key), the `splitLand()` rule, memoised per request. Agreement
allocations to a public holder are not counted in the first build; noted as an open point.

`views.js` `init()` subscribes `onFabricDelta` (must never throw; it runs inside `publish`): for
added/updated ids, `peek` and, if a plan piece, record `knownPlan: Map<id, {bbox, cadastreIds}>`
(`forBox` fills it too); removed ids resolve through `knownPlan`; seed and release deltas collect
nothing. After a 150 ms debounce:

1. `viewCache.evict(entry => envelope scope && dirty boxes intersect expand(entry.bbox, 45 m))`,
   new in `scene.js`; it deletes stored entries and aborts matching in-flight loads (flights gain
   `scope` and `bbox`), so a refresh never joins a request that carried the old plots. 45 m covers
   the 40 m street-width rays and the 35 m frontage reach: an entry is evicted exactly when its
   request would now send different pieces.
2. If the entry on screen was evicted, drop items whose `source.parcel` is a changed piece or one
   of its cadastral ids, then `drawMap()` and `notifyGeometry()`, so no stale bound sits over a new
   piece.
3. `refresh()`; `fetchArea('envelopes', box)` builds `forBox` and POSTs when non-empty.

Unapplying a proposal is a removed-only delta on the same path; the lots return because nothing
replaces them. `plannedMetrics` and `parcelItemOf` need no code; a regression test covers `#` ids.

### 3. Bogotá block assembly (arts. 303–304)

The server decides standing by geometry; the client sends only `cessionM2`. (A client block flag
from the flood fill would flip with what Leaflet has loaded, and MCP has no flood fill.)

`street-width.js` gains `edgeStanding(parcel, obstacles, streets, { minGapM: 2, spacingM: 2,
maxDistanceM: 40 })`: obstacles projected once per lot, rays every 2 m along each edge (≥ 3 per
edge); an edge is **open** when no ray hits a lot within 2 m **and** a frontage street lies within
reach of that edge (a missing cadastral lot is not a street); `widthM` per edge is the median hit.
`wholeBlock`: every edge of ≥ 1 m is open. `corner`: two open edges of ≥ 3 m whose outward
directions differ by 45–135°. It runs lazily as `context.standing()` in the `parcelRecords`
context, so only Renovación lots pay for it.

`bogota-pot-rules.js`: `BOGOTA_RULES.renovacion` gains `wholeBlockIndex: 7, cornerCessionIndex: 6,
cornerCessionMinM2: 400` with the citation; `assemblyIndex(standing)` → `{ index, basis }`;
`solveRenovacion` takes `standing` and uses `limitM2 = index × lotM2`; for a whole block
`dimensionalConstraints` sets rear and side yards to 0 (no 11.40 m side yard) and applies
`streetWallConstraint` per role (front, side, rear) with that role's widest D, so an edge with
nothing across within 40 m frees its role (an outer bound). `tieredBound` already stacks a different
start height per role. Evidence `resultante` gains `{ index, indexBasis, wholeBlock, corner,
cessionM2, openEdges, edgeWidthsM, assemblyRule }`; the `RENOVACION_RESULTANTE` text names the index.
Existing test fixtures with one lone Renovación lot would now read as a block; they get a neighbour.

### 4. Zagreb and NYC plot paths

Neither source runs the envelope pipeline, so plots reach them through a provider hook
`plotRecords(plots, query)` that `loadParcelEnvelopes`' caller (`routes/planning.js`) invokes for
descriptors without `parcelStudy`; the answer is a `planning-representations.v1` list of items with
volumes, the form those sources already draw, keyed `envelope:<source>:<plotId>` with the §1
provenance. `views.js` requests this for any source once plots exist in the box.

**Zagreb.** New shared-API route in `cadastre-data`, `POST /envelope/solve-geometry` with
`{ gup_id, geometry }` (GeoJSON Polygon, EPSG:4326, `validateBounds` under 1 km², one geometry per
call, timeout), running `resolveRuleContextForGeometry` and `solveMaxBuilding` and returning the
volumes, rule id, variables and resolver evidence marked `hypothetical_plot: true`.
`zagreb-gup.plotRecords` calls it per plot and maps the answer to an item with
`sourceEvidence.plot = { solverVersion, gupId, ruleId, note: 'what-if on a plan plot; outside the
citywide evaluation of existing cadastral parcels' }`. Behind `ZAGREB_PLOT_SOLVER` (off by default
until the shared API is deployed with the route). The GUP doc gains the what-if note.

**NYC.** `nyc-pilot.plotRecords`: fetch the PLUTO rows of `cadastreParcelIds` (`fetchPluto` per
BBL); require one `zonedist1` (else unavailable `plot-spans-districts`); synthesize `{ zonedist1,
lotArea, lotFront, lotDepth, lotType, irregularLot, version: 'plan-plot:' + revision }` from the
plot polygon (front edge length from the frontage scorer, depth perpendicular to it, `lotType` 5
for one street edge or 3 for a corner, `irregularLot` from the pilot's rectangle test) and run
`computeEnvelope` with no review. The pilot's screening answers: a merged plot normally fails the
18–40 ft front band and reports `outside-scope` with its reasons, the truthful result for a pilot
that models one R6A lot type. Widening NYC beyond the pilot is rule research outside this plan.

Until built, plots on these sources are `unavailable` with reason `plot-without-lot-record`.

### 5. MCP parity

Named-plan `fit_to_permitted` (`mcp-named-plans.js` → `mcp-drafts.js`): derive the plan's ground
with `deriveWithApp` (headless fabric), pick the plan piece under the building, POST
`PlanPlots.forBox(fabric, box)` and match `item.source.parcel` to that piece id. Standalone
`ugt_draft_building {permitted}` keeps cadastral ids and the GET. Schemas, discovery and
`docs/mcp-editing.md` name the plots input; `ugt_parcel_context` stays cadastral.

### 6. Documents

`docs/permitted-plan-parcels.md` (this plan, living); `docs/bogota-pot-source.md` (block rule,
standing evidence); `docs/vocabulary.md` ("Plan plot" as a parcel origin; "Standing: whole block,
corner, cession"); `docs/source-adapters.md` (plots in `loadParcelEnvelopes`, `plotRecords`);
`docs/gup-scenario-integration.md` (what-if note); `docs/mcp-editing.md`.

## Milestones

Unit tests run from `backend/` with typed file paths, `--pool=threads --maxWorkers=2`.

1. **M1 Server.** Validation, replacement, corridor frontage, provenance, cache key, the 422 code.
   New `test/planning-plan-plots.test.js`: a plot replacing two lots gets one envelope and the lots
   none; the lot opposite's street width changes when a plot replaces the lots across; corridor
   pieces dropped but used for frontage; a `part` piece kept; the overlap guard; cache hit/miss;
   empty plots give the GET key. `test/planning-parcel-envelopes.test.js` confirms GET unchanged.
2. **M2 Client.** `plan-plots.js`, `evict`, POST in `feed.js`, the subscription. Tests:
   `test/viewport-refetch.test.js` (`evict` aborts the in-flight load, the next load starts fresh);
   new `test/planning-plan-plots-client.test.js` with a headless `createLiveParcelFabric()` (seed
   delta ignored, removed id resolves through `knownPlan`, cover includes parts, cession sums);
   `test/planning-scene-parcel-item.test.js` (`#` id). E2E `e2e/tests/planning-plan-plots.spec.ts`
   with the Bogotá four-lot demo layout and `**/planning/**` stubbed to echo the plots: on apply the
   POST carries the plot ids, items show them, the lot ids are gone; on unapply the lots return.
   Run from `e2e/`: `npx playwright test tests/planning-plan-plots.spec.ts --workers=2`.
3. **M3 Bogotá block rule.** `edgeStanding`, index function, per-role street wall, evidence.
   `test/planning-bogota-pot.test.js`: index table (whole block 7; corner with 401 m² → 6; corner
   with 400 m² → 5; non-corner with 1,000 m² → 5) and whole-block constraints;
   `test/planning-parcel-envelopes.test.js`: `edgeStanding` cases including a missing-lot gap that
   is not a street.
4. **M4 NYC plot path.** `plotRecords`, synthesized record, `plot-spans-districts`. Tests in the
   `test/zoning-envelope.test.js` style: a two-lot R6A merge screens `outside-scope` with the
   front-width reason; a mixed-district merge is `plot-spans-districts`.
5. **M5 Zagreb plot path.** Shared-API route in `cadastre-data` (its own tests and deploy, on
   request), provider `plotRecords`, switch, what-if note. Provider tests mock the route.
6. **M6 MCP parity and docs.** `test/mcp-plan-placement.test.js` extended; docs above.

## Verification

- Headless unit tests named per milestone; never the full suite without a yes.
- Browser (launched Chrome, Bogotá on the Caracas corridor), end state through
  `PlanningViews.getItems()`, never animation: apply the readjustment demo and see the plot ids
  appear, the lot ids disappear and `resultante.index` of 5, 6 or 7; apply a road through a block
  and see the remainders and the lots across recompute.
- Timing on a quiet machine, host load recorded: a dirty refresh of one block under the current
  cold view time.

## Risks and open points

1. **False whole blocks** where the cadastre lacks a lot: mitigated by the "open needs a street"
   test; the evidence lists open edges. A real single-lot block gets 7.0, which is the rule.
2. **Overlap threshold**: `parcelOverlapProblems` flags above 0.01 m²; design-tolerance slivers
   between a plot and an untouched neighbour could fire. Measure on the demo; if so, use
   `GeometryTolerances.isGround` for plot pairs.
3. **Shape limits**: the evaluator rejects rings over 500 vertices and holes; a merged block plot
   can exceed 500 vertices and reads `unsupported-parcel-shape`. No simplification, by rule.
4. **Performance**: the edge test is about 200 rays against about 1,000 segments for a 400 m block
   perimeter, only on Renovación lots; payloads about 6 MB at most; a plan-changing POST costs a
   cold GET; the debounce absorbs replay bursts. The 64-entry server cache is shared with GET.
5. **Lot cap**: road cuts add remainders, so a view near 1,000 lots can flip to "zoom in".
6. **Frontage bias**: a road piece's ring touches its remainders at 0 m and outscores a street
   10 m away on a corner lot; a centreline would be better but pieces carry none.
7. **Cession definition**: owner labels and `splitLand()` classes only; agreement allocations to
   public holders (`agreement-record.js`) are not counted yet. Confirm before M3.
8. **Fabric contract**: a plan piece must carry one of `producedByProposalId`,
   `formedByProposalIds`, `liveParcelDerivation`, `readjustmentPiece`; any new proposal kind must
   set one. `knownPlan` only covers pieces that were sent, which suffices since an unsent piece
   never fed a cached answer.
9. **Zagreb route** adds a synchronous solver call to the shared API; one geometry per call,
   under 1 km², timeout, switch.
