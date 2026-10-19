<!-- Code-grounded vocabulary and semantic audit. Keep observed behavior separate from proposed terminology and RDF mappings. -->

# Vocabulary

This is the maintained vocabulary for Consensus Builder: what its records mean, what they identify, and how they relate. It begins with **the definitions implemented by the code**, including inconvenient overlaps. The audit register records questions to resolve; it does not silently redefine the product.

**Baseline:** 2026-10-19, branch `colosseum-worlds-fair`, HEAD `83b1c31fc2facf53430e2959e2fa08347e356c4c`, plus the working-tree edits already present during the audit. Those edits included parcel, geometry, building, readjustment and rendering modules. This is a source audit, not a census of stored rows or verification of a deployed release. References identify files and symbols so they remain useful when line numbers move. The adjacent `cadastre-data` solver was inspected for comparison at HEAD `08b1e96`; it is a separate implementation.

**Status convention:** “Observed” describes code. “Proposed” describes a possible vocabulary or interoperability change. Findings remain open unless their entry records a resolution. The local term identifiers in backticks below are documentation identifiers, not a deployed RDF namespace.

**Change policy:** This is experimental software without customer compatibility obligations. Improve the model in small, verified changes, using one current contract. Existing data can be discarded and recreated; do not add migrations or parallel legacy/current flows solely to preserve it. Record changed meanings and commitment coverage here. Historical commitments are not rewritten or reinterpreted as proof under a new contract.

## Semantic coherence roadmap

Status tracks repository implementation and verification, not deployment. Each item is delivered in
small changes; the detailed findings below remain the record of unresolved issues.

| Work | Status | Result / next bounded step |
| --- | --- | --- |
| Code-grounded definitions, relationships and standards research | **Done** | Baseline vocabulary, 18 audit findings, Schema.org and construction/geospatial vocabulary mappings recorded. External mappings are proposals, not implemented exports. |
| Plan commitment coverage — V04 | **Done** | Every member hash covers authored site and decision kind, including readjustment proposals. |
| Identifier namespaces — V01 | **Partly done** | Row/authored lookup namespaces, creation inputs, HEAD headers and named-plan API fields clarified. General proposal API/browser field names and globally qualified export identifiers remain. |
| Published design and named-plan immutability — V03 | **Done in code; locally verified** | Database guards protect published content and named-plan identity. Incomplete commitments are rejected; minting also checks current members and the aggregate hash. Activation requires the backend DDL deployment. |
| Qualified spatial and planning terms — V02, V05, V10, V11, V13 | **In progress** | V02 labels distinguish local composition from named membership. V05 selection labels distinguish source parcels, source parts, formed ground, readjustment plot pieces and remainders; plot pieces reference their authored content, and custom register references are source-qualified. Remaining: consistent provider/jurisdiction/version qualification and other parcel-labelled surfaces; internal names and statutory plans/drawings; proposal site/project site; permitted envelope/illustrative massing/observed building. |
| Parties, rights and approvals — V06, V07, V15 | **In progress** | V15 site/subdivision labels state unknown ownership and explain omitted draft accounting; the open-ground accounting marker is documented without a title assertion. V07 removes parcel-to-owner acceptance inference, requires current term commitments for local tallies, and keeps seller-offer creation free of presumed owner consent. Unsigned local tallies are excluded from API/portable records and remote imports. Still queued: right holder/signer/allocation-party namespaces, remaining approval presentations, and other ownership-labelled surfaces. |
| Lifecycle and realization — V08 | **In progress** | Seller-offer funding has a separate display modifier; terminal/deadline states take priority. Purchase simulation records a browser-local result, preserves shared terms/lifecycle and is excluded from portable records. Local acceptance and signed decisions now record consent only; withdrawal preserves execution and map state. EVM acceptance refreshes lifecycle from the receipt block; new verified mirrors retain the observed EVM/Solana status and its observation time. Unverified execution timestamps are excluded from portable/API records. API and browser reads preserve missing/unrecognized lifecycle as Unknown and expire only Active records; unknown status blocks new consent. The lifecycle oracle now reconciles only qualified verified Solana devnet mirrors. Market lookup uses the exact devnet program and canonical account field; RPC readers check network, account program/type, market subject and stake mint. Market actions require observed chain state, and presentation describes chain settlement separately from physical construction. Remaining: qualify execution evidence across other records and surfaces, separately from physical realization. |
| Classifications and quantities — V09, V12, V16 | **In progress** | V12 keeps the planner’s floor area, modeled gain and offer tied to the published geometry; samples above a stated coverage/GFA ceiling are rejected. V16 removes the seller dialog’s boolean-to-money shortfall and no-op Fund action. Structure archives now cover park, square, lake and station, preserving structure category separately from decision kind and excluding local state. Market percentages are labeled as pool shares, with devnet USDC as their basis. Still queued: a consistent design-category scheme across the other records; name the other units and bases of shares and values. |
| Named-plan scoring scope — V19 | **Resolved for current-session scoring** | Exact verified members must be the whole applied composition. Other applied proposals prevent a named score. Counts and dimensions use one captured fabric revision; changes detected before Start or Repeat require reopening the score. An isolated evaluator and historical reproducibility are not implemented. |
| Record authority, relationships and documentation — V14, V17, V18 | **Done for the audited boundaries** | The published-record authority table covers column/JSON precedence and mirror overrides; the API emits one SQL-owned chain attachment, with null clearing stale JSON claims. V18’s cited documentation matches the code. Market help distinguishes parcel-reference grouping from mutually exclusive or geometric alternatives. |
| Machine-readable publication | **Queued after definitions stabilize** | Choose stable IRIs and publish a small JSON-LD projection; reuse Schema.org, GeoSPARQL, PROV and relevant building terms where meanings match; validate against concrete consumer questions. No triple store is required. |

## Central terms as implemented

### Proposal — `Proposal`

A portable authored record expressing a proposed change, rule, or transaction concerning land. It combines design intent, applicable geometry, cadastral references, optional deal terms, and optional approval configuration. A proposal can describe several buildings or corridor segments; it is not necessarily one physical object. It can also change ownership or rules without supplying a new building.

The durable record is the cleaned object handled by `ProposalAuthoredRecord` and the API serializer. A browser materialization adds local state and generated land pieces; those are not part of the portable instruction. A material proposal may have **zero cadastral anchors** when it has its own site. Parcel acts require cadastral land. At publication the declared cadastral IDs must match the server's site binding, subject to the parcel-act path.

Identity has several layers: `proposal.id` is a database row key; API `proposalId` / SQL `proposal_id` is the authored/external identifier; `serverProposalId` is used by browser records to refer to the published row; a chain reference also needs chain type, network, contract/program and token/account. These must not be exported as interchangeable identifiers. [Authored boundary](frontend/js/proposals/authored-record.js), [serializer](backend/proposals/serializer.js), [DDL](backend/routes/proposals-ddl.sql), [API validation and lookup](backend/routes/proposals.js), [chain references](frontend/js/proposals/chain-ref.js).

The browser's `proposalId` is a stable local record key, which is not always the published authored ID. `buildUploadReadyProposal` assigns a content fingerprint to the upload copy's `proposalId` while leaving the author's local key intact; imported copies normally use the published authored ID as their local key. `serverProposalId` is the explicit link from either browser copy to the published row. Exact named-plan membership uses that link, never local-key equality or source ancestry.

#### Proposal identifiers at API boundaries

| Term | Current representation and meaning | Boundary rule |
| --- | --- | --- |
| **Database proposal row ID** — `ProposalRowId` | `proposal.id` in SQL and API responses; browser `serverProposalId` refers to it. Assigned by the publication database and meaningful within that database. | Digit-only lookup values select this namespace exclusively. A row ID neither proves minting nor identifies a chain token. Creating a proposal cannot supply this ID. |
| **Authored proposal ID** — `AuthoredProposalId` | API `proposalId`, stored as `proposal.proposal_id`. The browser commonly publishes a content fingerprint; agents commonly supply an operation ID. It is unique within the publication store, not automatically a global IRI or an immutable snapshot. | Creation accepts an optional nonempty string of at most 255 characters that is not all digits; absent values receive a generated authored ID. Top-level `id` and `proposal_id` are rejected creation fields, including when `proposalId` is also supplied. |
| **Chain proposal reference** — `ChainProposalRef` | `{ chainType, chainId, contract, tokenId }`: chain family, network, contract/program, token/account. For example, the nested `onchain.proposalId` is a token/account ID, unlike the root `proposalId`. | `POST /proposals/mirror` accepts only `{ chainRef }` and verifies that location. Chain token/account IDs are never searched as a third namespace by ordinary proposal lookup. A server mirror has its own row and authored IDs. |

`GET`/`HEAD`/edit/owner-decision/lineage lookup and batch lookup use the same namespace rule:
digits select the row ID; other identifiers select the authored ID. Missing numeric rows stay
missing even if another record has that value in `proposal_id`. Batch epoch edits use the same
rule before checking edit tokens. There is no numeric authored-ID fallback.
`HEAD /proposals/:id` exposes `X-Proposal-Row-Id` and `X-Proposal-Authored-Id`; the former ambiguous
headers were removed. The browser's upload projection removes read-response `id` and SQL
`proposal_id` fields from its copy while preserving the local record.
[Lookup implementation](backend/proposals/identifiers.js), [API routes](backend/routes/proposals.js),
[upload projection](frontend/js/proposals/create.js): `buildUploadReadyProposal`,
[machine-readable agent input schema](backend/routes/agent-recipe-schema.json).

The `/plans` API uses `proposalRowIds` for the ordered list of database row IDs in creation and
all plan responses; its list filter is `proposal_row_ids`. Detail members expose `proposalRowId`
and `authoredProposalId`, with only `proposalRowId` available when the row is missing. Published
members need no mint. The retired creation key `proposalIds` and filter `proposal_ids` return 400,
even alongside their replacements; responses contain no aliases. Browser consumers and the naming
script use this single contract. The stored `ens_plan.proposal_ids` column still contains row-ID
strings; this API rename changes neither membership nor content commitments. [Plan API](plans.md#api-identifiers).

### Named plan — `NamedPlan`

An immutable named, ordered collection of published proposal rows. `ens_plan.slug` identifies it; `proposal_ids` stores deduplicated **database row IDs as strings**. A proposal can belong to multiple named plans. A plan must have at least one member when created. It may cover several cities; its stored city is selected from member cities.

Creation stores member hashes and a plan hash; the plan hash uses stable `proposal_id` values and member hashes in order. A revision is a new slug with `supersedes`; multiple later plans can supersede one predecessor. Its site is the union of member sites only when every member has a site. Chain mint metadata can be attached separately.

Every member hash commits to the decision `kind` and site from `proposal_data` (absent values are `null`). Ordinary members also commit to their design, cadastral references and applicable approval context. Readjustment members include the canonical deal fingerprint as a component. All members use SHA-256 over their sorted-key JSON projection. The PostGIS site projection is excluded; authored site coordinates retain their order and precision. This is record identity, not geometric equivalence. The 2026-10-19 contract deliberately replaces the prior hashing path: old hashes report drift and affected experimental plans can be recreated. [Hash contract](plans.md#experimental-contract-changes).

Normal design edits of a published or minted proposal create a **new proposal linked to its source**; the source remains intact. A named plan continues to reference that original row, so this fork model already preserves the selected design without a second copy inside the plan. [Edit boundary](frontend/js/proposals/lineage.js): `isPublished`, `editsInPlace`; [editor save](frontend/js/proposal-editor-shell.js).

The [database publication guards](backend/db/publication-immutability.sql), applied by the backend deployment, enforce this boundary for direct operator SQL too: authored content cannot be overwritten, and a named plan's membership, commitments and descriptive fields cannot change. This retires the overwrite behavior of tools such as [structure repair](backend/scripts/set-structure-geometry.mjs) and [road-network repair](backend/scripts/repair-sibenik-road-network.mjs). Proposal names, descriptions, thumbnails, epoch labels, lifecycle/approval outcomes and chain attachment remain separate mutable metadata; response ID mirrors can be filled after insertion while actual identifiers remain fixed. Plan chain data can be attached once.

Plan reads require complete member hashes and a valid-format aggregate hash; absent, partial or malformed commitments return 422 instead of implying unchanged content. Each member is then compared with its saved hash: missing or changed content reports `changed: true`. Minting additionally requires current content and aggregate hash agreement; ENS refuses incomplete commitments. There is one current contract, with incomplete experimental plans discarded and recreated. No historical content is manufactured or restamped. The list's order contributes to the plan hash; geometry replay has its own order. [Commitment validation](backend/plans/plan-commitment.js), [plan route](backend/routes/ens-plans.js), [store](backend/plans/plan-store.js), [hashing](backend/plans/plan-hash.js).

### Published record projection and authority

The API reconstructs one proposal from a stored row. SQL columns are queryable projections of
parts of `proposal_data`, not additional proposal entities. The serializer's current precedence
is explicit below; “non-null” includes `false`, `0`, empty strings, empty arrays and empty objects.
These values never trigger a truthiness fallback. The rules describe stored facts, not evidence
that the facts are legally or physically true. [Serializer](backend/proposals/serializer.js),
[full and summary queries](backend/routes/proposals.js).

| Response facts | Source and precedence |
| --- | --- |
| `id`, `proposalId`, `city` | Present SQL `id`, `proposal_id`, `city` replace JSON values. Normal API queries select these identity columns. Row and authored IDs retain their distinct namespaces. |
| `name`, `title`, `description`, `author`, `type`; `offer`, `offerCurrency`, `budget`, `budgetCurrency` | Non-null dedicated column, otherwise the corresponding JSON field. Numeric amount columns become JavaScript numbers; this does not change their currency. |
| `createdAt`, `expiresAt`, `updatedAt` | Non-null timestamp column formatted as ISO, otherwise its JSON value. Effective lifecycle separately uses only the SQL deadline; a JSON display date cannot establish expiry. |
| `decayEnabled`, `decayPercent`, `decayDurationMs`, `depositEnabled`, `depositPercent`, `isConditional`, `disbursementMode`, `epochYear` | Non-null dedicated column, otherwise JSON; duration and epoch columns become numbers. Missing epoch becomes null. |
| `cadastreParcelIds` | Full rows require the dedicated array; it must agree with any JSON declaration. Derived references and retired declarations are rejected. |
| `ownershipFlow`, `cadastreFrame`, `binding`; `roadProposal`, `buildingProposal`, `structureProposal`, `reparcellization`, `lens`, `bounds` | Non-null dedicated column when selected, otherwise JSON. The ordinary full query does not select `binding`, so it serves that stored JSON field. |
| `site`, `geometry`, decision `kind`, `goal`, approval configuration and other authored fields without a selected column | Cleaned JSON. The PostGIS `site` column supports spatial queries and guards; the API transports the authored GeoJSON. Summary fields are their own explicit query projection, not a second authored record. |
| `acceptedParcelIds`, `ownerAcceptances` | Omitted from API responses and portable records, regardless of SQL/JSON copies. These are browser-local unsigned bookkeeping; signed decisions use the separately verified receipt endpoint. |
| `lifecycleStatus` | SQL effective/stored lifecycle and SQL deadline only; unavailable state is Unknown. Authored JSON never supplies a missing status. |
| `onchain` | SQL `onchain_data` only, including null. A query that omits it also yields null. JSON chain fields cannot restore a missing attachment. `onchainData` is no longer emitted or accepted for creation. |
| `screenshotUrl` | Dedicated screenshot URL, then SQL chain attachment image URL, then JSON screenshot URL, then null. A thumbnail is presentation, not chain identity evidence. |
| `agent` | JSON claim only if the query's selected payment ID is non-null; verified mirrors instead use the signer-verified agent stamp. An absent payment projection is not independently verified provenance. |

For a verified `proposal-chain/1` mirror, the validated `chainMirror.record` replaces the authored
fields listed in `chainRecord.FIELDS` after the ordinary projection. It preserves the minted
values rather than SQL-normalized copies. The API's authored identifier remains the server's
mirror identifier; the original identifier remains in the committed record. Row identity,
current lifecycle and chain attachment remain server projections; `mirroredAt` records server
receipt separately from the committed creation time. Browser-local state and unqualified execution
timestamps are stripped after reconstruction too. [Mirror projection](frontend/js/proposals/chain-record.js).

**Contract break, 2026-10-19:** chain identity in old JSON-only or `onchainData`-only records is no
longer exposed by the API. Recreate those experimental records through verified mirroring; no
compatibility reader, data rewrite or migration was added. The other precedence rules above are
observed existing behavior, not newly added compatibility paths. Export consumers must use this
canonical response and its qualified evidence instead of publishing every stored projection.

### Applied composition — `WorkingComposition`

The proposals currently applied in one browser, together with their materialized effects. It can combine members of several named plans and local drafts, and has no `ens_plan` identity of its own. **Share applied proposals** opens a temporary selection from this composition. Uploading the selection and copying its `/proposals/<row IDs>` link do not create a named plan. The separate **Create named plan** action records the selected published members; subsequent changes to the browser composition do not change that membership. [Sharing panel](frontend/js/proposals/dialog-share.js), [named-plan contract](plans.md#named-membership-and-local-application).

Application and replay are local operations. Replay orders formations by `authoredAt || createdAt`, then numeric record ID, then record key; `epochYear` is a presentation bucket, not a dependency or replay order. Named membership, being applied locally, selection for sharing, replay chronology and authored dependencies are separate relationships. A member's position in a named plan affects its commitment hash, not its replay order. [Sharing flows](frontend/js/proposals/sharing-routes.js), [proposal manager](frontend/js/proposal-manager.js), [ordering](frontend/js/proposals/plan-order.js) (`formationTime`, `compareFormationOrder`), [epoch](frontend/js/proposals/epoch.js).

Other uses of “plan” need qualification: a statutory planning document, a floor-plan drawing, and the nested `reparcellization` layout are different objects.

#### Measurement scope

**Applied proposal stats** counts proposals currently applied in the browser and derives their quantities from the live fabric; opening a named-plan page does not make that statistics dialog a report limited to its members. **Urban grain score** has two scopes: without a named-plan context it measures the applied composition; with a named-plan context it fetches the plan detail and requires every member to be verified unchanged and applied with the exact published row ID. Its card identifies the scope explicitly, and a named plan without a title is labeled with its slug. [Statistics](frontend/js/proposals/plan-stats.js), [grain score](frontend/js/proposals/grain-score.js).

A local edit or fork cannot substitute for a named member, even if its source/replacement ancestry reaches that member. A fork can be scored when its own published row is a member. Missing, changed, unverified, ambiguous or unapplied members prevent a named score; absent membership never falls back to the whole local composition. Both the route and the score action fetch current plan verification. The shared-proposal loader still recognizes replacements for ordinary application, but scoring separately checks exact membership. [Pure membership rules](frontend/js/proposals/grain-score-rules.js): `verifiedNamedPlanMembers`, `selectNamedPlanProposals`.

The named members must also be the **whole applied composition**. Any outside applied proposal prevents a named score, including proposals on distant parcels or open ground. This conservative rule is intentional: overlapping cadastral IDs alone do not establish independence, and there is no isolated replay evaluator. Scoring reports the restriction and leaves the applied state intact; the user can unapply outsiders and reopen the score. Local composition scoring continues to measure the whole composition.

A **grain score assessment** is a derived measurement of one current-session fabric snapshot, not an intrinsic or committed property of a named plan. Ground loading finishes before eligibility is rechecked and parcel features are captured. Counts and dimensions come from those captured features; named scores require complete measurable result geometry and never fill a missing materialized parcel from original cadastral geometry. `state.prepared` retains the fabric revision and measured features. Start and Repeat recheck eligibility; a changed fabric revision requires reopening the score. [Measurement rules](frontend/js/proposals/grain-score-rules.js): `namedPlanScoreScope`, `measureParcelRows`.

Its inputs include the verified member rows, current cadastral repository facts, runtime materialization/replay rules, and the captured fabric revision. Neither ground versions nor engine versions are committed by the named-plan hash, and assessments are not persisted as historical evidence. This resolution prevents outside proposals or mixed revisions from silently becoming a named score; it does not promise reproducibility across sessions or releases.

### Cadastral parcel / base parcel — `CadastralParcel`

A source land unit referenced by its provider's parcel identity and geometry. Within a browser session the cadastral repository preserves source facts independently of the mutable map. A source feature may have multiple disconnected polygon parts. Its identity is not its polygon, display label, owner, or a generated fabric ID.

The common Croatian identifier is `HR-<cadastral municipality>-<parcel number>`; other providers have different identifiers and sometimes geometry-derived display identities. `cadastreParcelIds` is the durable relationship on a proposal, but the field name alone does not establish the legal quality or authority of a provider. Use source and jurisdiction context when interpreting an ID. [Ground repository](frontend/js/parcels/ground-service.js), [source adapters](backend/parcels/sources.js), [source normalization](frontend/js/parcels/ground-fallback.js), [authored ID checks](frontend/js/proposals/authored-record.js).

**Custom register identity contract, 2026-10-19:** a visitor's exact trimmed register URL is hashed with SHA-256 into `custom-url:sha256:<digest>`. Each normalized feature retains that `sourceId`; its parcel reference includes the same digest. A native ID is preserved as `sourceParcelId` with `sourceIdentityKind: native-id`, and encoded in the `URL:<digest>:native:<encoded ID>` reference. Without a native ID, `sourceParcelId` is `null`, `sourceIdentityKind` is `geometry-content`, and `URL:<digest>:geometry:<geometry digest>` identifies exact geometry type/coordinate content. These two reference kinds cannot collide with each other, and identical native IDs or geometry in different links do not name the same source feature. The source identity is preserved through viewport fetching, exact-ID lookup and tab-session restoration. [Pure identity projection](frontend/js/parcels/custom-url-identity.js), [custom-link transport](frontend/js/parcels/ground-fallback.js).

A URL identifies the selected source configuration, not a dataset release, a cadastral jurisdiction or a legal authority. URL aliases are not merged. Here a native ID means the first usable source key from the supported parcel/id fields, `OBJECTID`, `FID`, `gml_id`, or GeoJSON feature ID; it may identify a provider row rather than a cadastral unit. Its reference stays stable while that key and URL remain the same, including across geometry edits. Reused keys do not establish continuity of a parcel entity across dataset revisions. Anonymous geometry references change with the encoded geometry. No version or retrieval-time evidence is manufactured from the URL or the browser's city. This intentionally replaces the unqualified `URL:<native ID>` / short geometry-hash contract; affected experimental records must be recreated, with no compatibility lookup for old references. The tab's saved URL is still the source configuration, so restoration derives current references from fresh source data. Other provider paths do not yet share a complete jurisdiction/release contract.

### Live parcel / fabric piece — `FabricPiece`

A face of the currently materialized land fabric: unchanged cadastral ground, a proposed body, or a remainder created by applying formations. It has a runtime identity and provenance back to cadastral anchors and/or synthetic open ground. One base parcel can produce several pieces; a resulting piece can span several base parcels. A piece is not a newly registered cadastral parcel.

`LiveParcelFabric` is the mutable derived land representation. `ParcelPresenter` renders its revision. `ParcelMutation` coordinates atomic publication of proposal state, fabric and related local state. Neither a Leaflet layer nor its visibility determines cadastral identity. [Ground service](frontend/js/parcels/ground-service.js), [mutation transaction](frontend/js/proposals/apply/transaction.js), [claims](frontend/js/proposals/claims.js), [open-ground hosts](frontend/js/proposals/open-ground.js).

The single-selection menu and inspector qualify identity from explicit provenance: **source parcel** for a feature whose sole source is itself; **source parcel part** for a connected component marked `cadastralPart`; **formed ground piece** for other proposal-produced/derived ground or a feature with different source anchors. A readjustment's explicit output role further distinguishes **plot piece** and **ground remainder**. An unknown kind remains the generic “Parcel”; ID punctuation and `isProposed` alone do not establish a kind. A plot piece keeps that title on open ground; other open-ground titles remain qualified by ground provenance. “Source parcel” does not certify that the provider represents legal cadastral units. Formed pieces and source parts display their own runtime reference, even when they inherit a source's cadastral-number or geometry-reference metadata. [Shared presentation rules](frontend/js/ui/parcel-menu-model.js), [menu](frontend/js/ui/parcel-menu.js), [inspector](frontend/js/parcels/ui/parcel-panel.js).

**Readjustment output contract, 2026-10-19:** producer identity alone still groups both plots and leftover ground. Live features now also carry `readjustmentPiece`: `{ role: 'plot', plotFingerprint }` for a piece of an authored plot, or `{ role: 'remainder' }` for a remainder created outside this readjustment's plots. A carried piece of another formation retains that formation's producer and plot reference. The reference is captured before later corridors cut/filter plots and survives splitting into connected pieces; modeled allocation follows each resulting plot piece. `readjustmentPiece` is derived runtime metadata, removed when a feature becomes authored geometry and recreated on replay. No authored-record migration or compatibility reader was added. [Readjustment application](frontend/js/proposals/apply/parcels.js), [authored boundary](frontend/js/proposals/authored-record.js).

### Authored readjustment plot content — `AuthoredPlotContent`

One output entry in `reparcellization.polygons`: exact Polygon/MultiPolygon coordinates plus normalized owner allocations and joint-pool status. Its `lr-plot1-sha256:` fingerprint hashes the same canonical plot payload used inside the deal, wrapped with schema `land-readjustment-plot/v1`. Owner order, display metadata and the plot's array position do not affect this fingerprint; authored coordinates and allocations do. The reference is scoped by the producing proposal (`producedByProposalId` plus `readjustmentPiece.plotFingerprint`), not globally identified by a bare hash or an array index. [Plot projection and fingerprint](frontend/js/reparcellization-deal.js): `plot`, `plotFingerprint`.

One authored plot can yield zero, one or several live pieces after other applied proposals cut its ground. Their runtime IDs and geometries can change while they retain the original plot-content reference. This is content identity for one authored version, not a continuing legal lot or a stable logical plot across edits. A geometry/allocation edit changes the reference. The new derived fingerprint does not change existing deal/plan commitment payloads, replace the complete consent fingerprint, or assert cadastral registration. Provider/jurisdiction/version qualification and globally qualified export identifiers remain unresolved.

### Proposal site — `ProposalSite`

The ground occupied by a proposal, represented as a Polygon/MultiPolygon in geographic coordinates and stored in PostGIS as `MultiPolygon, 4326`. It may cross parcels, occupy parts of parcels, or include ground without available cadastral coverage. It is distinct from the set of affected parcels and from the building footprint.

Publication derives or validates the site and computes a binding against source parcels. A supplied design footprint must fit within the site. In transport, the serializer reads the site's GeoJSON from the authored record; the spatial database column supports queries. A site is currently embedded geometry, not a separately identified domain entity. [Site DDL](backend/routes/proposal-site-ddl.sql), [binding](backend/proposals/binding.js) (`checkProposalBinding`, `validateSiteGeometry`), [serializer](backend/proposals/serializer.js).

### Parcel binding — `ParcelBinding`

A computed, source-dependent statement about which parcels a site reaches into, at a stated tolerance and computation time. It includes bound parcels, touched parcels, intrusion measurements, coverage and unaccounted area. It is neither ownership evidence nor a title transfer.

For geometric binding, an intersection binds when it survives an inward buffer of half the greater of the configured tolerance and the numerical noise floor. Thus binding uses **intrusion width in metres**, not simply intersection area. A parcel merely touching the boundary need not bind. The default tolerance is zero, with a 0.001 m noise floor; uncertainty near the threshold can produce an unresolved answer. The browser computes a preview over supplied data; the server computes the publication answer.

Coverage values are `complete`, `partial`, `none`, `unknown`. `none` and `unknown` are distinct: confirmed lack of supported coverage does not mean the same thing as an unavailable or unrecognized source. A later cadastre can produce binding drift without rewriting the original publication. [Shared rule](frontend/js/proposals/site-binding.js), [server implementation](backend/proposals/binding.js), [drift](frontend/js/proposals/binding-drift.js).

### Owner / party / actor — `RightsParty`, `DecisionActor`

In the approval engine, the misleadingly named `ownerId` is an **opaque party identifier**. It can identify an ownership holder, leaseholder, or authority whose decision a policy requires. A holder has a right in a particular parcel and a share; a party is not intrinsically “an owner” everywhere.

`actorId` identifies the signing wallet acting for a party. A party ID may itself be a wallet key in a particular provider, but the two roles remain distinct. A rights declaration does not prove that the actor represents the party: the approval path separately checks rights and authority evidence against the proposal's selected lens. `proposal.author` is a descriptive field, not this relationship. Browser user/agent profiles and readjustment `ownerKey` values are further identity systems.

Rights snapshots use `parcel-rights/v1` or `v2`, with a source, per-parcel holders, completeness and optional areas; v2 adds leases and public bodies. Shares are exact positive fractions. Complete holder lists must sum to `1/1`; incomplete lists must not exceed it. This is a declared rights model, not an automatic land-registry certification. [Approval model](frontend/js/proposals/approval.js) (`normalizeRights`, `holders`, `contextContent`, `evidenceAllows`), [decision receipts](backend/db/proposal-owner-decision-ddl.sql), [browser profiles](frontend/js/user-management.js).

There is also a completely different `owner_id` in the building floor-model registry: for source `proposal` it identifies the **containing proposal**, not a landowner. [Floor-model identities](backend/buildings/floor-models.js) (`validateModelIdentity`, `attachProposalFloorModels`).

### Building / building design — `SourceBuilding`, `ProposedBuildingDesign`

A source building is an object in a particular survey or provider dataset. A proposed building is authored geometry, parameters and optional architectural evidence belonging to a proposal. Both can be rendered as buildings, but they make different assertions about existence.

One proposal may contain multiple features in `geometry.buildings`; a freeform tool named `single` does not establish a one-building cardinality. `buildingProposal` primarily carries authored settings; the canonical cleaner removes older duplicate feature containers. A building can overlap multiple parcels. Survey, cadastral and Overture identities are source-qualified rather than automatically merged.

Floor models identify a building by `(city, source, ownerId, buildingId)`, with a separate version and at most one current row. For proposal buildings the owner namespace is the proposal ID. Generated suggested interiors are expressly rejected as registry evidence. [Authored containers](frontend/js/proposals/authored-record.js) (`cleanFeatureContainers`), [building feature collection](frontend/js/proposals/geometry.js), [floor-model DDL](backend/db/building-floor-model.sql), [floor-model validation](backend/buildings/floor-models.js) (`prepareFloorModel`).

### Envelope — several implemented concepts

| Qualified term | Observed meaning and boundary | Evidence |
| --- | --- | --- |
| **Authored permitted envelope** — `PermittedMassing` | The maximum form permitted by a proposed urban rule, stored as a 2D polygon with maximum floors/height metadata and rendered as an extrusion. For detached buildings, the code insets a parcel by setback and checks minimum plot/footprint constraints. `max` permits up to the form, `range` may require configured minimum floors and/or footprint area, and `exact` requires that form. A detached minimum does not pin a particular polygon/location. This is normative **within the authored proposal**, not proof of compliance with all current planning law. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js): `normalizeParcelRule`, `evaluateParcel`, `parcelEnvelope` |
| **Block/row permitted massing** | Authored footprint with height/rule metadata, split into cadastral pieces. A range can include a compulsory minimum footprint/depth. The shaded `massingStyle: 'envelope'` is a rendering choice for this maximum form. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js): `normalizeBlockRule`, `massingWithRule`, `summariseBlockRule`, `plannedDrawPlan` |
| **Example build-out** — `ExampleBuildOut` | A deterministic sampled realization within the authored rule, controlled by a seed. It illustrates one outcome. Main urban-rule statistics use the envelope, so changing the sample should not change those statistics. Under `exact`, sample and envelope coincide. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js): `realizeFromEnvelope` |
| **Zoning solver result** — `BuildEnvelopeResult` | The adjacent cadastre service combines parcel/rule/context inputs into floor outlines, heights, setbacks, footprint and floor-area capacity. It distinguishes envelope geometry, capacity estimate and existing buildings. This is a separate implementation; the audit found no direct `/build-envelope` call in this checkout's frontend/backend sources. Do not ascribe all of its constraints to the app's simpler envelope generator. | [adjacent API](../cadastre-data/api/src/domains/envelope/routes.js), [solver](../cadastre-data/lib/solver.mjs); app comparison: [agent planner](backend/agents/planner.js) |
| **Reconstructed building envelope** — `ReconstructedBuildingEnvelope` | `building-envelope.v1`: an estimated vertical storey stack over a supplied footprint, derived from textual storeys, elevations and survey height. It describes evidence about an existing/advertised building. It is not a permission volume. | [archive envelope](backend/floor-plans/envelope.js): `buildEnvelope`; [site model](backend/floor-plans/site-model.js) |
| **Bounding envelope** — `BoundingBox` | A rectangular spatial-query extent, for example `ST_MakeEnvelope`. It carries no planning permission or architectural meaning. | [spatial helpers](backend/utils/helpers.js) |

### Offline imagery-derived plot diagnostic — `VisibleDivisionProbe`, `InferredPlotCandidate`

Observed in ParcelBench only (2026-10-19): an **inferred plot candidate** is a generated polygon
feature supported by imagery/model and reconstruction inputs. It asserts no registered parcel
identity or ownership. The runtime fallback proposed for locations without cadastre is not yet
integrated; this experiment does not resolve the cadastral/authored/runtime distinctions in V05.

A **visible-division probe** binds two image-pixel anchors to hashed imagery and its metric extent.
Relation `separate` records an agent-reviewed physical/use division; `same_surface` is a secondary
fragmentation check. These draft annotations are not human-verified legal boundaries. A **false
merge** in this diagnostic means both separation anchors are uniquely covered by the same output
feature, even if that feature has disconnected components. Different unique features mean separated;
missing coverage is uncovered, and multiple coverage is ambiguous. Neither is counted as successful
separation. Invalid polygon outputs remain unscored. Pair outcomes do not measure boundary-length
recall or establish general plot accuracy. [Annotation contract](world-parcels/parcel-bench/annotations/README.md),
[strict scorer](world-parcels/parcel-bench/visible_divisions.py).

The **exact-cell partition candidate** constructs one feature per positive reconstruction label,
including every occupied cell and all disconnected components. Zero-labelled ground remains
unassigned. It uses shared raster-cell edges, without contour filtering, smoothing or geometric
repair, and verifies polygon validity, area, overlap and cell-centre label preservation. This is an
offline candidate contract; frozen historical contour outputs and metrics retain their prior
meaning. [Constructor](world-parcels/parcel-bench/cell_partition.py),
[2026-10-19 evidence](world-parcels/parcel-bench/studies/visible-divisions-v1.md).

The offline **core-marker candidate** erodes the eligible learned-interior mask before component
admission, then gives each accepted core one starting label while preserving supplied OSM building
markers and barriers. It can create newly eligible components as well as shrink or split existing
ones; it is not a guaranteed subset of the native admitted markers. A **boundary flood surface**
uses learned boundary probability as watershed elevation. Neither marker nor surface choice is
physical-boundary ground truth. Their [frozen comparison](world-parcels/parcel-bench/studies/visible-boundary-v1.md)
remains diagnostic; no runtime rule was promoted. Target imagery marked `pending-human-review`
has provenance and crop geometry but no accepted division labels or evaluation role.

A **human visible-division observation** is an explicitly submitted `separate`, `same_surface`, or
`unclear` judgment about two distinct interior image-pixel anchors in an immutable, hashed review
batch. The mobile Autokatastar tool records optional traces and notes as evidence; a trace does not
assert an exhaustive boundary network or legal ownership. Unfinished edits are **drafts**, distinct
from submitted judgments. **Saved on phone** means committed to IndexedDB; **synced** means the server
has acknowledged its durable revision. Concurrent device revisions require an explicit conflict
choice, with earlier server revisions retained. The `human-visible-divisions-v1` export preserves
per-sample CRS and image hashes, keeps unclear observations outside `probes`, and leaves evaluation
roles unassigned. Reviewing all **starting tasks** describes offered pair coverage only, never
complete image annotation. This new contract does not relabel frozen agent-draft experiments as
human review. [Mobile review contract](world-parcels/parcel-bench/annotation-app/README.md),
[validation and state](world-parcels/parcel-bench/annotation-app/public/model.mjs),
[exporter](world-parcels/parcel-bench/annotation-app/export_reviews.mjs).

## Supporting vocabulary

### Intent, publication and state

| Term | De-facto definition and relationships | Evidence |
| --- | --- | --- |
| **Design / draft** | Local editable authoring state before publication. Editor adapters serialize it into a proposal. A local draft can have no decision kind; kind is selected at publication. A draft object and the server lifecycle value `draft` are different representations. | [drafts](frontend/js/proposal-drafts.js), [adapters](frontend/js/proposal-editor-adapters.js), [publish kinds](frontend/js/proposals/proposal-kind.js) |
| **Goal** | The design/tool discriminator: `as-is`, `square`, `park`, `lake`, `station`, `single`, `buildings`, `row`, `parcelBased`, `urban-rule`, `road-track`, `reparcellization`, `ownership-transfer` in the current editor registry. Other runtime/legacy goals include `decide-later`, `parcel`, and directional ownership transfers. A goal is not the approval kind. | [adapters](frontend/js/proposal-editor-adapters.js): `CREATABLE_PROPOSAL_GOALS`; [normalizer](frontend/js/proposals/urban-rules.js): `normalizeProposalGoalKey` |
| **Type / typology** | `type` is a broad storage/API classification; `goal`, `typologyType` and nested structure/corridor kinds select more specific behavior. The SQL `type` column is free text with a length limit, not an enum of the four values in its comment. There is no single exhaustive taxonomy enforced across all paths. | [proposal DDL](backend/routes/proposals-ddl.sql), [API](backend/routes/proposals.js), [adapter resolution](frontend/js/proposal-editor-adapters.js): `sourceGoal` |
| **Proposal kind** | `owner-deal`, `owner-vote`, `community-vote`: who decides and whether the proposal is binding in the app. Votes are nonbinding and cannot carry positive offer/budget or enabled deposits. Missing kind reads as `owner-deal`; unknown kind is invalid. Publication defaults to `community-vote`. This is independent of geometric goal. | [proposal-kind.js](frontend/js/proposals/proposal-kind.js): `kindOf`, `kindErrors`; [API validation](backend/routes/proposals.js) |
| **Owner sale offer** | A direction of owner deal: identified by goal `ownership-transfer-from-me`, role `owner-offer`, or transfer direction `from-me`. A seller declares an offer concerning land; this declaration supplies no owner acceptance records. New `from-me` offers begin with `funded: false` and display “Awaiting funding.” These aliases remain in current predicates. | [proposal-kind.js](frontend/js/proposals/proposal-kind.js): `isOwnerSaleOffer`; [lifecycle](frontend/js/proposals/lifecycle.js): `isProposalOpenSaleOffer` |
| **Facets** | Additional authored dimensions such as ownership destination and parcel treatment, found as `facets` and `proposalFacets`. They describe intended effects; they no longer define the current decision-kind enum. | [adapter serialization](frontend/js/proposal-editor-adapters.js), [creation](frontend/js/proposals/create.js), [consent payload](frontend/js/proposals/sharing.js) |
| **Published / uploaded / minted** | Uploaded means a server proposal record exists. Minted means a chain account/token and its metadata exist. A published row is not necessarily minted. A chain-only record may be reconstructed or mirrored into the API. None of these means the design has been built. | [sharing routes](frontend/js/proposals/sharing-routes.js), [minting](frontend/js/proposals/publish-mint.js), [chain record](frontend/js/proposals/chain-record.js), [serializer](backend/proposals/serializer.js) |
| **Fork / counterproposal** | A new proposal identity derived from an existing proposal, with source references such as `sourceProposalId`. Normal design editing forks published or minted sources and preserves them; a local unpublished record can be edited in place. An explicit Fork also creates a new record from an unpublished source. This creates branching lineage, not a mutable “latest version” alias or an automatic replacement in a named plan. | [lineage](frontend/js/proposals/lineage.js): `editsInPlace`, `publishedSourceIds`; [creation](frontend/js/proposals/create.js); [editor](frontend/js/proposal-editor-shell.js) |
| **Lifecycle status** | Authored/server enum `Active`, `Executed`, `Cancelled`, `Expired`, `draft`; missing or unrecognized existing state reads as `Unknown`. Only `Active` expires from a deadline. The creation input resolver still accepts legacy `status: applied/unapplied` as initial `Active`; existing browser/API reads do not infer lifecycle from application state. | [lifecycle](backend/proposals/lifecycle.js), [DDL](backend/routes/proposals-ddl.sql) |
| **Applied / unapplied** | Whether a proposal contributes to this browser's map/fabric composition. The server serializer strips this state. It is not owner approval, chain settlement, or real-world completion. | [serializer](backend/proposals/serializer.js): `stripLocalProposalState`; [local state](frontend/js/proposals/state.js) |
| **Accepted parcel / owner approval** | `acceptedParcelIds` is a parcel-level aggregate, not a decision receipt. The local owner-state evaluator rebuilds it from in-scope, term-bound `ownerAcceptances` records and never infers owner decisions from aggregate flags. Signed `ownerApprovals` are separately verified party/actor decisions against the proposal commitment and approval context. Uploads strip client-supplied acceptance claims; stored API rows can still expose old projections. Their evidential strength remains different. | [approval](frontend/js/proposals/approval.js), [relay](frontend/js/proposals/approval-relay.js), [older acceptances](frontend/js/proposals/owner-acceptance.js), [upload filtering](backend/routes/proposals.js): `dropUnprovableClaims` |
| **Execution / verdict** | Execution can mean local simulated changes, an on-chain lifecycle transition, or an attester's statement about a proposal. The same display word does not identify which evidence exists. An on-chain verdict and market settlement are separate operations; physical construction and legal registration require their own evidence. | [execution](frontend/js/proposals/execution.js), [chain status](frontend/js/proposals/chain-status.js), [verdict schema](backend/oracle/lens-schemas.js), [market model](backend/markets/contests.js) |
| **Epoch / timeline** | `epochYear` assigns a proposal to a display year; null is unbucketed. It does not promise a construction date or define precedence between proposals. | [epoch](frontend/js/proposals/epoch.js), [DDL](backend/routes/proposals-ddl.sql) |

### Local acceptance record and signed decision — distinct evidence

`ownerAcceptances[parcelId]` holds an owner-slot roster (`owners`, `ownerOrder`), claimed accepted keys, per-key metadata (`acceptedBy`) and optional history. A local acceptance counts only when its nonempty `effectHash` matches the current commitment. A parcel enters the evaluated tally only if it belongs to `cadastreParcelIds` and every slot in its nonempty roster has a current acceptance. Reading owner state updates the roster before evaluating that tally. Missing records, missing commitments and an unavailable evaluator count no consent. The helper does not manufacture a decision, signer or timestamp from `acceptedParcelIds`, `executedAt`, `updatedAt` or the clock. The “Terms changed” hint requires a stored commitment that differs from the available current commitment; a hashless record cannot establish that comparison. These are local app records: a matching hash proves neither signer authority nor legal ownership. [Bookkeeping](frontend/js/proposals/owner-acceptance.js), [validity](frontend/js/proposals/ownership-flow.js), [browser adapter](frontend/js/proposals/execution.js).

Signed `ownerApprovals` use a different evidence contract: a party (`ownerId`, including holder/authority roles), acting signer (`actorId`), decision, terms commitment, authority/rights evidence, source decision time and signature proof. The relay re-verifies admitted receipts and appends them; readers verify them again. Neither publishing a proposal nor receiving an API parcel tally grants this authority. [Runtime](frontend/js/proposals/approval-runtime.js), [relay verification](frontend/js/proposals/approval-relay.js), [receipt storage](backend/proposals/owner-decisions.js).

**Intentional contract break, 2026-10-19:** hashless local acceptances and parcel-only flags no longer establish current consent in the owner-state evaluator; old records remain inspectable, but require a new acceptance to count. No inferred timestamps, compatibility path or preservation migration is provided. This does not retroactively change an existing execution lifecycle. Remaining audit work includes raw stored API projections and comparison surfaces, owner-roster authority/completeness (placeholders and previously stored real-owner slots can remain), and labels that may imply verified approval. These must not be exported as signed decision evidence.

### Market location and account evidence

The markets API and bet-share lookup accept only `onchain_data.chainId: solana-devnet`, the configured
proposal program in `contractAddress`, and a canonical public key in `proposalId`. Token/account
aliases and bare Solana prefixes no longer select a market. The same location projection applies
to named-plan accounts. This is a declared location, not proof that the published design matches
that account's commitment.

Before reading accounts, both RPC readers verify devnet's genesis hash. Proposal status requires
an account owned by the configured proposal program, the Proposal discriminator, and a supported
status. A missing or invalid proposal account fails the read. A present market must belong to the
configured market program and decode to the requested proposal and devnet USDC mint. A missing
market means no pool has been found; it does not prove a missing proposal. These checks supply
chain/account evidence, not physical construction evidence. Unqualified experimental links must
be recreated; no alias fallback is provided. [Market reader](backend/routes/markets.js),
[location projection](backend/markets/contests.js), [share lookup](backend/routes/bets-share.js).

Market action eligibility uses the observed chain state only: `Active` permits new bets or opening
a pool; `Executed`, `Cancelled` or `Expired` may permit settlement of an existing unresolved pool.
Missing chain status neither inherits the app lifecycle nor establishes a terminal result. A
settled market remains readable. Market close times and app-level proposal deadlines are labeled separately; neither is a promised settlement time. Named plans have no assumed Active lifecycle. The sheet, direct
bet dialog and proposal card follow this distinction; a closed existing pool remains visible.

Displayed percentages are **pool shares**: a side's staked atomic devnet USDC divided by both sides'
stakes, multiplied by 100 and rounded to one decimal. The sheet names the yes side explicitly;
two-sided details label each side's share. Empty pools have no share; these figures are not a
calibrated probability. The separate payout multiple includes the reference stake and follows the
program's integer rounding. Market questions, sides and share previews describe on-chain execution
and settlement, not verified construction. Group help states that shared parcel references form a
contest and multiple grouped proposals can execute. [Pure market view](frontend/js/bets/bets-model.js),
[card model](frontend/js/proposals/market-view.js), [market UI](frontend/js/bets/bets-sheet.js).

### Consent decisions and recorded execution — independent state

**API lifecycle reads, 2026-10-19:** the dedicated lifecycle column is authoritative, including when missing or unrecognized; the JSON projection cannot supply a replacement claim. Such reads return `Unknown`, a read result rather than a valid authored lifecycle. SQL lists/filters and the serializer agree: only `Active` may become `Expired` from its deadline; draft, terminal and unknown states retain their meaning. `?lifecycle=Unknown` selects unavailable states. New proposal creation retains its explicit initial-state rule; this does not infer a state for an existing record. No stored record is rewritten. [Read contract](backend/proposals/lifecycle.js), [SQL projection](backend/routes/proposals.js), [serializer](backend/proposals/serializer.js).

**Browser lifecycle reads, 2026-10-19:** canonical reads, imports, reloads and recovered records retain `Unknown` when lifecycle evidence is absent or unrecognized. Chain import adapters read their decoded status without supplying Active. The creation entrypoint `addProposal` initializes an absent lifecycle to Active for a newly authored record; import/recovery paths establish their observed state first. Unknown has a visible “Status unknown” modifier, cannot expire from a deadline, and cannot start a new owner acceptance or wallet acceptance. Existing consent withdrawal and local map application remain separate concerns. This changes no chain enum, adds no compatibility reader and does not reinterpret old application words as lifecycle evidence. [Status axes](frontend/js/proposals/status.js), [storage](frontend/js/proposals/data.js), [display](frontend/js/proposals/lifecycle.js), [consent](frontend/js/proposals/execution.js).

**Oracle subject qualification, 2026-10-19:** the lifecycle materializer scans and updates only records whose server-verified `chainMirror` has the current protocol and exact `(solana, solana-devnet, configured ProposalNFT program, account)` reference. Its transaction query also selects devnet evidence. The land-event job verifies the RPC genesis before transaction collection or event writes; direct lifecycle calls check it too. Bare token/account IDs and the `onchain`/`onchainData` projections cannot supply this relationship. Unqualified experimental records must be mirrored again; they are not backfilled or automatically reinterpreted. Source transaction time, terminal recipe hashes and initial mirror observations retain their existing meanings. A chain terminal event still asserts no legal registration or physical construction. [Oracle](backend/oracle/proposal-lifecycle.js), [job](backend/oracle/land-event-job.js).

Withdrawing a local owner acceptance or recording a signed abstract-party withdrawal changes the consent records and tally. It does not rewrite `lifecycleStatus`, delete `executedAt`, change local `applied` state, reverse modeled ownership or undo a payment. A signed withdrawal retains its decision evidence/history; the plain local acceptance store still has its own unsigned bookkeeping contract. [Withdrawal handlers](frontend/js/proposals/execution.js): `rejectProposal`, `recordAbstractProposalDecision`.

**Correction, 2026-10-19:** withdrawal no longer turns an Executed record back into Active. EVM withdrawal pre-checks no longer treat map application as execution: an applied Active conditional proposal can reach the chain withdrawal call. Existing execution/non-conditional guards and the Solana final-acceptance restriction remain; the EVM contract enforces its own eligibility and signer authority. No map flag supplies chain execution evidence. [EVM withdrawal contract](blockchain/contracts/ProposalNFT.sol): `withdrawAcceptance`.

**Intentional contract change, 2026-10-19:** both `acceptProposal` and `recordAbstractProposalDecision` record consent only, including a complete tally and `funded: true`. They do not set `lifecycleStatus`/`executedAt`, apply geometry, transfer modeled ownership, settle simulated pledges/donations or report `proposalExecuted`. Human and agent activity updates the accepted-proposals list only. The unused automatic application/transfer helpers and recipient-consent execution gate are removed. Explicit map application and the separate purchase simulation remain available. No compatibility branch or migration reclassifies older Executed records; recreate affected experimental records as needed. [Local adapter](frontend/js/proposals/execution.js), [human activity](frontend/js/proposals/core.js), [agent actions](frontend/js/agents.js).

The EVM acceptance transaction remains a distinct chain action: `ProposalNFT.acceptProposal` can set its chain status to Executed and distribute funds when all chain parcels have accepted. After confirmation, the wallet adapter reads `getProposal` from the same contract/provider at the receipt block, checks the network again, and returns that lifecycle observation separately from local consent. The browser applies only a recognized enum value for the same submitted and current chain/contract/token identity; hex and decimal EVM IDs compare canonically. A failed or unknown read keeps the previous lifecycle and explicitly reports that acceptance was confirmed but status could not be refreshed. It does not retry the transaction, fabricate `executedAt`, apply geometry, transfer modeled ownership or settle simulated support. The receipt-block status is an observation, not a new execution timestamp, durable proof archive or finality guarantee. Independent loading/import still supplies other chain state. Execution provenance on older records, other chain/API projections, legal registration and physical realization remain unresolved V08 work. [Contract](blockchain/contracts/ProposalNFT.sol), [wallet adapter](frontend/js/blockchain-proposals.js), [chain loader](frontend/js/proposals/chain-proposal-loader.js).

**Verified mirror lifecycle observation — correction, 2026-10-19:** a new server mirror initializes `lifecycle_status` and its `proposal_data.lifecycleStatus` projection from the configured chain reader's recognized status. The EVM reader decodes `getProposal.status`; the Solana reader decodes the Proposal account's status byte. Missing or unknown values refuse publication instead of defaulting to Active. Only the verified mirror middleware can supply this evidence; an ordinary upload's Executed claim is still dropped. [Chain reader](backend/proposals/chain-reader.js), [mirror](backend/proposals/chain-mirror.js), [creation](backend/routes/proposals.js).

`chainMirror.lifecycle = { status, observedAt }` records the initial observation alongside the already qualified `chainMirror.ref`. `observedAt` is the server time immediately after the chain read, before metadata retrieval; `verifiedAt` is the later metadata-verification time. Neither is an execution event time, and the mirror does not invent `executedAt` or per-owner consent. The observation is outside the immutable authored `chainMirror.record` and does not affect its content commitment. It remains the initial snapshot if the oracle later updates the current lifecycle projection. These mirror reads do not archive a block/slot proof; status can subsequently change. No backfill reinterprets old Active mirrors or adds evidence to them. Older lifecycle claims, the public API's unknown-to-Active default and later oracle provenance remain separate unresolved work.

**Execution-time boundary — intentional contract change, 2026-10-19:** the root `executedAt` field has no verified execution-event producer in the current publication contract. The shared browser publish/export projection and API input/output projection now omit it for every lifecycle state, including Executed and verified mirrors. A direct upload cannot supply it merely by claiming Active; historical stored copies are also omitted from API responses. No date is inferred from acceptance, creation, observation or metadata-verification time. Existing browser-local records and consent withdrawal retain their local history; projection copies do not mutate those records or rewrite stored database rows. Chain lifecycle observations remain in their qualified evidence record, and valid recorded lifecycle values are preserved. There is no migration or replacement event-time field. [Portable boundary](frontend/js/proposals/formation-depth.js), [API projection](backend/proposals/serializer.js).

**Unsigned consent boundary, 2026-10-19:** `acceptedParcelIds` and `ownerAcceptances` remain
browser-local bookkeeping. The API strips both SQL and JSON copies on read as well as write;
publish/export projections omit them, and import initializes an empty tally instead of inheriting
the sender's local decisions. Local save/reload retains the originating browser's records. A
same-ID remote refresh preserves the existing local owner history, then recomputes the tally
against the incoming terms; with no evaluator the tally stays empty. The projection leaves
authored `approvalConfig` intact. Signed decisions are obtained separately from
`/proposals/:id/owner-decisions` and reverified against the current terms, party, actor and authority
evidence. No unsigned tally is converted into a signed receipt or a refusal. Existing database
copies are not rewritten, migrated or served as consent. [Portable projection](frontend/js/proposals/formation-depth.js),
[import boundary](frontend/js/proposals/status.js), [API projection](backend/proposals/serializer.js),
[signed receipt relay](backend/proposals/owner-decisions.js).

### Seller offer, funding and closure

Creating a `from-me` offer leaves `acceptedParcelIds` empty and records no owner decision or nested acceptance status. Sale intent, eligibility to offer, funding and consent are distinct. The `awaiting-funding` display modifier is derived from the local `funded: false` flag and transfer direction; it neither proves consent nor measures a chain escrow. It replaces the misleading `accepted-not-funded` key and label. Binding proposals retain their executed, withdrawn or expired display state ahead of the funding modifier; a passed deadline also displays expiry. [Creation](frontend/js/proposals/create.js), [display derivation](frontend/js/proposals/lifecycle.js), [badges](frontend/js/proposals/display-state.js).

The purchase-simulation predicate requires an active, unexpired, binding offer that is not marked sold and has no local simulation result. It refuses drafts, closed offers and repeated simulations before mutation. `simulateSaleOfferPurchase` changes only browser-local modeled parcel ownership and adds `localPurchaseSimulation: { buyerAgentId, simulatedAt, cadastreParcelIds }`. The timestamp records this simulation event; the parcel list snapshots its modeled scope. This result is a historical local action, not an assertion that later model changes leave the same holder in place. The authored transfer direction/recipient, funding flag, consent, commitments and shared lifecycle remain unchanged. [Local simulation](frontend/js/proposals/execution.js), [offer predicate](frontend/js/proposals/lifecycle.js).

The result survives local save/load, appears separately from lifecycle in the list/details UI and is omitted from sharing, upload/API records and chain metadata. Imports and new proposal drafts cannot inherit it. Another browser receives the unchanged offer and may run its own simulation. The action makes no payment and verifies no signed owner consent, chain settlement, legal registration or physical realization. Modeled ownership itself remains browser-local state; other execution paths and their evidence/authority remain audit work. [Portable projection](frontend/js/proposals/formation-depth.js), [API projection](backend/proposals/serializer.js), [import state](frontend/js/proposals/status.js), [new drafts](frontend/js/proposal-drafts.js).

**Intentional contract change, 2026-10-19:** the former local Buy action is now explicitly Simulate purchase and no longer writes a synthetic sale, funding or Executed claim. No compatibility path or migration tries to reinterpret earlier executed records; recreate affected experimental offers when needed. Published source records are not rewritten.

**Intentional contract change, 2026-10-19:** newly created seller offers omit the synthetic acceptance preset and nested `accepted-not-funded` status. The display/filter key is now `awaiting-funding`; no old-key compatibility reader or data migration is added. Published source records are not rewritten.

### Funding readiness flag and monetary funding — distinct quantities

`funded` is used as a local readiness flag, not a currency amount. Seller offers explicitly start with `false`. Local acceptance no longer uses this flag to trigger execution: neither `true`, `false` nor absence changes the consent-only contract. Neither `true` nor absence establishes an escrow balance, payment receipt or verified funding sufficiency. [Creation](frontend/js/proposals/create.js), [local consent](frontend/js/proposals/execution.js).

**Presentation correction, 2026-10-19:** the seller offer bar shows a funding-availability note. The former Accept ownership transfer / Fund dialog and its no-op submission are removed: it made no transaction and falsely computed a currency shortfall as `offer - Number(funded)`, turning `true` into one currency unit. No replacement funding action or synthetic balance is introduced. The deposit label now says “No deposit specified”; it describes authored settings and no longer asserts the absence of financial backing. The existing offer display and browser-local purchase simulation remain separate. [Offer bar](frontend/js/proposals/details-panel.js).

The Solana support flow reads proposal-account donation escrow totals separately; a pledge is a revocable commitment whose USDC has not yet moved, while a donation is deposited into escrow. Those records are not the seller offer's `funded` flag and cannot supply a universal seller-purchase shortfall. This correction does not change support transactions. [Support bridge](frontend/js/solana/pledge-bridge.js), [escrow reader](frontend/js/solana/pledge-client.js), [support presentation](frontend/js/proposals/support-view.js).

### Open-ground accounting — `UnrepresentedGroundEntry`

The reserved `ownerKey: 'open-ground'` entry accounts for the part of a modeled site outside the supplied parcels. Its `noOwner: true` flag is an accounting exclusion marker, not evidence of legal ownerlessness. It has no represented ownership party, known value or cash recipient. This differs from a public-land allocation, an unassigned output plot, a failed parcel fetch, and a parcel whose holder data are unavailable.

`poolShares` includes this ground's area in the denominator and chooses an area basis; `ledgerOf` retains contributed/assigned area but returns a `null` cash balance. The readjustment UI displays an em dash and explains that this draft calculates no balance or cash allocation for the ground. The canonical deal represents its cash fields as zero cents and excludes the marked entry from payment-party lines. Neither representation proves that no debt, compensation claim or ownership right exists. Plot ownership shaping yields an empty modeled allocation, and materialization creates no recipient agent or ownership transfer for that placeholder. [Accounting](frontend/js/proposals/subdivision.js), [deal and money schedule](frontend/js/reparcellization-deal.js), [plot allocation](frontend/js/reparcellization-ownership.js), [application](frontend/js/proposals/apply/parcels.js).

**Presentation correction, 2026-10-19:** new subdivision labels and site/create help state that ownership is unknown; authority-verdict help explicitly concerns on-chain execution. This changes labels and explanations, not accounting, allocation, approval evaluation or commitment payloads. The internal `noOwner` name and broader ownership terminology remain audit work. The marker must never be exported as a legal ownership category.

### Land and geometry

| Term | De-facto definition and relationships | Evidence |
| --- | --- | --- |
| **Parcel set** | A canonical sorted set of parcel IDs plus jurisdiction and authority. Its `setHash` hashes those three inputs, not geometry or `referenceAt`. It identifies a declared set, not a cadastral survey version. | [parcel-set.js](backend/proposals/parcel-set.js): `buildParcelSet` |
| **Cadastre frame** | Publication-time context for cadastral-dependent stamps (`capturedAt`, and an optional geometry hash where supplied). The current object is not a full reproducible copy of the cadastre. | [DDL](backend/routes/proposals-ddl.sql), [serializer](backend/proposals/serializer.js) |
| **Open / unsurveyed ground** | Land within a modeled site not represented by supplied/bound cadastral parcels. The fabric can host it as `ground:<siteHash>` with `groundIds` provenance. Readjustment uses an accounting placeholder with no represented ownership party. Absence of an owner in this model is not evidence of legally ownerless land. | [open-ground.js](frontend/js/proposals/open-ground.js), [subdivision.js](frontend/js/proposals/subdivision.js), [deal](frontend/js/reparcellization-deal.js) |
| **Formation** | A spatial proposal's ground-forming role: it cuts/replaces live land and produces pieces. `potential-formation` describes authored intent before materialization. Formations include corridor, structure, some building, readjustment and the `decide-later` merge goal. “Mints ground” in these modules can mean creating runtime pieces, independently of blockchain minting. | [formation-depth.js](frontend/js/proposals/formation-depth.js), [parcel apply](frontend/js/proposals/apply/parcels.js) |
| **Plot / lot / slice** | In the partition editor, an authored output polygon or multipolygon with allocation metadata (`ownerKey`, `owners`, joint-pool information). It is a planned unit of land, not a registered parcel. A multipolygon can contain several connected pieces; record count and connected-piece count can differ. “Lot” elsewhere may be a provider's tax/legal unit and needs that source qualification. | [readjustment editor](frontend/js/reparcellization.js), [ownership shaping](frontend/js/reparcellization-ownership.js), [deal projection](frontend/js/reparcellization-deal.js): `plot` |
| **Readjustment / reparcellization** | A proposal pooling input land and assigning output plots, owner contributions/entitlements and optional cash. The persistent object is `reparcellization`; its canonical deal commits to the partition, ledger, terms and approval context. Generated child parcels are apply-time results. | [deal](frontend/js/reparcellization-deal.js): `content`, `fingerprint`; [authored cleaner](frontend/js/proposals/authored-record.js) |
| **Subdivision / pool** | The site-based partition path: pool = site; cadastral contributions = site intersections with supplied parcels; the remainder is open ground in the model. The editor outputs plots, including public land as an allocated plot. It is not a separate cadastral registration process. | [subdivision.js](frontend/js/proposals/subdivision.js): `sitePool`; [readjustment editor](frontend/js/reparcellization.js) |
| **Remainder** | Live ground left after subtracting a formation body from parent land. A formation can produce body and remainder pieces; only some output pieces lie under the proposed body. | [hover-ground.js](frontend/js/proposals/hover-ground.js), [parcel apply](frontend/js/proposals/apply/parcels.js) |
| **Footprint** | A 2D outline whose subject must be stated. A building footprint is the building's ground outline. A proposal footprint is the union of selected authored geometry parts. A corridor footprint is its occupied land, distinct from the centerline. A proposal site can be larger than the footprint. | [footprint-parts.js](frontend/js/proposals/footprint-parts.js), [plan-order.js](frontend/js/proposals/plan-order.js): `footprintOf`; [binding](backend/proposals/binding.js) |
| **Ground surface / treatment** | Authored surroundings of freeform buildings, typically the ground boundary minus building footprints. `geometry.groundSurface` carries `{ treatment, polygon }`; treatments are `none`, `paved`, `green`. It is not the cadastral ground repository or the entire site by definition. | [building-ground.js](frontend/js/building-ground.js): `buildSurface`, `surfaceOf` |
| **Corridor / alignment / cross-section** | Corridor = occupied transport land and authored design. Alignment = line segments/points, with level/elevation information. Cross-section = lanes and widths describing transverse form. `roadProposal` can describe roads or tracks; a designation with a polygon but no centerline names road land without a constructed alignment. | [corridor profile](frontend/js/corridor-profile.js), [OSM form](frontend/js/corridor-osm-form.js), [corridor reconstruction](backend/proposals/corridor-reconstruction-geojson.js), [site-binding.js](frontend/js/proposals/site-binding.js): `isRoadDesignation` |
| **Road / street / planned road** | A road/track proposal is an authored change. Existing named streets and road geodata provide context/frontage. Planned-road source data describe reservations or planned streets. Shared location does not make these the same object. | [street frontage](backend/streets/near.js), [planned roads](backend/routes/planned-roads.js), [corridor reconstruction](backend/proposals/corridor-reconstruction-geojson.js) |
| **Structure** | An app category for area features such as park, square, lake, and station authoring. It is not the general engineering concept of a load-bearing structure. The specific reconstruction exporter currently only accepts park/square/lake. | [editor registry](frontend/js/proposal-editor-adapters.js), [structure exporter](backend/proposals/structure-reconstruction-geojson.js) |
| **Map claim / dossier** | A claim is selectable ground, fabric or proposal content, ranked for interaction. The bare cadastral ground is the null/no-change claim. A dossier collects proposals referencing the land. This use of “claim” is not a legal ownership claim or a signed oracle assertion. | [claims.js](frontend/js/proposals/claims.js): `CLAIM_RANKS`, `dossierFor` |
| **City / place / source** | `proposal.city` is a filing/context code resolved from location on publish. A named plan's `place` is a free-text contest/location label. A provider's geographic coverage can span cities. None of these strings alone is a globally identified administrative jurisdiction. | [publication city](backend/proposals/publication-city.js), [plan store](backend/plans/plan-store.js): `membersCity`; [source registry](backend/parcels/sources.js) |

### Architecture, rules and measurements

| Term | De-facto definition and relationships | Evidence |
| --- | --- | --- |
| **Urban rule / zoning rule** | Either imported geographic rule/text/variables with a plan vintage, or an authored proposal rule specifying allowed/required form. The point-query API can return overlapping source rules; agent intake selects one using vintage and variable availability. An authored `urbanRule` is not automatically an enacted source rule. | [rule route](backend/routes/urban-rules.js), [agent source](backend/agents/parcel-source.js), [authored rules](frontend/js/urban-rule-variation.js) |
| **Setback** | A distance in metres used to inset buildable geometry. App field `minDistance` and agent field `minSetbackM` express this parameter. The simple generator applies a uniform inset, not every contextual setback rule available in the separate solver. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js): `evaluateParcel`; [planner](backend/agents/planner.js) |
| **Massing / realization** | Footprint/massing geometry with vertical metadata, rendered as a volume; a stored GeoJSON polygon is not itself a 3D solid. Depending on the caller, “massing” can denote permitted form or a sampled realization. Record the role explicitly when interpreting it. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js), [planner](backend/agents/planner.js) |
| **Floor / storey / floor level** | A vertical building subdivision or its index/label. The reconstruction pipeline distinguishes below-ground, ground, upper and top storeys. A floor index, total storey count and elevation are different quantities. Local floor labels cannot be converted to a universal integer without a convention. | [envelope reconstruction](backend/floor-plans/envelope.js): `parseStoreys`, `storeyStack`; [floor models](frontend/js/building-floor-plans.js) |
| **Floor plan** | Architectural layout data or source drawing describing a floor or unit. The evidence registry uses `consensus-builder.building-floor-plans.v2`; the archive also stores source assets, readings and fitted placements. A drawing, its interpretation, and a generated default layout are distinct artifacts. | [registry DDL](backend/db/building-floor-model.sql), [archive DDL](backend/db/floor-plan-archive.sql), [site-model placements](backend/floor-plans/site-model.js), [default layouts](frontend/js/default-floor-plans.js) |
| **Unit / room** | A unit is an identified accommodation/layout within a building or floor; a room is a subdivision within a layout. Generated rooms and unit counts are design/model data, not separately registered property titles. An archive placement can have `scope: unit` or `floor` and optional `unitId`. | [unit models](backend/floor-plans/unit-models.js), [site model](backend/floor-plans/site-model.js), [floor-plan validation](frontend/js/building-floor-plans.js) |
| **Area / GFA / GBP** | Parcel/site/footprint area is horizontal area, normally m². GFA and source `max_gbp` / normalized `maxGfaM2` are floor-area amounts in m². Model GFA may be computed using floor counts and conventions; it is not necessarily a jurisdiction's exact statutory calculation. | [agent source](backend/agents/parcel-source.js), [planner](backend/agents/planner.js), [rule summaries](frontend/js/urban-rule-variation.js) |
| **Coverage / FAR** | Building coverage is footprint divided by relevant plot area; `maxCoveragePct` is percent. FAR is floor area divided by relevant plot area and is dimensionless. The adjacent solver distinguishes KIG/coverage from KIS/floor-area caps. `maxGfaM2` is an absolute limit, not FAR. “Coverage” also names binding/source completeness, an entirely separate enum. | [planner](backend/agents/planner.js), [adjacent solver](../cadastre-data/lib/solver.mjs), [binding coverage](frontend/js/proposals/site-binding.js) |
| **Height / elevation** | Height is a vertical size; elevation is position relative to a datum/reference. The simple parcel generator defaults to 3 m per floor, block massing to 3.5 m. An assumed floor height, a measured roof height, and a corridor elevation must not be exported as one unqualified number. | [urban-rule-variation.js](frontend/js/urban-rule-variation.js), [corridor levels](frontend/js/proposals/corridor-levels.js), [reconstruction envelope](backend/floor-plans/envelope.js) |
| **Source site / project site** | `floor_plan.site` identifies a crawled website by URL. A floor-plan `site_key` groups a located real-estate/project site using permit/address/parcel evidence. Neither is the embedded proposal site's geometry. | [archive DDL](backend/db/floor-plan-archive.sql), [site model](backend/floor-plans/site-model.js): `siteKey` |

### Rights, money and evidence

| Term | De-facto definition and relationships | Evidence |
| --- | --- | --- |
| **Ownership share / allocation share** | Rights snapshots use exact fractions in a parcel/right. Readjustment plot allocation uses `percentageShare`, projected to fractions of one for the deal. Contribution area/value, entitlement and assigned area/value are separate ledger quantities. They are not interchangeable ownership percentages. | [approval](frontend/js/proposals/approval.js), [readjustment ownership](frontend/js/reparcellization-ownership.js), [deal](frontend/js/reparcellization-deal.js) |
| **Ownership flow** | Publication stamp per crossed cadastral parcel: `cededM2` and destination class (`public`, `proposer`, `mapping`, `undecided`). It describes intended land effects, not the current rights holder or proof of completed transfer. | [ownership-flow.js](frontend/js/proposals/ownership-flow.js): `computeOwnershipFlow` |
| **Approval policy / regime** | Policy computes support tests and required authority decisions from a rights snapshot. Tests can count heads or area and distinguish owners/leaseholders/public bodies. A regime pins a named, versioned research template. Its modeled approval stage is not a substitute for all steps of a real legal procedure. | [approval.js](frontend/js/proposals/approval.js): `normalizePolicy`, `inspect`; [regime templates](frontend/js/proposals/approval-regimes.js) |
| **Decision receipt / withdrawal** | A signed party decision with actor, commitment, evidence and time. Current approvals and retained history distinguish active support from earlier or withdrawn support. Signature identity and proposal-content identity both matter. | [decision DDL](backend/db/proposal-owner-decision-ddl.sql), [approval](frontend/js/proposals/approval.js): `decisionContent`; [relay](frontend/js/proposals/approval-relay.js) |
| **Lens / lens member** | A proposal's selected trust set and one attester in that set. Solana members are authority public keys; directory metadata describes name, service and coverage. Membership/coverage is not an owner's vote. Display lens configuration also has EVM address entries, so keys require chain context. | [lens core](frontend/js/lens-core.js), [directory DDL](backend/routes/lenses-ddl.sql), [approval context](frontend/js/proposals/approval.js): `lensKeys` |
| **Attestation / oracle / land event** | An attributed statement and the machinery that produces or observes it. Schemas include parcel ownership, proposal verdict and market evidence. `land_event` stores source-time observations with subject, outcome, source reference/hash, attester and transaction signature. A signed assertion remains attributed to its issuer. | [lens schemas](backend/oracle/lens-schemas.js), [land-event DDL](backend/routes/land-events-ddl.sql) |
| **Agent / user / author** | Browser “agents” include the user-controlled profile and simulation actors. Backend agent runs describe automated work and cost. A paid-agent publication stamp depends on settled x402 provenance. Neither a profile name nor `author` proves a wallet identity or land right. | [profiles](frontend/js/user-management.js), [agent DDL](backend/db/agents-ddl.sql), [serializer](backend/proposals/serializer.js) |
| **Offer / budget / deposit / disbursement** | Distinct financial terms: offered consideration, separate budget, deposit settings and payout mode. Votes exclude specified money terms. In a readjustment, the proposal offer must equal the outgoing owner cash ledger; owner payments are separately represented, and cash-bearing deals currently require EUR. | [DDL](backend/routes/proposals-ddl.sql), [kind validation](frontend/js/proposals/proposal-kind.js), [deal](frontend/js/reparcellization-deal.js): `content`, `schedule` |
| **Gain / uplift** | An estimate derived from existing/proposed floor area and valuation inputs. It is neither a cash balance nor observed transaction proceeds. Record assumptions and the area basis. | [gain](frontend/js/proposals/gain.js), [planner](backend/agents/planner.js) |
| **Market / contest** | A market is a betting instrument associated with a chain proposal account, including a named plan's account. A contest groups entries transitively through shared cadastral parcel IDs. Shared IDs can group disjoint takes of one parcel; site-only overlaps do not establish membership through that algorithm. A contest is not a formal conflict or exclusivity proof. | [contests](backend/markets/contests.js): `groupByLand`, `contestId`; [market question](frontend/js/bets/market-question.js) |
| **Fingerprint / hash** | A commitment to a specified projection, not a universal identity function. Browser content/legacy consent/effect hashes, SHA-256 approval commitments, readjustment deal hashes and plan hashes cover different fields and use different algorithms. Equality is meaningful only with the scheme/version and canonicalization rules. | [sharing](frontend/js/proposals/sharing.js), [ownership effect](frontend/js/proposals/ownership-flow.js), [approval](frontend/js/proposals/approval.js), [deal](frontend/js/reparcellization-deal.js), [plan hashing](backend/plans/plan-hash.js) |

## Relationships and cardinality

These are implementation relationships, not OWL axioms. “0..n” includes missing/unavailable data; it does not assert that the real world has no such relationship.

| Subject → relationship → object | Observed cardinality / qualification |
| --- | --- |
| Named plan → member → proposal row | 1..n at creation, ordered and deduplicated. Proposal → plans is 0..n. Rows can later be missing or changed. |
| Named plan → supersedes → named plan | 0..1 predecessor; predecessor → successors is 0..n. |
| Proposal → declares → cadastral parcel | 0..n for material site proposals; parcel acts require land. Parcel → proposals is 0..n. |
| Proposal → occupies → site | At most one embedded site geometry, potentially multipolygon. Older/draft records may lack it. |
| Site + source frame + tolerance → binding → parcels | Publication binding is computed; future bindings can differ. A touched parcel is not necessarily bound. |
| Proposal → has design → building/structure/corridor/layout | Heterogeneous nested content; building/segment/plot collections can contain several objects. No universal one-proposal/one-building rule. |
| Applied formation → produces → fabric pieces | 0..n runtime results, including body and remainders; provenance may span multiple cadastral parcels. |
| Authored readjustment plot content → materializes as → plot pieces | 0..n per applied composition. Each plot piece names the producing proposal and original plot-content fingerprint; readjustment remainders carry a separate role without that fingerprint. |
| Rights snapshot → parcel/right → party + share | Many-to-many through holdings; completeness and fractions are part of the statement. |
| Party → represented by → actor for a decision | Checked through scoped authority evidence; not an unconditional identity equivalence. |
| Proposal → approval context → rights + policy + lens | One normalized context per inspected record; the default lacks rights and uses unanimity. |
| Decision → refers to → party, actor, proposal commitment | A signed event; multiple historical decisions can concern the same party/proposal. |
| Building identity → floor-model version | 0..n versions; at most one current version. Source and containing-proposal namespace are part of identity. |
| Authored urban rule + land → permitted massing → example build-out | Separate normative and illustrative representations; the seed determines a sample. |
| Source rule + parcel/context → solver result | Derived evidence with constraints/provenance; not identity with the rule or the physical building. |
| Plan/proposal → chain reference → market | Optional; chain/network qualification is necessary. A market outcome is not a cadastral ownership record. |

```mermaid
flowchart LR
    Plan[Named plan] -->|ordered members| Proposal[Proposal record]
    Proposal -->|declares| Cadastre[Cadastral parcels]
    Proposal -->|occupies| Site[Proposal site]
    Site -->|computed against source frame| Binding[Parcel binding]
    Binding -->|bound parcels| Cadastre
    Proposal -->|authored design| Design[Buildings / corridors / layouts / rules]
    Proposal -->|local apply| Fabric[Live fabric pieces]
    Fabric -->|provenance| Cadastre
    Proposal -->|approval context| Context[Rights + policy + lens]
    Context --> Rights[Party holdings and shares]
    Rights --> Cadastre
    Decision[Signed decision] -->|party and actor evidence| Rights
    Decision -->|commits to| Proposal
    Proposal -->|optional mint or mirror| Chain[Chain account / token]
    Chain --> Market[Prediction market]
```

## Audit register — findings and resolutions

| ID | Finding and evidence | Consequence / decision to make |
| --- | --- | --- |
| V01 | **“Proposal ID” means row ID, authored ID or chain ID. Partially resolved 2026-10-19.** Baseline lookup preferred row IDs but fell back to authored IDs; creation accepted three synonymous input keys; `/plans` called numeric IDs “minted”. [routes](backend/routes/proposals.js), [plan validation](backend/routes/ens-plans.js) | Lookup now uses disjoint row/authored namespaces, creation accepts only `proposalId`, and HEAD headers name the two identifier kinds. Named-plan requests/responses and their consumers now use `proposalRowIds`, `proposalRowId` and `authoredProposalId`; membership does not imply minting. The identifier table above defines the chain distinction. Remaining: qualify general proposal API/browser identifiers and export identities in coordinated small changes. |
| V02 | **“Plan” means a named collection, local composition, statutory source, or drawing. Partially resolved 2026-10-19.** Named-plan order is also different from formation replay order. [plan store](backend/plans/plan-store.js), [replay](frontend/js/proposals/plan-order.js) | Sharing, replay, applied-proposal statistics and grain-score scope now use qualified labels in all four locales. “Create named plan” fixes selected membership; untitled named plans show their slug in scoring. [The contract](plans.md#named-membership-and-local-application) separates membership, local application, sharing selection, chronology and dependency. Calculation, replay order and data formats are unchanged. Remaining: internal `sharePlan`/`plan` names, statutory-plan/drawing terminology, and the separate scoring correctness issue V19. |
| V03 | **Fork immutability enforcement and complete commitments. Resolved in code 2026-10-19; locally verified.** Baseline operator scripts could overwrite published content and plan membership; absent hashes could yield `changed: false`. The normal editor already forked published/minted designs. | [Database guards](backend/db/publication-immutability.sql) now reject authored-content and named-plan identity updates, including operator UPSERTs. [Plan validation](backend/plans/plan-commitment.js) requires complete member commitments; invalid plans are rejected/recreated, and minting checks actual content and aggregate agreement. Retained proposal rows provide history without duplicate snapshots. Mutable metadata is explicit. Database enforcement takes effect when its deployment DDL is applied; no persistent database was changed during verification. |
| V04 | **Plan hashes omitted authored decision kind and site. Resolved 2026-10-19.** The baseline probe showed that changing either field left an ordinary member hash unchanged; the readjustment deal fingerprint also omitted this proposal-level scope. The former site exclusion conflated authored geometry with its PostGIS projection. [plan hashing](backend/plans/plan-hash.js), [sharing](frontend/js/proposals/sharing.js) | Every plan member now commits to `proposal_data.kind` and `proposal_data.site`; readjustment deal fingerprints remain components of that wider commitment. One current SHA-256 path replaces the old path, with no compatibility verifier or migration. [Focused headless unit tests](backend/test/plan-hash.test.js) cover both member types; [route tests](backend/test/ens-plans.test.js) verify drift reporting without rewriting the stored hash. This resolves the missing plan scope, not every difference between plan, sharing and consent projections. |
| V05 | **“Parcel” collapses source cadastre, tax/provider units, authored plots and runtime pieces. Partly addressed 2026-10-19.** Selection labels distinguish source parcels, connected source parts, formed ground, readjustment plot pieces and remainders. Explicit `readjustmentPiece` roles resolve the producer-only ambiguity; plot pieces retain a proposal-scoped fingerprint of their authored geometry/allocation through cuts and replay. Custom URL sources now qualify native/geometry references by the selected link and retain source identity on their features. [Materializer](frontend/js/proposals/apply/parcels.js), [plot content](frontend/js/reparcellization-deal.js), [presentation rules](frontend/js/ui/parcel-menu-model.js), [custom source identity](frontend/js/parcels/custom-url-identity.js) | Still open: consistent provider/jurisdiction/version qualification and other parcel-labelled surfaces. A custom URL does not prove a dataset version or cadastral authority. Plot content identity changes with authored geometry/allocation edits; no continuing plot identity across edits or legal lot identity is claimed. Geometry equality or shared labels do not establish cross-proposal entity identity. No authored-record migration or alternative reader was introduced. |
| V06 | **“Owner” has unrelated namespaces.** Rights `ownerId` can be an authority/leaseholder; `actorId` is a signer; readjustment uses `ownerKey`; floor-model `owner_id` is the containing proposal; user profiles use agent IDs. [approval](frontend/js/proposals/approval.js), [floor registry](backend/buildings/floor-models.js), [readjustment](frontend/js/reparcellization-ownership.js) | Use party, holder, actor, allocation party and containing proposal as distinct roles. Do not generate a generic `owns` triple from every owner-shaped field. |
| V07 | **Acceptance representations disagree in granularity. Partly addressed 2026-10-19.** Local owner-state reads no longer synthesize per-owner decisions/timestamps from parcel flags. Current local tallies require matching term commitments, a nonempty roster and proposal parcel membership; hashless records and missing evaluators cannot count. Seller-offer creation no longer presets parcel consent; the SQL comments describe the parcel-keyed local record shape. [Bookkeeping](frontend/js/proposals/owner-acceptance.js), [validity](frontend/js/proposals/ownership-flow.js), [DDL](backend/routes/proposals-ddl.sql) | Signed decisions remain separately verified party/actor/evidence receipts. API/portable projections now omit stored unsigned claims and imports cannot inherit them; local persistence retains their own history. Still open: local comparison projections, roster authority and approval-labelled surfaces. No aggregate flag or unsigned local record establishes signed authority; old hashless records require a new acceptance. |
| V08 | **“Executed”, “accepted”, “applied”, “published” and “built” are not one state axis. Partly addressed 2026-10-19.** Seller offers now display funding readiness without presumed approval; terminal/deadline states take priority. Purchase simulation now has its own browser-local result and cannot change shared lifecycle, funding, authored recipients or commitments; portable projections exclude it. The no-op seller funding/acceptance control is removed; acceptance records consent without automatic execution, map application, ownership transfer or simulated support settlement. Withdrawal preserves recorded lifecycle and map state, and map application no longer blocks EVM withdrawal. EVM acceptance reads its resulting lifecycle at the confirmed receipt block; read failure preserves the old status with an explicit notice. New verified EVM/Solana mirrors retain the observed chain status and observation time instead of assuming Active; unknown values prevent publication. Portable/API records omit unverified root execution timestamps across all lifecycle states. [Display lifecycle](frontend/js/proposals/lifecycle.js), [execution](frontend/js/proposals/execution.js) | Still open: separate evidence for local simulated execution, verified payment/owner consent, chain settlement, legal registration and physical construction. Provenance of older execution claims, remaining execution-evidence presentations and evidence for real-world sale completion remain unresolved. API expiry can also precede chain settlement. |
| V09 | **Classification is scattered. Partly addressed 2026-10-19.** `type`, `goal`, `typologyType`, several `kind` fields, and facets cover different axes. Structure archives now accept exactly `park`, `square`, `lake`, or `station` in `structureProposal.kind` on export and import; the root `kind` remains the independent decision kind. Station parameters survive round trips. Archives use the shared local-state stripping boundary and also omit browser row links and unsigned local acceptance records/aggregates. [adapters](frontend/js/proposal-editor-adapters.js), [kind](frontend/js/proposals/proposal-kind.js), [exporter](backend/proposals/structure-reconstruction-geojson.js) | The station coverage gap is resolved and tested. The broader design-category concept scheme remains open. Archives retain authored structure geometry and metadata; application, simulated purchases and unverified execution timestamps do not become portable claims. Existing files are not rewritten. |
| V10 | **“Site” names geometry, a crawled website and a located project group.** [proposal site](backend/routes/proposal-site-ddl.sql), [archive](backend/db/floor-plan-archive.sql), [site model](backend/floor-plans/site-model.js) | Use proposal site, source website and project site. Their identities and properties differ. |
| V11 | **“Envelope” and “massing” mix constraints, examples, reconstruction and bounds.** The app's simple generator does not enforce all constraints handled by the adjacent zoning solver. [variation](frontend/js/urban-rule-variation.js), [archive envelope](backend/floor-plans/envelope.js), [adjacent solver](../cadastre-data/lib/solver.mjs) | Qualify envelope by role, rule source/version and solver. Do not equate an illustrative volume with either an existing building or a complete permission. |
| V12 | **Resolved for agent candidates, 2026-10-19.** `proposedGfaM2` is the measured gross floor area of the sampled building that `record-builder` publishes. It drives modeled gain, offer, score and picker descriptions. A sample above a stated footprint-coverage or GFA ceiling is rejected; a coverage ceiling requires a positive parcel area. No scalar-only cap or `scoreParts.capped` flag remains. [planner](backend/agents/planner.js), [publication](backend/agents/record-builder.js) | The permitted envelope is separate from the sampled building. The planner does not search for maximum capacity or retry smaller designs, so rejection does not prove the parcel has no feasible design. Targeted tests measure the actual published building and compare its area and offer with the candidate; older experimental proposals are not rewritten. |
| V13 | **“Footprint” and “coverage” need a subject.** Building footprint, proposal footprint, site, ground surface and corridor centerline are intentionally different geometries; coverage can mean area ratio, source completeness, or attester coverage. [footprint parts](frontend/js/proposals/footprint-parts.js), [binding](frontend/js/proposals/site-binding.js), [lens core](frontend/js/lens-core.js) | Give geometry/measurement roles explicit names. Do not delete distinct geometries as duplicates merely because they overlap. |
| V14 | **Resolved for API reconstruction, 2026-10-19.** The authority table declares the source and precedence for each duplicated field and the verified-mirror override. The API emits only `onchain`, from SQL even when null; stale JSON cannot revive a cleared attachment. Creation rejects `onchainData`. [serializer](backend/proposals/serializer.js), [DDL](backend/routes/proposals-ddl.sql) | Multiple physical storage projections remain, but do not establish multiple entities. Unsigned approvals, approximate numeric money conversion and other evidence limitations remain under their own findings; declaring precedence does not verify those claims. |
| V15 | **Open-ground accounting can read as a title assertion. Partly addressed 2026-10-19.** New subdivision labels and site/create help now state unknown ownership, explain omitted draft accounting, and qualify the authority-verdict requirement as on-chain execution. The `UnrepresentedGroundEntry` definition records the actual null/zero cash representations and absent recipient allocation. [subdivision](frontend/js/proposals/subdivision.js), [binding](backend/proposals/binding.js), [editor](frontend/js/reparcellization.js) | Internal `noOwner` naming and other ownership-labelled surfaces remain open. Coverage `unknown`, absent parcel records, public ownership and legally ownerless land remain distinct. No cash, approval or hash contract changed; no model marker supplies legal ownership evidence. |
| V16 | **Several “shares” and financial quantities coexist. Partly addressed 2026-10-19.** The seller dialog no longer treats the `funded` readiness flag as a monetary amount; its unsupported Fund/acceptance action and fabricated shortfall are removed. Exact rights fractions, plot percentages, contribution ratios, assigned values, cash payouts, budgets and gains use different bases. Market percentages now name their stake-pool basis, separately from payout multiples and probabilities. Default proposal currency is USD, while cash readjustment is EUR and cash-free deals have no effective currency. [DDL](backend/routes/proposals-ddl.sql), [approval](frontend/js/proposals/approval.js), [deal](frontend/js/reparcellization-deal.js) | Name numerator, denominator, unit and currency. Never export an unqualified `share` or treat modeled gain as consideration paid. |
| V17 | **Resolved as a distinct relationship, 2026-10-19.** Contest membership is transitive connectivity through shared parcel references. It can link disjoint proposals on one parcel and does not group site-only proposals by intersection. Market help now states the grouping basis and that multiple proposals in a group can execute; headings use the plural rather than imply one winner. [contests](backend/markets/contests.js): `groupByLand`, [help](frontend/index.html): Bets sheet | Preserve contest membership separately from “conflicts with”, “overlaps”, and “alternative to”. No geometric conflict relation is inferred or exported from this grouping. |
| V18 | **Cited discrepancies resolved, 2026-10-19.** The kind document describes the implemented enum, sale-offer consent boundary and independent structure category, while marking result reporting and sponsorship as planned. Its dated milestones remain historical. The site-binding header now describes the server’s site-local operation frame. The lifecycle definition distinguishes creation defaults from Unknown reads. [kind document](proposal-kinds.md), [kind code](frontend/js/proposals/proposal-kind.js), [binding header](frontend/js/proposals/site-binding.js), [server](backend/proposals/binding.js) | Source-checked against the executable definitions; keep documentation current with each related change. This resolves the specific audited discrepancies, not every historical design note in the repository. |
| V19 | **Named-plan scoring identity and materialization were conflated. Resolved for current-session scoring, 2026-10-19.** The old filter followed replacement ancestry and then measured the whole live fabric on member anchors. [Membership rules](frontend/js/proposals/grain-score-rules.js) now require every verified unchanged member by exact published row identity, with no outside applied proposals. [Grain scoring](frontend/js/proposals/grain-score.js) measures captured features after ground loading and rejects incomplete named-result geometry or a changed revision before inspection. | **Current contract:** only the exact named members may be applied, including when outsiders appear distant. Scoring does not unapply anything automatically. The assessment describes current ground/runtime inputs and one fabric revision. Isolated evaluation in a mixed composition and historical reproducibility remain unimplemented capabilities, not guarantees of immutable plan membership. |

## Existing machine-readable semantics

This repository already uses Schema.org JSON-LD for the website/application and instructional pages. The real-estate catalogue emits `Apartment`, `ApartmentComplex`, `PostalAddress` and quantitative floor size. The floor-plan ingestion pipeline also reads third-party JSON-LD. [Application markup](frontend/index.html), [instructional page](frontend/how-to-use-buildings.html), [catalogue generator](backend/routes/novogradnje.js), [page evidence reader](backend/floor-plans/page-evidence.js).

Those are useful existing integration points. The audited proposal/plan/parcel transport remains application JSON, GeoJSON and chain metadata; the audit did not find a shared domain RDF ontology or JSON-LD context for these core records. JSON Schema validates JSON shape; a JSON key named `schema` or a chain attestation schema does not itself supply RDF meaning.

## External vocabulary assessment

Checked against primary sources on 2026-10-19. Schema.org's live pages display a development-version banner and version 30.1/date 2026-09-16; pin a release when implementing an exporter. The recommendations below are **proposed alignments**, not equivalence assertions or already-implemented integrations.

### What Schema.org can express usefully

| Local subject | Candidate mapping | Fit and limits |
| --- | --- | --- |
| This vocabulary and its entries | [`DefinedTermSet`](https://schema.org/DefinedTermSet), [`DefinedTerm`](https://schema.org/DefinedTerm), `termCode`, `inDefinedTermSet` | Publish discoverable definitions, identifiers and labels. A glossary term is not the same resource as a proposal instance or an RDF class. |
| Proposal document | [`CreativeWork`](https://schema.org/CreativeWork), with a local proposal type | Good for title, description, creator, dates, language, subject and media. Keep local predicates for decision kind, cadastral binding and approval policy. |
| Named plan | [`Collection`](https://schema.org/Collection) plus an ordered [`ItemList`](https://schema.org/ItemList) / `ListItem`, or an RDF list | Preserve membership order and commitment/version separately. [`Project`](https://schema.org/Project) denotes an organized undertaking and is an `Organization` subtype; it is not a synonym for a plan document. |
| Physical place / source building | [`Place`](https://schema.org/Place), with applicable specialized types | Use `House`, `Apartment`, `ApartmentComplex`, `Residence`, `Park`, etc. only where their definitions fit. The reviewed [type hierarchy](https://schema.org/docs/full.html) has no general `Building`, `LandParcel` or zoning-envelope class. Use local types and domain vocabularies for those meanings. |
| Unit layout / architectural drawing | [`FloorPlan`](https://schema.org/FloorPlan), [`Drawing`](https://schema.org/Drawing), [`ImageObject`](https://schema.org/ImageObject) | `FloorPlan` is accommodation-oriented, including common layouts for similar accommodations. It is not every architectural drawing or a statutory spatial plan. Link a source drawing and its interpretation separately. |
| Building location and quantities | [`PostalAddress`](https://schema.org/PostalAddress), [`GeoCoordinates`](https://schema.org/GeoCoordinates), [`QuantitativeValue`](https://schema.org/QuantitativeValue) | Good for discoverable summaries. For `floorSize`, `MTK` denotes m². Keep statutory/model area definitions and measurement provenance explicit. |
| Simple spatial summaries | [`GeoShape`](https://schema.org/GeoShape), `geo`, spatial predicates on `Place` | Can describe simple geographic extents. Its polygon text uses latitude/longitude point convention, whereas GeoJSON positions use longitude/latitude. It is not a lossless substitute for our multipolygons, holes, elevations and role-tagged geometry. |
| People and organizations | [`Person`](https://schema.org/Person), [`Organization`](https://schema.org/Organization) | Use when the entity's nature is known. An opaque `ownerId`, wallet key or containing-proposal ID cannot safely be typed as a person. |
| Ownership and offers | [`owner`](https://schema.org/owner), [`OwnershipInfo`](https://schema.org/OwnershipInfo), [`Offer`](https://schema.org/Offer) | `owner` can summarize a supported person/organization relationship. `OwnershipInfo` is oriented to products/services and does not cover our rights, shares, representation and consent model. An actual commercial offer can use `Offer`; an arbitrary proposal or vote should not become one. |
| Listing / construction business | [`RealEstateListing`](https://schema.org/RealEstateListing), [`HomeAndConstructionBusiness`](https://schema.org/HomeAndConstructionBusiness) | A listing is a page describing real-estate offers; a construction business is a business. Neither represents a cadastral unit, construction design or envelope. |
| Structured datasets and source documents | [`Dataset`](https://schema.org/Dataset), [`Legislation`](https://schema.org/Legislation), [`3DModel`](https://schema.org/3DModel) | Useful for cadastral releases, actual legislative documents, and model assets. A proposed rule is not enacted legislation; a mesh asset is not the physical building. |

Do not use `Landform` merely because a resource is land: it describes geographic formations, not the administrative parcel concept. Do not use `sameAs` for “similar to”, “derived from”, “located on”, or “this survey probably depicts that building”. Those relationships carry different assertions. [Landform](https://schema.org/Landform), [sameAs](https://schema.org/sameAs).

### Domain vocabularies that fill the gaps

| Vocabulary / standard | Proposed use here | Scope and adoption judgment |
| --- | --- | --- |
| **BOT — Building Topology Ontology** | Physical building topology: `bot:Site`, `bot:Building`, `bot:Storey`, `bot:Space`, `bot:Element`; `hasBuilding`, `hasStorey`, `hasSpace`. | A compact way to connect buildings, storeys and rooms. A BOT site is not automatically a legal parcel. Proposed/model objects must remain distinguishable from surveyed ones. BOT is published by the W3C Linked Building Data Community Group, not a W3C Recommendation. [Ontology](https://w3c-lbd-cg.github.io/bot/), [group](https://www.w3.org/community/lbd/) |
| **IFC / ifcOWL / buildingSMART Data Dictionary (bSDD)** | Refer to established construction element/property classifications; use versioned bSDD identifiers for verified concept mappings. IFC becomes relevant for actual BIM interchange. | bSDD is a dictionary service with term/property/unit/translation relationships, including RDF/Turtle access. It is not the entire IFC schema. ifcOWL is a much larger IFC-derived ontology with documented conversion limitations; do not claim IFC conformance from attaching an IFC label to a polygon. Start with references, not a wholesale replacement of the app model. [ifcOWL and RDF access](https://technical.buildingsmart.org/standards/ifc/ifc-formats/ifcowl/), [schema versions](https://technical.buildingsmart.org/standards/ifc/ifc-schema-specifications/), [bSDD service](https://www.buildingsmart.org/users/services/buildingsmart-data-dictionary/) |
| **OGC GeoSPARQL 1.1** | Spatial entities as `geo:Feature`, separate `geo:Geometry`, `geo:hasGeometry`, and supported literals. `geo:asGeoJSON` / `geo:geoJSONLiteral` can preserve existing GeoJSON geometry; `geo:asWKT` / `geo:wktLiteral` is another option. | Best immediate RDF fit for cadastral/site geometry and spatial queries. GeoJSON literals use CRS84 longitude/latitude; declare CRS/axis order for other encodings. Keep footprint, site and centerline roles separate; geometry intersection alone is not the application's tolerance-based binding rule. [Standard](https://docs.ogc.org/is/22-047r1/22-047r1.html) |
| **LADM — ISO 19152-1:2024** | Conceptual separation of parties, rights/restrictions/responsibilities, administrative units, spatial units and versioned sources. | Better starting terminology for owner/party/right than a generic `owns` edge. It is an encoding-independent conceptual standard, not a ready-made RDF namespace to invent under `ladm:`. Select and document a concrete profile before any formal class mapping. [ISO scope](https://www.iso.org/standard/81263.html) |
| **INSPIRE Cadastral Parcels and Land Use** | Source-qualified cadastral identifiers and spatial units; distinguish planning documents, zones and prescribed land use from physical land cover. | Useful alignment for European source adapters. INSPIRE cadastral geometry does not by itself provide rights/party information. These are exchange models, not automatic semantics for every worldwide parcel feed. [Cadastral parcels](https://knowledge-base.inspire.ec.europa.eu/cadastral-parcels_en), [land use](https://knowledge-base.inspire.ec.europa.eu/land-use_en), [scope](https://knowledge-base.inspire.ec.europa.eu/document/download/63cc28c8-513e-4e53-89d6-853914c0a6f4_en?filename=d2.3_definition_of_annex_themes_and_scope_v3.0.pdf) |
| **W3C PROV-O** | Source records, derived envelopes, model versions, publishers/attesters and generating activities: `prov:Entity`, `prov:Activity`, `prov:Agent`, `wasDerivedFrom`, `wasGeneratedBy`, `wasAttributedTo`. | Gives machines the distinction between an observation, estimate, authored proposal and attributed assertion. It does not verify a signature or make an assertion true. [Recommendation](https://www.w3.org/TR/prov-o/) |
| **W3C SKOS** | Stable design/decision-kind concepts, preferred labels, aliases, definitions, broader/narrower relationships and reviewed external concept mappings. | Useful for the vocabulary and multilingual UI labels. Use `closeMatch`/`exactMatch` only between appropriately modeled concepts after review; use RDFS/OWL class relations for actual class alignment. [Recommendation](https://www.w3.org/TR/skos-reference/) |
| **W3C SHACL** | Validate an exported graph: required identifiers, ordered membership, allowed kinds, geometry roles, units and rights completeness. | RDF/OWL's open-world semantics do not enforce the application's closed-world publication checks. Shapes and existing application validation should express those checks. Spatial coverage and signature validation still need their own implementations. [Recommendation](https://www.w3.org/TR/shacl/) |

### Proposed incorporation path

1. **Resolve the meanings first.** Start with V01–V08 and V11–V12. Keep a small local vocabulary for proposals, named plans, bindings, permitted envelopes, rights snapshots and decision events. Reuse external terms only where the meanings match. A general construction vocabulary will not define this application's consent model for us.
2. **Choose durable identifiers and publication policy.** Separate vocabulary IRIs, entity IRIs, document URLs, versions and geometry resources. Use globally qualified proposal/parcel/building identities. Decide what happens to entity links when a database row is copied, a cadastre changes, or a plan is superseded. Do not publish replay-local fabric IDs as permanent cadastral identity.
3. **Add a read-only JSON-LD projection.** Begin with published proposals and named plans, extending the existing public-page metadata. Keep current application JSON, GeoJSON and validation as the implementation boundary. Link source datasets/documents and derived representations with PROV; add BOT topology when actual building/floor evidence exists. A triple store is not required to publish JSON-LD.
4. **Validate with real consumer questions.** For example: “Which proposals affect this source parcel?”, “Which exact proposal versions does this plan commit to?”, “Is this volume a permission, illustration or survey?”, and “Which party/actor/evidence supports this decision?” Validate JSON-LD expansion and shapes, then compare results with the existing APIs. Schema.org validation alone cannot establish these domain relationships.

The following is **an illustrative future export**, not a current API payload. `example.org` IRIs are deliberately fictitious; no project namespace has been allocated. The graph keeps a plan, its member, the spatial site, its geometry, and a binding to a source parcel distinct. An ordered list preserves member order. A full export would also include the content commitments, source release, measured intrusion and computation time.

```json
{
  "@context": {
    "schema": "https://schema.org/",
    "geo": "http://www.opengis.net/ont/geosparql#",
    "cb": "https://example.org/vocab/",
    "members": { "@id": "cb:members", "@type": "@id", "@container": "@list" },
    "site": { "@id": "cb:hasSite", "@type": "@id" },
    "binding": { "@id": "cb:hasBinding", "@type": "@id" },
    "boundParcel": { "@id": "cb:boundParcel", "@type": "@id" }
  },
  "@graph": [
    {
      "@id": "https://example.org/plans/harbor-v1",
      "@type": ["cb:NamedPlan", "schema:Collection"],
      "schema:name": "Harbor concept",
      "members": ["https://example.org/proposals/design-a"]
    },
    {
      "@id": "https://example.org/proposals/design-a",
      "@type": ["cb:Proposal", "schema:CreativeWork"],
      "cb:decisionKind": { "@id": "cb:community-vote" },
      "site": "https://example.org/sites/site-a",
      "binding": "https://example.org/bindings/binding-a"
    },
    {
      "@id": "https://example.org/sites/site-a",
      "@type": ["cb:ProposalSite", "geo:Feature"],
      "geo:hasGeometry": { "@id": "https://example.org/geometries/site-a-v1" }
    },
    {
      "@id": "https://example.org/geometries/site-a-v1",
      "@type": "geo:Geometry",
      "geo:asWKT": {
        "@type": "geo:wktLiteral",
        "@value": "<http://www.opengis.net/def/crs/OGC/1.3/CRS84> POLYGON ((0 0, 0.001 0, 0.001 0.001, 0 0.001, 0 0))"
      }
    },
    {
      "@id": "https://example.org/bindings/binding-a",
      "@type": "cb:ParcelBinding",
      "site": "https://example.org/sites/site-a",
      "boundParcel": "https://example.org/cadastre/provider-a/parcel-42",
      "cb:toleranceMetres": 0
    },
    {
      "@id": "https://example.org/cadastre/provider-a/parcel-42",
      "@type": ["cb:CadastralParcel", "geo:Feature"],
      "schema:identifier": "provider-a:parcel-42"
    }
  ]
}
```

Before adopting such a projection, define the local predicates and their domains/ranges. A JSON-LD context maps syntax to IRIs; it does not supply those definitions by itself. Distinguish a code-list concept such as `community-vote` from an actual voting event. Do not use `owl:sameAs` or `owl:equivalentClass` to paper over unresolved findings.

## Maintenance

Baseline verification: all 90 distinct local source-link targets existed; the illustrative JSON-LD passed JSON syntax parsing (RDF expansion/SHACL validation was not performed). Four focused headless unit-test files passed, 46 tests total: `test/ens-plans.test.js`, `test/proposal-kind.test.js`, `test/proposal-schema-contract.test.js`, `test/proposal-approval.test.js`, run from `backend/` with `npx vitest run <those four paths> --pool=threads --maxWorkers=2`. The synthetic hash probe is recorded in V04. These checks do not establish deployed behavior or resolve the audit findings.

- Update this file in the same change as a domain field, meaning, relationship, identifier, state, unit, or source-precedence change. Repository instructions link here so future changes encounter that requirement.
- Every term needs a definition, representation/identity, important exclusions, relationships and implementation evidence. Give overloaded meanings distinct qualified labels even before code is renamed.
- Preserve the distinction between observed behavior and proposed changes. Resolve an audit ID only with the decision, implementation reference and date; keep its history. Do not turn this register into an assertion that an unfixed issue is resolved.
- When a hash, schema or semantic commitment changes, record the contract, date and field coverage. Retire obsolete experimental records rather than adding compatibility paths. Published commitments and signed approvals must not silently acquire new meanings.
- Recheck external mappings against a named release before implementation. Record mapping strength, rationale and source; similarity is not equivalence. Maintain preferred labels and translations independently of stable term IDs.
- Verify changed source links and examples. For documentation-only edits, inspect the resulting document and its links; run focused headless unit tests only where a behavioral claim needs confirmation. No full suite is required for this vocabulary edit.

| Date | Change |
| --- | --- |
| 2026-10-19 | Initial code-grounded vocabulary, relationship map, 18 open audit findings, existing JSON-LD inventory and proposed standards mappings. No application behavior or schema changed. |
| 2026-10-19 | Resolved V04: named-plan member hashes include authored site and decision kind for ordinary and readjustment proposals. One current SHA-256 contract; prior experimental hashes are unsupported. Recorded the policy of small verified changes without legacy compatibility flows. |
| 2026-10-19 | Partially resolved V01: defined row/authored/chain identifier roles; removed numeric authored-ID fallback from reads and edits; rejected creation aliases; renamed HEAD headers; aligned upload projection and agent input schema. Plan/browser field renames remain open. |
| 2026-10-19 | Continued V01: renamed named-plan membership fields and filter to explicit row-ID names across the API, browser and naming script; member details distinguish row IDs from authored IDs. Retired request names are rejected, with no response aliases. Storage and hashes retain their existing meaning. |
| 2026-10-19 | Clarified V03 after tracing publication/edit lineage: normal design changes already fork published/minted proposals. Narrowed the finding to operator mutation paths and incomplete hash verification; documented forks and mutable labels. Documentation only; no runtime behavior changed. |
| 2026-10-19 | Implemented V03: database guards reject published-content and named-plan identity updates; complete commitments required by plan API/ENS; minting checks current members and the aggregate hash. Added the semantic coherence roadmap. No old-data compatibility or hash restamping path was added. |

V04 verification: 58 targeted headless unit tests passed across `test/plan-hash.test.js`,
`test/ens-plans.test.js`, `test/readjustment-publication.test.js` and
`test/proposal-approval-publication.test.js` (from `backend/`, `npx vitest run <those four paths>
--pool=threads --maxWorkers=2`). The run completed without being stopped. This checks the hash
contract, API drift reporting and publication/approval integration with mocked storage; it does
not verify a deployed database or chain mint.

V01 verification: 221 targeted headless unit tests across eight files:
`test/proposal-identifiers.test.js`, `test/proposal-upload-identifiers.test.js`,
`test/proposals.test.js`, `test/proposal-edit-auth.test.js`, `test/agent-proposals.test.js`,
`test/ens-plans.test.js`, `test/chain-mirror.test.js` and `test/proposal-lineage.test.js`,
run from `backend/` with `npx vitest run <those eight paths> --pool=threads --maxWorkers=2`.
The initial run had three incorrect test expectations; after correcting those, the affected
`test/proposals.test.js` rerun passed all 114 tests. The other seven files passed in the initial
run. Neither run was stopped. Storage, payment and chain boundaries were mocked; no live
database, payment or mint was changed.

V01 named-plan API verification: 79 targeted headless unit tests passed across
`test/ens-plans.test.js`, `test/proposal-plans.test.js`, `test/proposal-url-entry.test.js`,
`test/grain-score-wiring.test.js`, `test/plan-hash.test.js` and `test/backfill-plan-supersedes.test.js`.
Seven selected headless Playwright tests passed across `named-plans.spec.ts`,
`grain-score-route-controls.spec.ts`, `bets-button-controls.spec.ts` and
`proposal-button-controls-extra.spec.ts`: plan creation, discovery, opening, supersession and scoring.
The first browser attempt ended during server startup before running any tests; the successful
run used a local static server. Both completed test runs finished without being stopped. Storage
and network API boundaries were mocked; no live database or chain was changed.

V03 verification: the initial two-file headless unit run passed 39 tests, and a separate static
schema-contract run passed seven. The final targeted set was seven files: `plan-commitment`,
`ens-plans`, `ens-route`, `plan-hash`, `proposal-edit-auth`, `proposal-lifecycle-oracle` and
`proposal-schema-contract` (each `backend/test/<name>.test.js`). Its initial run passed 131/132;
one plan-name conflict request unexpectedly returned HTTP 401 instead of 409. The affected
26-test file passed on rerun; a controlled sequential run of all seven files then passed all
132 tests. The initial 401 could not be attributed to a code path and did not recur. The
headless PostgreSQL integration file `publication-immutability-postgres.test.js` first passed 23
tests, then passed 25 after adding two operator-UPSERT cases. Both runs used the real DDL in an
isolated schema within a rolled-back transaction on local `geodata`.
No run was stopped. No persistent database schema, stored proposal or chain state was changed.

## Continuous parcel-source processing

A **city knowledge record** is either `world-parcels/cities/<WUP code>/failed-urls.json` (a deduplicated list of unsuccessful parcel-source URL attempts, with optional reasons) or `settings.json` (working parcel source descriptors, adapter configuration, and explicit app-city bindings). An unsuccessful attempt never proves that a city has no cadastre. Settings rebuild parcel bindings and source configuration; shared adapter code preserves implementation knowledge. A **pipeline task** owns temporary research, review, or qualification inputs, logs and checks. Its completed result is reduced to city knowledge and small operational queue progress; its worktree and evidence are then deleted. Only active work may retain recovery files. The shared runtime keeps the current code generation and any interrupted transaction's rollback generation. **Intentional contract break, 2026-10-19:** permanent research packets, shared findings, snapshot sidecars, qualification histories and admission archives are retired; successful settings and failed URLs replace them. Existing unresolved domain audit findings elsewhere in this document remain open.

## Manual floor-plan processing

A **floor-plan reading task** retains its existing processor, source-hash and listing-context identity when run through the subscription CLI. Transport does not create a new drawing, apartment or building identity. A sole generated region name such as `plan-1` does not rename an unnamed apartment offer or change its public link when geometry is added. A manual invocation processes at most 30 eligible tasks from one stage and exits; it neither schedules future invocations nor submits API batches. Image and drawing work requires an eligible, current source owner; building location is optional for interpreting a confirmed floor plan; a location-review task instead starts with current candidate evidence.

The task result records `billing.mode: subscription`, the CLI engine, `cliAttempt`, and a durable `cliResponse` before applying the existing domain reader. `cost_usd: 0` means no metered API charge for that invocation, not zero subscription consumption; usage and the metered equivalent remain separate. A saved response is replayed without a new model call. An interrupted attempt without a response becomes an explicit error for inspection, so it cannot silently repeat or hold up the queue. Existing `paidResponse` checkpoints remain API evidence and are not sent to the CLI. Processing completion does not imply publication or resolve the audit findings above. [Worker](backend/floor-plans/cli-worker.js), [manual command](backend/scripts/floor-plan-cli.mjs).

The user's manual-pass policy is Codex CLI with `gpt-6.1-sol`, medium or high effort, and at most 30 task identities per pass. The command defaults to high effort; explicit model/effort choices override a reader's cheaper tier, including image triage. Attempt checkpoints record those choices. Retrying a rejected model request is restricted to its original task IDs and does not add another cohort.

Reader `floor-plan-vision-v15` uses `floor-plan-evidence-v4`, which includes measured grey partition strokes. A slab anchor `W14:2/W8:0` combines the measured x coordinate of one selected wall corner with the measured y coordinate of another selected corner; it is a rectilinear intersection across an aperture, not a supplied freehand coordinate or evidence of an additional wall. Both references must belong to selected source strokes. Changing the reader version creates a distinct reading-task identity and counts toward the same manual-pass limit; saved readings from earlier versions remain separate.

A public project's `thumbnailUrl` is a derived SVG image of its stored building envelope, using the same local-metre footprint/storey prisms as the detailed 3D viewer. It is a schematic preview, not a photograph, additional facade evidence, or a new reconstruction. It neither establishes a building identity nor changes location, quality or publication eligibility. Missing or invalid envelope geometry produces no thumbnail; the card states that the 3D outline is unavailable. [Projection](backend/floor-plan-archive/building-thumbnail.js), [public projection](backend/floor-plan-archive/public-catalogue.js).

A public **building context view** is a bounded view of the published project envelope and existing GDI survey meshes within 100 metres of that footprint (at most 100 survey objects). It uses the same mesh triangulation as Consensus Builder. Survey objects covered more than halfway by the project are replaced in this view by its highlighted envelope; this is a presentation rule, not a demolition claim. A common measured ground datum preserves neighbouring elevations; the project base is inferred from the overlapping survey object, or the nearest measured neighbour. Navigation permits rotation, tilt and zoom; panning is disabled. The 2022 survey may predate construction and does not establish current occupancy, facade details or apartment placement. [Query](backend/floor-plan-archive/building-context.js), [viewer](frontend/novogradnje/viewer.js).

A public **floor layout** (`inventory.floorPlans`, `scope: floor`) is a whole-floor drawing, distinct from an apartment. Reused typical floors share one layout entry with multiple `levels` and retain source hash, page and crop; their count does not increase the apartment count. Each is deep-linked under `/tlocrti/:id/`. Older archival drawings can be included with an explicit design-state description; permit years are evidence dates, not completion years. Registered archival site models (`registered:`) belong to the building-floor registry; a listing refresh retires only its own `permit:`, `address:` and `parcels:` identities. Catalogue order uses known actual construction year, otherwise planned completion year, descending, with unknown years last; the default catalogue includes older plans. [Projection](backend/floor-plan-archive/public-catalogue.js), [ordering and filters](frontend/novogradnje/catalogue.js).

Public Novogradnje projects require a retained floor-plan drawing or reconstructed plan. A map location additionally requires a `located` or `probable` building identity and a WGS84 footprint; other projects display **Nepoznata lokacija**, with no map marker, geographic envelope, placement or surroundings. This intentionally replaces the earlier location-required publication policy. A source-only project is keyed by its source listing; unrelated unlocated projects never share an unknown-location bucket. A plan interpretation and its optional building association are separate records.

Published floor plans are a shared worldwide API domain owned by the geodata API, while collection and reconstruction remain producer jobs. A publication plan has a stable opaque ID independent of geographic association or interpretation revision, a source SHA-256/page/crop, unit or floor scope, local architecture, review status and an optional qualified native building reference. A publication building ID is a source/project grouping, not proof of one physical building. Unknown-location plans have null geographic location and footprint. Novogradnje and Consensus Builder consume this same read contract; shared API metadata never exposes storage paths.

Novogradnje human-facing collection routes use plural nouns: `/novogradnje/zgrade/:slug/`, `/stanovi/:id/` and `/tlocrti/:id/`. IDs are unchanged. Singular detail routes are intentionally removed before public adoption; they are not compatibility aliases.

Private Stanovanje.plus trial revisions retain immutable original model and LLM-response checkpoints. Source-anchored refinement and visual-review records are separate artifacts. A usable-with-limitations verdict applies only to the exact model SHA-256 reviewed; it does not establish geographic registration, publication permission or construction accuracy.

A private **building outline stack** shows archive-declared above-ground storeys (including ground level) and underground storeys in a local drawing frame. It repeats the representative floor exterior schematically; it does not establish individual-storey extents, geographic placement or repeated interiors. Heights may be scaled from a cited section per level; unresolved heights use an explicit 3 m estimate. An archive characteristic-plan variant number is not a floor index. User-selected placement of that reconstruction is an illustrative inspection state unless an independently evidenced level association exists.

A private **floor registration** is a rigid horizontal transform from drawing coordinates (x right, y down) to a local east/north frame at the retained printed scale. It is fitted against an independently identified survey or cadastral footprint and bound to the exact reconstruction and geographic-evidence hashes. Known geographic identity does not settle rotation or which part of a building pair owns a characteristic plan. Comparable alternatives remain candidate previews, with no default assignment; geographic rotation does not establish the floor index or a per-level building envelope.
