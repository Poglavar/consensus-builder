# Proposal → parcel dependency map (baseline for PARCEL-OPTIONAL.md)

Snapshot at 425828c7 (line numbers drift). Overall: every proposal already has authored geometry and a
site can be derived from it (`footprintParts`/`footprintOf`); parcels are not used to derive geometry for
most tools but a non-empty `cadastreParcelIds` is required at ~8 independent gates, and apply turns every
non-station formation into parcels cut from the live fabric, which needs cadastral host ground.

## 1. Record
- DB `backend/routes/proposals-ddl.sql`: `cadastre_parcel_ids JSONB NOT NULL` (42) + CHECK
  `proposal_cadastre_parcel_ids_nonempty` (84-89) + CHECK `proposal_cadastre_declaration_matches_record`
  (90-93) + GIN (106); `accepted_parcel_ids`, `owner_acceptances` (POST writes NULL; dropUnprovableClaims
  proposals.js 577-607); `ownership_flow` [{parcelId,cededM2,destination}]; `cadastre_frame` {capturedAt};
  geometry in `road_proposal`, `building_proposal`, `structure_proposal`, `reparcellization`; `bounds`.
- `backend/proposals/serializer.js` `assertCanonicalProposalRow` (66-109): 422 on empty/missing
  declaration, generated `#` ids, retired aliases, accepted/flow/acceptances outside declaration
  (frontend/js/proposals/authored-record.js:241-262). `buildParcelSet` (backend/proposals/parcel-set.js)
  hashes parcel ids; unused `geometryHash` slot.
- `backend/routes/proposals.js`: body schema 371-384; `precheckProposalCreate` 464-525 (empty declaration
  → 400 at 492-495); strict check `refuseUndeclaredParcels` 538-553 → `checkDeclaredParcels`
  (backend/proposals/footprint.js:86-104, PostGIS `PARCEL_OVERLAP_SQL` 46-66: every current parcel covered
  ≥1 m² must be declared; skipped without geometry); paid route runs it before x402
  (backend/routes/agent-proposals.js:433-434).
- `backend/routes/agent-recipe-schema.json`: `cadastreParcelIds` required minItems 1; MCP zod `.min(1)`
  (backend/agents/mcp-server.mjs:106,134).
- Legacy migration `backend/scripts/migrate-legacy-parcel-declarations.mjs`: rule
  geometry-supported-declaration = every current parcel covered ≥1 m² — effectively a server-side
  site→binding adapter already.
- Frontend: `createProposal` frontend/js/proposals/create.js:786-824 (declaration, bounds from parcels
  709, per-tool fields); drafts `fields.selectedParcelIds` (live piece ids) with validator
  `missing-parcels` (frontend/js/proposal-drafts.js:731-733), `buildProposalFromDraft` projects live ids →
  cadastre via `LiveParcelFabric.cadastreIdsForParcelIds` (763-777); adapters `commonValidation`
  (frontend/js/proposal-editor-adapters.js:144-146), `applyFieldsToProposal` 384-398,
  `cadastreIdsForLiveSelection` 512-519; `conformanceOf` (frontend/js/proposals/formation-depth.js:34-68)
  `missing-cadastral-provenance` enforced in `finalizeAuthoredProposal`, `buildProposalFromDraft`, publish
  gate (create.js:2163-2170). Pieces carry `properties.cadastreParcelIds`, synthetic ids `root#token-n`
  (proposal-parcel-identity.js, proposal-manager.js:417-505), arrangement piece id = cadastral id +
  geometry hash (proposals/parcel-arrangement.js).

## 2. Geometry
- `footprintParts` (frontend/js/proposals/footprint-parts.js:66-108, browser+server): reparcellization
  polygons, road polygon/buffered centreline, structure geometry, geometry, buildingGeometry,
  geometry.buildings[]. `plan-order.footprintOf` unions them. Goals parcel/offer/ownership-transfer/vote
  have no geometry (site = parcels).
- Derived from parcels at creation: park/square/lake `buildGeometryFromParcels`
  (proposals/geometry.js:657+); block superparcel `robustUnion` (building-blocks.js:2829-2848); row = house
  per parcel (row-house.js); detached = envelope per parcel (parcel-based.js); freeform must stay inside
  block parcels (single-building.js:386-420, 2027); road/track authored, parcels collected
  (road-drawing.js findAffectedParcels); station footprint from centre+bearing, parcels derived from it;
  reparcellization slices selected parcels. `computeProposalArea` prefers parcel areas
  (geometry.js:1123), `calculateProposalBounds` uses parcels (1055).

## 3. Creation gates
- Palette only with a parcel context (frontend/js/ui/parcel-menu-model.js:18-30;
  parcels/ui/proposal-actions.js:299-318). `startParcelBuildTool` 203-234 ("Select a parcel first", row ≥2,
  offer). `startParcelTransportTool` 134-146 needs no selection but lives in the palette.
- `startInstantProposalDesign` (proposal-editor-shell.js:1049-1079) false on empty ids;
  `instantCreateStructureFromSelection` 1107-1176 (prepare selection, contiguous, buildGeometryFromParcels,
  one-area); `instantCreateProposalFromDraft` ~1470-1610.
- Station `commitPlacement` (transit-stations.js:1144-1209) + `resolveStationCadastreScope` 659-684 refuses
  incomplete cadastral coverage via `_flatGroundCoverageIsComplete` (proposal-manager.js:535-542).
- Road `finishRoadDrawing` "No parcels affected" (road-drawing.js:4701-4705); edit/clone re-derives
  declaration (679-691); create extends with `declarationCoveringFootprint` (create.js:948-953).
- Structures apply "must take whole parcels" (proposals/apply/structures.js:362-376); buildings
  `takeWholeParcels` (apply/buildings.js:269-279); reparcellization coverage-gap/excess/pool checks
  (proposal-editor-adapters.js:331-344, create.js:1113-1124).
- Create dialog (proposals/dialog-create.js) refuses without selection (~650, noParcelsMessage 483);
  `createProposal` "No parcels selected" (create.js:573-576); owner-offer gate
  `checkOwnerOfferEligibility` 68-114.

## 4. Apply
- `_resolveLiveFormationParents` (proposal-manager.js:3305-3423): `formation-cadastre-unresolved` on empty
  declaration, ≥95% footprint coverage by `fabric.entriesForCadastre`, live-parcel overlap check; used by
  buildings, structures (not station), reparcellization, decide-later. Formations mint parcels stamped with
  cadastre ids (apply/buildings.js 316-396 incl. "No parcels found under the building footprint" 360-375;
  apply/structures.js 437/447; apply/parcels.js 191-207).
- Scope: `_resolveAndStampFlatCadastreAnchors` 1179-1215, `_flatScopeSeeds` 1217-1235,
  `rematerializeFlatScope` "cadastral ground is incomplete" 1358-1381, empty scope → silent ok/applied:0
  (1392-1394). `_localFormationClosure` 1253-1309 finds interactions ONLY via shared cadastral anchors.
- Corridors: `_corridorScopeSeeds` tolerates cadastral gaps (1312-1331); `_deriveCorridorFabricBody`
  `corridor-cadastre-scope-missing` (1915-1935); arrangement per cadastral parcel
  (proposals/parcel-arrangement.js).
- Repository `CadastralParcelRepository` (parcels/ground-service.js): ensureIds 289, ensureFootprint 466,
  getMany 789, peekMany 797, coverageOf 809; absent vs unavailable distinguished (274-278).
- `deriveForNewProposal` (proposal-manager.js:2149-2215).

## 5. Stats
planYield/measureProposal geometry only (plan-yield.js:283); resultingParcels parcel (404, 382-394);
plan-stats.js:54-93 parcel; grain-score.js:508-542 fully parcel; gain.js:66-111 per-parcel but any polygon
works; building-density-stats.js:72-111 one polygon; financials.js parcel; execution.js:94-96 payout share
by parcel area; ownership-flow.js:50-60 & effectHash 115-145 per parcel; ownership mix parcel.

## 6. Chain
- proposal_nft (blockchain/solana/programs/proposal_nft/src/lib.rs): `mint_and_fund(parcel_ids)` NoParcels
  (49); `accept_with_attestations` (122-191: parcel ∈ list, parcel_nft anchor PDA, attestation parcel_uid,
  consent tally ["consent",proposal,parcel_id], record ["acceptance",proposal,parcel_id,owner],
  MAX_PARCEL_ID_LEN 32, Executed when acceptance_count == parcel_ids.len()); `settle_with_verdict` executed
  needs `verdict_may_execute || acceptance_count == parcel_ids.len()` (221-224) — with an empty list
  0 == 0 lets ANY executed verdict execute; `distribute_funds` per accepted parcel, refund owner if none
  (279-288); account fixed 4096 bytes; fields parcel_ids (553), accepted_parcels.
- proposal_market/src/lib.rs:345-386 and proposal_pledge/src/lib.rs:243-251 mirror the layout; external
  market subject sha256(parcelUid). Decoders: backend/oracle/proposal-lifecycle.js:49-82,
  frontend/js/solana/chain-data-loader.js:153-189, frontend/js/solana/acceptance-client.js:391-407,518.
- Client pre-rejects empty lists: solana/proposal-bridge.js:150-152, acceptance-client.js:141,
  blockchain-proposals.js:364-365, backend/agents/minter.js:97-98, ugt-agent-tools.js:209,243-244.
- Mint path create.js: parcel NFT/anchor pre-check 650-704 (proposals/chain.js:587-892),
  `shouldMintOnchain` needs parcels (613), screenshot/metadata from parcel polygons, mint silently skipped
  with no parcel features (1340-1420), metadata 1680-1696; publish `buildUploadReadyProposal` 2071-2101 →
  `publishDeclaration`/`validateCadastreParcelIds` (proposals/cadastre-ancestry.js:121-185,
  `cadastre-declaration-missing` 152-156) → ownershipFlow/effectHash; server-sync.js:471-540.
- Oracle: proposal-consent.js:74-145,227-249 by parcelUid; proposal-lifecycle.js:212-234; parcel-history.js.
- Local simulation executes only with parcels (execution.js:1290).

## 7. Server
`GET /proposals/counts?parcel_ids=` (proposals.js:1065-1100); list summary parcelSet (1124-1172);
`GET /proposals?parcel_id=` (1359-1415); `/parcels/:uid/history`. Agents: record-builder.js:68,
planner.js:68-156, parcel-source.js, canonical-case.js (2-8 parcels, anchor/attest/accept per parcel),
ugt-agent-tools mint/submit/accept, agent-proposals.js:54. Thumbnails geometry-first with parcel-union
fallback (backend/thumbnails/proposal-thumbnail.js:85-195).

## 8. Explore
city-config.js:507-551 explore: parcels.source 'none', disabledSections incl. stations, proposals, game;
`hasParcelData()` false stops fetches; no explicit "can propose" flag — blocked indirectly (no parcel
context → no palette; hidden sections). Test frontend-world-entry.test.js:218.

## 9. Tests encoding the requirement
proposal-schema-contract (36), proposal-serializer (72,89), proposal-undeclared-parcels (29-221),
cadastre-ancestry-resolve (93-158), formation-depth (32-103), proposal-manager-ids (209),
transit-stations (780-837), structure-formation (30-40), proposal-editor-adapters (55,451,536),
proposal-drafts, migrate-legacy-parcel-declarations, agents-minter (121), canonical-case, agent-proposals,
live-parcel-fabric, parcel-arrangement, parcel-mutation, authoritative-parcel-architecture,
frontend-world-entry (218), blockchain/solana/tests/proposal_nft.ts:194 (NoParcels), parcel_nft.ts:69.

## Existing partial support
Site derivable from geometry; site→binding adapters exist (PARCEL_OVERLAP_SQL/parcelOverlaps,
declarationCoveringFootprint/undeclaredParcelsUnder, migration rule); station is geometry-first; corridors
accept gaps; geometry-hash identities (proposalContentFingerprint c2-, arrangement piece ids, unused
parcelSet.geometryHash); rootless synthetic ids; ProposalOwnParcel works from produced features;
verdict_may_execute; unsurveyed-ground.md; gain & density accept any polygon. Caveat: `_buildHashSeed`
(proposals/data.js:1488-1530) hashes parents + building params, not building geometry — without parcels two
same-param building proposals collide (time suffix saves them at 1189-1191).

## Hardest coupling points (ranked)
1. On-chain consent model + 0==0 verdict loophole; layout mirrored in market/pledge/decoders.
2. Formation apply (`_resolveLiveFormationParents` 95% coverage; formations mint cadastre-anchored parcels).
3. Scope/conflict closure only via shared cadastral anchors.
4. Corridor arrangement per cadastral parcel; "No parcels affected".
5. Durable record contract enforced in ~8 places (DB CHECKs, serializer, precheck, conformance, schemas).
6. Rule generators needing plots (row, detached, block, freeform).
7. Reparcellization over owners' parcels.
8. Selection-driven UI (palette, startParcelBuildTool, drafts, dialog, buildGeometryFromParcels, bounds).
9. Publish gate and effect stamps (validateCadastreParcelIds, ownershipFlow/effectHash, NFT pre-check).
10. Parcel-keyed downstream (owner offer, local execution, payouts, oracle events, history, counts, grain
    score, agents).
