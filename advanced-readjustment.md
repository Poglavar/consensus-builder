# Perimeter-Block Reparcellization Pipeline

## Context

Goal: enable the classic European perimeter block through reparcellization — buildings on the perimeter, each on its own parcel, with one shared **joint courtyard** parcel inside. Two user-requested capabilities drive this: (a) **form-first** derivation ("draw the block first, derive the parcel plan from it"), and (b) **gradual adoption** ("owners join individually: accept to cede your courtyard sliver, get your building permission — no unanimity needed"). Scope approved: full pipeline, joint **pro-rata** custody of the courtyard.

Exploration confirmed the machinery mostly exists: the reparcel editor already supports multi-owner slices (`slice.owners[]` with shares, checkbox popup), a carve primitive (`carvePlotIntoPlan`), plan round-tripping (`hydrateSlicesFromPolygons`), and the blockify `buildingFeature` stores the courtyard as the polygon's **interior ring** (building-blocks.js:2634-2641, verified). The two real gaps: shares are forced equal in the UI, and **execution collapses multi-owner slices to one owner** (proposal-manager.js:3424-3431 builds a single-element `ownershipDetails.owners`; :3456-3469 transfers to one agent).

## Architecture decisions

- **Joint ownership at execution (two layers):** `feature.properties.ownershipDetails.owners` gets the FULL `slice.owners[]` (display/acceptance truth — `_extractOwnersFromProperties` already prefers it); the canonical single-agent registry (`parcel_<id>_owner`) gets a new **joint-pool agent** (`getOrCreateJointPoolAgent(label, members)` in agents.js, pattern of `getOrCreateAgentForRecipient` :388) so the single-owner invariant holds everywhere else. Multi-owner shares not summing to 1 (±1e-6) fail the apply loudly.
- **Pro-rata shares:** ∝ each recipient's assigned VALUE over **non-joint** slices (excluding joint slices breaks circularity); zero weights → equal. Joint slices flagged `jointPool: true` (persisted per polygon, survives `hydrateSlicesFromPolygons`). Re-synced in `updateCommitState()` (runs after every edit).
- **Emission of gradual deals:** one **mini reparcellization proposal per parcel** (remainder → original owners; sliver → joint pool) — reparcellization is the only single-shot split+transfer primitive. Template: `createRoadProposalFromComponent` (road-drawing.js:650-685): `addProposal` → `_linkProposalToAncestors` → `applyProposal(id, {applyAnyway:true, suppressMissingParentAlerts:true})`. The building right is already granted by the applied Block proposal (per-parcel acceptance exists on it).
- **Testability:** all new pure helpers go into NEW `frontend/js/reparcellization-plan-utils.js` (IIFE + `module.exports` guard, turf injected as `turfApi` param — pattern corridor-tunnel.js), added to index.html's script list just before `js/reparcellization.js`. Tests in `backend/test/reparcellization-plan-utils.test.js` (createRequire + fake planar turf, pattern corridor-tunnel.test.js). Tests **written, not run** (project rule).

## Phase 1 — Joint pro-rata assignment + execution honoring `owners[]` (shippable alone)

Files: `reparcellization-plan-utils.js` (NEW), `reparcellization.js`, `proposal-manager.js`, `agents.js`, `index.html`, i18n ×4, `css/modals.css`, test file (NEW).

- utils `computeJointProRataShares(entries)`: `[{ownerKey, weight}]` → shares summing to exactly 1 (last-entry remainder correction); zero weights → equal.
- reparcellization.js: `getJointRecipients()` (ownerShares minus PUBLIC_LAND); `computeProRataJointOwners()` (weights = assigned value over `!jointPool` slices, loop shape of `computeOwnerLedger` :548); `assignJointToSlice(i)` (sets owners + `jointPool:true` + joint displayName, then `syncSlicePrimaryOwner`); `resyncJointSliceShares()` called at top of `updateCommitState()` (:630). Popup `onSliceClick` (:1521): "Joint — all recipients" button above the checkboxes; `toggleOwnerOnSlice` (:1620) clears `jointPool` on manual change. `persistResult` (:2134-2145) adds `jointPool` per polygon; `hydrateSlicesFromPolygons` (:981) restores it.
- agents.js: `getOrCreateJointPoolAgent(label, members)` — lightweight agent `{jointPool:true, members:[{name, agentId|null, share}]}`.
- proposal-manager.js `_applyReparcellizationProposal` (:3345): when `slice.owners[]` present, write the full array into `ownershipDetails.owners` (share → percentageShare); validate share sum (loud fail). Multi-owner: resolve each member's agent, transfer child to the joint-pool agent. Single-owner and legacy (no `owners[]`) paths unchanged.

Tests: pro-rata shares (2:1 → 2/3,1/3; zero → equal; exact sum 1 with uneven triple; single → [1]).

## Phase 2 — "Keep parcels (amend)" start mode

Files: `reparcellization.js`, i18n ×4.

- `getAlgorithmOptions()` (:150): add key `'amend'` ("Keep parcels (amend)").
- `buildOwnerShares` (:2234): populate `state.parcelOwnerIndex` (Map parcelId → owner slot list) as a byproduct of the existing per-parcel loop.
- `buildAmendSlices()`: one slice per `state.selection.layers` entry — geometry deep-copied from the layer's feature, owners from `parcelOwnerIndex` via `makePlotFromOwners(..., 'amend')`; missing index entry → loud status, seed unassigned.
- `refreshPreview()` (:2739): `else if (algorithm === 'amend')` branch before manual; hint status. `updateDrawToolButtons` (:1159): enable for `manual || amend`. Algorithm-change handler (:432-454): don't cancel draw when switching between manual/amend; no auto-arm for amend; no sweep handle.
- `totalArea` stays the super-parcel union — the adapter's 0.5% coverage tolerance absorbs union smoothing (comment it). Overlapping input parcels → adapter's pairwise overlap check flags it (correct loud behavior).

## Phase 3 — "From built form" courtyard carve (v1: carve-only)

Files: `reparcellization-plan-utils.js`, `reparcellization.js`, `proposals/data.js`, i18n ×4, `css/modals.css`.

- utils `deriveCourtyardFromFootprint(footprintFeature)` — **pure coordinate work, no turf**: collect every interior ring of the (Multi)Polygon (blockify emits the courtyard as the hole; gaps>0 destroy the hole; wings are unioned onto the ring so holes stay true); reverse orientation → courtyard Polygon/MultiPolygon; no holes → `null`.
- proposals/data.js `buildingProposalsCoveringFeature(poolFeature)` — mirror `roadProposalsCoveringFeature` (corridor-structures.js:143-162): applied/executed `buildingProposal`, footprint from `bp.buildingFeature || geometry.buildings[0] || bp.buildings[0]`, intersect area > 2 m²; returns `[{proposalId, proposal, footprint}]`.
- reparcellization.js: "Derive courtyard from built form" button in `reparcel-edit-tools` (amend mode only); `openBuiltFormPicker()` (0 candidates → loud status; 1 → derive; many → chooser popup reusing `reparcel-owner-popup` classes); `applyCourtyardFromProposal(entry)` → derive → null = loud "block has gaps / no courtyard" status → else `carvePlotIntoPlan(courtyard, computeProRataJointOwners(), 'form', {jointPool:true})`. Extend `carvePlotIntoPlan` (:1003) + `pushSliceParts` (:942) with an optional flags arg so new parts carry `jointPool` while remainders keep their flags.
- Footprint clipping to the pool is inherent to the carve (block may cover more parcels than selected — correct, comment it).

Tests: courtyard from square-with-hole Polygon; from MultiPolygon with one holed part; null for hole-less.

## Phase 4 — "Owners join individually" emission

Files: `reparcellization-plan-utils.js`, `reparcellization.js`, i18n ×4, `css/modals.css`.

- utils `splitPlanPerParcel({parcelFeatures, jointPolygons, parcelOwnerIndex, jointOwners}, turfApi)`: jointUnion = union(jointPolygons) (loud throw on failure); per parcel: sliver = intersect(parcel, jointUnion); area < 1 m² → `{parcelId, skipped:true}`; remainder = difference(parcel, jointUnion) (null remainder = parcel fully consumed → error in v1); returns per-parcel mini plans `[{parcelId, polygons:[remainder(owners=parcel's), sliver(owners=jointOwners, jointPool:true)], totalArea}]`.
- reparcellization.js: emission radio row next to Done ("One agreement" default / "Owners join individually"), amend mode only, `state.emissionMode`. Individual commit: require ≥1 jointPool slice (loud status), call `emitPerParcelReparcellizationProposals()` — per non-skipped parcel build a proposal `{goal:'reparcellization', primaryType:'Reparcellization', title: '<plan> — parcel <BROJ_CESTICE>', parentParcelIds:[pid], reparcellization: miniPlan}` → addProposal → `_linkProposalToAncestors` → `applyProposal({applyAnyway:true, suppressMissingParentAlerts:true})`; collect and report failures loudly (partial success is the feature); success toast with created/skipped counts. Skip `persistResult`/draft sync; clear `window.pendingReparcellizationPlan`; check for a shell draft-discard helper during implementation so no phantom draft survives.

Tests: two unit-square parcels + courtyard rectangle overlapping one — skip logic, remainder/sliver owners, jointPool flag (fake planar turf).

## Phase 5 — Party-wall re-cut (v2, later/optional)

utils `partitionPerimeterBand({poolFeature, courtyardFeature, buildings}, turfApi)`: band = pool − courtyard; order buildings around the courtyard centroid; cut line per gap between adjacent buildings (gap midpoint on outer boundary → nearest courtyard boundary point); split band (reuse noding approach of `splitPolygonByLineExact` :1029); assign each face to the building overlapping it most; pre-assign owners by original-parcel overlap. Second option in the built-form picker ("re-cut to party walls"). Emission works unchanged.

## Cross-cutting

- i18n keys under `reparcellization.modal` in **all four** locales: `algorithms.amend`, `jointOwnership`, `jointAssignButton`, `deriveFromBuiltForm`, `choosePlanTitle`, `status.amendHint`, `status.noBlockProposals`, `status.blockHasNoCourtyard`, `status.courtyardCarved`, `emissionModeTitle`, `emissionSingle`, `emissionIndividual`, `status.jointRequiredForIndividual`, `perParcelProposalName`, `emittedProposals`.
- CSS in `css/modals.css`: `.reparcel-owner-popup__joint`, form-derive button, `.reparcel-emission-toggle`, joint-plot legend badge.
- MEMORY.md entry per phase; `node --check` + JSON validation sweep after each phase.

## Verification (manual, per project rule — no automated runs)

1. **P1:** 3 parcels, manual mode, carve a plot → "Joint — all recipients" → pro-rata split in Owners table shifts when other assignments change → commit, apply → courtyard child lists ALL owners with percentages; joint-pool agent owns it canonically.
2. **P2:** 4 contiguous parcels → amend mode → original shapes pre-assigned, balances ≈ 0, Done enabled immediately; carve tools work; draft round-trip preserves shapes.
3. **P3:** apply a gap-less Block over the parcels → amend → "Derive courtyard from built form" → hole appears as dashed joint plot, parcels keep shapes minus courtyard; gapped block → loud error, nothing carved.
4. **P4:** after P3, "Owners join individually" → Done → N per-parcel proposals, each applied independently; execute one → only that sliver transfers; unapply one → that parcel's shape returns.
