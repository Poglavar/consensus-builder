# Vocabulary

The canonical definitions of concepts in Consensus Builder. Names in backticks identify their record or field representations.

[The model specification](plan-design-agreement.md) describes the protocols. [The historical semantic audit](docs/vocabulary-audit-2026-10-23.md) retains implementation history, research, superseded contracts and unresolved findings; it is not the current glossary.

## Designs, agreements and identity

### Design

An authored instruction proposing a change to land, buildings, infrastructure or rules. A `design/v1` record contains intent and applicable geometry; an agreement supplies the affected parties, allocations, money and decision rule. One design may describe multiple physical objects and participate in multiple agreements.

### Proposal

The application's local working record for a design, commonly named `Proposal` in code. It combines authored content with browser-local application and presentation state. Its local identity is `proposalId`; its published design identity is a CID.

### Draft

Editable design or agreement content that has not been published in its current form. A draft can be retained locally or returned as a private artifact.

### Goal

The kind of change a design intends, identified by the canonical design-goal registry. A goal classifies the instruction, not an existing physical object or its approval status.

### Keep-as-is design

A design that retains the selected ground or existing form while proposing different rights or terms. Its absence of new construction is an explicit design choice.

### Ownership-transfer design

A design proposing changes to rights or recipients. Transfer direction and agreement allocations specify the intended transaction; the design itself does not complete a transfer.

### Typology

A form or generation scheme within a design goal, such as Freeform, Block, Row or Detached. Typology is independent of an agreement's decision rule.

### Design origin

A reference identifying the design from which another design was copied, revised or rebound. A portable origin names the source design CID; a local origin may name a local key. Origin records lineage without making the designs interchangeable.

### Duplicate

A new local design copied from an existing design and placed independently. The source design and its agreements retain their identity and content.

### Revision

A new authored version of a design or agreement. Published content retains its original CID; changing that content creates a different record rather than rewriting the existing commitment.

### Agreement

A proposed arrangement containing one or more designs in authored order, input land and holders, output pieces, allocations, money, a decision rule and a deadline. Published `agreement/v1` content identifies its designs by CID and its outputs by piece hash.

### Binding owners' agreement

An agreement whose owners' decision rule is binding. This is the agreement kind eligible for a chain account, escrow, lens decision, execution and an execution market.

### Poll

An owners' or community agreement whose decisions are counted without binding chain settlement. A poll can be published and receive signed decisions; it is not minted.

### Agreement input

Land consumed by the included designs, with its source-qualified cadastral references and holder snapshot. Inputs can also include modeled open ground.

### Agreement output

A land piece standing on the input land after the included designs are applied. Its committed identity is a `piece1-sha256:` hash of the defined output projection, not a permanent cadastral identifier.

### Allocation

The proposed assignment of an agreement output to a party, the public or joint holders with stated shares. It describes the intended result, independently of the input land's current rights.

### Sponsor

The wallet named in a published agreement that creates its chain account and controls sponsor-only funding and cancellation actions. The sponsor is not automatically the owner of its input land or the recipient of every output.

### Agreement currentness

Whether a local agreement still matches its referenced designs, their application, and the derived input and output land. A stale agreement retains its published identity but no longer describes the current working composition.

### Local key

A browser-local identifier used to find a working record. A `proposalId` or local agreement key is distinct from a publication CID, database row ID and chain account.

### Remove from this device

Removal of a browser-local agreement copy. Its designs retain their map application, and any published agreement retains its CID and remains accessible through its link.

### Publication

The retention of canonical record bytes and their inclusion in the publication index. A locally computed CID, preview, saved draft or local map application does not by itself constitute publication.

### CID

The content address of canonical design or agreement bytes: CIDv1, SHA-256, base32, using the UnixFS file scheme with fixed 256 KiB chunks and raw leaves. A single-leaf file has a raw root; a multi-chunk file has a DAG-PB root. The CID identifies content, independently of the API indexing it.

### Canonical record

The deterministic authored projection serialized for a content commitment. Derived browser state, materialized land and rendering caches are excluded; explicit authored geometry and decoration designs are included.

### Fingerprint

A hash committing to a named, versioned projection of content. Agreement approval-context hashes and output-piece hashes have narrower scopes than a whole-record CID.

### Publication index

A service's searchable projection of published records, their derived bindings and observed chain metadata. Index metadata and observations are distinct from the immutable bytes identified by the record's CID.

### Qualified chain reference

A chain location identified by network or cluster, program or contract, and account or token identifier. A bare address or token number is insufficient to identify the same record across deployments.

## Data sources

### Source abstraction

A named data responsibility with documented reader operations, arguments, results, units and missing-data semantics. Parcels, existing buildings, building details and economics are separate abstractions. An abstraction does not choose a provider from the current location.

### Source adapter

An implementation of an abstraction's reader operations for a particular transport or dataset structure. Its configuration contract describes the source format it accepts; its runtime context supplies services such as database pools, fetch functions and credentials. Different adapters may support different optional operations.

### Source definition

A selected dataset described by stable `id`, `abstraction`, `adapter`, `kind`, readable `label` and adapter-specific `config`. A default source is registered by the application; a custom source supplies configuration to an adapter that accepts custom sources. These kinds describe configuration ownership, not legal authority or data quality. Existing domain source IDs and qualified record identities remain authoritative.

## Land and parcel geometry

### Cadastral parcel

A land unit represented by a particular cadastral, tax or other parcel provider. Its identifier and meaning belong to that source; a displayed polygon alone does not establish registered title or equivalence with another provider's unit.

### Parcel source

The provider of parcel identities and geometry, identified by `sourceId`. Jurisdiction and legal authority describe the source but do not replace its identity. A custom source descriptor identifies the selected service and its interpretation. Map lookup and server-side site binding use that same selected parcel source.

The frontend consumer owns source configuration and sends its selected source explicitly. Backend services validate and serve that selection; they do not infer a city default.

### Source-qualified parcel reference

A parcel ID qualified by its source and, when available, snapshot. Equal unqualified IDs or overlapping polygons do not establish identity across sources.

### Source snapshot

An identified captured state or release of a provider's data. A null `snapshotId` means the snapshot is unknown, not that two observations necessarily describe the same release.

### Parcel set

A canonical sorted set of parcel IDs with its parcel-source descriptor. Its `setHash` commits to the IDs and normalized source identity, not to current geometry, ownership or legal authority.

### Cadastre frame

The source context captured for a cadastral-dependent calculation or commitment, including its observation time and any supplied geometry hash. It is not necessarily a reproducible copy of the entire cadastre.

### Site

The geographic land on which a design operates. An authored site can cover parts of parcels, several parcels or modeled open ground; it can be larger than the building footprint.

### Parcel binding

The derived relationship between authored site geometry and a stated parcel source, including intersections, coverage and the intrusion tolerance used. A binding describes the source observed at calculation time, rather than altering the authored geometry.

### Binding coverage

The extent to which a site has represented cadastral coverage: `complete`, `partial`, `none` for confirmed lack of supported coverage, or `unknown` for unverified coverage. Unknown or failed source data cannot establish that the site is open ground.

### Binding drift

A difference between a retained binding and a later calculation against the identified source. Drift qualifies the relationship to current source data without changing the published record's original commitment.

### Live parcel

A selectable piece of land in the working parcel fabric, including unchanged source land, formed outputs and remainders. Its runtime identity and geometry are distinct from the underlying cadastral references.

### Parcel fabric

The current modeled subdivision of land produced by source parcels and applied designs. It records the provenance and relationships of its live pieces.

### Materialization

The browser-local result of applying a design to the parcel fabric. It includes generated land pieces and other derived effects; it is not part of the portable design instruction.

### Formation

A design's operation that cuts or replaces live ground and produces land pieces. Creating a fabric piece is separate from minting a blockchain account.

### Remainder

The part of parent land left after subtracting a design's land take. A remainder retains its modeled provenance and carried rights rather than belonging automatically to the new design.

### Plot

An authored output polygon or multipolygon in a parcel layout or readjustment. It is a proposed land unit with allocation information, not a registered parcel. One record can contain several connected pieces.

### Vacant layout plot

A current plot produced by an applied parcel layout with no standing building or applied physical design occupying it. Its default display is uncultivated yellow-green ground with a boundary fence. This scenery is derived from the current composition; it is not an authored park, a recorded existing surface, a legal enclosure or a change of ownership.

### Parcel layout

A design specifying new parcel borders over its site. Applying it carries modeled rights from the input ground; the agreement specifies any proposed changes to those rights.

### Authored plot identity

A proposal-scoped commitment to a plot's authored geometry and allocation. Editing that content changes the commitment; materialized plot pieces retain its provenance without establishing a permanent legal-lot identity.

### Land readjustment

The pooling and repartitioning of input land into output plots, with contributions, entitlements, allocations and optional balancing cash. `reparcellization` is the application's record name for this concept.

### Open ground

The part of a modeled site not represented by the supplied or bound cadastral parcels. It can carry `groundIds` provenance in the fabric. Its legal ownership remains unknown.

### Unrepresented-ground accounting entry

The `unrepresentedGround` marker for open ground excluded from represented owner and cash-recipient accounting. It is distinct from public land, an unallocated plot, a missing owner record and a failed parcel query.

### Working composition

The set of designs currently applied in one browser and the land fabric they produce. This local composition is separate from an agreement, a publication selection and a statutory plan.

### Road junction

A shared same-level centerline node and its incident street arms, with the cross-sections and corner land needed to connect them. Each participating road design records its split stretches and the neighbouring arms needed to rebuild its own footprint. A crossing at different levels or through a protected bridge/tunnel span is not a road junction.

MCP plan drafting and revision author the included roads as a complete network before parcel binding and agreement output calculation. Changed junctions produce revised road designs and CIDs. Reading, applying or comparing published records does not rewrite their topology.

### Map share

A link naming a selected set of published designs and the current map view, including location and 2D, model 3D or realistic 3D mode. Selection starts with the entire applied working composition; exclusions are explicit. An unnamed map share carries its design CIDs and view in the URL. “Name this plan” saves a named plan snapshot instead. Neither form creates an agreement. “Designs” names the map's design browser; “Agreements” names arrangements and decision rules over designs.

Choosing “Unapply existing & continue” replaces the conflicting applied designs. An incoming parcel layout also replaces applied roads, layouts and content occupying its authored plots; designs outside that ground remain applied. Unapplied designs remain saved. The replacement commits together, or retains the previous working composition if any member cannot be applied.

Restoring a saved camera retains the map's display settings and surrounding context. Its selected design is highlighted without isolating it from the shared composition.

Its social preview is a derived 2D image of the included designs' authored map geometry, framed together independently of the interactive camera. The image is cached by the unique set of design CIDs and renderer revision; it is not authored plan content. Missing or failed images can be regenerated from those published records.

When shared designs conflict with the current map, the person chooses whether to unapply the existing conflicting designs and continue, skip the conflicting incoming designs, or cancel. Unapplying existing conflicts and deriving the chosen plan is atomic; failure retains the previous map. Every design remains saved, and unrelated applied designs remain on the map. Overlapping road revisions are conflicts; ordinary roads meeting at a junction remain compatible.

### Named plan

An immutable `plan/v1` snapshot containing a title, a selected set of published design CIDs and a map view. Its canonical content has its own CID and permanent `/plans/<cid>` link. Changing the title, membership or saved view creates a new snapshot and link; existing links keep their original content. It references existing designs without changing their authorship, geometry or publication. It carries no land allocations, money or decision rules; those belong to an agreement. The backend address used to access a plan is transport configuration, not part of its content.

### Applied / unapplied

Whether a design currently contributes to the working composition. Application expresses a modeled map effect, independently of consent, chain execution and physical construction.

### Replay

The reconstruction of a working composition by applying designs in their defined formation and dependency order. Display order, agreement membership order and display year do not themselves determine replay order.

### Display year

The year assigned to a design for its timeline presentation, represented by `epochYear`. It is distinct from a promised construction date and from replay precedence.

### Footprint

A horizontal outline whose subject must be qualified. A building footprint describes the building's plan outline; a corridor footprint describes occupied transport land; a design footprint combines the authored parts relevant to an operation.

### Land take

The exact ground a design consumes. A Freeform design's `geometry.landTake` can combine footprint cuts and whole touched parcels while its material building footprint stays unchanged. It governs land formation and building-removal effects.

### Demolition review

The modeled full building removals and partial cuts caused by a land take. Acceptance acknowledges those shown consequences in the editor; it is distinct from an owner's agreement decision and from real-world demolition.

### Ground surface

An authored paving or green treatment of the land around proposed buildings, represented by `geometry.groundSurface`. Paving is the default for new and edited building designs and uses ordinary sidewalk slabs, distinct from square paving. Its area excludes the stored building footprints and stays within the design’s ground boundary; a surface treatment does not independently determine land take, demolition or transfer rights.

Its visible geometry excludes applied corridor footprints in every map view, including its furniture and planting. The authored surface remains unchanged; removing a corridor restores the surrounding treatment.

### Corridor

Transport land and its authored road or track design. Its alignment and cross-section describe its form; its footprint describes the land occupied.

A corridor design's canonical stored form is `roadProposal.definition.osm`. Expanded drawing fields are a view of that form and do not independently determine the design's CID.

### Alignment

The ordered line or curve of a corridor, with its horizontal position and any stated levels or elevations. An alignment is distinct from the corridor's width and occupied polygon.

### Cross-section

The transverse arrangement of corridor elements, such as lanes and their widths. It specifies form across the alignment.

### Structure design

The application's area-feature design category, including parks, squares, lakes and stations. This category is broader than the engineering meaning of a load-bearing structure.

### Decoration design

An explicitly authored arrangement of furniture, trees or similar surroundings. Authored layouts belong to the design commitment; generated decoration caches are local rendering data.

### Map claim

A selectable item of cadastral ground, fabric or design content in the map's interaction model. This interaction term does not denote a legal claim to land.

## Buildings and planning

### Source building

An observed building object identified within a survey or provider dataset. Its geometry, identity and measurements retain that source's provenance.

### Proposed building

Authored building geometry, parameters and optional architectural evidence belonging to a design. Its representation proposes a building rather than asserting an existing surveyed object.

### Freeform building

A building design with one connected authored footprint, including any courtyard holes, and its vertical dimensions. Its land take can extend beyond that footprint.

### Imported model footprint

The connected horizontal projection of a GLB model's visible mesh triangles, including concavities and courtyard holes. It is the model's silhouette, which can include overhangs and canopies; it does not infer a foundation boundary.

### Urban-rule design

An authored rule governing possible building form on land, such as Block, Row or Detached. The design's permitted envelopes express that rule; an example build-out illustrates one realization.

### Block rule

An urban-rule design generating perimeter building form and courtyard space from its land and stated dimensions.

### Row rule

An urban-rule design generating a row arrangement of buildings from its land and stated dimensions.

### Detached rule

An urban-rule design generating separate buildings on selected parcels from its stated dimensional constraints.

### Source planning rule

A rule or planning instrument supplied by an identified authority or dataset, with its edition and applicability evidence. An authored urban rule does not become an enacted source rule by sharing its name or geometry.

### Planning representation

An inspection or display projection of a source record, existing building or authored design. It retains the subject's identity and provenance without becoming a new design or an applied change.

### Obligatory source proposal

A read-only representation of a provider record whose underlying instrument claims obligatory normative effect. Its authority, applicability and evidence quality remain separate attributes; representing it does not establish compliance or owner consent.

### Source reference

An authored reference pinning a provider record, edition or scenario and source revision. It identifies the evidence used by a design without transferring that source's authority to the design.

### Permitted envelope

The maximum building form derived under an identified rule and its supported assumptions. An authored permitted envelope is normative under that proposed rule; a source-derived envelope retains its source's legal and calculation qualifications.

### Outer bound

The combined extent of the drawable building configurations and their supported interpretations. It bounds possible forms rather than defining one constructible building.

The comparison controls label this **Max envelope**, as they do an authored rule's maximum envelope. This display label does not make alternative configurations simultaneously buildable or remove the source's qualifications.

### Configuration

One source-recorded building option, such as an allowed housing type, with its own constraints, treatment, derived geometry and availability. Configurations are alternatives, not additive permissions.

### Lot test

The comparison of a parcel's area with a configuration's stated minimum lot area. Pass, fail and unknown describe that comparison, independently of whether every rule for building on the parcel is satisfied.

### Shown configuration

The configuration selected for display. This choice changes the inspected illustration, not the source record, permitted limits or authored agreement.

### Assumed street side

A parcel edge treated as the front for a displayed calculation. It is an explicit modeling assumption unless independently established by the source.

### Example build-out

One illustrative building realization within an authored urban-rule envelope. It is neither the maximum permitted capacity nor an existing building.

The comparison controls label this **Illustration**. A source's one calculated option or displayed configuration is also labeled Illustration, retaining its own assessment and source qualifications.

### Zoning area

The geographic area to which supplied zoning evidence refers. It is distinct from a cadastral parcel, a permitted building volume and a completed compliance assessment.

### Applicability

Whether and under what conditions a source rule applies to the subject and context being assessed. Normative authority and available numeric dimensions alone do not establish applicability.

### Evidence quality

The stated strength and limitations of the evidence supporting a representation or assessment. A cached calculation, estimate and independent verification have different evidential roles.

### Massing

A footprint with vertical extent, represented as volumes or extrudable geometry. Its role must distinguish observed built form, permitted form, proposed form and an illustrative realization.

### Built / Permitted / Proposed

The three planning display roles: observed buildings; source-derived permitted massing; and the browser's applied building designs. These roles classify represented content, independently of its display appearance. Buildings and massing settings apply to every represented object in each role across the view; selecting or inspecting a parcel, building or design does not create a separate display configuration. Permitted and Proposed have independent display-only example rolls; rolling either role changes no authored design or source record and leaves the other role's example unchanged.

### Reconstructed building envelope

An interpreted exterior form assembled from architectural or geographic evidence. Its provenance and uncertainty differ from a surveyed building and a permitted envelope.

### Bounding envelope

An enclosing spatial extent used for indexing, filtering or framing. It is not the object's architectural shape or a planning permission.

### Building stock

The source-qualified building footprints considered by an operation, with any known heights or storeys. A complete query covers its stated source and bounds; a failed, clipped or truncated query leaves the operation's consequences unresolved.

## Parties, rights and decisions

### Party

A person, organization or authority identified for rights, allocations or decisions. A party can hold different rights in different parcels; the rights engine's `ownerId` is a party identifier, not an assertion of universal ownership.

### Rights holder

A party holding a stated right, such as ownership or a lease, in identified land. The right and its share are part of the rights snapshot.

### Decision actor

The signing identity acting for a party, represented by `actorId`. A party identifier, profile name and signing wallet have distinct roles even when a provider uses the same string for two of them.

### Author

The attribution supplied for a design or agreement. Authorship alone establishes neither a signing identity nor a right in the affected land.

### Rights snapshot

A declared source-qualified account of parcel rights, holders, shares, completeness and any supplied areas. A complete holder list sums to one for its stated right; separate rights are not combined into one ownership total.

### Ownership share

An exact fraction of a stated ownership right in a parcel. A lease share refers to that lease, while an allocation share refers to a proposed output; the fractions have different denominators.

### Signing authority

The evidence that a decision actor may act for a particular party in the approval context. It is checked separately from the party's rights in the land.

### Electorate

The parties eligible to decide under an agreement's rule, such as the relevant owners or a stated community. Eligibility and the required support threshold are separate parts of the rule.

### Approval rule

The policy determining counted support and any required authority decisions from the electorate and rights snapshot. It can use headcount or area and distinguish holder classes; it does not summarize every requirement of a real legal procedure.

### Approval context

The committed rights, policy and verification context against which agreement decisions are evaluated. A receipt counts only for the agreement and context it actually signs.

### Decision receipt

A signed party decision identifying the actor, agreement CID, approval context, rights or authority evidence and signing time. Receipt admission, current validity and sufficient aggregate support are separate judgments.

### Withdrawal

A later decision withdrawing previously expressed support. Decision history remains distinct from current counted support and any execution already recorded.

### Accepted parcel

A parcel-level aggregate of the agreement decisions that currently count. `acceptedParcelIds` summarizes support; it is not itself a signed decision receipt.

### Approval headcount

The number of supporting eligible parties relative to the number of parties in the specified electorate. It measures policy support, independently of their ownership fractions.

### Approval area

The area-weighted support defined by an approval rule and rights shares. Overlapping rights can contribute separate policy weights, so the result need not equal a union of physical land area.

### Lens

The selected verification trust set for an agreement or assertion. A lens identifies whose attestations the relevant rule accepts, independently of the owners' own decisions.

### Lens member

An attester belonging to a lens, identified by its chain-qualified authority key and associated service or coverage information. Directory membership is not an owner's vote.

### Attestation

An attributed statement under a defined schema, with its issuer and evidence references. Its meaning depends on that schema and issuer; a signature alone does not extend the assertion's scope.

### Agreement decision

The lens's attested statement that an agreement's approval rule is satisfied. `AgreementDecision-v1` commits to the counted evidence; it is separate from the owner receipts and the chain transaction recording the decision.

### Devnet owner registry

The modeled rights source used by the development lens member to associate parcel parties with their signing wallets. It supplies application verification context, not registered land title.

### Ownership flow

A declaration of the land a design intends to cede and its destination class or mapping. It describes intended effects, independently of current holders and completed transfers.

## Lifecycle and settlement

### Agreement lifecycle

The agreement's active, executed, cancelled or expired state, derived from its qualified chain account and deadline where applicable. Missing or unrecognized state is unknown; a design has no agreement lifecycle of its own.

### Lifecycle evidence

The provenance of a lifecycle claim: an observed matching chain state or event, a deadline-derived conclusion, or unknown evidence. An observation time is distinct from the event's own time.

### Chain agreement account

The agreement program account identified by network, program, sponsor and agreement CID. On Solana its address is derived from the sponsor and the hash of the CID; the account is separate from the published agreement content.

### Minting

The creation of a binding agreement's chain account. Publishing a design, creating a local fabric piece and computing a CID are separate operations.

### Settlement

The agreement process combining qualifying decisions, a lens decision, recorded chain state and sufficient escrow to execute, or closure by cancellation or expiry. Each step has its own evidence.

### Execution

The agreement program's recorded transition applying its settlement conditions and payout. Chain execution is separate from local design application, legal registration and physical construction.

### Land event

A source-attributed observation concerning land or an agreement, with a subject, event time and evidence reference. An agreement-executed event links an input parcel to the observed execution.

### Parcel history

The sequence of recorded events associated with a source-qualified parcel, such as agreement publication, ownership evidence and agreement execution. Events retain their respective sources and meanings.

### Escrow

The funds held by an agreement's chain account for its settlement. Its observed balance and required amount are monetary quantities, separate from authored cash allocations or a local readiness flag.

### Payout

The transfer specified by a chain agreement's settlement terms. A configured recipient or intended cash line is not a receipt proving that a payout occurred.

### Deadline

The time limiting the agreement's decision or settlement process. It is distinct from a design's display year and an estimated construction date.

## Money, value and markets

### City currency

The explicitly identified currency in which a city's monetary assumptions and authored fiat amounts are expressed. Display locale changes formatting, not currency or exchange value.

### Money line

A stated cash amount assigned to a party under an agreement, with its currency and direction. Amounts in different currencies cannot be added without an explicit conversion.

### Consideration

The payment or other value proposed in exchange for an agreement's land or rights effects. An offered amount is distinct from a funded escrow balance and an actual payment.

### Contribution

The land, value or funds supplied by a party to a stated arrangement. Land contribution area, modeled value and transferred chain tokens are distinct quantities.

### Entitlement

The area or modeled value a party is due under the readjustment's stated contribution basis and ratio. It is distinct from the land or cash actually allocated to that party.

### Readjustment cash

Incoming or outgoing balancing money in the deal's explicit fiat currency, represented canonically in integer cents. Outgoing cash, incoming cash and net balance are separate amounts.

### Token balance

An amount in the atomic units of an identified chain asset. SOL lamports, devnet USDC atomic units and authored fiat cents have different units and cannot be inferred from one another.

### Funding readiness

A local declaration that funding is considered ready. A boolean readiness flag neither measures money nor establishes sufficient escrow or a payment receipt.

### Price estimate

A modeled amount with its currency, source and basis. A source price without a usable amount or explicit currency is unknown; an area-based estimate identifies its rate and area basis.

### Economic rate observation

A source-attributed amount per stated unit, with an explicit currency, basis and, for evidence, valuation date. Land and road-land rates use land area; building sale and construction rates use floor area. Market evidence, policy appraisal and editable scenario assumptions retain separate meanings. An assessed property total is not a unit rate or a market price. Source selection changes model inputs without rewriting authored cash amounts.

### Modeled gain

An estimated change in value derived from stated existing and proposed floor areas and valuation assumptions. It is not a balance, cash offer or realized sale proceeds.

### Portfolio estimate

A modeled value of an agent's assigned land, expressed in a stated currency and conversion basis. Adding it to a wallet balance requires both quantities and their conversion to be known.

### Market

A betting instrument about a qualified binding agreement's execution. Its yes outcome is execution; its no outcome is cancellation or expiry. The subject account, market account, network and stake asset are distinct identities.

### Contest

A group of published agreements connected transitively by shared source-qualified input parcels. Geographic overlap or equal unqualified parcel labels alone does not establish membership.

### Pool share

One side's stakes divided by total stakes in the market's stated asset, usually displayed as a percentage. It is not itself an estimated probability or a payout multiple.

### Payout multiple

The modeled or contract-defined return per unit stake under a stated market outcome. It is distinct from the side's pool share and from proof that settlement has occurred.

## Architecture and measurements

### Setback

A stated distance between a building or permitted form and the relevant land boundary or reference. Its reference side and rule determine how it applies.

### Height

A vertical size in metres with an identified basis, such as measured roof height, authored building height or storeys multiplied by an assumed floor height.

### Elevation

A vertical position relative to a stated datum or reference. An elevation is not interchangeable with building height.

### Storey

A vertical subdivision of a building. A storey count, floor index, local label and elevation are separate quantities and require an explicit numbering or height convention to relate them.

### Land area

The horizontal area of a stated parcel, site, footprint or land piece, in m². The subject and measurement convention determine the quantity; land area is distinct from summed floor area and inclined surface area.

### Floor area

An area summed over the stated floors and measurement convention, in m². GFA and GBP name floor-area measures; a model's estimate need not equal a jurisdiction's statutory measure.

### Site coverage

Building footprint area divided by the relevant plot or site area. It is a fraction or percentage, distinct from parcel-source completeness.

### Floor-area ratio

Floor area divided by the relevant land area, a dimensionless intensity measure. A stated absolute floor-area limit in m² is a different quantity.

### Committed agreement area

The deterministic area value used in agreement input and output commitments, expressed in m² at 1 mm² resolution. It is a commitment measurement convention rather than a surveyed-accuracy claim.

### Floor plan

A drawing or architectural layout describing a whole floor or an accommodation unit. The source drawing, its interpreted reconstruction and a generated suggested layout are distinct artifacts.

### Published floor plan

An architectural artifact with a stable publication ID, retained source evidence, unit or whole-floor scope, architectural content and review status. Its geographic building association and interpretation revision are separate from that publication identity.

### Floor model

A versioned architectural model associated with `(city, source, ownerId, buildingId)`. For a proposal building, `ownerId` identifies the containing design rather than a landowner; version identity and the current-version designation are separate.

### Unit

An identified accommodation or layout within a building or floor. A modeled unit or its count does not by itself establish a separately registered property title.

### Room

A subdivision of an architectural layout. Its modeled walls, openings and use belong to the floor interpretation or design.

### Floor registration

A horizontal transform placing drawing coordinates into a geographic local frame at a retained scale. Registration identifies its model and geographic evidence; building identity alone does not determine drawing rotation or placement.

### Geographic building identity

An evidence-qualified association between a source or project record and a real-world building location. An archive group, address candidate and confirmed survey object are different levels of association.

## Sources, evidence and agent workflows

### City

The application's geographic context for filing records, selecting sources and expressing local assumptions such as currency. The published city is resolved from the design's place; it is not a parcel-source identity or legal authority.

### Jurisdiction

The geographic or institutional scope within which a source, rule or authority applies. Jurisdiction is source metadata, independently of a provider's ID and a displayed city name.

### Source availability

Whether an identified source or record can be obtained in the current context. Availability, freshness, completeness, evidence quality and legal applicability are independent qualifications.

### Source revision

The identified version or content fingerprint of a particular source record. A changed revision can qualify an authored source reference without rewriting the design that pinned the earlier revision.

### Source completeness

Whether a query has supplied all records promised for its stated source and bounds. A cap, failure, missing requested region or clipped query leaves coverage unresolved; completeness does not assert that the source has captured every real-world object.

### Imagery source

A visual map background supplied by an imagery provider. Selecting imagery changes the view, independently of parcel identities, rights and building geometry.

### Source website

The web publication from which evidence such as a listing or floor drawing was obtained. Its URL is distinct from a design's geographic site.

### Project site

An evidence-based grouping of source listings or building material associated with a development or location. A grouping key does not itself establish cadastral or building identity.

### Visible-division probe

An imagery-derived diagnostic of apparent physical divisions in land. Its candidate plots are interpreted visual evidence, not cadastral boundaries, ownership or approved subdivision.

### Source asset

Retained evidence such as a drawing, photograph or model file, identified by its content hash and any page or crop. Its interpretation and publication status remain separate from the asset's identity.

### Agent

A user-controlled profile or automated actor participating in the system. A profile, its modeled land assignments, an automation run and a signing wallet are separate identities or records.

### Linked parcel

A profile's association with land through a modeled assignment or an observed parcel token. These associations retain their different evidence scopes and do not establish registered ownership.

### Agent run

A recorded execution of an automated workflow, with its inputs, outcomes and any accounted costs. It does not itself establish publication, a settled payment or signing authority.

### Draft artifact

Canonical design or agreement content returned with its recomputed CID without a pin or index write. Its content address remains meaningful even when its private preview is unavailable.

### Private preview

A temporary means of inspecting a draft artifact. Its bearer link or compressed fragment conveys access to the draft, independently of permanent publication and wallet approval.

### Agent editing reference

A design or building reference scoped to one inspected immutable revision. A building reference includes its design CID and feature index; a JSON Pointer addresses authored fields within that design. These are selection addresses, not new persistent object identities. A derived land piece is inspected by its piece hash and changed through the designs that produce it.

### Agent plan revision

A private revision of an agreement's ordered design composition and terms. It rederives input land and output pieces from the revised designs. It has a new CID and carries no prior decisions or execution state; retained rights and holders remain explicitly unverified snapshots. A map share and a person's unsaved working composition remain separate from an agreement plan.

### Approval link

Navigation intent identifying an agreement or market action and optional amount or side. Opening the link does not sign a decision, transfer funds or execute the action.

### Headless working composition

A freshly derived composition used by an agent calculation over its stated source context. It is independent of the person's browser composition and must retain unknown or incomplete source evidence.

### Comparison

A report of specified designs' modeled land, buildings, quantities and agreement allocations under a stated context. Its measures distinguish authored geometry, observed sources and simulated effects.

### Unknown measurement

A quantity for which sufficient evidence or inputs are unavailable. It is distinct from a known zero; a calculation requiring that missing quantity remains unknown.

### Locale

The selected language and regional formatting convention for the interface, numbers and dates. Locale is separate from city, currency and geographic location.

## Activity

An event record describing an actor’s action, its subject, outcome and provenance. Live activity
records observed application and chain actions; simulation activity records actions in the local
simulation. Simulation history belongs to the current device and city. A missing event location
means its city is unknown, not the city currently shown on the map.

The Activity panel presents Events, Actors and Watched areas. An actor, agreement or run scope
selects related events; it does not change their identity or source. Watched areas are subscriptions
to changes in defined areas and retain their own city context.


## Feedback report

A private bug report or suggestion submitted to the maintainer inbox through the web form, MCP
or API. Its receipt UUID identifies that report; status `received` means it was stored, not that
it has been triaged or fixed. Retrying the same receipt and content is idempotent; reusing the
receipt for different content is refused. Report text is not a published design, agreement,
wallet decision or instruction to an agent. The inbox has no public listing.

The maintainer can receive a private Telegram notification with a bounded text excerpt and the
receipt ID. Notification delivery is separate from report receipt: `telegram_notified_at` records
confirmed delivery, while `telegram_attempted_at` and `telegram_attempts` track retries. Delivery
does not mean the report has been read, triaged or fixed.
