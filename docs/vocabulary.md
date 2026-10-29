# Vocabulary

The canonical definitions of concepts in Consensus Builder. Names in backticks identify their record or field representations.

[The model specification](plan-design-agreement.md) describes the protocols.

### Autonomous proposed-design selection

An explicit persona policy ranking proposed building floor area and the parcel ground outside its footprint. Mapped controls retain their source; missing controls are recorded as design assumptions. Existing-stock measurements, net floor-area uplift and modeled gain remain unknown without a complete named inventory. The separate uplift policy requires that inventory and a mapped urban rule. A retired experimental agreement is a terminal automation skip, not a chain execution or settlement. Sponsor market seed liquidity has an explicit devnet allowance separate from trading budgets; seeding does not buy sponsor shares.

## Designs, agreements and identity

### Design

An authored instruction proposing a change to land, buildings, infrastructure or rules. A `design/v1` record contains intent and applicable geometry; an agreement supplies the affected parties, allocations, money and decision rule. One design may describe multiple physical objects and belong to multiple plans. Its agreement memberships follow those plans.

### Local design record

The application’s working record for a design, still named `Proposal` in internal code. It combines authored content with browser-local application and presentation state. Its local identity is `proposalId`; its published design identity is a CID. The interface calls this a Design; “proposal” is informal language, not another domain entity.

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

An arrangement referencing exactly one immutable plan revision, with input land and holders, output pieces, allocations, money, a decision rule and a deadline. Published `agreement/v1` content names the plan with `planCid` and its outputs by piece hash. The plan supplies all design membership; it must be created independently before it is selected for an agreement. The agreement has no independently authored spatial layout or design list. Several agreements can reference the same plan. A local editing record can cache design references for replay and preparation, but publication must match the referenced plan exactly.

### Counter-agreement

A new agreement drafted from an existing agreement's plan and terms, optionally under another scheme. It references the same plan revision and is an ordinary agreement once saved; no record field links it to the agreement it answers.

### Binding owners' agreement

An agreement whose owners' decision rule is binding. This is the agreement kind eligible for a chain account, escrow, lens decision, execution and an execution market.

### Poll

An owners' or community agreement whose decisions are counted without binding chain settlement. A poll can be published and receive signed decisions; it is not minted.

### Nonbinding community agreement

An agreement asking for nonbinding community support for its referenced plan. It carries no land allocations, cash transfers or owner approval rule. Its optional `consultation` metadata names an organiser by a canonical `did:web` identifier and an HTTPS participation page. Changing the referenced plan or participation metadata creates a new agreement CID; reporting results does not change the agreement.

### Agreement organiser

The website identified by a community agreement's `consultation.organiser`. Its DID document lists wallets under `assertionMethod` that may report on its behalf, qualified by network and address using CAIP-10. Live website verification confirms only that the site currently lists the signing wallet; it establishes neither organisational legitimacy nor the correctness of an agreement’s decision procedure or result.

### Community result report

An immutable `community-result/v1` record containing the agreement CID, organiser DID, signing wallet, a plain-text statement, optional HTTPS report link, signing time and a committed DID-document snapshot, with a wallet signature over those fields. Reports are content-addressed, pinned and indexed append-only; later statements retain earlier reports as history. Reports may follow the agreement deadline and require no mint or chain transaction. Readers reverify both the signed record and the website's current wallet list. Solana message signatures are the implemented signing method.

### Code electorate

A community agreement's optional `consultation.voting` record (`community-voting/v1`) commits a random list identifier and a sorted, unique set of voting-code verifiers. Eligibility is fixed by that agreement's CID. Changing the list creates a new agreement with separate ballots; votes never transfer automatically. An organiser assigns and distributes the codes and is trusted to determine eligibility. Names, contact details and their code assignments stay in the organiser's browser or local voter-list file.

### Voting code

A reusable, randomly generated credential authorizing one ballot on each agreement that explicitly commits its verifier. The current format is fifteen letters, displayed in groups of three, with I, L and O excluded; case, spaces and dashes do not affect its value. A verifier is PBKDF2-HMAC-SHA256 with 600,000 iterations and the voting-list identifier as domain-separated salt. Published verifiers are not credentials. Possession of the original code authorizes voting and reading that ballot's private history; it does not identify the human using it.

### Community ballot

The latest Support, Oppose or Abstain choice for one eligible code and one exact agreement CID. Every changed choice is appended to a server-timestamped history with a monotonically increasing version. An update must name the version the voter reviewed. The latest choice counts once; repeating a request does not count twice. The deadline closes changes while code holders can continue reading history. An organiser's signed result statement remains separate from these server-counted ballots.

### Agreement input

Land represented by the included designs, with source-qualified cadastral references and a holder snapshot. Inputs can include modeled open ground: the union of each qualifying design site's geometry outside its bound cadastral parcels, not an area inferred from a binding summary.

### Agreement output

A land piece standing on the input land after the included designs are applied. Outputs include materialized fabric pieces and any remaining modeled open-ground host that has no materialized piece. Such a host is carried as geometry with no claimed holder or cadastral identity. Its committed identity is a `piece1-sha256:` hash of the defined output projection, not a permanent cadastral identifier.

An unchanged whole cadastral parcel commits to its source geometry, including its Polygon or MultiPolygon type. Splits and designed pieces commit to their resulting geometry. Even an unchanged whole parcel needs an explicit single recipient in an owners’ agreement; by default that is its own parcel party.

### Allocation

The proposed assignment of an agreement output to exactly one recipient: an input parcel party (`parcel-owner:<parcelId>`), the proposer or the public. Every output in an owners’ agreement has an explicit allocation. An output allocated to a parcel party is held by that parcel's co-owners in their ownership shares; agreements never name persons as recipients.

### Proposer allocation

The agreement recipient role `{kind: 'proposer'}`, independent of input-land ownership. It receives explicitly selected output parcels, including all outputs in a private acquisition. Input owners retain their scheme-defined compensation; the sponsor balances the resulting cash schedule. The Persons tally combines proposer land with that balancing cash. A proposer who contributes input land remains represented separately under that input party's key.

### Sponsor

The wallet named in a published agreement that creates its chain account and controls sponsor-only funding and cancellation actions. The sponsor is not automatically the owner of its input land or the recipient of every output.

### Agreement currentness

Whether a local agreement still matches its referenced designs, their application, and the derived input and output land. A stale agreement retains its published identity but no longer describes the current working composition. The agreement panel warns only about a stale agreement, and Propose and Before / after need a current one.

### Local key

A browser-local identifier used to find a working record. A `proposalId` or local agreement key is distinct from a publication CID, database row ID and chain account.

### Remove from this device

Removal of a browser-local agreement copy. Its designs retain their map application, and any published agreement retains its CID and remains accessible through its link.

### Publication

The retention of canonical record bytes and their inclusion in the publication index. A locally computed CID, preview, saved draft or local map application does not by itself constitute publication.

### Pinning provider

The configured service retaining published IPFS content. Filebase is the current upload provider; Pinata remains selectable in reserve through `IPFS_PINNING_PROVIDER`. Provider adapters retain the application's CID scheme and verify the service's returned CID. An upload failure does not automatically publish through another provider.

### Read gateway

The HTTP service resolving an IPFS CID for a reader. `IPFS_READ_GATEWAY` selects generated asset URLs independently of the upload provider. Changing storage or gateway configuration does not change published content identifiers or rewrite existing URLs.

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

The frontend consumer owns source configuration and sends its selected source explicitly. When a design is shared, that source is chosen by where the design's ground lies (its site, else its drawn polygons), not by its city label. Backend services validate and serve that selection; they do not infer a city default. A retained cadastral namespace and the API gateway selector can have different identifiers while referring to the same parcel source; choosing a gateway does not rewrite the retained source observation.

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

The site is a design's saved land boundary, not a restriction against editing its geometry.
Editing a road's footprint updates its site to the new corridor land and invalidates its old
parcel binding. Geometry must fit the current authored site at publication; a refusal returns
the outlying geometry so the map can identify the affected area.

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

One authored site can produce several body pieces or explicit layout plots, plus remainders of its
source land. Producer metadata groups the materialization effects; it does not make remainders
part of the design's body. Cadastral input references are independent of the number of body pieces.

A building's formed land take and its subtracted remainders use the same clipping grid (nine decimal places in longitude and latitude). This is derived geometry; the authored land take and building footprint retain their original coordinates. Facade intersections use the same clipper so different coordinate precision cannot create a second ownership slice along that cut.

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

The set of designs currently applied in a saved workspace and the land fabric they produce. This local composition is separate from an agreement, a publication selection and a statutory plan.

### Saved workspace

The durable local working state for this site in one browser profile, containing designs, agreements, application state, editor drafts and modeling inputs, partitioned by geographic context. Its identity and saved work survive closing or reopening a tab. Only one map tab may edit it at a time; another tab waits until the editor closes and the person retries. Opening a tab does not create a copy. Account connections and display preferences can remain shared. See the [saved workspace](saved-workspace.md) record for the verified boundaries.

### Road junction

A shared same-level centerline node and its incident street arms, with the cross-sections and corner land needed to connect them. Each participating road design records its split stretches and the neighbouring arms needed to rebuild its own footprint. A crossing at different levels or through a protected bridge/tunnel span is not a road junction.

A level is a discrete topology label, with omitted levels treated as ground level zero; it is not an elevation in metres. Editing a participating road refreshes the affected neighbouring arm definitions. Drawing a road that joins an existing one, or editing a participating road, updates a neighbour that is still the author's own unpublished design in place; a published neighbour is immutable, so its updated junction is saved as a new revision that names it by CID and replaces it on the map, and the person is told which roads were revised. The junction owns its shared visible surface, including during drawing previews, so participating road strips do not paint over that surface.

An MCP road draft, import or edit is joined to the roads and tracks of the agent's working plan, by the same junction planning as the map editor; a neighbour whose junctions change is replaced in the plan by a revised design naming it by `origin.cid`. Agreement drafting does not revise designs. Reading, applying or comparing published records does not rewrite their topology.

### Map share

A design link shares exactly one published design revision. A plan link shares exactly one saved plan revision; its share dialog cannot change its name, membership or view. Create plan chooses a name, designs and saved view without publication. Add to plan opens creation or a reviewed revision of a chosen saved plan. Saving any change creates a new immutable snapshot; existing links remain unchanged. Create agreement starts a separate agreement editor from a saved plan, and agreement sharing uses that agreement's own flow. “Lists” names the panel containing Designs, Plans and Agreements. Its browser scope contains local library records; its published scope reads the public index. Removing a browser copy does not withdraw a published record, remove plan members, or change an agreement’s exact plan reference.

Choosing “Unapply existing & continue” replaces the conflicting applied designs. Incoming buildings and surface spaces replace conflicting applied roads occupying their authored footprints. An incoming parcel layout also replaces applied roads, layouts and content occupying its authored plots; designs outside that ground remain applied. Compatible road junctions and host parcel layouts remain. Unapplied designs remain saved. The replacement commits together, or retains the previous working composition if any member cannot be applied.

Replacement re-derives only the affected ground and its spatial dependencies. Applied designs elsewhere are not replayed as part of that local change.

After a successful confirmed replacement, the view frames all incoming applied designs together, overriding a previous position or camera in the shared URL. A visitor who takes over the view during loading retains control of it.

Selecting an object in model or Google 3D, including a design from a list or a click-stack section, retains the camera and surrounding composition. A yellow pulsing outline follows the selected building or massing's drawn volume, or the authored ground boundary for parcels and ground-only designs; reduced-motion views use a steady outline. Ground-only designs also show a transparent yellow hatch across their authored surface; formed and cadastral parcels use an unfilled boundary, including when a formed parcel shares the design's geometry. Selection does not recolor underlying parcel surfaces or isolate the design. Both 3D views use the same selection sections, inspectors, repeat-click retention and deselection rules, and both views build the stack from the selected object outward. Google imagery supplies a visible surface position; cadastral and building identities come from source records. Where the Google mesh has no addressable object volume, selection outlines the known source footprint on the loaded surface. Cadastral boundary visibility controls drawing independently of selection.

**Side-by-side comparison** (model view and map): the Buildings and massing sheet's Compare tab splits the view at a draggable divider; each side draws one state of the same scene from the same camera. A side is Built today, Permitted massing, Proposed (every applied design), one applied design or one plan. The standing city is shared; a side adds only the work it applies and removes the buildings that work demolishes, and shows no other design's work. Permitted massing draws on the Permitted side alone. Display settings still decide what each side may draw. On the map the sides differ in building footprints and permitted massing; parcels, roads and parks show on both. The comparison is a view, not a record.

Restoring a saved camera retains the map's display settings and surrounding context. Its selected design is highlighted without isolating it from the shared composition.

Opening the Freeform building editor preserves the current map view. Choosing another city for exploration leaves the previous shared plan and its saved view behind.

In 3D, sharing can include the captured camera position and angle, independently of the optional “Rotate on arrival” choice. Rotation defaults off, orbits the view's focal point and starts when the view is ready, after terrain alignment in Google 3D. The first click, touch, scroll or key input stops rotation or cancels it while the scene loads. Reduced-motion views remain still. Unnamed links carry these choices in `camera` and `rotate` URL parameters; named plans save them in their view.

The browser address follows completed view switches and the current 3D camera target, heading, pitch and range. Moving the camera updates the view without publishing designs or changing the plan referenced by the address. Private draft preview references remain in the address while navigating their view.

The planet in the city/search control indicates whether the current address reproduces the applied composition: green when it names the same published design revisions, orange when local edits or different membership are absent from that address. Saved but unapplied designs do not affect the indicator. Camera movement alone does not change it. In 3D the control shows only the icon and retains its globe action.

Its social preview is a derived 2D image of the included designs' authored map geometry, framed together independently of the interactive camera. The image is cached by the unique set of design CIDs and renderer revision; it is not authored plan content. Missing or failed images can be regenerated from those published records.

When shared designs conflict with the current map, the person chooses whether to unapply the existing conflicting designs and continue, skip the conflicting incoming designs, or cancel. Unapplying existing conflicts and deriving the chosen plan is atomic; failure retains the previous map. Every design remains saved, and unrelated applied designs remain on the map. Overlapping road revisions are conflicts; ordinary roads meeting at a junction remain compatible.

### Plan

An immutable `plan/v1` snapshot containing a title, a selected set of design CIDs and a map view. Its canonical content has its own CID; publication gives it a permanent `/plans/<cid>` link. Changing the title, membership or saved view creates a new snapshot and link; existing links keep their original content. It references existing designs without changing their authorship, geometry or publication. It carries no land allocations, money or decision rules; those belong to an agreement. The backend address used to access a plan is transport configuration, not part of its content.

Plan stats and Compare plans evaluate one exact saved plan revision, including unapplied members. Parcel figures derive from its members and source cadastral ground in isolation; unrelated map designs and the current map extent do not affect them. Evaluation does not apply the plan. The Compare tab's divider takes a saved plan as a side the same way: a member an applied design stands for is that design; the rest are read as Plan stats reads them and drawn on that side alone, with the standing buildings they clear taken off it. Built today is the present state of that comparison. The urban rooster scores a plan only when every member is applied, from the live map.

A private named-plan draft can reference unpublished design revisions carried with it. Publishing that draft first publishes its missing designs, then the named snapshot, and verifies the same content identifiers. Drafting or editing a named plan derives no agreement ground. Editing places added and revised designs as an agent's working plan does; drafting assembles the given designs as they are.

A plan contains one or more designs and can exist without an agreement. Each agreement references one exact plan revision; any number of agreements may reference that revision. Editing a plan never changes an existing agreement’s subject. Plans and agreements have separate share links. The map click stack orders Agreements above Plans, scoped to the selected exact plan revision, followed by Designs and source objects; it displays the selected level and its nearest available neighbours. Whatever opened the stack, the selected object's own references supply the sections above and below it. Agreements inherit their plan’s extent for inspection; they are not independent spatial picks. Multiple agreements share a selector. The expanded Agreement section contains the full scrollable properties and actions. Its Plan button selects that exact plan in the current view without navigation, importing or applying its designs.

### Working plan

The private plan an MCP agent authors in, standing in for the map a person applies designs to. Each agent draft or design edit is placed into it with the map's explicit Apply rules and makes a new plan revision: roads join its roads, and ground another member holds is refused until the person agrees to displace that member. Without a named plan the first design starts one. A working plan is an ordinary plan. A shared plan session can name its current revision for a browser and an agent.

### Shared plan session

A private server connection that names the current accepted ordinary plan revision and carries its exact design members. It adds no new design or plan format. A published plan can start a session; subsequent edits create private revisions without changing the published source. Publication remains a separate explicit action.

The owner controls whether the browser or the invited agent may save the next revision. The session version changes on both content and control changes; a save must match that version and the current editing authority. The owner capability controls the session; the separate invitation capability permits inspection and, only when granted, editing. Neither capability belongs to authored plan content or a public link. The browser's local workspace remains separate and retains its single-tab lock.

While the owner edits a connected member, the browser keeps a pending ordinary plan revision containing that member’s current local revision. The Plan section follows this pending revision. The accepted server revision changes only on Save to shared plan or handover; earlier plan revisions remain immutable.

### Plan area

The land a plan covers: every cadastral parcel its members stand on, counted once, plus their open ground (site area on no parcel), in m².

### Public land

Land in public use: road parcels (the road classification, or parcels marked as roads), land covered by OpenStreetMap parks and squares (`leisure=park`, `place=square`, pedestrian areas), and the pieces a plan's designs make into a road corridor, park, square or lake. Ownership does not decide it. Semi-private land is not yet defined.

### Private land

A plan's parcel land that is not public land, in m²; open ground is in neither.

### Present state

What stands today on the land of a chosen saved plan (or of all compared plans), read as a plan of its own: every existing building from the city's building source, clipped to the parcels and measured as a freeform building by plan-yield's rules, today's public land, and no designs. It is the baseline column of Compare plans.

### Remaining building

An existing building a plan's designs do not clear. A plan's standing buildings are its new buildings plus its remaining ones; apartments, people and jobs derive from their summed floor area. A design clears its demolition ground (its parcels or footprints, a structure, a road corridor) with the demolition scan's thresholds: under 2 m² of overlap the building is untouched, and when under 10 m² or 15 % of its footprint is left it is gone.

### Private draft reference

An expiring bearer URL resolving to an immutable unpublished design, agreement or named plan and its exact member revisions. It persists independently of an MCP client session; its stated expiry limits retention. Exported canonical content can restore it after expiry. A private preview is not publication, application, consent or a permanent share link.

The MCP preview flow carries this reference in the `draft` URL parameter for review before publication. The Designs sharing panel requires publication for every included design and does not carry a private draft reference into a permanent link.

### Applied / unapplied

Whether a design currently contributes to the working composition. Application expresses a modeled map effect, independently of consent, chain execution and physical construction.

Import retains a design definition independently of the currently viewed ground context. Reconstruction uses its authored geography and actual cadastral source references; descriptive city text does not determine eligibility.

Unapplying a design that later applied designs stand on (their footprints lie on its ground) names them first. The person unapplies them with it, in one change, or leaves them applied; a design left applied takes its ground again from what remains, as in any replay.

### Replay

The reconstruction of a working composition by applying designs in their defined formation and dependency order. Display order, agreement membership order and construction windows do not themselves determine replay order.

### Construction window

A plan member's start and end month (`YYYY-MM`, both inclusive), stored in the plan's `schedule` under the member's design CID. Dates belong to the plan, not the design: the same design can be built at different times in different plans. Members without a window are unscheduled and count as built at every date. The time control only displays a plan's windows; it does not set them. A window is distinct from replay precedence, and Plan stats counts a member in the year its window ends.

### Time control

The map's control that moves one month back and forth over the construction windows of the plan in view. At that month each scheduled member is planned (before its start), under construction (progress grows linearly over its window's months) or built (after its end). It only displays: nothing is applied, unapplied or replayed. Closing it returns to now, where everything on the map stands as applied. `when=YYYY-MM` in an address opens it at that month.

### Simulated build-out

A seeded, repeatable scenario giving the plan's undated members construction windows: a start month drawn from a yearly start rate and a duration from floor area; an urban rule builds parcel by parcel, one window per building. Members the plan dates keep their windows. It is shown on the time control and in an address as `buildout=<seed>`, and is never stored in a plan or agreement.

### Footprint

A horizontal outline whose subject must be qualified. A building footprint describes the building's plan outline; a corridor footprint describes occupied transport land; a design footprint combines the authored parts relevant to an operation.

### Land take

The exact ground a design consumes. A Freeform design's `geometry.landTake` can combine footprint cuts and chosen whole parcels while its material building footprint stays unchanged. A chosen whole parcel remains taken only while a building footprint overlaps it. When the last building leaves, that parcel and its surroundings leave the design, restoring its source state. It governs land formation and building-removal effects. Surrounding paving or green space occupies only taken land outside the building footprint; a footprint-only take has no surroundings.

### Demolition review

The preview of modeled full building removals and partial cuts caused by a land take. It updates with the design and does not require a separate acceptance before saving. It is distinct from an owner's agreement decision and from real-world demolition.

Reviewing a replacement design evaluates observed stock before the source design's own removals. Application evaluates removals against the transaction's applied composition, including sources stood down by that replacement; an unchanged land take does not lose its removals merely because the source is still visible until commit.

### Ground surface

An authored paving or green treatment of the land around proposed buildings, represented by `geometry.groundSurface`. Paving is the default for new and edited building designs and uses ordinary sidewalk slabs, distinct from square paving. Its area excludes the stored building footprints and stays within the design’s ground boundary; a surface treatment does not independently determine land take, demolition or transfer rights.

Its visible geometry excludes applied corridor footprints in every map view, including its furniture and planting. The authored surface remains unchanged; removing a corridor restores the surrounding treatment.

A ground surface does not make land shared. Every parcel boundary that crosses its open ground is shown as a fence, along the street edge too but never along a building wall, whether the surface is paved or green. A courtyard is shared ground only when the parcel layout makes it a parcel of its own; a block's **Courtyard as a parcel** action opens that layout with the courtyard carved.

### Corridor

Transport land and its authored road or track design. Its alignment and cross-section describe its form; its footprint describes the land occupied.

A corridor design's canonical stored form is `roadProposal.definition.osm`. Expanded drawing fields are a view of that form and do not independently determine the design's CID.

### Bounded road

A road placed into ground already left for it (`definition.bound.site`): its land is that site, not
what its lanes cut, and it declares only the parcels the site covers. Its lanes (the core) are
fitted along the middle of each street to the street's narrowest part; pavements up to 3 m and verges
fill the rest. Edits keep the site: one that moves the road off it or leaves its lanes too little
room is refused. See [road in a parcel](road-in-parcel.md).

### Alignment

The ordered line or curve of a corridor, with its horizontal position and any stated levels or elevations. An alignment is distinct from the corridor's width and occupied polygon.

### Cross-section

The transverse arrangement of corridor elements, such as lanes and their widths. It specifies form across the alignment.

### Structure design

The application's area-feature design category, including parks, squares, lakes and stations. This category is broader than the engineering meaning of a load-bearing structure. A park, square or lake's authored area is its occupied land and supplies its site when reshaped; applying it forms modeled ground borders. An unsaved drawn outline is temporary and has no land effect until a design is applied.

A park, square or lake may carry an uploaded glTF model: `structureProposal.modelUrl` (the served model reference), `modelName` (at most 120 characters), `rotation` (degrees, default 0) and `source: 'upload'`. Its geometry stays the site polygon; an upload sets it to the model's projected footprint placed unrotated at a point on the site. In the 3D view the model replaces the generated ground (lawn, paving or lake basin), fitted to the geometry's bounding box in the rotation frame at its native height, while authored decorations still render; a model that fails to load falls back to the generated ground.

A park or square's furniture may also use uploaded models, one per furniture kind: `decorationDesign.models` maps a kind (parks: bench, stall, tree, lamp, swing, seesaw, slide; squares: bench, statue, fountain, stall, tree, lamp) to `{ url, name? }`, and every item of that kind draws that model, instanced, with its +X facing the item's bearing; the key is absent when no kind has a model. A furniture model is limited to 5000 triangles, 1024 px textures and 4 MiB (`furniture-models.js`). Lamps are placed points, `decorationDesign.lamps = [{ coordinate, bearing }]`, that glow in the 3D view while the sun layer shows night.

A **pavement tree** is a tree on paving (a square, or paved building surroundings) standing in a pit in the paving rather than straight out of it: `decorationDesign.trees[i].pit` is `grille` (a cast-iron grate over the soil), `grass` or `soil`, a 1.4 m square edged in stone except under a grille, laid square to the square's longest edge. A tree's `heightM` stays within its kind's range (`park-planting.js`); trees on green ground (parks, green surroundings) stand on lawn and have no pit.

### Transit station

A station attached to a compatible corridor. Road stations use a road with driving or bus lanes.
Track stations use rail and are placed at ground level, elevated or underground; these are
placement levels rather than tram or metro service types. The chosen level determines the station
model, footprint and attachment. The current record identifiers are `bus` for road stations and
`tram`, `elevated`, `underground` for the three track-station levels.

### Decoration design

An explicitly authored arrangement of furniture, trees or similar surroundings. Authored layouts belong to the design commitment; generated decoration caches are local rendering data.

### Enclosure

A fenced area inside a park: `decorationDesign.enclosures = [{ fence, use, gates, ring? }]` (`park-enclosures.js`). Without `ring` the fence follows the park's own outline and moves with any reshape; with `ring` it encloses that closed ring, which must lie inside the park (a ring left outside by a reshape or a road is dropped from the ground it no longer stands on). `fence` is one of four styles, lightest first: `rail` (a 0.6 m timber rail), `mesh` (1.2 m), `iron` (1.8 m wrought iron) and `plinth` (2.2 m iron on a brick plinth with stone-capped pillars). `use` is `none`, `dog` (a dog area, gravel ground) or `play` (a play area, rubber safety surface); a new dog or play area takes a mesh fence, any other a wrought-iron one. `gates` are points on the fence, at least one, each within 2 m of it; a gate is a 1.2 m opening, and walkers in the model view cross a fence only at its gates. Swings, seesaws and slides are park furniture placed like benches (`swings`, `seesaws`, `slides`: `[{ coordinate, bearing }]`), inside an enclosure or anywhere in the park.

### Map claim

A selectable item of cadastral ground, fabric or design content in the map's interaction model. This interaction term does not denote a legal claim to land.

## Buildings and planning

### Source building

An observed building object identified within a survey or provider dataset. Its geometry, identity and measurements retain that source's provenance.

A source building is baseline context, not a member of a Plan. Its cadastral parcel supplies the
ground context for inspection. An explicit design impact can link it to an affecting design;
spatial overlap alone does not establish that relationship. Current agreements allocate land and
money and do not create a separate transfer of a source-building record.

### Proposed building

Authored building geometry, parameters and optional architectural evidence belonging to a design. Its representation proposes a building rather than asserting an existing surveyed object.

### Freeform building

A building design with one connected authored footprint, including any courtyard holes, and its vertical dimensions. Its land take can extend beyond that footprint. Dragging moves only the selected building footprint; surroundings stay anchored on occupied parcels. Leaving a parcel releases its surrounding treatment and furniture.

### Imported model footprint

The connected horizontal projection of a GLB model's visible mesh triangles, including concavities and courtyard holes. It is the model's silhouette, which can include overhangs and canopies; it does not infer a foundation boundary.

### Urban-rule design

An authored rule governing possible building form on land, such as Block, Row or Detached. The design's permitted envelopes express that rule; an example build-out illustrates one realization.

Any of the three may also permit **balconies** (`balconyDepthM`: how far, in metres, they may stand out of the envelope; absent means none) and a **slanted roof** (`roof: "pitched"`: a roof with its attic set on the top floor, ridge parallel to the street side; absent means flat). Both ride on the rule each building carries.

### Block rule

An urban-rule design generating perimeter building form and courtyard space from its land and stated dimensions. Its record stores one building per parcel, cut from the block massing and carrying the rule and its own variation seed, beside the complete authored block massing (`geometry.ruleMassing`); parcels the rule leaves out are recorded separately as ineligible.

### Row rule

An urban-rule design generating a row arrangement of buildings from its land and stated dimensions. Creation uses at least two distinct selected parcels, or at least two frontage plots cut from an authored site. Its complete footprint must remain within the selected land, including its disconnected boundaries and excluding gaps and holes. An unplaceable footprint cannot be finished as a Row design. Like a Block, its record stores one building per parcel, cut from the row massing and carrying the rule and its own variation seed, beside the complete row massing.

### Detached rule

An urban-rule design generating separate buildings on selected parcels from its stated dimensional constraints.

### Source planning rule

A rule or planning instrument supplied by an identified authority or dataset, with its edition and applicability evidence. An authored urban rule does not become an enacted source rule by sharing its name or geometry.

### Zoning district

A source-defined area with a named zoning regime. A base district and an overlay district remain separate source observations when their geography overlaps. Unmapped, extinct and unidentified district records retain those distinctions.

### Atlas slice

A derived Atlas area representing a combination of base-district and overlay rules under the publisher's composition method. It is distinct from the source districts and from a cadastral parcel or a generated building envelope.

### Literal dimensional observation

A complete numeric value recorded in a source field with a known unit, without an unresolved expression or alternative value kind. Spreadsheet dates remain date values even when stored as numeric serials; cached formula results are not literal observations. The `literal` evidence state distinguishes public district-table values from the Atlas Slices product's `direct` numeric method. Both can supply a supported dimensional calculation; neither resolves applicability, missing constraints or overlay precedence.

### Planning representation

An inspection or display projection of a source record, existing building or authored design. It retains the subject's identity and provenance without becoming a new design or an applied change.

### Obligatory source proposal

A read-only representation of a provider record whose underlying instrument claims obligatory normative effect. Its authority, applicability and evidence quality remain separate attributes; representing it does not establish compliance or owner consent.

### Source reference

An authored reference pinning a provider record, edition or scenario and source revision. It identifies the evidence used by a design without transferring that source's authority to the design.

### Permitted envelope

The maximum building form derived under an identified rule and its supported assumptions. An authored permitted envelope is normative under that proposed rule; a source-derived envelope retains its source's legal and calculation qualifications.

### Outer bound

The combined extent of the drawable building configurations and their supported interpretations. It bounds possible forms rather than defining one constructible building. A lot that several zoning areas partition has one outer bound per part, each the whole lot's bound clipped to that part; a zoning area under 2 % of the lot is evidence, not a part.

The comparison controls label this **Max envelope**, as they do an authored rule's maximum envelope. This display label does not make alternative configurations simultaneously buildable or remove the source's qualifications.

### Configuration

One source-recorded building option, such as an allowed housing type, with its own constraints, treatment, derived geometry and availability. Configurations are alternatives, not additive permissions.

### Lot test

The comparison of a parcel's area with a configuration's stated minimum lot area. Pass, fail and unknown describe that comparison, independently of whether every rule for building on the parcel is satisfied.

### Shown configuration

The configuration selected for display. This choice changes the inspected illustration, not the source record, permitted limits or authored agreement.
The housing-type selector and per-parcel pins choose this configuration. The Permitted dice
varies a sample building inside its derived volumes while retaining that choice and frontage.

### Assumed street side

A parcel edge treated as the front for a displayed calculation. It is an explicit modeling assumption unless independently established by the source.

For source parcel envelopes, nearby street geometry selects a stable street-facing lot edge. Setbacks are measured inward from parcel boundaries; the street centreline only informs the orientation. Changing the shown configuration does not change that edge. Without usable street evidence, the result retains all supported edge interpretations as an unoriented outer bound and claims no front edge.

### Example build-out

One illustrative building realization within an authored urban-rule envelope or a source-derived
configuration's volumes. It is neither the maximum permitted capacity nor an existing building.

The comparison controls label this **Illustration**. A source's one calculated option or displayed configuration is also labeled Illustration, retaining its own assessment and source qualifications.

### Zoning area

The geographic area to which supplied zoning evidence refers. It is distinct from a cadastral parcel, a permitted building volume and a completed compliance assessment.

### Treatment area (Bogotá)

A zoning area of Bogotá's POT treatment map (Decreto 555/2021): one polygon with a treatment (consolidación, renovación, desarrollo, mejoramiento integral, conservación), an optional typology (`TA`, detached) and a height code. A storey count on the map is the base height; a range's upper number, development ranges, instrument codes and blanks are evidence, not geometry. Storeys become metres through the decree's clear height plus an assumed slab ([Bogotá POT source](bogota-pot-source.md)).

### Antejardín

Bogotá's front yard: the private strip between the lot line and the building line whose minimum depth the POT front-yard map assigns to Consolidación lots. It is read under the parcel, not from the treatment area, and becomes the parcel's front setback.

### Applicability

Whether and under what conditions a source rule applies to the subject and context being assessed. Normative authority and available numeric dimensions alone do not establish applicability.

### Evidence quality

The stated strength and limitations of the evidence supporting a representation or assessment. A cached calculation, estimate and independent verification have different evidential roles.

### Massing

A footprint with vertical extent, represented as volumes or extrudable geometry. Its role must distinguish observed built form, permitted form, proposed form and an illustrative realization.

### Built / Permitted / Proposed

The three planning display roles: observed buildings; source-derived permitted massing; and the browser's applied building designs. These roles classify represented content, independently of its display appearance. Buildings and massing settings apply to every represented object in each role across the view; selecting or inspecting a parcel, building or design does not create a separate display configuration. Permitted and Proposed have independent display-only example rolls; rolling either role changes no authored design or source record and leaves the other role's example unchanged.

### Illustrative facade

A display-only architectural skin on a proposed building. The view-wide facade setting defaults to Mixed, which assigns a deterministic style independently to each building; glass styles are eligible only from ten modelled storeys. Named masonry and small-, medium- or large-panel glass presets override the style for all proposed buildings. Building identity controls the mixed style and glass tint; parcel ownership can vary its shade. Panel sizes are measured in metres and storeys. Glass panels follow each wall and storey; soft sky sheen and specular highlights depend on the viewing angle. These skins are illustrative appearance, not surveyed materials or authored construction specifications.

### Reconstructed building envelope

An interpreted exterior form assembled from architectural or geographic evidence. Its provenance and uncertainty differ from a surveyed building and a permitted envelope.

### Bounding envelope

An enclosing spatial extent used for indexing, filtering or framing. It is not the object's architectural shape or a planning permission.

### Building stock

The source-qualified building footprints considered by an operation, with any known heights or storeys. A complete query covers its stated source and bounds; a failed, clipped or truncated query leaves the operation's consequences unresolved.

## Parties, rights and decisions

### Party

Each input parcel of an agreement is exactly one party, `parcel-owner:<parcelId>`, displayed as “Owner(s) of parcel X”. Agreements name no persons: input parcels carry no holders, and allocations and money lines name a parcel party, the proposer or the public. The parcel party is the owner group of that parcel whoever its members are; it is not verified ownership.

### Persons

The people behind parcel parties, derived from a rights snapshot and never stored in an agreement. A person holding share s of parcel i co-owns every output allocated to that parcel's party at fraction s and receives s of its cash; each parcel's cash is split in minor currency units by largest remainder, so per-person totals equal per-party totals exactly. Parcels whose rights do not name complete holders stay one unresolved party. Owner approvals and lens decisions read the rights snapshot, not the agreement.

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

### Lens preference

A person's editable, chain-specific default trust set, persisted in the browser and shared by agent details and agreement authoring. Editing either shared lens dialog updates this default for future use. A new agreement copies its keys; an existing agreement keeps its own lens snapshot. Merely opening an existing agreement's lens does not replace the default. Changing the default never rewrites saved agreements.

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

### Area monitor

A named, server-stored list of up to 400 Croatian cadastral parcels (`HR-<cadastral municipality>-<parcel number>`) with an optional drawn Polygon or MultiPolygon, used to track a project's public land acquisition ([routes](../backend/routes/area-monitors.js), [table](../backend/routes/area-monitor-ddl.sql)). Reading a monitor joins current ownership and counts parcels owned by the City of Zagreb against those remaining; when the ownership lookup fails, parcels are returned with unknown ownership rather than failing the read. The overlay clips current parcels to the stored polygon. `city_id` is a caller-supplied namespace (`global` when omitted), not a resolved app city. Optional EOJN and SkyscraperCity links name the procurement notice and the forum thread. Creation is limited to 20 monitors per IP address; the API has no edit or delete. Monitors appear in Activity under Watched areas.

## Lifecycle and settlement

### Agreement lifecycle

The agreement's active, executed, cancelled or expired state, derived from its qualified chain account and deadline where applicable. Missing or unrecognized state is unknown; a design has no agreement lifecycle of its own.

### Proof case

A selected published agreement whose chain lifecycle, market outcome and winning claim are supported by source transactions. Outcome verification is distinct from completion of optional donations or pledges, legal registration and physical construction.

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

The time limiting the agreement's decision or settlement process. It is distinct from a plan member's construction window.

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

What a party is due from the readjustment before cash balances it. By area: the land it put in after the stated contribution ratio. By value: the share of the value of the land distributed to parties and the proposer that matches the value the party put in. It is distinct from the land or cash actually allocated to that party.

### Land valuation

An agreement's `valuation`: one whole-cent value per m² for every input parcel (before the designs) and every output piece (after them), in the agreement's currency. Present only when the agreement settles by value; a missing or unknown value blocks saving and publication. A value is the author's stated assumption, not an appraisal the record verifies.

### Scheme distribution rules

The land rules a pinned scheme (`rule.approvalConfig.regime`) adds to its decision tests: a cap on the land an owner or the pool gives up, the area or value basis of distribution, the share of each owner's value gain settled in money, the fewest parties, and, under an authority-led scheme, no proposer acquisition. The record, the HTTP index and MCP check them with one shared function; the editor marks schemes the plan does not meet before they are chosen.

### Scheme dimensions

The eleven properties every scheme is described and compared by, in two groups. How it is decided: who starts it (owners or the authority), who has the final say (owners alone, owners then the authority, or the authority alone), the owner support needed (the tests), who is counted (owners or owners and leaseholders, all or private only), what happens to owners who say no (veto, bound by the majority, bound by the authority), and what passing unlocks (the stage). How the land is shared: the basis (area, value or either), public land without compensation (no cap, per owner or per pool), how differences are levelled (in money), the value gain (kept in land or a share settled in money; not applicable by area) and the fewest parties. `dimensionsOf` derives them from a scheme's data: the starter from its family, the outcome for dissenters from its tests and family. The scheme guide, its comparison table and the MCP `schemes` topic word them the same way.

### Readjustment cash

Incoming or outgoing balancing money in the agreement’s explicit fiat currency, represented canonically in integer cents. With area compensation, each party receives or pays the difference between its remaining land entitlement and allocated land multiplied by the stated currency-per-m² rate; positive cash is received and negative cash is paid. A scheme may permit a capped proportional land contribution before compensation. With value compensation, each party receives its value entitlement minus the value of the land it got, and pays the scheme's share of its value gain (the entitlement minus the value it put in). The sponsor pays or receives the balancing cash. A no-cash rule produces no money lines. Cash is calculated from the rules, land values and allocations, not entered per person.

### Token balance

An amount in the atomic units of an identified chain asset. SOL lamports, devnet USDC atomic units and authored fiat cents have different units and cannot be inferred from one another. Betting points are a separate internal unit.

### Betting points

An internal, non-transferable unit in the points betting book. Each points account receives 1,000 points; a point is not cash, a token, or a claim on an on-chain asset. Ordinary points positions and trades share the ordinary points book. Each named simulation run has its own accounts, book and standings.

### Funding readiness

A local declaration that funding is considered ready. A boolean readiness flag neither measures money nor establishes sufficient escrow or a payment receipt.

### Price estimate

A modeled amount with its currency, source and basis. A source price without a usable amount or explicit currency is unknown; an area-based estimate identifies its rate and area basis.

### Economic rate observation

A source-attributed amount per stated unit, with an explicit currency, basis and, for evidence, valuation date. Land and road-land rates use land area; building sale and construction rates use floor area. Market evidence, policy appraisal and editable scenario assumptions retain separate meanings. An assessed property total is not a unit rate or a market price. Source selection changes model inputs without rewriting authored cash amounts.

### Modeled gain

An estimated change in value derived from stated existing and proposed floor areas and valuation assumptions. An unknown existing floor area leaves net gain unknown. It is not a balance, cash offer or realized sale proceeds.

### Portfolio estimate

A modeled value of an agent's assigned land, expressed in a stated currency and conversion basis. Adding it to a wallet balance requires both quantities and their conversion to be known.

### Market

A dated LMSR betting instrument about whether a qualified binding agreement executes by its own recorded deadline. YES means a valid on-chain execution timestamp is at or before that deadline. NO means execution after the deadline, expiry, or an active agreement still unresolved after the market's grace interval. Cancellation resolves VOID, paying half of each share on either side, floored per position. Points and devnet-USDC markets are independent books with the same quote and settlement rules. The market PDA, agreement account, network and asset are distinct identities.

### Contest

A group of published agreements connected transitively by shared source-qualified input parcels. Geographic overlap or equal unqualified parcel labels alone does not establish membership.

### Market deadline

The market's last-trading timestamp, copied from the agreement's execution deadline. An execution after it does not satisfy YES, even if observed before settlement. Grace delays a NO-by-absence settlement; it never extends the event deadline.

### LMSR liquidity

The positive parameter `b` in the logarithmic market scoring rule. It controls how much a quote moves as shares are bought or sold; it is not a pool balance or a guaranteed amount of trading volume.

### Share

A quantity in an LMSR market position on YES or NO, with six decimal places. One whole winning share pays one unit of the selected asset; one atomic share pays one atomic asset unit. VOID pays half that amount, rounded down per position.

### Betting journey event

A browser's report of viewing or acting in the betting flow, with an anonymous visitor identity, session and source occurrence time. It is separate from a verified chain transaction. Simulated visits carry an explicit test-run identity and are excluded from ordinary visitor aggregates; a visitor count does not establish a count of real people.

### Payout multiple

The user-facing quote for how many fixed-payout shares a budget would buy at the current LMSR price. It is a quote for that budget and current inventory, not a pool share, a guaranteed return, or evidence that settlement occurred. Later trades move prices.

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

The application's geographic context for filing records, selecting sources and expressing local assumptions such as currency. The published city is resolved from the design's place; it is not a parcel-source identity or legal authority. Descriptive city text on a design or agreement does not gate import, reconstruction or rendering. A required cadastral source context is resolved from the design's ground geometry and source coverage, independently of that text.

### Jurisdiction

The geographic or institutional scope within which a source, rule or authority applies. Jurisdiction is source metadata, independently of a provider's ID and a displayed city name.

### Source availability

Whether an identified source or record can be obtained in the current context. Availability, freshness, completeness, evidence quality and legal applicability are independent qualifications.

### Source revision

The identified version or content fingerprint of a particular source record. A changed revision can qualify an authored source reference without rewriting the design that pinned the earlier revision.

### Source completeness

Whether a query has supplied all records promised for its stated source and bounds. A cap, failure, missing requested region or clipped query leaves coverage unresolved; completeness does not assert that the source has captured every real-world object.

### Parcel source proof

A bounded observation used to check a city's cadastral source and its integration, consisting of safe request/result metadata and unchanged sample polygons. Downloaded datasets and extracted archives are disposable inputs, fetched only for a current check and deleted afterward. Source proof is temporary until the city's result is accepted; working source configuration and adapter code preserve a successful integration, and the city's failed-URL list preserves unsuccessful source attempts.

### City integration task

The work of bringing one city's discovered parcel source into the app: verifying the source, writing its source and city configuration, implementing the backend and browser adapters, admitting the city and checking it in the app. It completes only when the app reads live polygons, fetches repeatable exact-ID geometry, renders parcels and selects them; technical source qualification alone does not complete it. A city worker gets at most three implementation turns. A remaining implementation problem is an `integration-blocked` outcome with its reason; only an evidenced publisher limitation is `blocked-source`. A city whose qualification inputs are missing or invalid stays `pending-inputs` until they validate, without consuming model calls or source-failure retries. An implementation failure never adds the endpoint to the city's failed URLs.

### City knowledge record

What the parcel pipeline keeps about a city in `world-parcels/cities/<WUP code>/`: `settings.json` (working parcel-source descriptors, adapter configuration and explicit app-city bindings) and `failed-urls.json` (a deduplicated list of unsuccessful source URLs with optional reasons). An unsuccessful attempt never proves that a city has no cadastre. An enabled city source establishes usable observed parcel geometry within its stated scope, not citywide completeness, title, ownership or survey accuracy. Research packets, qualification inputs, logs and checks belong to a temporary pipeline task, whose result is reduced to city knowledge and queue progress before its worktree and evidence are deleted.

### Coverage-report city row

A row of the parcel coverage report ([report builder](../scripts/build-parcel-coverage-report.mjs)). Its research identity stays separate from an app-city identity: a reviewed city-to-app crosswalk takes precedence over a source-level inference, and either requires the enabled source and runtime provider to agree. An enabled app city without a reviewed crosswalk appears as an `app:<cityId>` row with no invented registry identity, demographics or investigation date. Conflicting links stay unbound.

### City knowledge record

What the parcel pipeline keeps about a city in `world-parcels/cities/<WUP code>/`: `settings.json` (working parcel-source descriptors, adapter configuration and explicit app-city bindings) and `failed-urls.json` (a deduplicated list of unsuccessful source URLs with optional reasons). An unsuccessful attempt never proves that a city has no cadastre. An enabled city source establishes usable observed parcel geometry within its stated scope, not citywide completeness, title, ownership or survey accuracy. Research packets, qualification inputs, logs and checks belong to a temporary pipeline task, whose result is reduced to city knowledge and queue progress before its worktree and evidence are deleted.

### Coverage-report city row

A row of the parcel coverage report ([report builder](../scripts/build-parcel-coverage-report.mjs)). Its research identity stays separate from an app-city identity: a reviewed city-to-app crosswalk takes precedence over a source-level inference, and either requires the enabled source and runtime provider to agree. An enabled app city without a reviewed crosswalk appears as an `app:<cityId>` row with no invented registry identity, demographics or investigation date. Conflicting links stay unbound.

### Coverage-report city row

A row of the parcel coverage report ([report builder](../scripts/build-parcel-coverage-report.mjs)). Its research identity stays separate from an app-city identity: a reviewed city-to-app crosswalk takes precedence over a source-level inference, and either requires the enabled source and runtime provider to agree. An enabled app city without a reviewed crosswalk appears as an `app:<cityId>` row with no invented registry identity, demographics or investigation date. Conflicting links stay unbound.

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

### Bot test-token funding

Wallet maintenance on Solana devnet that tops up a configured bot wallet with test USDC before it transfers tokens (`backend/agents/funding.js`, enabled by `AGENT_USDC_FUNDING_ENABLED=1`). It is separate from betting and donation spend limits. The main bot wallet funds the shortfall up to 0.5 test USDC while retaining 1 test USDC; a database lock serializes balance checks, transfer and readback, and confirmed receipts are recorded in the agent-run ledger. It never funds unknown wallets or another network.

### Draft artifact

Canonical design, named-plan or agreement content returned with its recomputed CID without a pin or index write. Its content address remains meaningful even when its private preview is unavailable.

### Portable plan file

A versioned `ugt-plan-file/v1` JSON envelope containing a `plan/v1`, its exact canonical design members,
embedded authored model assets and known source references. The plan owns membership and the saved
view. Import creates local, unapplied drafts and retains that membership; it conveys no publication,
agreement decisions, signatures or ownership. Referenced source datasets are independent dependencies.

### Private preview

A temporary means of inspecting a draft artifact. An opaque bearer reference grants access to a stored draft object, independently of permanent publication and wallet approval. Collection previews reference their member designs individually; URLs contain no serialized records or geometry.

### Agent editing reference

A design or building reference scoped to one inspected immutable revision. A building reference includes its design CID and feature index; a JSON Pointer addresses authored fields within that design. These are selection addresses, not new persistent object identities. A derived land piece is inspected by its piece hash and changed through the designs that produce it.

### Agent plan revision

A private revision of an agreement’s referenced plan and terms. It rederives input land and output pieces from the revised designs. It has a new CID and carries no prior decisions or execution state; retained rights and holders remain explicitly unverified snapshots. A map share and a person's unsaved working composition remain separate from an agreement plan.

### Approval link

Navigation intent identifying an agreement or market action and optional amount or side. Opening the link does not sign a decision, transfer funds or execute the action.

### Headless working composition

A freshly derived composition used by an agent calculation over its stated source context. It is independent of the person's browser composition and must retain unknown or incomplete source evidence.

### Comparison

A report of specified designs' modeled land, buildings, quantities and agreement allocations under a stated context. Its measures distinguish authored geometry, observed sources and simulated effects.

### Unknown measurement

A quantity for which sufficient evidence or inputs are unavailable. It is distinct from a known zero; a calculation requiring that missing quantity remains unknown.

### Existing-building baseline

Parcel-wide existing building count, footprint area and gross floor area, each known only when its inputs and inventory coverage support that total. The autonomous parcel planner requires a named building source and complete inventory coverage; unknown or partial coverage cannot establish vacancy. Missing heights leave floor area unknown even when footprints are observed. Height-derived floor counts are estimates with a stated storey-height assumption. Geometry previews and explicit housing-research concepts can exist without a complete baseline, but they do not establish net gain.

### Building observations and coverage

Features returned by a named building source, with their measured footprint area, available estimated floor area and missing-height count. Coverage describes whether that source establishes the complete existing inventory for the parcel: complete, partial or unknown. A successful or untruncated query does not establish complete geographic inventory coverage; an empty result alone does not mean an empty parcel.

### Locale

The selected language and regional formatting convention for the interface, numbers and dates. The language also determines the interface reading direction; map coordinates and technical addresses keep their own direction. Locale is separate from city, currency and geographic location.

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

### Track design target

The selected track speed in km/h and minimum radius in metres are authored design targets. Changing a rail lane's gauge changes its cross-section without changing those targets. Finishing a drawing warns when circles through consecutive polyline points have tighter radii; the author can keep editing or explicitly continue. This diagnostic does not establish an engineered alignment or an achievable operating speed.
