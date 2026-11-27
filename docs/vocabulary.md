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

A design that retains the selected ground or existing form while proposing different rights or terms. Its absence of new construction is an explicit design choice. Applying it records the design locally without changing modeled geometry.

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

An arrangement with a decision rule for exactly one immutable plan revision. Depending on the rule, its terms can cover land and payments, a community vote, or developer crowdfunding. Published `agreement/v1` content names the plan with `planCid` and any output pieces by hash. The plan supplies all design membership. Several agreements can reference the same plan. A local editing record can cache design references for replay and preparation. Publication must match the referenced plan exactly.

### Property offer

An immutable offer to buy or sell one exact apartment or a bundle of cadastral parcels for a price in SOL. The maker specifies the lens, expiry and property in `property-offer/v1`. A listing commits the payout schedule at publication. A bid binds the schedule when accepted. For an apartment, the named lens qualifies the accepting buyer or seller for the exact terms. The reference parcel policy also requires consent from the parcel owners.

### Apartment anchor

An ownerless, non-transferable Solana account identifying an apartment by its published or fingerprinted X-ray building and unit address. Different bids and listings share the same anchor. Creating it grants the payer no rights over the apartment. Its identity is independent of the developer’s inventory IDs used for crowdfunding reservations.

### Parcel anchor

A public record of a parcel on the blockchain: an ownerless Solana `parcel_nft` account seeded by the parcel's anchor id, `HR-<cadastral municipality>-<parcel number>` for the Croatian cadastre, else the source's parcel id (at most 32 bytes; a longer id cannot be anchored and is reported). Its URI is the parcel's page on the public site, `https://urbangametheory.xyz/parcel/<anchor id>`; nothing is pinned for it. Anchors created earlier keep the IPFS metadata URI they were created with (there is no update instruction), and those created before `parcel_nft` v2 (2026-10-01) also a wallet in their old owner field; that field confers nothing. Anyone may create an anchor and pays only its rent: the parcel panel's "Mint anchor", an agent's `ugt_anchor_parcels`, and the mint of an agreement, which first anchors every input parcel that has none. Anchors go several to a transaction, and parcels already anchored are skipped. Nobody owns an anchor and it grants no rights: a wallet's anchors are at most listed as anchored with it, never counted or valued as its parcels. Ownership of the parcel is a lens member's attestation. In the interface it is an anchor, never an NFT.

### Parcel ownership transfer

Seller-signed evidence linking source-qualified parcels and their previous ownership evidence to the buyer named in a finalized property offer. A lens recognizes successor ownership by following validated transfers from roots it trusts. The anchor remains fixed, and registered title comes from the land registry.

### Shared property-offer acceptance

An immutable candidate binding a property offer to a buyer, seller representative and exact payout schedule. Its ID hashes these terms; each seller’s wallet signature is collected separately. The owner union comes from the selected lens, and every owner must consent before on-chain acceptance. A stored shared candidate is not itself an accepted offer.

### Counter-agreement

A new agreement drafted from an existing agreement's plan and terms, optionally under another scheme. It references the same plan revision and is an ordinary agreement once saved; no record field links it to the agreement it answers.

### Binding owners' agreement

An agreement whose owners' decision rule is binding. It is eligible for a chain account, escrow, lens decision, execution and an execution market.

### Developer crowdfunding agreement

A binding agreement to raise devnet USDC for one exact plan revision. The sponsor is the developer and payout recipient. The agreement commits a minimum funding target, a deadline, a lens of zero to eight members with its threshold, and the investor contract. The agreement program confirms the target itself from the recorded USDC deposits (see Contribution target); the lens, when named, checks investor eligibility and any other conditions. Execution permits release to the developer. Cancellation or expiry permits each contributor to reclaim their deposits.

### Contribution target

The minimum credited contributions, in base units of one token mint, an agreement needs before it can settle: `funding.targetUsdcAtomic` in devnet USDC for a crowdfunding agreement, frozen at mint as `required_funding` and `funding_mint`. Credited means donated less refunded in the agreement's `proposal_pledge` donation escrow. Anyone records the target as met with `confirm_funding`; the program reads the escrow and its vault itself, so no lens is involved.

### Investor contract

The developer’s attached PDF or UTF-8 text specifying what a contributor receives in return. The file’s name, media type and bytes are part of the crowdfunding agreement’s content identity. The escrow records contributions and settles the funding round. The developer is responsible for delivering the promised return.

### Apartment reservation

A crowdfunding offer for one whole apartment at a fixed price and deposit. The developer wallet, permanent project ID and permanent unit ID identify it across rounds. The unit’s X-ray address and attached drawing identify the layout the buyer reviewed. A member of the round’s lens qualifies the buyer wallet for this round, unit and deposit before one funded reservation can be recorded for it; an apartment round names at least one member. Execution retains its allocation. A refunded position permits the unit to be released and listed again.

The **reservation deposit** is the fixed USDC amount the buyer pays into the agreement’s escrow to reserve the unit. Only deposits attached to reserved units count toward an apartment round’s funding target.

The **reservation state** of an offered apartment is read from its `ApartmentUnit` listing on Solana (`ApartmentRound.model`): **reserved** (this round’s listing holds a funded reservation), **available** (listed by this round, unreserved, and the round is active before its deadline) or **not available** (awaiting the developer’s listing, the round closed, or reserved in another round). A reserved apartment is not sold. An apartment of a building that no round offers is **not offered**. Where several rounds offer the same apartment, the strongest state shows: reserved, then available.

The **contract schedule** ties that apartment, its full price and paid deposit to the buyer wallet, developer, exact agreement, attached contract and unit drawing. Its deposit position identifies the payment on Solana, and its qualification address identifies the lens attestation.

### Poll

An owners' or community agreement whose decisions are counted without binding chain settlement. A poll can be published and receive signed decisions; it is not minted.

### Nonbinding community agreement

An agreement asking for nonbinding community support for its referenced plan. It carries no land allocations, cash transfers or owner approval rule. Its optional `consultation` metadata names an organiser by a canonical `did:web` identifier and an HTTPS participation page. Changing the referenced plan or participation metadata creates a new agreement CID; reporting results does not change the agreement.

### Agreement organiser

The website identified by a community agreement's `consultation.organiser`. Its DID document lists wallets under `assertionMethod` that may report on its behalf, qualified by network and address using CAIP-10. Live website verification confirms only that the site currently lists the signing wallet; it establishes neither organisational legitimacy nor the correctness of an agreement’s decision procedure or result.

### Community result report

An immutable `community-result/v1` record containing the agreement CID, organiser DID, signing wallet, a plain-text statement, optional HTTPS report link, signing time and a committed DID-document snapshot, with a wallet signature over those fields. Reports are content-addressed, pinned and indexed append-only; later statements retain earlier reports as history. Reports may follow the agreement deadline and require no mint or chain transaction. Readers reverify both the signed record and the website's current wallet list. Solana message signatures are the implemented signing method.

### Code electorate

A community agreement's optional `consultation.voting` record commits a random list identifier and a sorted, unique set of voting-code verifiers (and, for a [street vote](#street-vote), may name its street). New lists are `community-voting/v2`, which can also commit a household partition and a ballot rule; published `community-voting/v1` lists (identifier and verifiers only) stay valid because published agreements are immutable. Eligibility is fixed by that agreement's CID. Changing the list creates a new agreement with separate ballots; votes never transfer automatically. An organiser assigns and distributes the codes and is trusted to determine eligibility. Names, contact details and their code assignments stay in the organiser's browser or local voter-list file.

### Voting code

A reusable, randomly generated credential authorizing one ballot on each agreement that explicitly commits its verifier. The current format is fifteen letters, displayed in groups of three, with I, L and O excluded; case, spaces and dashes do not affect its value. A verifier is PBKDF2-HMAC-SHA256 with 600,000 iterations and the voting-list identifier as domain-separated salt. Published verifiers are not credentials. Possession of the original code authorizes voting and reading that ballot's private history; it does not identify the human using it.

### Community ballot

The latest Support, Oppose or Abstain choice for one eligible code and one exact agreement CID. Every changed choice is appended to a server-timestamped history with a monotonically increasing version. An update must name the version the voter reviewed. The latest choice counts once; repeating a request does not count twice. The deadline closes changes while code holders can continue reading history. An organiser's signed result statement remains separate from these server-counted ballots.

### Household

A group of voting codes whose holders live at one address, committed as `consultation.voting.households`: a partition of the code verifiers in which every code appears exactly once. The organiser assigns one code per resident and groups them locally by a household label; the label stays in the browser and the local voter-list file, and only the grouping enters the agreement, so household sizes are public. A code in no group is a household of its own, and a list in which every household has one code is stored without `households`.

### Ballot rule

A dated threshold set a code electorate can pin as `consultation.voting.rule = { id, version }` (`frontend/js/community/ballot-rules.js`). Each test is an exact fraction, at least or more than, of one measure: Support among votes cast (Abstain counts as a vote cast), Support among all eligible codes, households where any code voted among all households, or households with a Support vote among households that voted. A shipped version is never edited; a re-check adds a new version. The API evaluates the rule over the latest ballots and returns only aggregates: each test's count, total, needed count and whether it is met, and whether the rule passes. The result is provisional until the deadline and final after it. A rule counts the resident ballots only and does not make the community agreement binding.

### Street vote

A community code vote of the residents of one street on a plan for it, decided by a street-vote ballot rule. Three rules ship, all proposals for England that are not in force: Policy Exchange's Strong Suburbs (2021), the government's December 2023 street vote development orders consultation, and Samuel Hughes's Living Tradition (Create Streets, 2021) for mansards. A rule can carry a [street code](#street-code) the plan claims (Strong Suburbs': its code is checked per building of the plan in the agreement editor and by `ugt_draft_agreement`, as advice). A rule can require [building eligibility](#building-eligibility): Living Tradition's covers only the houses the plan raises with a mansard, and its agreement cannot be created until each one is eligible; the voting record keeps that check (each house, its verdict, the failing or unknown tests and the source version read). Owner sign-off is not part of the street vote: owners decide in a separate owners' agreement on the same plan, and the community agreement's voting panel lists those agreements beside the resident result without reading or changing their records. The voting record can name the [street](#street) it covers (`consultation.voting.street`): the street's name, its OSM way ids, whole street or one [segment](#segment) with each end (its kind, the roads branching there or the house number, and its point), the [side](#side), and the official id where a source gives one. It comes from the street picked with Street here (or `ugt_select_parcels` action `street`), offered in the agreement editor while its parcels are among the plan's land; the person can leave it out. A plan or design never names a street.

### Agreement input

Land represented by the included designs, with source-qualified cadastral references and a holder snapshot. The input parcels are the parcels the designs' bindings name; each puts in only the part of the agreement's land that lies on it, not its whole area: the pieces on that parcel alone, and for a piece across several parcels its overlap with this one, in proportion. The rest of a large parcel stays its owner's, outside the agreement. Each input also records its parcel's whole area (`parcelAreaM2`): a scheme's land shares, its cap and the land contribution, are shares of it, the rest counting as land the owner keeps; an input without it counts as the whole parcel. Input areas set area settlement, value and area-weighted approval. Inputs can include modeled open ground: the union of each qualifying design site's geometry outside its bound cadastral parcels, not an area inferred from a binding summary.

### Agreement output

A land piece the included designs make once applied: the pieces they produce and the corridor pieces they take. A design that takes no land of its own (a building rule standing on existing parcels) has the pieces its site reaches into by the binding's rule, or every non-corridor piece of its parcels when it has no site. What other designs carve from the same parcels, and the parcel rest they leave, are not outputs, so they neither join the agreement nor make it stale. Outputs include materialized fabric pieces and any remaining modeled open-ground host that has no materialized piece. Such a host is carried as geometry with no claimed holder or cadastral identity. Its committed identity is a `piece1-sha256:` hash of the defined output projection, not a permanent cadastral identifier.

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

### Record title

A human-readable name for a design, plan or agreement. Titles are not unique and do not identify records. The interface pairs titles with abbreviated existing identifiers: publication CIDs where available, otherwise local keys. These abbreviations are display labels, never new record identities or lookup keys. A matching known plan title produces an advisory during plan creation, without reserving the name or preventing creation.

### Remove from this device

Removal of this browser's copy of a published design, plan or agreement (Lists). The published object retains its CID and remains accessible through its link. A removed design copy comes off the map if it was applied; a removed plan or agreement copy leaves its designs and their map application as they are.

### Publication

The retention of canonical record bytes and their inclusion in the publication index. Publishing a design, named plan or agreement is server-only: the server checks the client's CID and indexes the object, and nothing is pinned on IPFS at publication. A locally computed CID, preview, saved draft or local map application does not by itself constitute publication. Publication is always an explicit act: a design's action reads Publish… until it is published, and says what publishing means before it publishes; once published it reads Share.

### Pinning provider

The configured service retaining the content the application pins on IPFS: community reports and parcel NFT images and metadata ([ipfs-storage.md](ipfs-storage.md)). Filebase is the current upload provider; Pinata remains selectable in reserve through `IPFS_PINNING_PROVIDER`. Provider adapters retain the application's CID scheme and verify the service's returned CID. An upload failure does not automatically publish through another provider.

### Read gateway

The HTTP service resolving an IPFS CID for a reader. `IPFS_READ_GATEWAY` selects generated asset URLs independently of the upload provider. The chain reader tries its own ordered list in the browser (`IPFS_READ_GATEWAYS`) and trusts none of them: bytes are accepted only when they hash to the requested CID. Changing storage or gateway configuration does not change published content identifiers or rewrite existing URLs.

### CID

The content address of canonical design or agreement bytes: CIDv1, SHA-256, base32, using the UnixFS file scheme with fixed 256 KiB chunks and raw leaves. A single-leaf file has a raw root; a multi-chunk file has a DAG-PB root. The CID identifies content, independently of the API indexing it.

### Canonical record

The deterministic authored projection serialized for a content commitment. Derived browser state, materialized land and rendering caches are excluded; explicit authored geometry and decoration designs are included.

### Fingerprint

A hash committing to a named, versioned projection of content. Agreement approval-context hashes and output-piece hashes have narrower scopes than a whole-record CID.

### Publication index

A service's searchable projection of published records, their derived bindings and observed chain metadata. Index metadata and observations are distinct from the immutable bytes identified by the record's CID.

### Read source

Where this browser reads published agreements, plans and designs from: **Our server** (the publication index; the default), **Chain** (the chain reader) or **Both**. It is one explicit app-wide choice, made in Settings or above the Lists and kept in the browser; a link's `readFrom` parameter applies to the page it opens. Neither source is a fallback for the other: an error from a chosen source is reported as that source's. With Chain, lists hold the chain's rows (marked Chain) beside this browser's own; with Both, they hold the rows of either, each marked with the sources that hold it, and an object is taken from our server when it holds it, else from the chain, with which source served it shown. The chain lists only what minted agreements name: unminted plans and designs are on our server alone. Publication is to our server whatever the read source ([blockchain-flows.md](blockchain-flows.md), Flow 1).

### Chain reader

The browser's reading of minted agreements without the publication index ([blockchain-flows.md](blockchain-flows.md), Flow 1), used when the read source is Chain or Both: the agreement program's accounts listed from the chain, and agreement, plan and design objects read by CID from read gateways. A design read this way has no index binding; one is derived in the browser where it is applied. Only minted agreements and the plans and designs they name are pinned, so only those are expected to be readable this way. Designs and plans have no chain accounts: the reader lists the plans its agreements name (an agreement whose account's plan CID hash disagrees with the plan its object names is left out) and the designs those plans name, and a plan's agreements are the accounts carrying its plan CID hash whose objects name it.

### Qualified chain reference

A chain location identified by network or cluster, program or contract, and account or token identifier. A bare address or token number is insufficient to identify the same record across deployments.

## Data sources

### Source abstraction

A named data responsibility with documented reader operations, arguments, results, units and missing-data semantics. Parcels, existing buildings, building details and economics are separate abstractions. An abstraction does not choose a provider from the current location.

### Source adapter

An implementation of an abstraction's reader operations for a particular transport or dataset structure. Its configuration contract describes the source format it accepts; its runtime context supplies services such as database pools, fetch functions and credentials. Different adapters may support different optional operations.

### Source definition

A selected dataset described by stable `id`, `abstraction`, `adapter`, `kind`, readable `label` and adapter-specific `config`. A default source is registered by the application; a custom source supplies configuration to an adapter that accepts custom sources. These kinds describe configuration ownership, not legal authority or data quality. Existing domain source IDs and qualified record identities remain authoritative.

### Source list

The ordered sources of one abstraction for a city (buildings so far): the city's declared sources (`buildings.sources`) and any a person adds, each in use or not, and a source not in use optionally drawn as reference outlines. The sources in use stand in for each other in list order, one cell at a time: a cell is answered wholly by the first source that does not fail it or find it empty. A city whose list is merged (`buildings.combine: 'union'`) has every source answer each cell instead, and a building of a later source is drawn only where no building of an earlier source covers more than half of it; the same layering removes a stand-in's duplicates over a cell line. The person's list is kept per backend and city, or given in the URL (`buildingSources`); a change applies at once. A URL source (`building.<base64url>`, a public ArcGIS, WFS, OGC API, Socrata, GeoJSON or Overpass service, or a CityJSON or CityGML file pinned by the hash of its bytes) is read in the browser; a database source (`gdi-3d`, `dgu`, `osm`, New York's) through our server.

## Land and parcel geometry

### Cadastral parcel

A land unit represented by a particular cadastral, tax or other parcel provider. Its identifier and meaning belong to that source; a displayed polygon alone does not establish registered title or equivalence with another provider's unit.

### Free state plot

Land a cadastre lists as formed by the state for allocation and not yet registered, such as the EGKN
`freelands_view`. Free state plots are a map layer, not parcels: they can overlap each other and
registered parcels. Its state is the cadastre's procedure status (see State land status).

### Land application

A plot drawn in an application for state land, such as the EGKN `reqland_view`. It records a request,
not a right or an allocation; its state is the cadastre's procedure status (see State land status).

### State land status

The cadastre's procedure code of a free state plot or land application, read from the record and named
by the cadastre's own legend. Its **stage** is in procedure, granted (the akimat's resolution, a held
auction, a signed contract or payment), registered (cadastral and rights registration done), stopped
(refused, cancelled, failed) or unknown (a code missing from the legend). Granted is the state's
decision to allocate; title exists only once registered.

### Parcel source

The provider of parcel identities and geometry, identified by `sourceId`. Jurisdiction and legal authority describe the source but do not replace its identity. A custom source descriptor identifies the selected service and its interpretation. Map lookup and server-side site binding use that same selected parcel source.

The frontend consumer owns source configuration and sends its selected source explicitly. When a design is shared, that source is chosen by where the design's ground lies (its site, else its drawn polygons), not by its city label. Backend services validate and serve that selection; they do not infer a city default. A retained cadastral namespace and the API gateway selector can have different identifiers while referring to the same parcel source; choosing a gateway does not rewrite the retained source observation.

### Source-qualified parcel reference

A parcel ID qualified by its source and, when available, snapshot. Equal unqualified IDs or overlapping polygons do not establish identity across sources.

### Source snapshot

An identified captured state or release of a provider's data. A null `snapshotId` means the snapshot is unknown, not that two observations necessarily describe the same release.

A **saved copy** is our own complete capture of one provider view, kept as a backup and not served (Kazakhstan cadastre districts). Its capture time is the provider's own `timeStamp`; parcel identity is the same as the live view's.

### Parcel set

A canonical sorted set of parcel IDs with its parcel-source descriptor. Its `setHash` commits to the IDs and normalized source identity, not to current geometry, ownership or legal authority.

### Detected parcel block

A temporary selection derived from one seed parcel and one complete surface enclosure. The enclosure uses loaded OSM highways other than pedestrian ways (footway, path, steps, cycleway, bridleway and the like: a separately mapped sidewalk runs through the lots it borders), railway tracks and waterways, plus `natural=coastline` and `natural=water` ways; a street mapped to stop within 10 m of another enclosure way is carried on to it, since its ground still divides the blocks on either side; current applied surface-level corridor boundaries may also participate. Bridges, tunnels and other non-ground features do not divide surface blocks. Railway facilities such as workshops, stations and platforms are not track boundaries; proposed and razed tracks are excluded. A seed and every member must fit wholly inside one enclosure; representative points do not decide membership and geometry is never clipped. Any parcel touched by an eligible OSM street or track is a border parcel, including touches on its outer or hole boundaries, and cannot seed or join a block; a pedestrian way, service way or farm track (`highway=track`) touching a parcel does not make it one. A rejected enclosing parcel also excludes parcels enclosed by its holes or outline. The Road/track layer in Layers draws every eligible OSM transport line as a thick black line, pedestrian and service ways included. Known road and track ground is excluded from membership, including source parcels marked by the configured road classification and their disconnected cadastral pieces. Authored plots do not inherit road use solely through source ancestry. Detection requires complete OSM boundary, parcel and available road-classification coverage. More than 100 members is refused; the first 100 are shown as a temporary preview without changing the current selection or persisting a block record.

### Road parcel

A cadastral parcel marked as road ground, kept in the browser's road-parcel registry. Road parcels bound formed parcel blocks and never join one. Where the backend has a road classification for the city (`curatedRoads`, Zagreb), its road parcels are marked as parcels load. Anywhere else, "(Re)form blocks" first marks road parcels from the OSM roads and tracks that bound a detected parcel block (the Road/track classification over `/blocks/roads`, read live through the backend's Overpass chain, never the `osm_road` table): a parcel is a road when 3 m corridors either side of the lines, measured against the parcel grown by 2 m, together cover more than half of it. Incomplete OSM coverage marks nothing. The full count checks every parcel in view; the re-form after loading checks only the newly loaded parcels. The Roads section's OSM and GUP detectors apply the same coverage rule to their own lines.

### Cadastre frame

The source context captured for a cadastral-dependent calculation or commitment, including its observation time and any supplied geometry hash. It is not necessarily a reproducible copy of the entire cadastre.

### Site

The geographic land on which a design operates. An authored site can cover parts of parcels, several parcels or modeled open ground; it can be larger than the building footprint.

Any mapped zoning area can supply a design site. The design copies the entire source record boundary, including holes and separate parts, and pins the source edition and revision. A parcel-layout design can divide this site into proposed plots. Cadastral binding identifies the underlying registered parcels separately.

The site is a design's saved land boundary, not a restriction against editing its geometry.
Editing a road's footprint updates its site to the new corridor land and invalidates its old
parcel binding. Geometry must fit the current authored site at publication; a refusal returns
the outlying geometry so the map can identify the affected area.

### Parcel binding

The derived relationship between authored site geometry and a stated parcel source, including intersections, coverage and the intrusion tolerance used. A binding describes the source observed at calculation time, rather than altering the authored geometry.

An imported design awaiting its first binding uses its plan's parcel source. An explicit local declaration of open ground has an empty parcel scope.

### Binding coverage

The extent to which a site has represented cadastral coverage: `complete`, `partial`, `none` for confirmed lack of supported coverage, or `unknown` for unverified coverage. Unknown or failed source data cannot establish that the site is open ground.

### Binding drift

A difference between a retained binding and a later calculation against the identified source. Drift qualifies the relationship to current source data without changing the published record's original commitment.

### Live parcel

A selectable piece of land in the working parcel fabric, including unchanged source land, formed outputs and remainders. Its runtime identity and geometry are distinct from the underlying cadastral references. Disconnected polygons of an unchanged source parcel are separate selectable cadastral pieces with deterministic `#cadastre-N` identities, each retaining its parent cadastral reference. Selecting a multipart parent requires choosing a piece; authored cuts retain their own live identities.

### Parcel fabric

The current modeled subdivision of land produced by source parcels and applied designs. It records the provenance and relationships of its live pieces.

### Materialization

The browser-local result of applying a design to the parcel fabric. It includes generated land pieces and other derived effects; it is not part of the portable design instruction.

### Formation

A design's operation that cuts or replaces live ground and produces land pieces. Creating a fabric piece is separate from minting a blockchain account.

One authored site can produce several body pieces or explicit layout plots; what it leaves of the
parcels it cuts is their remainder, not its output. Producer metadata marks only the pieces a design
produced. Cadastral input references are independent of the number of body pieces.

A building's formed land take and its subtracted remainders use the same clipping grid (nine decimal places in longitude and latitude). This is derived geometry; the authored land take and building footprint retain their original coordinates. Facade intersections use the same clipper so different coordinate precision cannot create a second ownership slice along that cut.

### Remainder

The part of parent land left after subtracting a design's land take. A remainder retains its modeled provenance and carried rights rather than belonging automatically to the new design. The remainder of a parcel's own ground (land no design produced) is that parcel: it has no producer, records the designs and roads that cut it (`cutByProposalIds`), and keeps the parcel's id while it is one piece, so a parcel that designs are carved from inside keeps its name with holes where they stand. When cuts split it, each part is named by its outline. It is derived as the parcel minus every applied take, the same whichever design was applied first, and unapplying a design gives that ground back to it. The remainder of another design's piece stays that design's piece.

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

### Street

User decision, 2026-11-27: "A street is the road, branches included, carrying one official name (only numbers and monikers differ), from the official source where one exists (England: OS Open USRN / OS Open Names)."

Implemented as the connected OSM road ways (any road class; a service way only when named) that carry one name, compared without case, full stops or apostrophe variants, branches included; ways whose ends lie within 20 m join. Its official identity comes from a `street-identity` source: OS USRNs that OSM ways carry as `ref:GB:usrn` (an identity only when every way of the street or segment carries the same one), or a street register in geodata (`public.street`, Zagreb) matched by name inside its coverage. Elsewhere a street has no official id and is named by its OSM ways. `GET /streets/segments` reads one at a point or by name; the shared road vocabulary (`cadastre-data/roads.md`) also defines Street. A street is a selection aid and a reference a street vote records, never a design.

### Segment

User decision, 2026-11-27: "A segment is the part of a street between two referable points: its start, its end, a bend of 30° or more (measured over a baseline of tens of metres, not adjacent vertices), a branching (major or minor road), a bridge wider than 3 m, a gap over 50 m between buildings, or a house number (official numbers where published, OSM as the fallback)." Hughes's street (Strong Suburbs; Living Tradition para. 1) is a segment between two branchings.

Implemented in `frontend/js/streets/street-segments.js`. Referable points are: an end; a branching, where any other road (not a footway, path, cycleway, track or unnamed service way) or a branch of the street itself meets it; a bend whose 20 m chords on both sides of a vertex turn 30° or more, the sharpest within 20 m counting once; both ends of a bridge carrying the street for more than 3 m; a bridge over it (another way tagged `bridge`) wider than 3 m by its `width` tag, else 5 m for a railway, 2–2.5 m for a footway, path or cycleway and 6 m for a road; both edges of a gap over 50 m between buildings (below); and a house number within 50 m whose `addr:street` is the street's name (OSM; no open official numbers are read). Points within 5 m are one. The offered segments lie between consecutive referable points other than house numbers and gap edges; house numbers and gap edges name ends and bound a selection between any two points on one stretch, so an agent may cut at any gap explicitly.

A gap is a stretch over 50 m on one side without OSM buildings within 40 m of the centreline, from one building to the next, or to the end of the stretch between branchings when the next building is beyond the junction (none when the buildings could not be read). Following Strong Suburbs para 8, a gap is not developable by a street vote (a segment lists its gaps as `undevelopable`, by side), and it ends an offered segment only where it faces a gap on the other side: the segment is cut at both edges of the part where the two face each other, which becomes a segment of its own. A gap facing buildings stays inside its segment. A road joining opposite a gap (the paragraph's other buffer) is a branching, which ends the segment in any case. The user's definition above lists every gap as a referable point; the offered segments follow para 8. A segment is not the road vocabulary's connectivity stretch (`road_stretch`), which breaks at every junction only.

### Side

The left, right or both sides of a segment, relative to its direction: a segment runs west to east, or south to north when it runs more north–south. The UI names a side by compass ("north side"). A parcel is along a side when a perpendicular ray from the centreline, cast every 2 m up to 40 m, reaches that parcel's boundary first for at least 3 m of the segment; parcels containing the centreline and road parcels are looked through. For the whole street, each segment's own sides are used.

A plot belongs to every street its boundary runs along (Strong Suburbs para 6.3), so a corner plot is along each street it fronts. A **corner plot** of a segment is a plot along it whose boundary also runs along another road at one of the segment's ends: the same ray test, both sides, along that road for 60 m from the branching (each branching point carries those roads as `arms`). Chamfered corners count (para 80.5). The selection marks them and the street reference a vote records lists them (`corners`: the parcel and the other streets' names). When the Neighbours tab adds an affected parcel, a corner plot of the picked street defaults to compensation like a house not on the street (para 80.3), where other plots on the street default to consent. Not modelled: para 80.1 (a corner house gets permissions only if both streets vote, then the stricter of the two) and para 80.3's refund once the second street's vote succeeds; both need one vote linked to another.

### Map share

A design link shares exactly one published design revision. A plan link shares exactly one saved plan revision; when an applied member has a revision or rebind successor, Share plan prepares a new unpublished plan revision, otherwise its dialog cannot change the plan's name, membership or view. Create plan (Lists → Designs or Plans) ticks the plan's designs in Lists → Designs, where the ticked designs show on the map together, then names the plan and its saved view without publication; the plan dialog lists those designs and changes them only through Change designs, back in the list. Add to plan opens creation or a reviewed revision of a chosen saved plan with that design added, and Edit plan opens a revision with the plan's designs. Each Lists tab offers Create (a plan on Designs and Plans, an agreement on Agreements; a design starts from its place on the map), Compare, Import of its file kind (a design file adds its designs as drafts and keeps no plan) and Imported, the records files brought to this device. Saving any change creates a new immutable snapshot; existing links remain unchanged. Create agreement starts a separate agreement editor from a saved plan, and agreement sharing uses that agreement's own flow. “Lists” names the panel containing Designs, Plans and Agreements. Each tab lists one object per row, drafts and published alike: unpublished and published are stages of saving one object (autosaved in this browser, then also saved on the server when published; an agreement can also be on chain), and fetching a published object is automatic, its browser copy only a cache. Deleting a draft does not remove plan members or change an agreement’s exact plan reference. The Designs tab's **On the map** toggle, with its count, shows only the designs applied in this browser; the filters' Reset turns it off. **Unapply all** beside it, with the same count, takes them all off the map and is absent when none is on it. A Designs row carries no “Status unknown” badge; a known lifecycle modifier (Expired, Withdrawn, Awaiting funding) keeps its badge.

Choosing “Unapply existing & continue” replaces the conflicting applied designs. Incoming buildings and surface spaces replace conflicting applied roads occupying their authored footprints. An incoming parcel layout also replaces applied roads, layouts and content occupying its authored plots; designs outside that ground remain applied. An incoming road replaces an applied road it lies over nearly all of (at least nine tenths of that road's ground): the same road drawn again, such as an earlier publication of the plan's street. Compatible road junctions and host parcel layouts remain. Unapplied designs remain saved. The replacement commits together, or retains the previous working composition if any member cannot be applied.

Replacement re-derives only the affected ground and its spatial dependencies. Applied designs elsewhere are not replayed as part of that local change.

After a successful confirmed replacement, the view frames all incoming applied designs together, overriding a previous position or camera in the shared URL. A visitor who takes over the view during loading retains control of it.

Selecting an object in model or Google 3D, including a design from a list or a click-stack section, retains the camera and surrounding composition. A yellow pulsing outline follows the selected building or massing's drawn volume, or the authored ground boundary for parcels and ground-only designs; reduced-motion views use a steady outline. Ground-only designs also show a transparent yellow hatch across their authored surface; formed and cadastral parcels use an unfilled boundary, including when a formed parcel shares the design's geometry. Selection does not recolor underlying parcel surfaces or isolate the design. Both 3D views use the same selection sections, inspectors, repeat-click retention and deselection rules, and both views build the stack from the selected object outward. Google imagery supplies a visible surface position; cadastral and building identities come from source records. Where the Google mesh has no addressable object volume, selection outlines the known source footprint on the loaded surface. Cadastral boundary visibility controls drawing independently of selection.

**Side-by-side comparison** (model view and map): the Buildings and massing sheet's Compare tab splits the view at a draggable divider; each side draws one state of the same scene from the same camera. A side is Built today, Permitted massing, Proposed (every applied design), one saved design or one saved plan, applied or not; what is not applied is read without applying it. The standing city is shared; a side adds only the work it applies and removes the buildings that work demolishes, and shows no other design's work. Permitted massing draws on the Permitted side alone. Display settings still decide what each side may draw. On the map the sides differ in building footprints and permitted massing; parcels, roads and parks show on both. The comparison is a view, not a record. Like the camera, it is kept in the address while it is on: `compare=<left>,<right>`, each side `built`, `permitted`, `proposed`, a saved plan's CID or a published design as `design-<cid>`, so a copied link opens the Compare tab with the same two sides once they are offered; a published design not held in that browser is fetched and kept there, not applied. A side with no shareable name (an unpublished design, an agreement) leaves `compare=` out. The address also names a plan held only in this browser, so a refresh reopens it; another browser that opens such a link says the plan has not been published instead of opening it. Copy link (Compare tab) copies only what is on the server: when a plan or design side is not published, it reads Publish and copy link and publishes that side first.

Restoring a saved camera retains the map's display settings and surrounding context. Its selected design is highlighted without isolating it from the shared composition.

Opening the Freeform building editor preserves the current map view. Choosing another city for exploration leaves the previous shared plan and its saved view behind.

In 3D, sharing can include the captured camera position and angle, independently of the optional “Rotate on arrival” choice. Rotation defaults off, orbits the view's focal point and starts when the view is ready, after terrain alignment in Google 3D. The first click, touch, scroll or key input stops rotation or cancels it while the scene loads. Reduced-motion views remain still. Unnamed links carry these choices in `camera` and `rotate` URL parameters; named plans save them in their view.

The browser address follows completed view switches and the current 3D camera target, heading, pitch and range. Moving the camera updates the view without publishing designs or changing the plan referenced by the address. Private draft preview references remain in the address while navigating their view.

The planet in the city/search control indicates whether the current address reproduces the applied composition: green when it names the same published design revisions, orange when local edits or different membership are absent from that address. Saved but unapplied designs do not affect the indicator. Camera movement alone does not change it. In 3D the control shows only the icon and retains its globe action.

Its social preview is a derived 2D image of the included designs' authored map geometry, framed together independently of the interactive camera. The image is cached by the unique set of design CIDs and renderer revision; it is not authored plan content. Missing or failed images can be regenerated from those published records.

When shared designs conflict with the current map, the person chooses whether to unapply the existing conflicting designs and continue, skip the conflicting incoming designs, or cancel. Unapplying existing conflicts and deriving the chosen plan is atomic; failure retains the previous map. Every design remains saved, and unrelated applied designs remain on the map. Overlapping road revisions are conflicts, and so is an applied road that an incoming road lies over nearly all of; ordinary roads meeting at a junction or crossing remain compatible, as does a track along a road.

### Plan

An immutable `plan/v1` snapshot containing a title, a selected set of design CIDs and a map view. Its canonical content has its own CID; publication gives it a permanent `/plans/<cid>` link. Its publication timestamp is the server’s first indexing time, exposed as `publishedAt` outside canonical content; opening, importing or republishing the same CID does not change it. Lists displays this timestamp in the viewer’s local timezone beside Published. Changing the title, membership or saved view creates a new snapshot and link; existing links keep their original content. It references existing designs without changing their authorship, geometry or publication. Its designs stand together. In Lists each design ticked for a plan is applied, as an Apply click applies it (standing down a rival on its ground), after the ones already ticked in formation order (the order the designs were made in), inside a parcel mutation that is rolled back (`PlanWorkspace.trial`): the design ticked last takes its ground, a ticked one it stands down is unticked with a warning naming both, and one the apply refuses outright is not ticked, with the reason. Saving a plan (Create plan, Add to plan, Edit plan) runs the same trial over the designs held here. `ugt_draft_plan` places each design against the ones before it with the same apply rules as `ugt_edit_plan`. A plan saved before this can still hold such a pair; applying it reports the displaced member. A plan names its designs by content CID, so opening one finds this browser's own records of them, published or not, rather than importing copies. It carries no land allocations, money or decision rules; those belong to an agreement. It may name the [street codes](#street-code) it claims to respect (`codes`, each `{ id, version }`, left out when none, so a plan without them keeps its CID); a claim is checked wherever it is relied on, never trusted. The backend address used to access a plan is transport configuration, not part of its content.

Plan stats and Compare plans evaluate one exact saved plan revision, including unapplied members. Compare designs (Lists → Designs) evaluates each chosen design the same way, as its one-member plan; a published design not held on this device is fetched for it and not stored. Compare agreements (Lists → Agreements) sets the chosen agreements' terms side by side and marks those they differ in: plan (by CID), status, decision rule, approval, settlement and land contribution, deadline, input land, resulting pieces, land to the owners, the public and the proposer, owners left without a piece, cash paid and received, and the sponsor's part. Below the terms it evaluates each agreement's plan as Compare plans does, under the agreement's title. Compare plans is a decision sheet: per plan, besides Plan stats' figures, the existing parcels it takes and buildings it demolishes, its tallest new building (metres and storeys), its floor-area ratio (gross floor area standing after it ÷ its land) and site coverage (the union of the footprints standing after it ÷ its land), its green (parks) and road area, its build-out from the first to the last period, its Permitted limits (each new building of the whole plan checked against the Permitted items where it stands: within, how many break them with their floor area, none conditional or unknown, or no source) and the agreements backing it: those published on that exact plan revision, with a crowdfunding round's progress (USDC contributed less refunded, contributors, apartments reserved of offered) read from Solana, never from the index. An agreement with no plan yet cannot be chosen; a published one not held on this device is fetched for it and not stored. Parcel figures derive from its members and source cadastral ground in isolation; unrelated map designs and the current map extent do not affect them. Evaluation does not apply the plan. The Compare tab's divider takes a saved plan, or a stored agreement's plan, as a side the same way: a member an applied design stands for is that design; the rest are read as Plan stats reads them and drawn on that side alone, with the standing buildings they clear taken off it. Built today is the present state of that comparison. The divider's stats button opens the same evaluation for its sides that are a design, plan or agreement, with Built today as the present state. The urban rooster scores a plan only when every member is applied, from the live map.

A private named-plan draft can reference unpublished design revisions carried with it. Publishing that draft first publishes its missing designs, then the named snapshot, and verifies the same content identifiers. Sharing follows each member's applied revision or rebind lineage; changed members create and offer a new unpublished plan snapshot, while members without a local successor remain the exact carried snapshot. A separate copy is not a successor, and ambiguous applied forks require a choice before sharing. Drafting or editing a named plan derives no agreement ground. Drafting and editing place added and revised designs using the shared working-plan application rules.

Importing a plan saves its exact member revisions as a local named snapshot. A separate import receipt supplies the Imported plans catalogue; the named snapshot owns publication state. Importing or opening that receipt preserves an existing snapshot's publication state.

A plan contains one or more designs and can exist without an agreement. Each agreement references one exact plan revision; any number of agreements may reference that revision. Editing a plan never changes an existing agreement’s subject. Plans and agreements have separate share links. The map click stack orders Agreements above Plans, scoped to the selected exact plan revision, followed by Designs and source objects; it displays the selected level and its nearest available neighbours. Whatever opened the stack, the selected object's own references supply the sections above and below it. Agreements inherit their plan’s extent for inspection; they are not independent spatial picks. Multiple agreements share a selector. The expanded Agreement section contains the full scrollable properties and actions. Its Plan button selects that exact plan in the current view without navigation, importing or applying its designs.

### Working plan

The private plan an MCP agent authors in, standing in for the map a person applies designs to. Each agent draft or design edit is placed into it with the map's explicit Apply rules and makes a new plan revision: roads join its roads, and ground another member holds is refused until the person agrees to displace that member. Without a named plan the first design starts one. A working plan is an ordinary plan. A shared plan session can name its current revision for a browser and an agent.

### Shared plan session

A private collaboration record in PostgreSQL (`consensus.shared_plan_session`) that names the current accepted ordinary plan revision and carries its exact design members. It adds no new design or plan format. A published plan can start a session; subsequent edits create private revisions without changing the published source. Publication remains a separate explicit action. A session expires 24 hours after creation; reads and edits do not extend its lifetime. Expiry removes access and the stored collaboration record, without removing local or published plan revisions. Disconnect immediately terminates the session: an owner-authorized transaction deletes its private state and invalidates both capabilities, independently of the current turn or revision. Local and published plans remain intact.

The owner controls whether the browser or the invited agent may save the next revision. The session version changes on both content and control changes; a save must match that version and the current editing authority. Owner takeover uses the latest accepted revision even when the supplied version is stale. Revocation also rotates the invitation; it does not replace that revision. The owner capability controls the session; the separate invitation capability permits inspection and, only when granted, editing. The database stores hashes of these capabilities; version and authority are checked within the same save transaction. Neither capability belongs to authored plan content or a public link. The browser's local workspace remains separate and retains its single-tab lock.

While the owner edits a connected member, the browser keeps a pending ordinary plan revision containing that member’s current local revision. The Plan section follows this pending revision. The accepted server revision changes only on Save to shared plan or handover; earlier plan revisions remain immutable. A session also stores a receipt for its last accepted content change and, while eligible, the preceding artifact for one undo of an agent change. Undo makes a new session version pointing to that exact preceding artifact. An owner content save clears undo eligibility; control changes preserve it. These session records are not authored plan or design content.

Agent activity means an edit operation is in progress while the agent holds the current session version; holding control alone is not activity. Authenticated notifications report session state and activity, while the full accepted artifact and receipt are read separately.

### Shared-session publication approval

A browser-owner grant allowing publication of one exact saved shared-plan revision and its members. The grant binds the plan CID and session version and is recorded separately from authored content. The owner must hold editing control and review the saved revision before granting it. The invited agent can publish that approved revision without holding the editing turn. Saving a revision, undoing, changing turns or revoking the invitation clears approval; expiry and termination also end it. Owner revocation of publication approval does not need a current version.

The shared publication path checks approval immediately before starting and uses the server's immutable artifact. A publication already started may finish after approval is withdrawn or the session changes; it still publishes only that approved artifact. Retrying the same approved revision is idempotent. This grant does not require an account and does not restrict the ordinary anonymous publication API or prevent a reader from copying content.

### Plan area

The land a plan covers: the union of its members' sites (each design's authored site, else its own footprint, the ground its binding is computed on; a parcel act's declared parcels), open ground included, in m². The untouched rest of a parcel the members stand on is not plan land. Public land, private land, resulting parcels, remaining buildings and the present state are all measured over it.

### Public land

Land in public use: road parcels (the road classification, or parcels marked as roads), land covered by OpenStreetMap parks and squares (`leisure=park`, `place=square`, pedestrian areas), and the pieces a plan's designs make into a road corridor, park, square or lake. Ownership does not decide it. Semi-private land is not yet defined.

### Square enclosure

The Cat's overall score is the share of the selected square's perimeter defined by buildings,
rounded to a whole point out of 100. At 75 points it is well enclosed; from 50 to 74 it is partly
enclosed; below 50 it is mostly open. A minimum score from incomplete building stock is rounded
down and receives no enclosure verdict.

The share of an authored square's exterior perimeter defined by nearby buildings, measured for the exact saved plan revision. The Cat samples each side at about 2 m intervals and looks out perpendicular to the edge for the first building within 25 m. Adjacent collinear edges form one side. For the height-to-width figure, width is the distance from that building to the opposite square edge, including the facade setback; a side displays the median of samples with a measured or estimated building height. Building stock consists of the plan's buildings and the existing ones its designs leave standing. Unavailable existing stock yields a minimum based on plan buildings and leaves the rest of the edge unknown. Public designation follows the square design; pedestrian access is a separate question.

### Walkability assessment

The Dog measures the fastest route from each residential building in an exact plan revision to the nearest park or square, shop, and transit stop. Sidewalks and footways form the network. Same-level corners, authored crossings and zebra crossings drawn by the junction model link its parts. The assessment estimates access from a site edge up to 25 m where the connection avoids other buildings and ground-level carriageways. It uses 1.2 m/s and adds 15 seconds at crossings. Each residential building counts once. The score is the mean of the shares reaching a destination within ten minutes, over destination types present in the plan. An absent destination type has unknown coverage. A recorded destination with no route counts as unreachable on the plan network.

### Cycling assessment

The Hare estimates routes from residential buildings to parks, squares, shops and transit stops in an exact plan revision. It follows bike access and direction rules on authored roads and paths. Different levels stay separate. An off-street track needs a bike connection at a crossing of a through street. Missing links do not count as routes. A building or place can link to a rideable segment from its edge within 25 m. Bike reachability is a count of origins and destinations, independent of the lane quality score.

The Hare's lane quality score weights measured metres by direction. A protected track has a dedicated route away from motor traffic, a physical divider in the cross-section, or an explicit separation tag, and scores 100. A painted lane scores 70, shared traffic at 30 km/h or less scores 40, faster shared traffic scores 15, and a direction that prohibits cycling scores 0. Shared streets of unknown speed may still be routed where access allows. Their length is shown without a grade, and the score uses the rated length only. The map shows the lowest grade or a missing grade where directions differ.

### Private land

A plan's parcel land (on its plan area) that is not public land, in m²; open ground is in neither.

### Present state

What stands today on the land of a chosen saved plan (or of all compared plans, designs or agreements), read as a plan of its own: every existing building from the city's building source, clipped to the plan area and measured as a freeform building by plan-yield's rules, today's public land, and no designs. It is the baseline column of Compare plans, Compare designs and Compare agreements.

### Remaining building

An existing building a plan's designs neither clear nor extend. A plan's standing buildings are its new buildings, the existing ones it extends (counted once, as redrawn) and its remaining ones. A standing building the suggested default layout can lay out (or one with its own floor plans) counts that layout's apartments, and its shops as work; every other building's apartments, people and jobs derive from its floor area by the Plan stats assumptions. A design clears its demolition ground (a building design's site or land take and its footprints, a structure, a road corridor; never the rest of the parcels it stands on) with the demolition scan's thresholds: under 2 m² of overlap the building is untouched, and when under 10 m² or 15 % of its footprint is left it is gone.

### Profit on the new floor area

A model at the city's prices where its land is (economic rates for that location, or the prices a person slides or types or an agent passes), in its currency: the value of the new floor area (floor area × sale price, tax included as quoted), its all-in cost, and the profit, value − all-in cost. The all-in cost is the construction (floor area × construction cost), the development charge (floor area × the place's charge per m² of new floor area), the acquisition, and the sale tax inside the value (value × tax share ÷ (1 + tax share)), less the tax reclaimed on construction. The tax reclaimed is construction × tax share ÷ (1 + tax share) when the construction rate includes the tax on its inputs (`taxIncluded`), as a statistics office's cost of what developers paid does, and 0 otherwise. The acquisition buys each plot once, at its benchmark value: the higher of its land value (land area × land price per m² of land) and the value of the existing floor area the new floor area replaces on it at the same sale price (its existing use value). Vacant land is its land value; the land under a replaced building is not paid for again on top of the building. No premium is added. A plot is a parcel the plan stands on, with its part of the plan's land, or the plan's land on no parcel (open ground), in Plan stats and `ugt_compare`; in the 3D panel it is the parcel, each of the design's parcels, or its site. Its land is the plan's land in Plan stats and the designs' sites in `ugt_compare`, the parcel's or site's land in the 3D panel. Its replaced floor area is, for Plan stats and `ugt_compare`, the cleared floor area on it: what the designs clear of existing buildings, measured by plan-yield's rules, a cut building counting the part it loses and belonging whole to the parcel holding most of its footprint; in the 3D panel, the floor area standing on it. The floor area is what is built: the designs' floor area less what extended buildings already had; an extended building's floor area is neither sold nor replaced, and the land of designs that only extend is not bought. A missing price or area, a cleared building without a height, or an extended building without a stated existing height leaves what depends on it unknown, never zero. At a monthly rent per m² of floor area, the annual rent is floor area × rent × 12, and the rent yield on cost is the annual rent ÷ the construction, development charge and acquisition: a landlord who charges no tax on the rent and reclaims none on construction. A missing land price leaves the all-in cost and profit unknown. Fees and finance are not in it; it is not an appraisal.

### Private draft reference

A bearer URL resolving to an immutable unpublished design, agreement or named plan and its exact member revisions. It persists independently of an MCP client session. Hosted references have a stated expiry; local demos can retain references without expiry in persistent local storage. Exported canonical content can restore an expired reference's content. A private preview is not publication, application, consent or a public share link.

The MCP preview flow carries this reference in the `draft` URL parameter for review before publication. The Designs sharing panel requires publication for every included design and does not carry a private draft reference into a permanent link.

### Applied / unapplied

Whether a design currently contributes to the working composition. Application expresses a modeled map effect, independently of consent, chain execution and physical construction.

Import retains a design definition independently of the currently viewed ground context. Reconstruction uses its authored geography and actual cadastral source references; descriptive city text does not determine eligibility.

Unapplying a design that later applied designs stand on (their footprints lie on its ground) names them first. The person unapplies them with it, in one change, or leaves them applied; a design left applied takes its ground again from what remains, as in any replay.

Several designs are unapplied in one change: a plan's designs from its card (Unapply), or every design on the map from Lists (Unapply all). The same question is asked about designs standing on any of them and not themselves coming off. Afterwards a notice says what came off, naming any design the change took off beside those asked for, and offers Undo, which applies them all again in one change.

A saved design whose goal the application no longer applies (a retired format) cannot stand. A replay that meets one applied, on load or beside a plan being applied, unapplies it, keeps it saved and names it once; it never fails the replay. A design being applied in that same change still fails it.

### Replay

The reconstruction of a working composition by applying designs in their defined formation and dependency order. Display order, agreement membership order and construction windows do not themselves determine replay order.

Formation order is authoring time. Among designs of the same time, a parcel layout forms before the designs that stand on its plots; identifiers decide only what remains tied.

A replay puts back what already stood: it never changes which designs are applied. Only a design being applied or edited in that change can take another off the map, and every design taken off is named.

### Construction window

A plan member's start and end month (`YYYY-MM`, both inclusive), stored in the plan's `schedule` under the member's design CID. Dates belong to the plan, not the design: the same design can be built at different times in different plans. Members without a window are unscheduled and count as built at every date. The time control only displays a plan's windows; it does not set them. A window is distinct from replay precedence, and Plan stats counts a member in the year its window ends.

### Time control

The map's control that moves one month back and forth over the construction windows of the plan in view. At that month each scheduled member is planned (before its start), under construction (progress grows linearly over its window's months) or built (after its end). It only displays: nothing is applied, unapplied or replayed. Closing it returns to now, where everything on the map stands as applied. `when=YYYY-MM` in an address opens it at that month.

### Opening assessment

The Beaver checks an exact plan revision at the end of a chosen month. A building, park or square can open when its construction has finished and the scenario declares road access and servicing ready. The plan's construction end applies unless a test month is specified. A missing date, access assumption or servicing assumption leaves readiness unknown. The delayed-connection scenario blocks completed designs that explicitly depend on the external road connection. Its impact counts floor area and public space that would otherwise be ready. The assessment applies no designs and stores no scenario assumptions in the plan.

### Simulated build-out

A seeded, repeatable scenario giving the plan's undated members construction windows: a start month drawn from a yearly start rate and a duration from floor area; an urban rule builds parcel by parcel, one window per building. Members the plan dates keep their windows. It is shown on the time control and in an address as `buildout=<seed>`, and is never stored in a plan or agreement.

### Footprint

A horizontal outline whose subject must be qualified. A building footprint describes the building's plan outline; a corridor footprint describes occupied transport land; a design footprint combines the authored parts relevant to an operation.

### Building use

What a building is for, by storey, stored on the building as `properties.use`: residential, residential-shops (shops on the ground floor, flats above), mixed (shops on the ground floor, offices on the first, flats above), office, public (school, clinic, civic) or industrial (`frontend/js/building-use.js`). A word naming one ('housing', 'offices', 'school') reads as that use; any other value is no stated use. A drawn Freeform building starts as residential; an imported one states the use its city model's code maps to, or none, as does a design saved before uses existed. Only a housing use, or a Block, Row or Detached rule building, gets the suggested default layout and its counted apartments; an office building gets a suggested central-core office layout too; a building of another use counts its storeys as work. A building with no stated use follows the Plan stats housing share. A Block, Row or Detached (`parcelBased`) rule building takes its use from its rule's Use (`urbanRule.use`) and only from there; a `use` on the building itself is ignored (`BuildingUse.statedUse`). A Row or Detached rule starts as residential. A Block rule starts as Automatic, which states no use: its buildings are housing, and the suggested layout puts shops on the ground floor of a Block building of five storeys or more (`BuildingUse.storeyUsesOf`). Converting a rule design to Freeform writes each building's resulting use onto the building. Building use is distinct from a design's Land use (park, square or as is). It is the building's intended use (CityGML `function`); a city model's stated `function` or observed `usage` codes map onto the same values when imported (`BuildingUse.fromCityModel`), and an existing building a source states a use for carries it too, for Plan stats and X-ray: a city model's code, or an OpenStreetMap or Overture building's `building=*` value (`BuildingUse.fromOsmBuilding`; `building=yes`, sheds, garages and roofs state none).

### Building access

How a building's suggested default layout reaches its flats: `point` (point access: stair cores, each serving the apartments beside it, typically two per storey) or `corridor` (a double-loaded corridor along the building with flats on both sides and stair cores on it). Unset means automatic: a floor plate at least 15 m deep inside its exterior walls gets a corridor, a shallower one point access. Stored like the Building use: a Freeform building as `properties.access`, a Block, Row or Detached rule building on its rule as `urbanRule.access` (`BuildingUse.statedAccess`). The X-ray view may override it for every building it shows without changing any design (`BuildingUse.layoutAccess`: view, then building, then depth). It shapes only the suggested layout and the apartments counted from it, never the building's massing. An office building, a building of stepped parts or a compact tower takes a central core instead, with flats off a corridor along its lifts; a stated `point` or `corridor` Access keeps a compact tower to that access.

### Land take

The exact ground a design consumes. A Freeform design's `geometry.landTake` can combine footprint cuts and chosen whole parcels while its material building footprint stays unchanged. A chosen whole parcel remains taken only while a building footprint overlaps it. When the last building leaves, that parcel and its surroundings leave the design, restoring its source state. It governs land formation and building-removal effects. Surrounding paving or green space occupies only taken land outside the building footprint; a footprint-only take has no surroundings.

### Derived demolition

What the applied designs do to the source buildings shown: razed, cut (the rest stands) or passed under by a road tunnel. It is derived from each design's land (a road's footprint; a block, row or rule design's site and its footprints, its footprints alone when it has no site; a Freeform building's land take, else its footprints; a structure's body) against the buildings of the sources in use, against the union of every design's land, so the order of the designs does not matter: under 2 m² of overlap a building is untouched, and when under 10 m² or 15 % of its footprint is left it is razed. Nothing is stored on a design; a change to a design derives again the buildings under its old and new land, and a source switch derives everything again.

A design that redraws existing buildings on their own footprints (Raised existing buildings) takes nothing: the building at least half under its footprints is **extended** (the record's `extended`), kept and standing on as the design's redrawn building. The app says "Extended by", lists it apart from replaced buildings, never shows it as removed, and a design that really takes the building's ground decides instead.

It shows the plan fully built out: the buildings that give way if everything on its land is built as designed. A design does not order a building's demolition, and an urban rule only bounds what a replacement may be, so the app says **replaced** (the building card's "Replaced by", Compare plans' "Existing buildings replaced", the model view's Surviving and Removed states), never "demolished". A building rebuilt on its own, or raised by storeys, is its own design.

### Building tunnel

A span of a road's centre line (an edge, from one portal to the other) along which the road passes under buildings. The record is the span; which buildings it passes under is derived from it against the buildings shown, at the road's width along that span.

### Demolition review

The preview of modeled full building removals and partial cuts caused by a land take. It updates with the design and does not require a separate acceptance before saving. It is distinct from an owner's agreement decision and from real-world demolition.

Reviewing a replacement design evaluates observed stock before the source design's own removals. Application evaluates removals against the transaction's applied composition, including sources stood down by that replacement; an unchanged land take does not lose its removals merely because the source is still visible until commit.

### Surroundings

An authored paving or green treatment of the land around proposed buildings, represented by `geometry.surroundings` (in CityGML terms paving is a traffic area, green a plant cover; CityGML's `GroundSurface` is a building's base, see [building surfaces](#building-surfaces)). Paving is the default for new and edited building designs and uses ordinary sidewalk slabs, distinct from square paving. Its area excludes the stored building footprints and stays within the design’s ground boundary; a surface treatment does not independently determine land take, demolition or transfer rights.

Its visible geometry excludes applied corridor footprints in every map view, including its furniture and planting. The authored surface remains unchanged; removing a corridor restores the surrounding treatment.

Surroundings do not make land shared. Every parcel boundary that crosses its open ground is shown as a fence, along the street edge too but never along a building wall, whether the surface is paved or green. A courtyard is shared ground only when the parcel layout makes it a parcel of its own; a block's **Courtyard as a parcel** action opens that layout with the courtyard carved.

### Corridor

Transport land and its authored road or track design. Its alignment and cross-section describe its form; its footprint describes the land occupied.

Where its land lies on no parcel it binds (open ground), the corridor forms that land as ground pieces of its own (`groundIds`, no cadastral parcel); a corridor later in the plan order takes their crossing, and unapplying it gives the ground back.

A corridor design's canonical stored form is `roadProposal.definition.osm`. Expanded drawing fields are a view of that form and do not independently determine the design's CID.

### Bounded road

A road placed into ground already left for it (`definition.bound.site`): its land is that site, not
what its lanes cut, and it declares only the parcels the site covers. Its lanes (the core) are
fitted along the middle of each street to the street's narrowest part; pavements up to 3 m and verges
fill the rest. Edits keep the site: one that moves the road off it or leaves its lanes too little
room is refused. Removing the bound (the editor asks on a node drag) makes it an ordinary road,
whose land is what its lanes cut. See [road in a parcel](road-in-parcel.md).

### Alignment

The ordered line or curve of a corridor, with its horizontal position and any stated levels or elevations. An alignment is distinct from the corridor's width and occupied polygon.

### Cross-section

The transverse arrangement of corridor elements, such as lanes and their widths. It specifies form across the alignment.

### Structure design

The application's area-feature design category, including parks, squares, lakes and stations. This category is broader than the engineering meaning of a load-bearing structure. A park, square or lake's authored area is its occupied land and supplies its site when reshaped; applying it forms modeled ground borders. An unsaved drawn outline is temporary and has no land effect until a design is applied.

A park, square or lake may carry an uploaded glTF model: `structureProposal.modelUrl` (the model reference: a served URL or a [device-only model](#device-only-model)), `modelName` (at most 120 characters), `rotation` (degrees, default 0) and `source: 'upload'`. Its geometry stays the site polygon; an upload sets it to the model's projected footprint placed unrotated at a point on the site. In the 3D view the model replaces the generated ground (lawn, paving or lake basin), fitted to the geometry's bounding box in the rotation frame at its native height, while authored decorations still render; a model that fails to load falls back to the generated ground.

A park or square's city furniture may also use uploaded models, one per furniture kind: `decorationDesign.models` maps a kind (parks: bench, stall, tree, lamp, swing, seesaw, slide; squares: bench, statue, fountain, stall, tree, lamp) to `{ url, name? }`, and every item of that kind draws that model, instanced, with its +X facing the item's bearing; the key is absent when no kind has a model. A furniture model is limited to 5000 triangles, 1024 px textures and 4 MiB (`furniture-models.js`). Lamps are placed points, `decorationDesign.lamps = [{ coordinate, bearing }]`, that glow in the 3D view while the sun layer shows night.

A **pavement tree** is a tree on paving (a square, or paved building surroundings) standing in a pit in the paving rather than straight out of it: `decorationDesign.trees[i].pit` is `grille` (a cast-iron grate over the soil), `grass` or `soil`, a 1.4 m square edged in stone except under a grille, laid square to the square's longest edge. A tree's `heightM` stays within its kind's range (`park-planting.js`); trees on green ground (parks, green surroundings) stand on lawn and have no pit.

### Transit station

A station attached to a compatible corridor. Road stations use a road with driving or bus lanes.
Track stations use rail and are placed at ground level, elevated or underground; these are
placement levels rather than tram or metro service types. The chosen level determines the station
model, footprint and attachment. The current record identifiers are `bus` for road stations and
`tram`, `elevated`, `underground` for the three track-station levels. The attachment names the exact corridor source identity. A station and that corridor may share ground; overlapping unrelated corridors remain placement conflicts.

### Decoration design

An explicitly authored arrangement of city furniture (benches, lamps, stalls, play equipment; CityGML `CityFurniture`), trees or similar surroundings. Authored layouts belong to the design commitment; generated decoration caches are local rendering data.

### Enclosure

A fenced area inside a park: `decorationDesign.enclosures = [{ fence, use, gates, ring? }]` (`park-enclosures.js`). Without `ring` the fence follows the park's own outline and moves with any reshape; with `ring` it encloses that closed ring, which must lie inside the park (a ring left outside by a reshape or a road is dropped from the ground it no longer stands on). `fence` is one of four styles, lightest first: `rail` (a 0.6 m timber rail), `mesh` (1.2 m), `iron` (1.8 m wrought iron) and `plinth` (2.2 m iron on a brick plinth with stone-capped pillars). `use` is `none`, `dog` (a dog area, gravel ground) or `play` (a play area, rubber safety surface); a new dog or play area takes a mesh fence, any other a wrought-iron one. `gates` are points on the fence, at least one, each within 2 m of it; a gate is a 1.2 m opening, and walkers in the model view cross a fence only at its gates. Swings, seesaws and slides are park furniture placed like benches (`swings`, `seesaws`, `slides`: `[{ coordinate, bearing }]`), inside an enclosure or anywhere in the park.

### Map claim

A selectable item of cadastral ground, fabric or design content in the map's interaction model. This interaction term does not denote a legal claim to land.

## Buildings and planning

### Source building

An observed building object identified within a survey or provider dataset. Its geometry, identity and measurements retain that source's provenance. Its key is `<source>:<id>`: surveys of one city number their buildings in their own key spaces, so an id alone does not identify a building.

The GDI 3D source uses the cleaned outlines of its meshes for map footprints and demolition calculations. The separately published ArcGIS 2D polygons can contain oversized rectangles and do not define the ground occupied by those meshes.

A source building is baseline context, not a member of a Plan. Its cadastral parcel supplies the
ground context for inspection. An explicit design impact can link it to an affecting design;
spatial overlap alone does not establish that relationship. Current agreements allocate land and
money and do not create a separate transfer of a source-building record.

### Building facts

What is known about a source building beside its shape: storeys, when it was built, roof shape
and parapet (and height). The shared API's building-facts contract answers them for any city;
this app reads only that contract, never a source's own format. Each fact names its source, the
source's key and raw value; an unknown fact is unknown, never a default. "Built" is a span of
years, so a date known only as "before 1913" still decides a rule about 1918. Footprint area and
row size (how many buildings are joined to it by shared walls of at least 1.5 m) come from the
source's geometry. OpenStreetMap
buildings are answered from OpenStreetMap through Overpass, a few minutes behind edits, and a missing fact is added there by whoever
needs it (`building:parapet=yes|no` for a parapet along the whole street front). Croatian
cadastre buildings are to join the same contract.

**Adding a fact** from the app (the building card, an agreement's covered houses) saves it to
OpenStreetMap as the person's own edit: they sign in with their OSM account ("Sign in with
OpenStreetMap"), choose a value for each unknown parapet, roof shape or storey count, and the tags
go up in one changeset. The app then shows the saved facts at the version the edit made until the
contract reaches that version. Only people add facts; agents read them (OSM treats AI-agent edits
as automated edits needing community approval).

**Heritage** is the protection the country's heritage register gives the building: listed or not,
the grade as the register states it (England: I, II*, II), the entry's reference and page, and the
basis of the match. Each register is a source of the contract that declares the places it covers;
England's is the National Heritage List, read from planning.data.gov.uk (`listed-building-outline`
and `listed-building`). A building is matched by an outline over it, by the entry's point inside
it, or by the entry's house numbers against its `addr:street` and `addr:housenumber` (a terrace is
often one entry with one point, "Numbers 26 to 50"). Where a register covers the place, a building
no entry reaches is not listed. Heritage is unknown outside every register, where an entry on the
building's shared-wall row or just beside it may cover it, where a range may or may not include its
number, and while the register does not answer; the contract then says why.

### Building eligibility

Whether a source building meets a rule set's conditions on what it is, test by test, judged only
from its building facts, so the app and the agents' server judge it alike. A test passes, fails, is
unknown while its fact is, or is unchecked when no source states it (listed, not assumed). Living
Tradition's "not listed Grade I or II*" reads the heritage fact: not listed or Grade II passes,
Grade I or II* fails, and a listing whose grade the register does not state is unknown. The
verdict is ineligible when a test fails, unknown while one is unknown, else eligible. A rule set is
dated like a ballot rule and applies where a city plans under its planning rule set. The first is
Living Tradition's paragraph 17 for mansards under English planning (`gb-eng-planning`).

### Street code

A rule set of `kind: 'street-code'` in the building-eligibility evaluator (`frontend/js/planning/eligibility.js`):
the limits a street plan's buildings must keep, any jurisdiction can author as data. Every rule has an
id, a citation (the source's paragraph), an applicability (`existing`: a raised existing building, `new`,
`setback`: a building with a setback storey, or every building), a test from the evaluator's closed set of
operators, and a failure effect (`excluded`: the building is outside what a street vote may change;
otherwise the plan breaks the code). A test that does not apply is "does not apply"; a rule the app
cannot measure is listed as not checked, with its reason, never assumed.

A plan names the codes it claims to respect by exact revision (`plan/v1` `codes: [{ id, version }]`,
chosen in the plan dialog or with `ugt_draft_plan`/`ugt_edit_plan` `codes`). A claim is checked, never
trusted: where a street vote's ballot rule carries the code (`ballotRules`), the agreement editor checks
every building of the plan (`frontend/js/planning/street-code.js`) and shows each failing or unknown
rule with the facts it read; `ugt_draft_agreement` returns the same check as `streetCode`. The check
advises: it is not kept in the record and does not stop the agreement.

The facts a code is judged on are the plan's (storeys counted only from a stated storey height, the
setback storey, the storey height), the place's (from source adapters: the density of the small areas
near the street, the buildings built before 1918 near it, the designations a building lies in) and a
raised building's [building facts](#building-facts).

The first is `gb-strong-suburbs-street-code@2021`, Strong Suburbs (Hughes and Southwood, Policy Exchange
2021) for the Strong Suburbs street vote:

- **Exclusions (12–15):** listed buildings and buildings built before 1918 may not be changed; no new
  building on Green Belt land (a raised existing building stands on developed land); nothing in a
  National Park, AONB or SSSI (planning.data.gov.uk). Metropolitan Open Land is not checked: the
  publisher has no such dataset yet.
- **Storey cap (30):** the lowest cap of every small area within 200 m of the vote's street or under a
  building of the plan, by its people per hectare: under 20 → 2, up to 60 → 3, up to 120 → 4, more → 5
  (60 and 120 take the lower cap). Without a named street the cap is known only as an upper bound
  (the areas under the buildings), so only a plan over it fails. England's density source is ONS
  mid-year population per MSOA over its land area (`densitySources` in `planning-sources.json`, the
  shared API's `/api/population/small-areas`).
- **Setback storeys (31–32):** one setback storey everywhere, a second where the cap is 4 or 5; the
  app's setback storey is the [mansard](#urban-rule-design), wholly under the 75° plane.
- **Ceilings (36):** a design states storey heights (floor to floor), an upper bound of the ceiling: a
  storey up to 3.5 m keeps the maximum, one under 2.5 m breaks the minimum, others are unknown.
- **Historic streets (37):** ten or more buildings built before 1918 within 100 m of the street limit it
  to 3+1 storeys; undated buildings that could change the count leave it unknown; where half the
  buildings along the street (within 40 m) already exceed it, the existing total applies (not measured).
- **Not checked:** light planes from plots on other streets (35), building back toward them (39), front
  doors (41), side windows (42), the consent of semi-detached and detached neighbours (51–52), added
  floors against the highest existing floor (36.2).
- **Compensation (54–57):** the code's `neighbourGuides.boundary` (30°) adds a reading to Effects on
  neighbours for an owners' agreement on a plan claiming it; see [Agreement](#agreement) affected parcels.

### Proposed building

Authored building geometry, parameters and optional architectural evidence belonging to a design. Its representation proposes a building rather than asserting an existing surveyed object.

### Freeform building

A building design with one connected authored footprint, including any courtyard holes, and its vertical dimensions. Its land take can extend beyond that footprint. One design is one building on one connected piece of ground: stepped parts of different heights are one building and state one `buildingId`, and separate buildings are separate designs. Saving, drafting and publishing refuse a single-building design whose site or land take falls apart or whose parts are several buildings; a design published before that rule still opens. Applied, every single building forms its own parcel from its land take, including a stepped one and one whose land take covers a whole cadastral parcel. A new MCP Freeform design takes only its final building footprint; the constructor's input land supplies its sizing boundary. Typed movement or rotation of a footprint-only design updates its site and land take with the building. Dragging moves only the selected building footprint; surroundings stay anchored on occupied parcels. Leaving a parcel releases its surrounding treatment and furniture.

### Imported model footprint

The connected horizontal projection of a GLB model's visible mesh triangles, including concavities and courtyard holes. It is the model's silhouette, which can include overhangs and canopies; it does not infer a foundation boundary. It is one integer union of the triangles at millimetre precision (`projectedFootprint`, Clipper); a part or hole under 1 m² (or 1 % of the largest part, for a small model) is mesh noise and ignored, any larger separate part refuses the import.

### Device-only model

An imported 3D model (building, park, square or lake model, or a furniture model) kept in the browser's IndexedDB instead of on the server, referenced as `device-model:sha256-<hex>` where a model URL would stand (`frontend/js/device-models.js`). It is the default for the site's imports; Upload model offers a public upload instead. Only the browser that holds it draws it; any other viewer, and the author on another device, sees the plain block. Publishing a design, plan or agreement that holds one asks once to upload such models (public: anyone with the design's link can download them, and the references become their URLs before the CID is taken) or to publish without them (the published design keeps the reference). A plan file embeds it from the browser. MCP imports have no device: they are public uploads that need `confirmAssetUpload`.

### Model file placement

Where a CityGML, CityJSON or IFC building file says the building stands: its centre and rotation from the file's coordinate system, an IFC `IfcMapConversion`, or an IFC site's reference latitude and longitude with its true north. It is used when it lies within 1 km of where the building is being placed (the selected site, the selected footprint, or MCP's `center`); further away the model starts there instead, since IFC exports often carry their design tool's template location (`SingleBuildingGeometry.filePlacementNear`).

### Georeferenced building model

An uploaded building model (`properties.modelUrl`) whose building also states `modelOrigin` (`[lng, lat]`): the model is in true metres, its glTF origin stands on the ground at that point, turned by `rotation` (degrees counter-clockwise from east), and glTF y = 0 is ground level, so storeys below it stand underground. Without `modelOrigin` an uploaded model is stretched onto its footprint's bounding box and its lowest point sits on the ground. The building's footprint stays the design's ground either way.

### Building hue

The one colour a planned building has in the model view; parcel slices vary only its shade. A building of several features (stepped parts, each its own footprint and height) states one `buildingId` on every part, and its parts share the hue and the glass tint; any other building's hue comes from its own outline. An uploaded building model takes the same hue: its own material colours are tinted to it. It also takes the [illustrative facade](#illustrative-facade) on its walls, the style its building states or Mixed's; inside an X-ray [model section](#model-section) its own tinted materials show instead.

### Storey level and storey numbering

A storey level is a storey's position in its building: 0 is the storey at street level, 1 the one above it, negative levels are below ground. Unit addresses, apartment keys, links, the floor cutaway's value and agent (MCP) payloads carry the level. Storey numbering is only how a level is written for the reader, set per locale (`storeyNumbering` in `frontend/js/i18n.js`, applied by `frontend/js/storey-numbering.js`): `ground-zero` (the default) writes level 0 as the ground floor and level 1 as Floor 1; `ground-one` (Russian, Kazakh, Colombian Spanish) writes level 0 as Floor 1. Below-ground levels are basements numbered from 1 either way.

### Model section

How X-ray shows the interior of an uploaded building model: a horizontal cut 1.2 m above the floor of the storey chosen in the floor cutaway, or of the ground storey when none is chosen (a model's storeys cannot all be open at once) (`frontend/js/model-section.js`). The storeys are found in the model's own horizontal surfaces: a floor is a height holding at least 3 % of the fullest height's area and 25 m², a slab's top and bottom are one floor, and the highest surface is the roof. A model's storeys below ground show only when a basement is chosen, with everything else hidden. The cut is display only and changes no design.

### Urban-rule design

An authored rule governing possible building form on land, such as Block, Row or Detached. The design's permitted envelopes express that rule; an example build-out illustrates one realization.

Any of the three may also permit **balconies** (`balconyDepthM`: how far, in metres, they may stand out of the envelope; absent means none) and a roof (`roof`, absent means flat): a **slanted roof** (`"pitched"`: a roof with its attic set on the top floor, ridge parallel to the street side) or a **mansard** (`"mansard"`). Both ride on the rule each building carries.

A **mansard** is a roof holding a storey: on the street and the garden side it starts 0.38 m (15 inches) behind the wall top (the parapet), rises at 70° for 2.25 m, then at 30° for at most 2 m more, and is flat beyond that; walls shared with a neighbour rise as gables to its outline, and the lower slope carries dormer windows. These are the limits of the mansard guide in *Living Tradition* (S. Hughes, Create Streets, 2021). Its storey counts: one more storey, the footprint behind the two setbacks as floor area, and the roof's rise in the building's height for Compare plans and the Permitted check. A slanted roof's attic counts for none of these.

### Raised existing buildings

The Block editor's **Based on existing buildings** mode (`parameters.mode: "existing"`): the design's buildings are the existing buildings on its parcels, each redrawn on its own footprint at a stated number of storeys (`rule: "exact"`) or at its existing height plus added storeys (`rule: "additional"`, which may be none), with a roof of its own (`parameters.roof`, on each building as `properties.roof`) and the design's storey height (`parameters.floorHeightM`, on each building as `properties.floorHeightM`). It carries no urban rule and takes no land, and it replaces nothing: each building it redraws is **extended**. Its floor area before (its existing height over the design's storey height, never more than its walls hold after) is kept: Plan stats, Compare plans, the 3D value panel and `ugt_compare` count it among the existing buildings ("of which existing, extended"), build, sell and tax only the floor area it gains, and acquire neither its floor area nor its land. A building whose existing height is not stated leaves the gain and the money unknown. A stated height below the existing one adds nothing. A mansard on a terrace is this mode with no added storeys and the mansard roof.

### Block rule

An urban-rule design generating perimeter building form and courtyard space from its land and stated dimensions. Its record stores one building per parcel, cut from the block massing and carrying the rule and its own variation seed, beside the complete authored block massing (`geometry.ruleMassing`); parcels the rule leaves out are recorded separately as ineligible. When one building contains exactly that massing, its footprint is the sole stored geometry. Courtyard derivation uses the complete massing when present, otherwise the union of the authored building footprints.

### Row rule

An urban-rule design generating a row arrangement of buildings from its land and stated dimensions. Creation uses at least two distinct selected parcels, or at least two frontage plots cut from an authored site. Its complete footprint must remain within the selected land, including its disconnected boundaries and excluding gaps and holes. An unplaceable footprint cannot be finished as a Row design. Like a Block, its record stores one building per parcel, cut from the row massing and carrying the rule and its own variation seed, beside the complete row massing.

### Detached rule

An urban-rule design generating separate buildings on selected parcels from its stated dimensional constraints. Each buildable parcel gets one permitted envelope; parcels the rule excludes are shown with the reason (plot too small, street frontage too short, no room after the yards or under the caps, or a compelled minimum the plot cannot meet).

Its constraints are the distance from the borders (`minDistance`), maximum floors with an optional height limit (`maxHeightM`, which caps the floors at the floor height), the minimum plot size, and optional limits written only when set: front and rear yards (`frontSetbackM`, `rearSetbackM`, measured from the plot edge facing the nearest street, else its longest edge; unset, the border distance applies), sides and rear kept at least a share of the building's height from the border (`setbackHeightRatio`, 0.5 for h/2), a minimum street frontage (`minFrontageM`), maximum site coverage and minimum natural ground (`maxCoverage`, `minNaturalGround`, shares of the plot), a maximum floor area ratio (`maxFloorAreaRatio`) and a maximum ground floor (`maxFootprintAreaM2`). The envelope is the ground beyond the yards, shrunk evenly to the smallest ground-floor cap, at the floor count holding the most floor area (a yard growing with height or a floor area ratio can make that fewer than the maximum); every view measures it as the permitted floor area. An example build-out stays inside the envelope, at most its floors high.

### Source planning rule

A rule or planning instrument supplied by an identified authority or dataset, with its edition and applicability evidence. An authored urban rule does not become an enacted source rule by sharing its name or geometry.

### Zoning district

A source-defined area with a named zoning regime. A base district and an overlay district remain separate source observations when their geography overlaps. Unmapped, extinct and unidentified district records retain those distinctions.

### Atlas slice

A derived Atlas area representing a combination of base-district and overlay rules under the publisher's composition method. It is distinct from the source districts and from a cadastral parcel or a generated building envelope.

### Literal dimensional observation

A complete numeric value recorded in a source field with a known unit, without an unresolved expression or alternative value kind. Spreadsheet dates remain date values even when stored as numeric serials; cached formula results are not literal observations. The `literal` evidence state distinguishes public district-table values from the Atlas Slices product's `direct` numeric method. Both can supply a supported dimensional calculation; neither resolves applicability, missing constraints or overlay precedence.

A `derived` dimension is calculated by UGT from stated inputs. An `assumed` dimension is a value UGT supplies. In Alatau the zoning legend gives the upper storey count for a numbered housing class. UGT supplies the floor-to-floor height and derives the height in metres.

### Planning representation

An inspection or display projection of a source record, existing building or authored design. It retains the subject's identity and provenance without becoming a new design or an applied change.

### Permitted calculation trace

A provider-produced explanation of the calculation for one Permitted representation. Each row records the quantity, inputs with units, result or applied operation, limit where applicable, source citations and evaluation status. Passed and failed describe a particular checked comparison; applied describes an operation used to construct the geometry; assumed identifies a modelling choice; not-evaluated and pending preserve missing checks and outstanding procedures. A passed dimensional comparison does not establish overall compliance. The inspector and MCP read the same trace from source evidence.

### Conditional B-1 building plot

The candidate building plot used by the Staro Trnje–Savica B-1 permitted source: the intersection of an observed cadastral parcel and the source B-1 boundary, with its own source-scoped identity, geometry and area and a reference to its cadastral parent. It is separate from the unchanged cadastral site and from the boundary-uncertainty core. Its full intersection area is used for the minimum-area warning and conditional configuration, including when the source boundary cuts the cadastral parcel. Warnings and candidate selection cover only this intersection. Required preparcelation and competition remain unresolved; no cadastral or authored parcel is created. A calculated detached massing uses the mapped building line, conservative half-height edge separation and cited coverage, above-ground FAR and storey limits. Model storey height is a stated assumption. The configuration does not establish plot formation or compliance with unevaluated rules.

### Source warning

A read-only Permitted planning representation with source-derived site geometry and no inferred building volume. It makes a cited condition of the observed cadastral parcel discoverable without creating a parcel, envelope, permission or compliance verdict. A `parcel-too-small` source warning compares the explicitly identified assessment subject’s area with a cited minimum individual building-plot area: either the observed cadastral parcel or a source-defined candidate plot, with both identities kept distinct; its source evidence retains any exception, required procedure or land assembly, applicability limits and geometric uncertainty. A warning cannot generalize those conditions to another source or a future formed building plot.

### Obligatory source proposal

A read-only representation of a provider record whose underlying instrument claims obligatory normative effect. Its authority, applicability and evidence quality remain separate attributes; representing it does not establish compliance or owner consent.

### Source reference

An authored reference pinning a provider record, edition or scenario and source revision. It identifies the evidence used by a design without transferring that source's authority to the design.

### Permitted envelope

The maximum building form derived under an identified rule and its supported assumptions. An authored permitted envelope is normative under that proposed rule; a source-derived envelope retains its source's legal and calculation qualifications.

**Surviving permitted massing** is the part of the displayed permitted form outside the design sites occupied by applied proposals while Proposed is visible. This display choice preserves the source plot, zoning and calculated envelope.

### Outer bound

The combined extent of the drawable building configurations and their supported interpretations. It bounds possible forms rather than defining one constructible building. A lot that several zoning areas partition has one outer bound per part, each the whole lot's bound clipped to that part; a zoning area under 2 % of the lot is evidence, not a part. A bound is a stack of prisms: between any two levels, the ground some configuration's volume covers there. A yard that starts above the ground (a side yard from the second floor, a street-wall setback above the facade height) carries `fromHeightM` on its constraint and makes a configuration a stack of tiers. A level only configurations with a `condition` reach carries that condition on its tier; the bound's height and the Planned figures state what the rules grant without a condition, and the conditional extent is reported beside them with its condition.

The comparison controls label this **Max envelope**, as they do an authored rule's maximum envelope. This display label does not make alternative configurations simultaneously buildable or remove the source's qualifications.

### Permitted use

What a zoning area's plan allows its land for, on the representation as `use`: a `key` from the app's use vocabulary (translated as `planningViews.use.<key>`), a `group` the map colours by (`housing`, `housing-low`, `housing-mid`, `housing-high`, `mixed`, `commercial`, `public`, `industry`, `transport`, `green`, `water`, `agriculture`, `reserve`, `restricted`), the plan's own `label`, and the `stage` the plan marks it with (`existing` or `planned`, else null). `housing` describes residential land where the map states no height class. A Permitted envelope carries the use of the zoning area it stands in. The map and model use the same palette for zoning areas and envelopes. An envelope with no use group takes the Permitted role's colour. The assessment status states whether a building may stand there (`allowed`, `prohibited`, or `instrument_handoff` when another instrument sets it).

### Source wording

Text a source record carries in the source's own words (a zone's title, a reason, a condition): the app shows it quoted and in italics, tagged with the source's `language`, and never as its own text. Where the app has words for it, the record also carries a code the app translates (`use.key`, `use.stage`, `assessment.reasonCode`, `metrics.conditional.conditionCode`), and the translation leads while the source wording is quoted beside it.

### Permitted check

The comparison of a design's buildings with the Permitted items under them, rule by rule: height, storeys, site coverage, floor area ratio, minimum lot, ground-floor area (`footprintArea`), ground left free (`naturalGround`), and whether the item's land allows building. Each check passes, fails, is conditional (over the limit the rules grant but within a taller one only a condition allows, `metrics.conditional`, or beyond a limit the source grants only on a condition, `beyond: "condition"`) or is unknown (the rule is not recorded, another instrument sets it, or a relative rule term's input is unknown). A building is checked against every item covering at least 0.5 m² of its footprint. Every planning designation under a building adds a line by its effect: `prohibit` fails, `restrict` is conditional on its requirement, `note` is a `note` (read, limits nothing); each line links the publisher's record. Where no base rule is recorded the check says that only designations were checked. The check is advice: it never refuses a design. It tests a given design; finding the largest allowed one is the Permitted envelope's job.

### Effects on neighbours

What a design does to each neighbouring plot, before and after it: the share of the plot's garden with a number of hours of sun on a given day, the sky a wall facing the design sees (vertical sky component), the share of the year's probable sunlight hours a window facing the noon sun gets (sun positions weighted by the place's sunshine records, `frontend/data/sunshine-records.json`; no records, no reading), the share of each room's working plane that sees sky (the no-sky line, measured on demand per plot in the suggested layouts of its buildings), the angle tests from its windows and the distance to the nearest facing wall, each against the place's guide for it. An angle test can be a first check for a detailed reading (its guide's `then`): crossing it then says that reading decides, and grades nothing. The guides (which readings apply, their thresholds, whether they bind) are a rule set's `neighbourGuides`; a place whose rule sets state none has no effects readings. "Before" is the buildings standing now; "after" removes those on the design's parcels and adds the design's. Neighbours' heights are the height survey's where it covers them. A plot is listed only when a reading changes; it is beyond a guide, or loses something within the guides. Advice, like the Permitted check. The agreement editor's Neighbours tab measures the same readings for the agreement's plan and adds ticked plots as [affected parcels](#affected-parcel) with a snapshot of their readings. See [neighbour-effects.md](neighbour-effects.md).

### Planning designation

An area a publisher designates for protection or control, such as a conservation area, a listed building, a scheduled monument, a flood zone or green belt, read from a constraint source. A designation is evidence; what it does to Permitted is its rule set's effect, not the dataset's. A designation that has ended (`end-date` passed) no longer applies.

### Constraint source

A publisher of planning designations read for a box through one adapter (`frontend/js/planning/constraint-sources.js`), configured in `planning-sources.json` `constraintSources` with its endpoint, coverage, licence, attribution, page size and page cap. A read stopped at its page cap is `partial`, and the layer and the check say so. Designations that cut the envelope are read with their geometry for a box; the others are read per footprint or parcel as membership, without geometry: the publisher tests the intersection (the footprint set in by 0.25 m, so a shared edge does not count) and the check lists them for the buildings found inside. The first is `gb-eng-planning-data`, planning.data.gov.uk's entity API, England only. The browser asks it directly; the server reads it only for its own MCP answers.

### Submission target

The format in which a jurisdiction's planning authorities receive applications, configured in `planning-sources.json` `submissionTargets` and chosen for a city by the jurisdiction of its rule sets; a city without one has none. Its **planning application preview** (`frontend/js/planning/application-preview.js`, the Download design and Download plan dialogs) shows what a design or plan would send in that format: the red line (the union of its designs' sites), the figures it states (floor area, homes estimated from floor area, buildings, tallest storeys, open space; a figure no building states is absent, never 0), the drawings attached and its permanent link once published. Only the red line downloads; sending to an authority needs the authority's own connection. The first target is England's Open Digital Planning application format (PlanX, BOPS).

### Rule set

The planning regime of a place for designations: which datasets of a constraint source matter and the effect each has (`effects`, optionally narrowed by a source field, `where`), plus the regime's policies stated as rule terms (`policies`) and its guides for effects on neighbours (`neighbourGuides`). A city names its rule sets in `planning.ruleSetIds`. `baseRule: null` says the regime has no base Permitted rule here (England is discretionary).

### Restriction effect

What a designation does to Permitted, assigned by the rule set:

- `prohibit`: its area is removed from the Permitted envelope (zone areas, volumes and configurations are cut; a cut configuration's floor area becomes unknown). A designation of an existing building (`subject: "existing-building"`, a listed building) means that building must be kept: it is cut out and a design over it fails. A building designated only by a point takes the footprint of the building standing on it in the view's building source; with none it stays a point (footprint unknown), and only a design covering the point fails.
- `restrict`: the envelope is kept and a requirement is attached (`requirement`, such as `planning-permission` where an Article 4 direction withdraws permitted-development rights, or `design-scrutiny` in a conservation area).
- An entry may make its effect depend on the permitted development rights a direction removes (`removedRights`). England's Article 4 entry reads them as GPDO Schedule 2 codes (`1A`, `3L`, `20ZA`) from the area's `permitted-development-rights` field, else from the direction the area names (`article-4-direction`, matched by reference within the organisation without case or punctuation), else from the area's and the direction's words (`described` patterns, such as houses in multiple occupation for Part 3 Class L, unless the words also mention other works). The rule set maps each code, or its whole part, to the design actions it would have permitted (`actions`: enlarge, add storeys, roof works, outbuildings, demolish, replace, new dwellings; an empty list is a right no design uses, such as a change of use). A direction whose rights cover no design action takes the entry's `otherwise` effect (`note`): its line names the rights. Rights that are unstated, unreadable or not in the table keep the entry's effect: unknown is never taken as harmless. Every design is taken to do building works; the check does not narrow the actions per building.
- `note`: a reason the Permitted check lists; it changes no limit.

### Unknown base

Permitted where a rule set applies but no base rule source is recorded: "unknown base, known designations". Nothing is drawn as permitted massing; each prohibited area is a Permitted item whose land does not allow building (`assessment.meaning: "restriction"`, dashed), and the Permitted check reads every designation and says the base is unknown. England is the first such place.

### Existing context

What stands on a parcel, which relative rule terms read (`frontend/js/planning/rule-terms.js`): the existing buildings on it with their footprints and heights, each height with its basis and whether it is known; the parcel's built footprint and its natural ground (the parcel area no building stands on); the street width in front (the street-width measure: from the edge facing the street across to the next lot); and the heights of its neighbours along the street (the existing buildings of the lots within 60 m that face the same street, by name, else by line). A height is known when measured or stated as storeys; a display height a building source estimates is unknown, never its number. Where a policy states a relative term, each building is measured from the [height survey](#height-survey) covering it, if any, and the survey's height replaces its source's. No building source answer leaves every building term unknown; a parcel with no buildings has a known footprint and height of zero.

### Relative rule term

A limit stated against the existing context rather than as a number, carried on a constraint as `term: { of, add, addUnit, times }` with value `(input + add) × times` (`addUnit: "storeys"` counts `add` at the source's storey height). Inputs (`of`): `existingHeight`, `existingFootprint`, `existingNaturalGround`, `parcelArea`, `streetWidth`, and precedent over the street's neighbours, `neighbourHeight` with `aggregate` `max`, `min`, `median` or `share-above` (`aboveM`). A constraint may apply only `when` a term meets `atLeast`/`atMost`. An unknown input makes the constraint's value unknown (`evidence: "unknown"`, `unknownReason`). Bogotá's street wall reads its height through the same `streetWidth` term.

### Configuration

One source-recorded building option, such as an allowed housing type, with its own constraints, treatment, derived geometry and availability. Configurations are alternatives, not additive permissions. A configuration the project must opt into (an incentive's extra storeys) carries a `condition`; the map shows it only when pinned or when nothing unconditional draws, and draws the bound tiers only it reaches fainter.

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

### Land basis

The land a zoning area's rules are applied to when Permitted massing is derived. By default it is the registered parcels as they stand: the plan regulates building on existing land, and each parcel under the area gets its own envelope. Where the plan lays the land out anew, with streets and blocks of its own drawn over parcels it does not keep (a plan that presupposes land readjustment), the zoning area itself is the lot (`landBasis: "zone"`): it gets one envelope per polygon of its outline, and a parcel wholly under such areas gets none. A parcel lying partly under an area that keeps its parcels keeps the envelope of that part. The provider states the basis per zoning area from the plan's own evidence; it is never inferred from geometry, because a zone line crossing a parcel occurs under both kinds of plan. The zoning area and the envelopes derived on it carry the statement; absent, the basis is the parcel. A parcel study of a parcel wholly under such areas studies the plan's lot that holds most of it and names the parcel asked for (`requestedParcel`). The land basis says which land the source's rules are read on. It forms no parcels and is not a parcel layout: the map's ground stays the cadastre.

### Plan plot

A parcel in the applied design’s land layout. Its identity and shape come from the live parcel fabric. Its permitted massing uses the selected planning source’s rules. A plot drawn on a government-plan site keeps the source-area reference, including where the site has no cadastral parcels.

### Government-plan plot

A zoning area that the source uses as the land for a massing calculation (`landBasis: "zone"`). Its mapped boundary supplies the design site. The permitted envelope and the smaller example building are separate representations on that ground.

### Block assembly standing

In Bogotá’s Renovación calculation, whether a parcel holds a street corner or a whole block. This is measured from street-facing edges and neighbouring parcel boundaries. Cession is the area of public ground contributed by the layout, in square metres. It counts toward the corner index when it exceeds 400 m².

### Functional zone (Alatau)

A zoning area of Alatau's general plan (Decree No. 727, 2025) from the state urban-planning cadastre. The source records land use, a storey class for housing, and implementation stage where known. For Permitted massing the adapter uses the planned zone as its calculation boundary and uses existing parcels elsewhere. The source supplies no future plot identifier. A residential class's upper storey count is a maximum. Other uses hand the building parameters to the detailed plan (ПДП), and open land carries no building. See [Alatau general plan source](alatau-genplan-source.md).

### Functional zone (Astana)

A zoning area in the state urban-planning cadastre's Astana snapshot. It carries the source's land use, housing class where stated, and implementation stage where known. The snapshot date identifies the data edition. A bounded housing class supplies its upper storey count for a height-derived Permitted envelope on the covered parcel. A zone can also supply a design site by reference. Its authority for current parcel rules is unresolved. See [Astana general plan source](astana-genplan-source.md).

### Detailed-plan zone (Almaty)

A functional zone in one of the named Almaty detailed plans in the state urban-planning cadastre. A bounded housing class in the local plan label supplies its upper storey count for a height-derived Permitted envelope. The plan name, captured date and zone ID identify the evidence. Approval metadata is unrecorded in the published snapshot. See [Almaty planning sources](almaty-plan-source.md).

### Treatment area (Bogotá)

A zoning area of Bogotá's POT treatment map (Decreto 555/2021): one polygon with a treatment (consolidación, renovación, desarrollo, mejoramiento integral, conservación), an optional typology (`TA`, detached) and a height code. A storey count on the map is the base height; a range's upper number, development ranges and instrument codes are evidence, not geometry. A blank Consolidación polygon is an equipamiento whose storeys Decreto 253/2026 assigns by polygon; a blank Renovación polygon has a resulting height. Storeys become metres through the decree's clear height plus an assumed slab ([Bogotá POT source](bogota-pot-source.md)).

### Resulting height (Bogotá)

The height of a Renovación lot, which the POT does not state as storeys: the storey count whose floors, each bounded by the rear yard for that height, the side yards above the third storey and the street wall, hold the most floor area within the lot's construction index. It is solved per lot from its front edge and the lot line across its street, so it exists in the envelope view and is evidence elsewhere.

### Street wall (Bogotá)

The rule that a facade may rise to a multiple of the distance across the public space (2.5 × the street width plus the lot's own front yard, up to a 30 m distance) and must step back above that height. The street width is measured from the lot's front edge to the first other lot across it; a lot with no lot across within reach has no street wall.

### Antejardín

Bogotá's front yard: the private strip between the lot line and the building line whose minimum depth the POT front-yard map assigns to Consolidación lots. It is read under the parcel, not from the treatment area, and becomes the parcel's front setback. An equipamiento lot takes at least the Decreto 253/2026 minimum.

### Applicability

Whether and under what conditions a source rule applies to the subject and context being assessed. Normative authority and available numeric dimensions alone do not establish applicability.

### Evidence quality

The stated strength and limitations of the evidence supporting a representation or assessment. A cached calculation, estimate and independent verification have different evidential roles.

### Massing

A footprint with vertical extent, represented as volumes or extrudable geometry. Its role must distinguish observed built form, permitted form, proposed form and an illustrative realization.

### Level of detail

How much of a building's form a model holds, in CityGML's levels (LoD): LoD0 the footprint, LoD1 a block (the footprint raised to one height; our massing and extruded buildings), LoD2 the real roof shapes (Zagreb's GDI meshes, Vienna's roof model, 3D BAG's LoD 2.2), LoD3 the facades with openings. 3D BAG refines LoD1 and LoD2 by decimals (1.2, 1.3, 2.2). A source states its level; interiors (storeys, rooms, units) are separate from it.

### City object

Any physical object of a city model: a building, building part, road, water body, vegetation, city furniture or terrain (CityGML `CityObject`). Imports and exports in CityGML or CityJSON read and write city objects; inside the app they are source buildings, designs and their geometry.

### Building part

A portion of one building with its own height or roof, such as a lower wing or a tower (CityGML `BuildingPart`). Imported parts join their building: the building is the identity, its parts only its form.

### Building surfaces

The semantic faces of a building's shell: roof surfaces, wall surfaces, the ground face it stands on and closure surfaces that close an open volume (CityGML `RoofSurface`, `WallSurface`, `GroundSurface`, `ClosureSurface`). A source building read from a city model carries them per face; a building's ground face is its footprint at its base. It is a different thing from the authored [surroundings](#surroundings) around buildings.

### Roof type

The shape class of a building's roof: flat, gabled (saddle), hipped, mansard, shed and similar, as a city model states it (CityGML `roofType`, a code list each source defines). A permitted slanted roof or mansard (`roof: "pitched"`, `"mansard"`) is a rule allowance, or the roof set on a raised existing building; neither is an observed roof type.

### City model

A source's 3D model of a city's buildings and other city objects, published as CityGML or CityJSON in sheets, tiles or an API (Vienna's roof model, the 3D BAG). A city model source answers buildings with their surfaces at the source's level of detail.

### Built / Permitted / Proposed

Buildings and massing owns the Built appearance setting across the 2D map and 3D model. Built's source list determines which datasets supply observed buildings. Layer visibility and use highlighting are view preferences.

The three planning display roles: observed buildings; source-derived permitted massing; and the browser's applied building designs. Zagreb permitted massing uses saved future-building geometry. Parcel-clipped existing-stock allocations remain stock evidence; they do not become permitted standalone buildings. When the cache summary selects stock, a validated future typology from the same calculation may supply the permitted geometry. These roles classify represented content, independently of its display appearance. Buildings and massing settings apply to every represented object in each role across the view; selecting or inspecting a parcel, building or design does not create a separate display configuration. Permitted and Proposed have independent display-only example rolls; rolling either role changes no authored design or source record and leaves the other role's example unchanged.

### Illustrative facade

A display-only architectural skin on a proposed building. The view-wide facade setting defaults to Mixed. A building whose design states its facade (`properties.facade`: `brick`, `stone`, `plaster`, `glass-small`, `glass-medium` or `glass-large`) shows that style at any height. Mixed assigns every other building a deterministic style independently; glass styles are eligible only from ten modelled storeys. Named masonry and small-, medium- or large-panel glass presets override the style for all proposed buildings. Building identity controls the mixed style and glass tint; parcel ownership can vary its shade. Panel sizes are measured in metres and storeys. Glass panels follow each wall and storey; soft sky sheen and specular highlights depend on the viewing angle. These skins are illustrative appearance, not surveyed materials or authored construction specifications.

### Reconstructed building envelope

An interpreted exterior form assembled from architectural or geographic evidence. Its provenance and uncertainty differ from a surveyed building and a permitted envelope.

### Bounding envelope

An enclosing spatial extent used for indexing, filtering or framing. It is not the object's architectural shape or a planning permission.

### Building stock

The source-qualified building footprints considered by an operation, with any known heights or storeys. A complete query covers its stated source and bounds; a failed, clipped or truncated query leaves the operation's consequences unresolved.

## Parties, rights and decisions

### Allocation party

Each input parcel of an agreement is exactly one allocation party, `parcel-owner:<parcelId>`, displayed as “Owner(s) of parcel X”. Allocations name no persons: input parcels carry no holders, and allocations and money lines name a parcel party, the proposer or the public. The parcel party is the owner group of that parcel whoever its members are; it is not verified ownership. An [affected parcel](#affected-parcel) is a party under the same key: it receives a money line but never an allocation, since it gives no land.

### Affected parcel

A parcel outside an owners' agreement's input land whose owners give a right the plan affects and no land: a neighbour. Its party is `parcel-owner:<parcelId>`, the same party concept as an input parcel's, and a parcel is never both. The agreement's `affected` list records, per affected parcel, the right(s) it gives (daylight, sunlight, outlook, garden, privacy, or other with a note), whether it is a [waiver](#waiver) or [compensation](#compensation), the [Effects on neighbours](#effects-on-neighbours) readings it rests on as a snapshot (kind, before, after, guide, grade), an optional stated loss and its [consideration](#consideration). The list is part of the published object and its CID; an agreement without one carries no `affected` field. Affected parcels count in no land balance, scheme cap or owners' test.

### Waiver

An affected parcel's owners giving up a right, possibly for a consideration. Each waiver parcel's owners are parties to the decision (`waiverParcelIds` in the approval context) whom no owners' test counts: the agreement passes only when all of them approve, whatever the tally of the input owners. A lens member checks a waiver parcel's rights like an input parcel's.

### Compensation

What an owners' agreement pays an affected parcel's owners without their consent, for a loss it causes them. It is a multiple of a stated loss in market value: the rule's `neighbourCompensation.multipleBasisPoints` (10000 is 1×, the default when none is set; a preset such as Strong Suburbs' 150%, marked unverified until its citation is checked, fixes it). The loss is stated by the sponsor or a valuer (with an optional reference), never derived from the readings. Under a multiple other than 1× compensation needs a stated loss; under 1× without one its amount is stated directly. Not the land settlement's area or value compensation.

### Persons

The per-person positions behind parcel parties, derived from the rights snapshot held in the agreement’s rule rather than stored as allocation terms. A person holding share s of parcel i co-owns every output allocated to that parcel's party at fraction s and receives s of its cash; each parcel's cash is split in minor currency units by largest remainder, so per-person totals equal per-party totals exactly. Parcels whose rights do not name complete holders stay one unresolved party. Owner approvals and lens decisions read the committed rights snapshot in the rule.

### Rights holder

A person or organization holding a stated right, such as ownership or a lease, in identified land, identified by `ownerId`. The same holder can own shares in several parcels; headcounts count that identity once. An allocation party is not a resolved rights holder. Required authorities also have identifiers in decision records but do not count as input owners.

### Decision actor

The signing identity acting for a rights holder or required authority, represented by `actorId`. One actor can represent several holders; counting actors is not counting owners. Holder identifiers, profile names and signing wallets have distinct roles.

### Author

The attribution supplied for a design or agreement. Authorship alone establishes neither a signing identity nor a right in the affected land.

### Rights snapshot

A declared source-qualified account of parcel rights, holders, shares, completeness and any supplied areas. A complete holder list sums to one for its stated right; separate rights are not combined into one ownership total. Unresolved parcel-owner placeholders do not establish identities for voting. Updating the committed snapshot changes the agreement CID and approval context, requiring new decisions.

### Ownership share

An exact fraction of a stated ownership right in a parcel. A lease share refers to that lease, while an allocation share refers to a proposed output; the fractions have different denominators.

### Signing authority

The evidence that a decision actor may act for a particular party in the approval context. It is checked separately from the party's rights in the land.

### Electorate

The parties eligible to decide under an agreement's rule, such as the relevant owners or a stated community. Eligibility and the required support threshold are separate parts of the rule.

### Approval rule

The policy determining counted support and any required authority decisions from the electorate and rights snapshot. It can use headcount or area and distinguish holder classes; it does not summarize every requirement of a real legal procedure. A rule with no owner test, only required authority decisions, is one where the authority decides alone: it counts nobody's land, so it needs no rights snapshot and no parcels. A required authority keeps an id of its own, apart from any holder id, even when the same body also holds land.

### Approval context

The committed rights, policy and verification context against which agreement decisions are evaluated. A receipt counts only for the agreement and context it actually signs.

### Decision receipt

A signed party decision identifying the actor, agreement CID, approval context, rights or authority evidence and signing time. Receipt admission, current validity and sufficient aggregate support are separate judgments.

### Withdrawal

A later decision withdrawing previously expressed support. Decision history remains distinct from current counted support and any execution already recorded.

### Accepted parcel

A parcel-level aggregate of the agreement decisions that currently count. `acceptedParcelIds` summarizes support; it is not itself a signed decision receipt.

### Approval headcount

The number of distinct supporting eligible rights holders relative to the number of distinct holders in the specified electorate, independently of their ownership fractions. A scheme’s `minParties` is an additional absolute minimum of distinct approving input owners, never a parcel or wallet count. Unknown ownership leaves this test unresolved.

### Approval area

The area-weighted support defined by an approval rule and rights shares. A parcel or lease credits its counted share of area only when all counted co-holders approve. Overlapping rights can contribute separate policy weights, so the result need not equal a union of physical land area. This model convention is distinct from verification of a jurisdiction’s co-owner decision law.

### Lens

The selected verification trust set for an agreement or assertion. A lens identifies whose attestations the relevant rule accepts, independently of the owners' own decisions. An agreement's lens (`rule.lens`) is a list of zero to eight distinct Solana keys, frozen at mint. Any key may be a member, the sponsor's own included: the people who enter an agreement judge its lens. Only an agreement with a contribution target may name no lens.

### Lens threshold

How many distinct members of an agreement's lens must confirm its decision: `rule.lensThreshold`, from 1 to the number of members, 1 ("any one of the listed keys") when absent, and 0 for an agreement without a lens. Each member's confirmation counts once; the account records which members have confirmed.

### Lens preference

A person's editable, chain-specific default trust set, persisted in the browser and shared by agent details and agreement authoring. Editing either shared lens dialog updates this default for future use. A new agreement copies its keys; an existing agreement keeps its own lens snapshot. Merely opening an existing agreement's lens does not replace the default. Changing the default never rewrites saved agreements.

### Lens member

An attester belonging to a lens, identified by its chain-qualified authority key and associated service or coverage information. Directory membership is not an owner's vote. A lens member is either a service holding its key (the reference lens member, asked by an operator) or a person's wallet, such as a city authority's key. A lens member in a wallet confirms from the agreement panel (**Confirm as lens member**): it issues its own `AgreementDecision-v1` under its own SAS credential and records it in the same transaction, which also executes the agreement when that confirmation completes the lens. On a counted agreement (owners) it may confirm only once the signed decisions pass the rule, as the service does; when its key is also the id of a required authority, its confirmation is that authority's decision, so an authority that is its own lens member decides and executes in one transaction. On a crowdfunding round its confirmation is its own approval, for example a city's consent to the plan.

### Attestation

An attributed statement under a defined schema, with its issuer and evidence references. Its meaning depends on that schema and issuer; a signature alone does not extend the assertion's scope.

### Lens member statement

What a lens member signs: a fact about a parcel, an owner or an agreement (such as an agreement decision). Recorded on chain it is an attestation; until Solana records it for the agreement, a lens member's service may still list it, and it is shown as reported, not checked. The interface calls the signer a **lens member**, never a bare "member", and keeps three words apart: an owner's **approval** (the owner's own wallet signature), a lens member's **statement**, and its on-chain **attestation**.

### Lens walkthrough

The public view of one agreement (`/lens.html?agreement=<cid>`, `ugt_agreement_evidence` for agents): who takes part (owners or contributors, lens members, the agreement on Solana) and a checklist of what the agreement needs, each check met, waiting, not met or not checked, with who stated each fact. Owner approvals are verified by signature; a recorded statement is checked against the agreement's account; an agreement minted under a retired agreement program is read as not on Solana. It proves who signed what and when, not that a statement is true.

### Agreement decision

A lens member's attested statement that an agreement's approval rule is satisfied. `AgreementDecision-v1` commits to the counted evidence; it is separate from the owner receipts and the chain transaction recording it. The agreement's recorded decision becomes satisfied once the lens threshold of members have confirmed and any contribution target is met.

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

The agreement program account identified by network, program, sponsor and agreement CID. On Solana its address is derived from the sponsor and the hash of the CID; the account is separate from the published agreement content. It also holds the hash of the plan CID its sponsor named at minting, by which every account naming a plan can be listed from the chain alone; that hash is the sponsor's claim, which a reader confirms against the agreement content's `planCid`. An account under a retired agreement program reads as unminted.

### Minting

The creation of a binding agreement's chain account. Publishing a design, creating a local fabric piece and computing a CID are separate operations. The account commits to an agreement CID and, through the CIDs inside each record, to its plan and the plan's designs; it also stores the hash of the content's `planCid`. Before the wallet signs, all of them are pinned on IPFS, by our server or with the sponsor's own Pinata key, and the pinning provider must confirm each CID ([ipfs-storage.md](ipfs-storage.md)); each CID is pinned once and never unpinned.

### Settlement

The agreement process combining qualifying decisions, the lens threshold of members' decisions, any confirmed contribution target, recorded chain state and sufficient escrow to execute, or closure by cancellation or expiry. Each step has its own evidence.

### Execution

The agreement program's recorded transition applying its settlement conditions and payout. Chain execution is separate from local design application, legal registration and physical construction.

### Land event

A source-attributed observation concerning land or an agreement, with a subject, event time and evidence reference. An agreement-executed event links an input parcel to the observed execution. A state-land-status event records that a free state plot or land application was seen in a status (or no longer listed), dated by the record's own update time, with the stored snapshot it was seen in as evidence; it is an observation of the published cadastre, not on chain.

### Parcel history

The sequence of recorded events associated with a source-qualified parcel, such as agreement publication, ownership evidence and agreement execution. Events retain their respective sources and meanings. An execution attested by a retired agreement program stays in the history, labelled retired; its agreement still reads as unminted (see Agreement program).

### Agreement program

The Solana program that keeps chain agreement accounts. Exactly one is current: agreements are minted on it, and the index and the lifecycle oracle read it. A retired one is an earlier deployment at another address (each layout change of the account moves the program: the single-lens program, then the lens-set program without the plan CID hash); it stays deployed, an index row naming it reads as unminted, and the land events it attested remain parcel history. `frontend/js/solana/program-ids.js` lists them, with the pledge and market programs that read agreement accounts.

### Escrow

The funds held by an agreement's chain account for its settlement. Its observed balance and required amount are monetary quantities, separate from authored cash allocations or a local readiness flag.

### Payout

The transfer specified by a chain agreement's settlement terms. A configured recipient or intended cash line is not a receipt proving that a payout occurred.

### Deadline

The time limiting the agreement's decision or settlement process. Every new chain account has one in the future: an agreement without a stated deadline is minted with one 90 days ahead. The agreement can execute through its deadline second and can be expired by anyone after it. Accounts created before the deadline became mandatory may hold none (0) and never expire. It is distinct from a plan member's construction window.

## Money, value and markets

### City currency

The explicitly identified currency in which a city's monetary assumptions and authored fiat amounts are expressed. Display locale changes formatting, not currency or exchange value.

### Money line

A stated cash amount assigned to a party under an agreement, with its currency and direction. Amounts in different currencies cannot be added without an explicit conversion.

### Consideration

The payment or other value proposed in exchange for an agreement's land or rights effects. An offered amount is distinct from a funded escrow balance and an actual payment. An affected parcel's consideration (`considerationCents`, whole cents in the agreement's currency) is a money line to its party that the sponsor pays, whatever the land settlement: a waiver's is stated freely (it may be 0); a compensation's is the rule's multiple of its stated loss.

### Contribution

The land, value or funds supplied by a party to a stated arrangement. Land contribution area, modeled value and transferred chain tokens are distinct quantities.

### Entitlement

What a party is due from the readjustment before cash balances it. By area: the land it put in less the stated contribution ratio of its whole parcels, which never exceeds the land it put in. By value: the share of the value of the land distributed to parties and the proposer that matches the value the party put in. It is distinct from the land or cash actually allocated to that party.

### Land valuation

An agreement's `valuation`: one whole-cent value per m² for every input parcel (before the designs) and every output piece (after them), in the agreement's currency. Present only when the agreement settles by value; a missing or unknown value blocks saving and publication. A value is the author's stated assumption, not an appraisal the record verifies.

### Scheme distribution rules

The land rules a pinned scheme (`rule.approvalConfig.regime`) adds to its decision tests: a cap on the land an owner or the pool gives up, the area or value basis of distribution, the share of each owner's value gain settled in money, the fewest parties, and, under an authority-led scheme, no proposer acquisition. Shares are measured against each owner's whole parcels (Agreement input). The record, the HTTP index and MCP check them with one shared function; the editor marks schemes the plan does not meet before they are chosen. They judge an agreement only, never a design.

### Scheme dimensions

The eleven properties every scheme is described and compared by, in two groups. How it is decided: who starts it (owners or the authority), who has the final say (owners alone, owners then the authority, or the authority alone), the owner support needed (the tests), who is counted (owners or owners and leaseholders, all or private only), what happens to owners who say no (veto, bound by the majority, bound by the authority), and what passing unlocks (the stage). How the land is shared: the basis (area, value or either), public land without compensation (no cap, per owner or per pool), how differences are levelled (in money), the value gain (kept in land or a share settled in money; not applicable by area) and the fewest parties. `dimensionsOf` derives them from a scheme's data: the starter from its family, the outcome for dissenters from its tests and family. The scheme guide, its comparison table and the MCP `schemes` topic word them the same way.

### Readjustment cash

Incoming or outgoing balancing money in the agreement’s explicit fiat currency, represented canonically in integer cents. With area compensation, each party receives or pays the difference between its remaining land entitlement and allocated land multiplied by the stated currency-per-m² rate; positive cash is received and negative cash is paid. A scheme may permit a capped proportional land contribution before compensation. With value compensation, each party receives its value entitlement minus the value of the land it got, and pays the scheme's share of its value gain (the entitlement minus the value it put in). The sponsor pays or receives the balancing cash. A no-cash rule produces no money lines. Cash is calculated from the rules, land values and allocations, not entered per person.

### Token balance

An amount in the atomic units of an identified chain asset. SOL lamports, devnet USDC atomic units and authored fiat cents have different units and cannot be inferred from one another. Betting points are a separate internal unit.

### Betting points

An internal, non-transferable unit in the points betting book. Each points account receives 1,000 points; a point is not cash, a token, or a claim on an on-chain asset. Ordinary points positions and trades share the ordinary points book. Each named simulation run has its own accounts, book and standings.

### City token

A city's meme token (its slug, e.g. `zagreb`, shown as `ZAGREB`), beside one platform token, `UGT`. Today it is an off-chain ledger balance with 6 decimals: the sum of a recipient's awards in `consensus.city_token_award`, not a chain asset. A correct bet earns an award from the market's edge: the winning shares held at resolution minus their average cost. A points market splits a fixed pool by edge; a devnet-USDC market pays a rate per unit of edge. Each award adds UGT worth a tenth of it. The recipient of a points award is a points account, and of a USDC award a wallet; a wallet's balance includes its linked points accounts. A boost spends city token or UGT on an active agreement: it is held until the agreement ends, then paid 30% to the sponsor and 70% to the parcel owners (by the committed rights snapshot) if it executes, and refunded otherwise. A devnet-USDC boost is an on-chain donation to the agreement instead. See [citymemetoken.md](citymemetoken.md).

### Funding readiness

A local declaration that funding is considered ready. A boolean readiness flag neither measures money nor establishes sufficient escrow or a payment receipt.

### Price estimate

A modeled amount with its currency, source and basis. A source price without a usable amount or explicit currency is unknown; an area-based estimate identifies its rate and area basis.

### Economic rate observation

A source-attributed amount per stated unit, with an explicit currency, basis and, for evidence, valuation date. Land and road-land rates use land area; building sale and construction rates use floor area. A development charge is what a place levies per m² of new floor area (a building safety levy, an infrastructure levy, a communal contribution, an impact fee), statutory where a law or council sets it, with the class of land its rate is for where that decides it. Market evidence, policy appraisal and editable scenario assumptions retain separate meanings. An assessed property total is not a unit rate or a market price. Source selection changes model inputs without rewriting authored cash amounts.

A source published per area (an English local authority's land value or rent in an area rate table, a London value band) gives the observation of the area containing the location the rates are for: one point, the centre of the extent of the land being priced (the plan's land, the parcel, the design's site, the designs' sites). Without a location, or where the location lies in no covered area, it gives the city's own area's, and its scope says which and why.

### Modeled gain

An estimated change in value derived from stated existing and proposed floor areas and valuation assumptions. An unknown existing floor area leaves net gain unknown. It is not a balance, cash offer or realized sale proceeds.

### Portfolio estimate

A modeled value of an agent's assigned land, expressed in a stated currency and conversion basis. Adding it to a wallet balance requires both quantities and their conversion to be known.

### Market

A funded YES/NO forecast attached to an agreement. Any wallet can create a devnet USDC market with its own question, closing time and liquidity. An execution market pays YES for an on-chain execution by its chosen deadline. A public-record market commits to its evidence source, verifier and qualifying outcomes. Each market owns its vault, prices and share positions. The market address that opened the vault continues to authorize its payouts. The Bets tab labels creators whose wallets match the agreement proposer or verifier and ranks open markets by funded liquidity. The points simulator keeps one independent execution book per agreement.

### Contest

A group of published agreements connected transitively by overlapping ground. Two agreements are joined when they share a source-qualified input parcel or a government plan plot and their designs take overlapping ground: they share a design, or a design's site reaches into a design's site of the other (their overlap is ground, wider than the larger of the two designs' tolerances). Sharing a parcel alone does not establish membership: agreements whose designs stand apart on one large parcel are separate contests. Overlapping designs on different parcels, or equal unqualified parcel labels, do not join agreements either. An agreement's plan plots are the government plan records its designs were drawn on (the designs' source references, a planning source and record); they are its land where no cadastral parcel lies, such as state land in a general plan, and a crowdfunding round's only land. Each agreement in a contest can have several independently funded markets.

### Market deadline

The closing time chosen at market creation. Trading ends at that instant. An event recorded at the deadline can still qualify. Settlement by absence becomes possible strictly after the deadline plus grace. The points book uses the agreement’s execution deadline.

### Proposed outcome

A recipe-bound (kind 1) LMSR market's resolution before it is final: the outcome its resolver derived from the attestations it passed, or NO by absence. For 48 hours from the proposal, or from the last challenge that changed it, anyone may submit a qualifying attestation the resolver left out: it replaces a NO by absence, or turns a proposal backed by the other outcome's evidence into VOID. After that window anyone finalizes it, and only then can positions claim. On chain it is an unresolved market with a nonzero `resolved_at`.

### LMSR liquidity

The positive parameter `b` in the logarithmic market scoring rule. A larger `b` means a trade of the same size moves the price less. A funded market’s creator deposits `max_loss(b)` into its vault at opening. The ranking uses `b` in atomic units of the same asset.

### Share

A quantity in an LMSR market position on YES or NO, with six decimal places. One whole winning share pays one unit of the selected asset; one atomic share pays one atomic asset unit. VOID (conflicting evidence on a recipe-bound market) pays half that amount, rounded down per position.

### Betting journey event

A browser's report of viewing or acting in the betting flow, with an anonymous visitor identity, session and source occurrence time. It is separate from a verified chain transaction. Simulated visits carry an explicit test-run identity and are excluded from ordinary visitor aggregates; a visitor count does not establish a count of real people.

### Payout multiple

The user-facing quote for how many fixed-payout shares a budget would buy at the current LMSR price. It is a quote for that budget and current inventory, not a pool share, a guaranteed return, or evidence that settlement occurred. Later trades move prices.

## Architecture and measurements

### Setback

A stated distance between a building or permitted form and the relevant land boundary or reference. Its reference side and rule determine how it applies.

### Height

A vertical size in metres with an identified basis, such as measured roof height, authored building height or storeys multiplied by an assumed storey height.

An estimated context height shapes an existing building in Model view. It carries `height_source: estimated` and may name a prediction dataset in `height_estimate_source`: `global-building-atlas` when the GlobalBuildingAtlas's satellite-predicted height of the same building was used (a city asks for it with `buildings.heightEstimates`), else the height comes from the building's type and size. A stated height or storey count always wins over a prediction. Its building footprint and recorded storeys retain their original source. The estimate supplies no measured building or floor-area evidence.

A height calculated from recorded storeys carries `height_source: levels`. For Kazakhstan's NSDI buildings, the recorded value is the `levels` field on the official footprint and the shared extrusion assumes three metres per storey.

### Height survey

A public pair of elevation maps on one metric grid, a surface (roofs, trees) and a terrain (bare ground), that an existing building's height is measured from on demand (`frontend/data/height-surveys.json`, `frontend/js/buildings/height-survey.js`). The measurement reads one window of both maps around the buildings asked about and takes, over the cells inside each footprint and at least 1 m from its edge, the 90th percentile of surface minus terrain as the height and the 25th as the eave (cadastre-data's raster tier). Fewer than 9 cells, a height under 1.5 m or over 80 m, or low confidence give no height and a reason, never a number. A measured height is a known height with `height_source: measured` and `height_survey` naming the survey, the eave, the confidence and the dates the patch holding the building was flown. Results are kept in memory for the session; nothing is stored. A survey declares where it may answer (`coverage.bbox`); inside it the service's no-data cells say where it has none. A request that does not answer within 6 s is asked again, up to 6 times, before the survey counts as unavailable. A survey's height is the best measure available: it replaces a building source's tagged height, its storeys × 3 m and any estimate, while a stated storey count stays; where the survey gives no height, the source's height stands. The Built layer's **Heights** choice (`existingHeights`: `survey`, the default, or `source`) decides which heights the building card and the 3D model view show; it changes no rule result: the Permitted check, like an agent's parcel context, always uses the survey's heights and names the survey under its result. The 3D model view measures its extruded blocks (records with `height_source`; a city model's own roofs stay as they are) from the view's centre outwards, a core square first and four strips around it, and shows each block's chosen height as its vertical scale, growing to it as the answers arrive. A survey service may limit how often it is asked (the Environment Agency answers 429 after about seven requests in a few seconds), so a view is read in about five windows, two at a time, and a failed request is asked again after a doubling pause. The first survey is the Environment Agency's 1 m LiDAR composite for England.

### Elevation

A vertical position relative to a stated datum or reference. An elevation is not interchangeable with building height.

### Storey

A vertical subdivision of a building, and the one name for it: counts, rules, the floor model and the UI say storey (CityGML `Storey`, IFC `IfcBuildingStorey`). A storey count, storey number (`level`, 0 at the ground floor, negative below ground), local label and elevation are separate quantities and require an explicit numbering or height convention to relate them. "Floor" names only floor area, floor plans and a single storey's label (Ground floor, Floor 3, Basement 1). The building property `floors` and the rule fields `maxFloors`, `minFloors` and `floorHeightM` are storey counts and a storey height.

### Land area

The horizontal area of a stated parcel, site, footprint or land piece, in m². The subject and measurement convention determine the quantity; land area is distinct from summed floor area and inclined surface area.

### Floor area

An area summed over the stated storeys and measurement convention, in m². GFA and GBP name floor-area measures; a model's estimate need not equal a jurisdiction's statutory measure.

### Site coverage

Building footprint area divided by the relevant plot or site area. It is a fraction or percentage, distinct from parcel-source completeness.

### Floor-area ratio

Floor area divided by the relevant land area, a dimensionless intensity measure. A stated absolute floor-area limit in m² is a different quantity.

### Committed agreement area

The deterministic area value used in agreement input and output commitments, expressed in m² at 1 mm² resolution. It is a commitment measurement convention rather than a surveyed-accuracy claim.

### Floor plan

A drawing or architectural layout describing a whole storey or an accommodation unit. The source drawing, its interpreted reconstruction and an estimated layout are distinct artifacts. The app generates estimated layouts from building dimensions and typical floor plans.

In X-ray, **Proposed** shows interiors of buildings in designs and **Built** shows interiors of existing buildings. Each view uses available floor models and estimates layouts for eligible buildings that lack them.

### Published floor plan

An architectural artifact with a stable publication ID, retained source evidence, unit or whole-storey scope, architectural content and review status. Its geographic building association and interpretation revision are separate from that publication identity.

### Floor model

A versioned architectural model associated with `(city, source, ownerId, buildingId)`, in the `building-floor-plans.v3` format: reusable layouts and the building's `storeys`, each with its level, elevation, layout and `units`. For a proposal building, `ownerId` identifies the containing design rather than a landowner; version identity and the current-version designation are separate.

### Unit

An identified accommodation or layout within a building or storey (CityGML `BuildingUnit`). A floor model's unit has a kind: apartment, shop, office or garage; only apartments count as housing. A modeled unit or its count does not by itself establish a separately registered property title. A reusable architectural layout may carry normalized `apartmentRegions` for hover highlighting; a region identifies a position in that layout, while the storey's unit records retain their own identities. Regions come from the generated apartment partitions or a retained source drawing and do not create additional units.

An apartment in an unpublished design can be selected within its workspace. Sharing it or making an offer requires an address. An apartment link names its building (city, building source and source ID, or published design CID and building feature ID), storey level and the unit's own ID. An apartment in an estimated layout also carries a fingerprint of its modeled boundary and elevation. Apartment numbers in the picker are display labels. They are separate from unit IDs and street addresses.

### Room

A subdivision of an architectural layout. Its modeled walls, openings and use belong to the storey's interpretation or design.

### Floor registration

A horizontal transform placing drawing coordinates into a geographic local frame at a retained scale. Registration identifies its model and geographic evidence; building identity alone does not determine drawing rotation or placement.

### Geographic building identity

An evidence-qualified association between a source or project record and a real-world building location. An archive group, address candidate and confirmed survey object are different levels of association.

## Sources, evidence and agent workflows

### City

The application's geographic context for filing records, selecting sources and expressing local assumptions such as currency. The published city is resolved from the design's place; it is not a parcel-source identity or legal authority. Descriptive city text on a design or agreement does not gate import, reconstruction or rendering. A required cadastral source context is resolved from the design's ground geometry and source coverage, independently of that text.

### Jurisdiction

The geographic or institutional scope within which a source, rule or authority applies. Jurisdiction is source metadata, independently of a provider's ID and a displayed city name.

### City extent

The administrative area a configured city stands for, named in its configuration as areas of a boundary dataset (`extent`; London is the 33 London boroughs, an English or Welsh town its local authority district). A point inside it belongs to that city; a city without an extent claims a circle round its centre instead. Where extents overlap, the smaller one applies, then the nearer centre. An extent decides which city a place is filed and opened under, not which parcels exist. A city is identified in the parcel pipeline by its UN WUP 2025 city code; a district WUP does not list (one inside a larger WUP urban centre, such as Wirral in Liverpool's) is identified by its own area code instead (GSS `E08000015`, registry `ons-lad-2023:E08000015`), and that area is its extent.

### Declared source coverage

The countries or regions (ISO 3166-1 or 3166-2) a parcel source states it covers: a catalogue source's `coverage: { type: 'regions' }` (HM Land Registry: England and Wales), or a native source's entry in the coverage build (Croatia's cadastre). Every point inside it is covered; outside every city extent and circle it belongs to the nearest city reading that source.

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

Canonical design, named-plan or agreement content returned with its recomputed CID without an index write. Its content address remains meaningful even when its private preview is unavailable.

### Portable plan file

A versioned `ugt-plan-file/v1` JSON envelope containing a `plan/v1`, its exact canonical design members,
embedded authored model assets and known source references. The plan owns membership and the saved
view. Import creates local, unapplied drafts and retains that membership; it conveys no publication,
agreement decisions, signatures or ownership. Referenced source datasets are independent dependencies.

### Portable agreement file

A versioned `ugt-agreement-file/v1` JSON envelope (`agreement-file.js`): an `agreement/v1` record,
the portable plan file of its plan, and `designCids`, which maps each design CID the agreement names
to that design's CID in the plan file (embedding a model changes it). Import adds the plan's designs
as local, unapplied drafts and saves the agreement as a local draft under a new id over them, with
no publication, chain account, votes or signatures.

### Private preview

A temporary means of inspecting a draft artifact. An opaque bearer reference grants access to a stored draft object, independently of permanent publication and wallet approval. Collection previews reference their member designs individually; URLs contain no serialized records or geometry.

### Chat conversation

A private, token-authorized conversation with the application's hosted design agent. It retains a
working plan and optional working agreement, message history, undo revisions, turn count and spending
total for 24 hours. It belongs to one city; moving to another city starts a fresh conversation while
keeping existing designs saved. A restored or recovered conversation cannot apply its plan in
another city. Its content is not published. Deleting or expiring it removes the messages and
replay payloads while retaining the separate daily spending ledger.

### Chat turn

One person message and its bounded sequence of model and MCP calls. A client-generated turn key
identifies retries of the same turn; replaying it makes no further model call. Confirmed plan
changes survive a disconnected stream. Usage records distinguish settled cost from a reserved
estimate whose final provider usage is unknown.

### Chat map selection

The chat cursor identifies one exact parcel in the active parcel source. The selection is a separate
set of parcel IDs used as the next design's site. During manual multi-selection, moving the cursor
does not add parcels; Add changes membership and Done ends selection while retaining it. A source
ID and parcel ID must resolve in the current live fabric before the browser applies a selection.
Map navigation and selection are transient view state, separate from immutable plan revisions. A random starting parcel is a suggested site drawn from actual nearby source parcels, not a resolved interpretation of an ambiguous location. Choosing it changes only the selection; the person decides whether to draft there. Distance-based selection moves the cursor to a parcel near the requested destination. A landmark-relative selection uses the mapped edge, end, corner or boundary and distance to actual parcel boundaries. Its highlighted parcel is a suggested interpretation for the person to confirm. A displayed parcel number is a source-dependent map label, distinct from the full parcel identity; resolving it requires the active source and current lookup area, and duplicate labels remain ambiguous.

### Working plan (chat)

The conversation's current private `plan/v1` revision, addressed by an opaque draft reference.
There is no plan until a first design is drafted or the browser supplies its applied composition.
The relay injects the plan reference and revision checks into public MCP edits. Successful changes
are applied immediately on the map; undo restores the previous revision, including the empty map
before the first draft. Browser edits rebase the conversation onto the exact current composition.

### Working agreement (chat)

The conversation's current private `agreement/v1` draft, addressed by its opaque draft reference and
agreement CID. It names the working-plan revision by `planCid`; a later plan revision does not change
the agreement, but makes that relationship stale. Agreement edits change terms against the exact
agreement CID, and its own undo history is separate from plan undo. The draft remains private until
the person reviews and takes a separate action in the app.

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

In a bet, the visual comparison shows the city's mapped buildings before the agreement and the published designs on the same land after their modeled changes. Both views share a camera and scale. When the building source is unavailable, only the proposed design is shown.

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

### Simulated agreement

An owners' decision over an agent design inside the local simulation: the owning agents of its
parcels, and the city for unowned ones, approve or refuse over the turns, and the design is executed
on the simulated date of the turn the last approval came. It belongs to the saved game state, is
never minted, published or attested, and executing it applies nothing. The Agent city draws executed
designs, simulated or published, as they stood on a day ([Agent city](agent-city.md)).


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
