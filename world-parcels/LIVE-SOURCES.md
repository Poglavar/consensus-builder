<!-- Explains the live parcel gateway contract, source identity, and Toronto pilot evidence. -->
# Loading parcel sources

The source evidence is saved in `registry.json` and `research/`: endpoints, operators, scope,
sample requests and responses, native identifiers, paging observations and uncertainties.
The globe's `source` tier means a verified sample exists; it does not enable a runtime provider.

Executable providers are declared in `backend/parcels/source-catalog.json`, packaged with the
backend. The first provider is Toronto's municipal Property Boundary layer; it reads the
City's ArcGIS service directly and does not import parcel rows into our database. Bogotá also
streams through this gateway, using the explicitly selected December 2021 CAR mirror of
IDECA/UAECD lots.

## Integration policy

Terms, licences and reuse restrictions never block integration. They are retained as source
information for users, who choose the data they use. Source attribution and terms links remain
visible, and the source-details notice explains the provider and conditions without requiring
acceptance before loading parcels. This policy applies to every city and country.

Runtime eligibility depends on geometry, native identity and complete bounded/ID reads.
Authentication requirements, broken requests and ambiguous parcel identity remain technical
blockers. Existing failed attempts and earlier licence-based assessments are historical evidence;
the registry's current `liveIntegration` state follows this technical-only policy. Older batch
notes below describe the decisions at the time; their licence-based holds are superseded.

Live adapters proxy upstream requests without importing new parcel tables. The browser retains
immutable ground in memory for the session. Existing imported providers and proposal provenance
are separate from this live-source policy; the notice does not promise that all app data is transient.

## Runtime contract

City configuration selects a source ID. `GET /parcel-sources` lists executable descriptors.
The gateway exposes three provider-independent reads:

| Read | Request |
| --- | --- |
| Viewport cell | `GET /parcel-sources/:sourceId?bbox=west,south,east,north` |
| Saved parcel references | `GET /parcel-sources/:sourceId?ids=canonicalId,...` |
| Proposal footprint | `POST /parcel-sources/:sourceId/under` with `{ "geometry": GeoJSON, "srid": 4326 }` |

Adapters return complete WGS84 Polygon/MultiPolygon FeatureCollections with stable canonical
`properties.parcelId`, `sourceId` and `sourceParcelId`. Provider fields live under
`sourceProperties`; app consumers do not depend on their names. ID responses explicitly list
`absentIds`. Pagination is completed before a cell is published, including a further read when
a full GeoJSON page omits ArcGIS's transfer-limit flag. Limits, timeout, malformed
geometry, repeated pages and upstream errors fail the request; failures never become missing
parcels or loaded cells.

The existing cadastral repository deduplicates in-flight cell reads, retains immutable parcels
for the session and progressively integrates successful cells into the live fabric. Its callers
keep using bounds, IDs and footprints. New ArcGIS and WFS cities need descriptors and city configuration;
OGC API Features and provider-specific proxy protocols can add adapters behind this gateway.
Existing imported providers remain supported at the transport boundary.

Server proposal binding uses the same executable provider, fetches authoritative parcels and
applies the shared site-binding rule. It does not trust browser-supplied source geometry or
silently fall back to a different country's database. Geometry-less parcel acts resolve IDs
against the provider too. The provider's metric CRS is used for footprint construction and
containment checks.

## Identity and source changes

Keep canonical IDs stable when changing an endpoint or adapter for the same authoritative
dataset. Toronto uses `CA-ON-TORONTO-<PARCELID>`, never ArcGIS `OBJECTID`, whose role is only
ordering pagination. A different authoritative dataset needs an explicit identity mapping or
rebinding; changing the provider must not silently transfer saved consent to unrelated land.
Conflicting geometry for an already-retained ID is a source conflict, so a session cannot
quietly move the ground under applied proposals.

Proposal result geometry contains no retained derived parcel lists. The root
`cadastreParcelIds` remains the authored selection for provenance and consent; proposal output
geometry and live fabric are separate from that declaration.

## Toronto verification and scope

The live service was checked on 2026-10-02. A downtown sample returned four parcels, each
resolved again by its canonical ID. The browser initially loaded 81 parcels; a pan into a
second cell retained 212, and a revisit used the repository cache. An actual streamed parcel
received a complete server binding from `server:ca-on-toronto-property-boundary`.

The globe uses a conservative 15 km entry radius around downtown. This is an entry area,
not a claim that the sample proves all municipal coverage. Surrounding municipalities require
their own providers. Ownership and building data are not supplied by this parcel layer.
Source attribution and a licence link are shown on the map. Original evidence and its
uncertainties remain in `research/toronto.json`; the City's service and Open Data pages are
linked by the executable descriptor.

## Bogotá verification and scope

The current UAECD endpoint timed out from both the laptop and development server on 2026-10-02.
The user selected CAR's reachable mirror, whose layer explicitly identifies IDECA version
12.21 (December 2021). The globe popup and map attribution display this date. There is no
automatic failover between datasets. The current official catalogue also offers an August 2026
snapshot, recorded as a candidate for later investigation.

Bogotá's `LotCodigo` is a 12-character string. Canonical IDs keep all leading zeroes:
`CO-BOGOTA-006106001009`. Provider field case, string SQL literals and projection from the
mirror's native EPSG:9377 to WGS84 stay inside the adapter. Proposal city membership reads
the source prefix from city config, so each new live city needs no proposal-storage branch.

The mirror sends an incomplete/mismatched TLS chain. Its provider-scoped HTTPS transport
adds the GeoTrust intermediate from DigiCert to the normal roots; hostname and certificate
verification remain enabled. The bundled intermediate expires in July 2030; replacing the
provider endpoint or its certificate configuration is a catalogue/transport change.

A bounded live sample returned three lots with complete pagination and resolved all three
again by exact ID. The headed browser loaded 1,159 lots, retained 2,568 after panning and
reused cached cells on return. An uncached footprint read and server binding of an actual
streamed lot completed successfully. Evidence, certificate provenance, source scope and the
bounded raw response are saved in `research/bogota-live-2021-mirror.json` and
`research/bogota-car-2021-response.json`. No Bogotá parcel table was imported.

The conservative 12 km globe entry area does not establish full district coverage. This source
contains historical lots, which can contain several properties; it supplies no ownership or
building data. Neighbouring municipalities such as Soacha need their own sources.

## Los Angeles, Miami-Dade and Washington, D.C.

These three providers use the same ArcGIS gateway and viewport-cell streaming, with no parcel
imports. Their native projections, string queries and pagination stay inside the adapter; city
config selects the provider and local metric CRS. Each map links its authority and data terms.

Los Angeles uses the County Assessor's 10-character `AIN`. Its county GIS terms permit copying,
distributing, adapting and commercial/personal use, and give a recommended citation. A bounded
query paged ten parcels and resolved all ten by ID. The headed browser loaded 627 parcels,
retained 1,141 after panning, reused cells on return, and obtained a complete server binding.
County scope excludes adjacent counties; this does not establish separate condominium title
boundaries or a legal survey. Evidence is in `research/los-angeles-live.json` and its response file.

Miami-Dade uses the original County Property Appraiser service. Its 13-character `FOLIO` is a
**display number, not a row identifier**: the downtown sample contained spatially separate
polygons sharing one folio, and a full-layer query found 5,124 blank folios. Canonical IDs preserve
the exact brace-wrapped `GLOBALID`. All 596,304 queried rows had non-null GlobalIDs and a grouped
query returned no duplicate GlobalIDs; this is observed evidence, not an enforced constraint.
A bounded adapter query returned 68 polygons and resolved three by exact ID. The browser loaded
258 parcels, retained 322 after panning, reused cells on return, and obtained a complete binding.
The official public item supplies an accuracy/reliance disclaimer; no named open-data licence is
claimed. Broward and Palm Beach counties require separate sources. Details and the canonical
sample are in `research/miami-live.json` and `research/miami-live-response.json`.

Washington uses DCGIS **tax lots**, which are assessment polygons rather than surveyed/record
lots. `SSL` preserves its internal spaces for display but is not unique: `1223    0815` labels two
different polygons. Canonical IDs use `GLOBALID`; total and distinct counts both returned 30,867.
The layer's published licence is CC BY 4.0. Seven polygons completed the bounded viewport query;
three resolved by exact ID. The browser loaded 188 parcels, retained 369 after panning, reused
cells on return, and obtained a complete binding. The conservative central entry radius is 2 km;
Virginia and Maryland require separate sources. Evidence is in `research/washington-dc-live.json`
and its response file.

The adapter's optional `parcelNumberField` separates display labels from durable parcel identity.
Duplicate labels therefore retain every polygon; conflicting geometry under one stable ID still
fails closed. Headless tests exercise this distinction, GUID punctuation through the HTTP gateway,
paging, source-specific binding, saved-proposal membership and globe/deep-link routing.

Chicago remains research-only. The saved Clerk extract is dated 2021; newer official service
candidates timed out during this check and their identities/reuse terms remain unverified.
`research/chicago-live-candidates.json` records the next endpoints to investigate.

## Paris, Melbourne and Cape Town

Paris uses IGN/DGFiP Parcellaire Express PCI through the official Géoplateforme WFS 2.0
endpoint. The adapter fixes longitude/latitude order with `CRS:84`, sorts by `idu`, and requires
consistent numeric match/return counts before publishing a complete cell. It reconstructs pages
at the fixed endpoint rather than following supplied links. Exact IDs use CQL; the API Carto
candidate ignored an `idu` parameter and was not selected. Canonical IDs are
`FR-PCI-<idu>`; four-character parcel numbers remain display labels. Eight parcels paged in three
requests and all eight resolved again. A second bounded Lyon check returned and resolved 61
parcels, but only Paris is configured as a globe entry. The source covers vectorised French
cadastre, with possible gaps and alignment limitations. Map attribution links IGN/DGFiP,
source updates and Licence Ouverte 2.0. The browser loaded 393 parcels, retained 720 after a pan,
reused cells on return, and obtained complete footprint and server-binding results. Evidence is
saved in `research/paris-live-wfs.json` and `research/paris-live-response.json`.

Melbourne selects **Vicmap Parcel**, rather than the previously researched Vicmap Property
polygons. Native string `parcel_pfi` is the identity and `parcel_spi` is the display label,
including its backslash separators. A statewide snapshot counted 4,306,490 rows and the same
number of distinct non-null PFIs; another GUID-like field, `parcel_id`, was not unique. The
source item explicitly supplies CC BY 4.0. Both `parcel_status` and `parv_status` must be `A`
(Approved); `P` (Proposed) is excluded, including from exact-ID reads. Returned records are
checked against that filter too. This is the official approval code, not an inferred registration
date: many approved rows have no registration date. Crown and government-road categories are
retained. The ground source also keeps only `parv_z_level` G (unrestricted ground) and S
(ground surface affected by strata). Above/below-ground A*/B* strata overlap surface parcels
in the checked CBD sample and are excluded from this 2D ground source. Two forced three-row-page checks timed out; normal service pages, exact lookup,
footprint and binding succeeded. The final CBD surface-level query returned 2,337 approved parcels over two normal pages,
and three resolved again by ID. The final browser check loaded 10,658 parcels and retained
19,454 after a pan, with cached reads on return and complete authoritative binding.
Evidence is in `research/melbourne-live.json`; its response file explicitly
contains three examples rather than pretending to be a complete viewport.

Cape Town's `SG26_CODE` is a 26-character cadastral identity and `PRTY_NMBR` is a display label.
The service repeats parcels across address records: one tested 66-row group has identical
geometry and becomes one canonical parcel. Distinct geometry under the same ID fails closed.
ArcGIS transfer-limit flags can appear under collection `properties`; the adapter now reads
that location as well as the top level. Ten parcels completed four forced pages and all ten
resolved again. Two broader queries returned 1,368 and 2,139 canonical parcels without identity
conflicts. The browser loaded 703 parcels, retained 1,068 after a pan, reused cells on return,
and received complete footprint and binding results. The official public item links open-data
terms whose target returned 404 during verification; the descriptor records that uncertainty
and claims no named CC licence. Map attribution links the City's dataset metadata. Evidence is
in `research/cape-town-live.json` and `research/cape-town-live-response.json`.

These entries use bounded city radii; France, Australia and South Africa are not marked as
fully live countries. Melbourne and Cape Town use southern-hemisphere metric projections.
No parcel table was imported and no proposal was saved during verification.

Singapore's official weekly cadastral GeoJSON download is a candidate for a refreshed spatially
indexed snapshot adapter; no documented bbox geometry endpoint was verified. Sydney's SIX
service has an automated-retrieval restriction, while another current official service required
a token and listed no licence. Both remain research-only, with current findings saved in
`research/singapore-live-assessment.json` and `research/sydney-live-assessment.json`.

## Amsterdam and the next-source assessments

Amsterdam uses the current Kadaster / PDOK **Kadastrale Kaart OGC API Features** collection.
The new adapter translates GeoJSON, CQL2 text and opaque cursor pages into the same canonical
WGS84 contract used downstream. It fixes both bbox and output to CRS84 and rebuilds every request
at the configured collection. A next link must retain the collection, origin and every query
parameter; only its cursor is accepted. PDOK omits `numberMatched`, so completion follows the
validated terminal page, with unique upstream feature IDs and a bounded feature limit. A supplied
match count must still be numeric and consistent. Truncated, repeated or conflicting responses
remain failures rather than empty/complete cells.

Canonical identity is `NL-BRK-<identificatie_lokaal_id>`, qualified by the returned
`NL.IMKAD.KadastraalObject` namespace. Numeric `perceelnummer` is only the display label. Only
current valid (`G`) records are ground. Three parcels completed two forced cursor pages and all
three resolved through two exact-ID pages. The national dataset is updated daily and is licensed
CC BY 4.0; its map boundaries are indicative and not suitable for cadastral survey measurements.
Only a bounded Amsterdam entry is enabled on the globe. No Dutch parcel table was imported.
The browser rendered 1,760 parcels, retained 2,449 after a pan, reused cached cells on return,
and obtained complete footprint and authoritative binding results. The actual globe button
opened Amsterdam with the correct source. Evidence is in `research/amsterdam-live.json` and
`research/amsterdam-live-response.json`.

Cali's official `catastro:cat_bas_terrenos` WFS is technically usable: 118 parcels completed
three forced pages, with all 118 resolving by their 30-digit NPN. Its exact geometry reuse terms
remain unresolved, however: IDESC's published terms prohibit commercial exploitation, while a
related historical CSV's CC BY-SA licence does not establish a licence for the WFS geometries.
It stays research-only. Current evidence and the bounded canonical response are saved in
`research/cali-live-assessment.json` and `research/cali-live-response.json`.

Houston stays research-only because Harris County account keys do not identify unique geometry:
1,550,492 rows include two missing accounts and seven duplicated non-null account groups; four
have different polygons. The active-account flag does not resolve those conflicts and no GlobalID
is supplied. `research/houston-live-assessment.json` records the identity issue without exposing
owner data. Medellín's current and alternate official metadata services returned malformed JSON
or HTTP 500; its availability finding is saved in `research/medellin-live-assessment.json`.

Antwerp uses the official **Flemish GRB ADP OGC API** alternative. Its normal 1,000-row pages
completed 2,769 distinct parcels over three requests. The adapter validates that each `startIndex`
link advances by exactly the rows returned and preserves the collection and original query.
GeoServer reports `totalFeatures: unknown` and may omit links on a short terminal page; the adapter
accepts that documented terminal shape but rejects full uncounted pages without continuation.
Repeated feature IDs, changed query parameters and conflicting entity geometry fail closed.
Forced 20/30-row pages and sorted WFS requests timed out; those paths are not used at runtime.

Canonical IDs use `BE-GRB-ADP-<OIDN>`: the official GRB specification defines OIDN as the permanent
object identity. `UIDN` changes with the object's recorded version; `CAPAKEY` is retained separately
as its cadastral association and display label. ADP is a graphic cadastral depiction adjusted to
terrain, rather than a legal survey boundary. The Flemish Model Licence for Free Reuse allows
commercial/noncommercial reuse with the required Digitaal Vlaanderen attribution, linked on the map.
The bounded Antwerp globe entry does not enable Brussels, Wallonia or the whole country.
The browser rendered 1,592 parcels, retained 2,228 after a pan, reused cached cells on return,
and obtained complete footprint and authoritative binding results. Current source/version,
protocol and licence evidence are in `research/antwerp-live.json` and its response file.

## Source attempt history, Essen and San Francisco

`registry.json` retains research verification separately from runtime eligibility. Each source assessed for live
integration has `integrationAttempts`: verification date, exact endpoint, operation, outcome,
HTTP status where available, reason and a checked-in evidence file. `liveIntegration` records
its current enabled, held or superseded state. Failed paths remain alongside successful ones;
a timeout is neither an empty parcel response nor proof that no data exists.

Essen uses Geobasis NRW's current simplified ALKIS OGC API, replacing the old WFS adapter
candidate that offered no GeoJSON. The collection reports data through 2026-08-31; individual
`aktualit` values describe feature versions. `flstkennz` is the documented named ID serialized
as GeoJSON feature.id; all 20 characters, including underscore placeholders, remain intact.
Counted offset pages and exact native-ID lookups are verified. Unsupported sort parameters
returned HTTP 400 and are omitted. DL-DE Zero 2.0 permits reuse. Only bounded Essen is enabled,
not all Germany. Its browser rendered 714 parcels and retained 950 after a pan.

San Francisco uses a new fixed Socrata adapter for DataSF's Parcels – Active and Retired.
Only active Public Works recorded-map rows are ground. `blklot` uniquely identifies assessment
rows; the documented `mapblklot` groups condominium records sharing a 2D footprint. Every row's
geometry is checked before coincident rows collapse; conflicting geometry fails the whole read.
Selecting only `blklot=mapblklot` would omit one valid ground group and was rejected.
Intersection predicates include boundary-crossing parcels. Ordered row paging is bracketed by
matching counts and publication revisions; a changed source remains retryable, never complete.
The bounded sample produced 48 canonical groups and all resolved by native ID. The PDDL 1.0
source needs no parcel import. The browser rendered 685 parcels and retained 802 after a pan.
Both cities reused cached cells on return, produced complete footprint and binding results,
and opened through their actual globe buttons without uncaught browser errors.

Montréal remains held: a bounded lot and exact lookup succeeded, but forced page continuation
timed out and geometry reuse rights remain unresolved. The source-linked history and evidence
record each of these outcomes rather than disabling it without an explanation.

## Three continuation batches

The per-source outcomes for the original pair and three further batches are linked in
`research/source-batches-2026-10-03.json`. Research availability is kept separate from eligibility
to stream complete, reusable ground. All failed paths remain dated in `registry.json`.

Berlin's earlier connection/identity hold is resolved: default TLS now succeeds and the current
WFS returns the documented native `fsko` cadastral key, with `uuid` as the separate object ID.
Seventeen parcels completed six forced bbox pages and six exact-ID pages. DL-DE Zero 2.0
permits reuse. The browser rendered 154 parcels, retained 343 after a pan, reused cached cells,
and verified complete footprint/binding and the actual globe button. The enabled entry covers
Berlin, not surrounding Brandenburg. Evidence is in `research/berlin-live.json`.

Curitiba remains held. Current fiscal keys are unique where non-null, but two forced paging
strategies repeated provider rows; the adapter refused to mark either read complete. The exact
GIS layer's reuse rights remain unresolved. Rio's CC BY 4.0 licence is clear, but its physical
lot map is derived from the 2013 flight and last edited in 2022. The display lot code repeats;
the only unique field is an explicitly system-maintained OID with no durable parcel identity
contract. A forced 50-row polygon page also timed out. Neither source was enabled.

Hong Kong's documented bbox wrapper returns GML and rejects percent-encoded commas. Its response
references a public WFS 1.1 endpoint that supports GeoJSON in CRS84 and exact numeric `lotid`
queries. Six private lots completed two bbox and two exact-ID pages. The adapter handles this
explicit protocol using stable numeric `totalFeatures`, `maxFeatures` and sorted `startIndex`
pages. Unknown or changed counts, repeated transport IDs and conflicting entity geometry fail.
Every request to this fixed endpoint is serialized and starts at least one second after the
previous request; its upstream timeout starts after that wait. Bbox width and height are bounded
to 750×600 metres as well as a bounded area. The map uses the official Lands Department logo,
Government/CSDI copyright attribution and zoom 19 or closer. This entry includes private lots;
GLA and STT ground use separate collections. Source jurisdiction is preserved in globe metadata
even when a coarse country outline omits Hong Kong. Its browser retained 299 native parcels,
then 696 after a pan, reused cached cells and produced complete footprint/binding results. The
required official logo was visible, and the actual globe button opened the right source with
no uncaught browser errors. Evidence is in `research/hong-kong-live.json`.

Italy's current bounded WFS query returns HTTP 403; CC BY 4.0 is established, but GML retrieval
and completeness remain unverified. Tel Aviv's direct query returned HTTP 571 municipal
maintenance HTML, while source-specific reuse rights remain unresolved. Amman's bounded query
still returns parcel polygons, but reuse rights and durable-key completeness are unresolved.
Sri Lanka's current parcel layer requires a token, and earlier coverage excluded core Colombo.
Cotonou's current minimal WFS query returns native keys, but public consultation and service
access defaults do not establish unrestricted geometry reuse. These sources remain held with
current direct-request evidence; web-reader access failures are distinguished from provider
responses. No parcel database import or proposal write was used for this continuation.

## Shared-source city batch after release 0a084d6b

Lyon, Rotterdam and Cologne reuse the existing IGN/DGFiP, Kadaster/PDOK and Geobasis NRW
providers. Fresh three-row-page checks completed 9, 7 and 45 parcels respectively, with every
native ID resolving again. Each city has a bounded 8 km globe entry, the provider's attribution
and the same native identity namespace as its other cities. No parcel table was imported.
Evidence is in `research/lyon-live.json`, `research/rotterdam-live.json` and
`research/cologne-live.json`, with complete bounded response/ID-round-trip files alongside.

Executable catalogue schema version 2 uses `cityIds` rather than a single `cityId`. One provider
can serve several configured cities; its endpoint, adapter, canonical prefix and metric projection
remain provider facts. City-specific footprints select that provider for authoritative binding.
Configured entry names are not cadastral municipality facts; an unknown cadastral municipality
remains null in the canonical feature.

A shared prefix cannot name a city. Deep links now inspect exact geometry through the cadastral
repository's `locateIds` method, then choose the nearest configured city using that source.
`locateIds` retains immutable facts and complete absence evidence in the requested city's cache,
without publishing to the active live fabric or seeding a mutation. Normal `ensureIds` subsequently
publishes those facts as usual. Failed, absent, mismatched or timed-out lookups cannot select the
first city by accident. The existing Croatian countrywide routing retains its established behavior.

Four new-country candidates remain held, with attempts and failures attached to their registry
sources. Luanda returns polygons and exact brace-wrapped GlobalIDs, but reuse terms and the
layer's cadastral authority are unresolved; the unbraced query returned an ArcGIS error inside
HTTP 200. Lima has a new official SEDAPAL-hosted candidate, recorded separately from the
third-party copy: geometry and exact lookup work, but reuse terms and GlobalID uniqueness are
unconfirmed, and the unbounded count returned 403. Bamako's NINACAD string lookup works, but
reuse terms remain unconfirmed and only 6 of 74 bounded rows were freshly paged. Santo Domingo
serves historical polygons; unsorted paging repeated the first page at offset 9, while sorting
returned 13 unique rows. Published RI terms restrict reuse/modification, and the transport FID's
continuity is undocumented. These are holds, not claims that parcel data is absent.

The batch manifest is `research/shared-city-batch-2026-10-03.json`. Registry histories now preserve
92 dated attempts across 38 sources. The prior checkpoint is deployed; this continuation is local
until the next requested release.


## Technical-only reassessment — 2026-10-03

Bamako, Lima and Luanda now have executable live providers. Bamako uses SPRDF/NINACAD
`ninacad` keys (74 complete bounded rows and all 74 exact reads). Cali initially passed the
118-row sample, but the full viewport grid exposed two NPNs with distinct geometries. Exact
queries reproduce both conflicts and `id_predio` repeats too. Cali remains held for ambiguous
native identity, with all successful and failed checks saved; its terms never block integration.

Lima uses the SEDAPAL-hosted mapped-lot layer and its brace-wrapped `GLOBALID` keys. All 80
sample polygons resolved again by exact ID. This utility layer is not established as the legal
property cadastre. Luanda uses the GGPEN-published `Luanda_AGT_Oficial_2_gdb` property polygons;
its legal-register authority is likewise unverified and recorded as a scope notice.

Luanda's ordinary spatial geometry query still timed out at the existing 15-second deadline.
The ArcGIS adapter now supports a configured ID-first bounds path: count the bounded records,
check the complete object-ID list against that count, and fetch exact object-ID batches without
a spatial predicate or offset sorting. All 16 sample polygons and stable native GUID rereads
matched. Object IDs are paging tokens; canonical IDs retain `GlobalID_1`. Its SQL queries wrap
GUID literals in braces without changing the canonical bare GUID. Missing, extra, repeated,
truncated or conflicting records fail the read rather than publish incomplete ground.

Settings → Information → Parcel source information opens a manual source notice. It shows
publisher, scope, actual conditions and a source link, including unavailable metadata honestly.
It has no acceptance gate and is independent of streaming and proposal binding. Evidence files
for this reassessment contain metadata and request results, not parcel polygon collections.

Long ArcGIS queries use form-encoded POST rather than GET to avoid intermediary URL-length
limits. Luanda's two failed long GET batches and an 80-GUID lookup all succeeded as POST.
The final browser check rendered its parcels, retained 2,012 after panning, reused cached cells
on return and obtained complete footprint, binding and 80-ID reads. Lima retained 2,037 after
panning and passed the same footprint/binding flow. Choosing Lima on the global map selected
the provider and streamed parcels without opening the notice. Bamako rendered 181 parcels;
its panned area returned complete reads with no additional mapped parcels.

## Five-city batch — 2026-10-03

Sydney, São Paulo, Birmingham, Lusaka and Osaka bring the original positive-probe cohort
from 17 to 22 integrated cities, with 39 of its 61 cities remaining. The app now has 33
configured city entries across 21 countries and territories. The cohort accounting and
source-linked success/failure files are saved in `research/next-five-live-batch-2026-10-03.json`.
Integration counts do not imply complete municipal or national cadastral coverage.

Sydney proxies NSW Spatial Services lot polygons using native `cadid`; display `lotidstring`
and transport `objectid` remain separate. São Paulo uses the official GeoSampa WFS
`geoportal:lote_cidadao` and native `cd_identificador`, preserving the former capped bulk
candidate as research history. Both passed complete initial/panned viewport checks and all
observed exact-ID round trips, including the configured 500-row page size.

Birmingham uses the dated October 22, 2021 Geodom mirror of HMLR title-index polygons.
The fixed source scope excludes the explicit “No LR Title Detected” placeholder and SQL
NULLs; an upstream response that ignores the exclusion is rejected locally. All 898 observed
registered-title IDs resolved. This partial title-index extract is not full physical-parcel
coverage; the original unfiltered failures remain recorded.

Lusaka uses an unofficial ArcGIS Online Mtendere East sample containing only 28 polygons.
All 28 native GlobalIDs resolved, and its mapped cluster passed the viewport grid. The default
view shows that cluster; the 12 km globe entry routes city selection and does not promise data
throughout that area. Publisher, authority and source conditions remain explicitly unverified.

Osaka uses the published 2026 public-coordinate sheets for Chuo ward, with a reversible native
identity composed from municipality code, map name and sheet-local ID. The snapshot adapter
reads the fixed HTTPS file into a five-minute memory index and returns bounded viewport,
exact-ID and footprint responses through the existing gateway. Its ETag and 2,487-feature
count are pinned; changed revisions, truncation, projected coordinates, repeated native keys
and invalid geometry fail closed. Every one of the 2,487 IDs resolved, with no geometry
conflicts. There is no new parcel-table import or on-disk polygon copy.

All five passed headed app checks for viewport loading, pan/return caching, exact identity,
footprint reads and authoritative proposal binding. Failed probes for Indonesian cities,
Amman, Japan's older query service, Recife, South Africa, Guayaquil and Kuala Lumpur are
retained as metadata-only source-linked attempts. Earlier reuse-related holds are historical;
current integration policy uses technical blockers and informational source notices.

## Tokyo and Nagoya — 2026-10-03 continuation

Tokyo Chiyoda (236 polygons) and Nagoya Chikusa (284) join the existing Osaka Chuo package
through one `jp-moj-geospatial-2026` provider. Existing Osaka IDs remain unchanged: all three
use published municipality code, map-sheet name and sheet ID in `JP-MOJ-2026-`. Verified
resource extents select bounds queries; the municipality component selects exact-ID resources.
Each resource has its own ETag/count pin, namespace check and full polygon-extent validation.
Selected-resource failures abort the query; unavailable unrelated resources are not fetched.
Unknown municipality IDs are absent from these explicitly limited packages, not proof of
countrywide cadastral absence. Cache entries stay in memory for five minutes. Tokyo binding
uses EPSG:32654; Osaka and Nagoya use EPSG:32653 without splitting provider identity.

The actual combined adapter passed 54 viewport/pan cells and all 3,007 exact native-ID reads
with no geometry conflicts. Nagoya Naka, Higashi and Nakamura packages repeated the three-part
native key; these failed attempts remain recorded rather than inventing replacement keys.
CC BY catalogue metadata and conversion warnings remain source information: only public-coordinate
sheets are converted and some source geometries may be misplaced. Coverage is partial for
these named wards and is not complete for Tokyo, Nagoya, Osaka or Japan. This continuation
stays local until the next requested release. Evidence: `research/japan-2026-live.json`, the
per-city metadata files and `research/nagoya-2026-source-attempts.json`.

## Cotonou — 2026-10-03 continuation

The ANDF e-Foncier provider streams Cotonou samples using the published `nup` string
identifier in `BJ-ANDF-`; local parcel labels remain separate. Forced 25-row viewport
paging and a 0.004-degree pan passed all 18 cells; all 2,374 native IDs resolved exactly
without geometry conflicts. A genuine exact parcel footprint returned seven complete
intersecting records. The service is official but this verification does not establish
complete Cotonou or national Benin coverage. ANDF consultation/duplication conditions
and personal/confidential-information exceptions are informational source notices;
GeoServer Fees NONE / AccessConstraints NONE are defaults, not a reuse licence.
Evidence: `research/cotonou-live.json`; earlier holds remain unchanged in their dated
research and attempt history. New Delhi duplicate native keys and Fortaleza DNS failures
are separately appended from `research/batch-six-root-source-attempts.json`.


## Dortmund — 2026-10-03 continuation

Dortmund reuses the existing Geobasis NRW ALKIS OGC API source. The published
`flstkennz` GeoJSON feature ID remains the stable NRW-wide identity in `DE-NRW-`;
parcel labels and row/version fields do not replace it. A 3×3 grid and a 0.004° pan
at 0.0025° cell width completed 18/18 cells. All 1,105 observed IDs passed 14
exact-read batches of up to 80, with no absent IDs, conflicting geometries or
cross-cell conflicts. The `/under` route returned 18 complete features. All 33
provider requests returned HTTP 200; none timed out (maximum 514 ms).

This verifies the tested Dortmund entry area within the NRW regional source; it does
not establish complete NRW or Germany coverage. Dortmund was a user-authorized follow-on outside the original 61-city candidate
cohort. Four cities integrated from that cohort bring it to 26/61, leaving 35;
Dortmund is additional. After this addition, the app has 38 configured cities,
24 parcel sources, 30 source-city memberships and 22 countries. These totals describe
the current app, not progress against the original cohort. Evidence:
`research/dortmund-live-2026-10-03.json`.

## Five-city continuation accounting — 2026-10-03

This batch adds Tokyo, Nagoya, Montreal, Cotonou and Dortmund. Four belong to the
original 61 positive city probes: 26 are now integrated and 35 remain. Dortmund
is an additional verified city through the existing NRW regional provider. The app
has 38 configured city entries across 22 countries and territories, backed by 24
executable providers and 30 provider-city memberships; eight entries use older adapters.
See `research/batch-six-live-cities-2026-10-03.json` for the explicit cohort mapping.

All five passed complete viewport and exact-native-ID checks plus manual headed-browser
rendering, pan/cache, footprint lookup and proposal binding. The broad headless run
passed 1,632 checks with four database-dependent checks skipped; its stale Tokyo
source-only expectation was corrected and the focused 31-check suite passed. The
final post-Dortmund subset passed 199 checks across 13 files. Sources and their
successes/failures are recorded; no parcel database imports were made.

Cook County/Chicago remains held after seven PIN10 groups identified different baseparcel
polygons; documented baseparcel filtering does not resolve those conflicts. Recife's
alternate SEQIMOVEL field has missing or conflicting values in 13 of 18 cells.
New Delhi's full snapshot repeats native IDs across distinct polygons. Fortaleza's
hosts failed DNS resolution from the authorized network route; Singapore still lacks
a verified bounded vector/exact-key service. These are technical holds with source
conditions kept informational, and prior attempts remain in the registry history.

## Native-language retry and five-city batch (2026-10-04)

The original 200-city cohort had 60 verified candidates. The previously quoted 61
also included the extra Zagreb record. Shenzhen subsequently brought the original
cohort to 61; this batch verifies Barcelona. The count audit also repairs Berlin’s stale city record
using its already-saved live verification. There are now 63 verified original-cohort
cities: 32 are configured in the app and 31 remain to integrate. The app now has 44 city
entries and 34 executable provider descriptors overall. These totals distinguish
original-cohort cities from additional cities and multiple cities sharing a provider.

All 139 original-cohort cities unresolved at the start of this batch received an
executed native-language search. Exact query, language/script, source links and
assessment are saved per city under `research/native-language-2026-10-04/`, indexed
by `index.json`. Historical evidence did not preserve query languages, so a consistent
native-language pass cannot be claimed for those earlier searches. New leads such as
Mexico City, Quito, Maputo, Belo Horizonte, Kyiv and several Asian cadastral viewers
remain discovery evidence until actual vectors, native identity and completeness pass.

| City | Executable source | Verified scope |
| --- | --- | --- |
| London | `gb-hmlr-city-of-london` / `gml-snapshot` | City of London Corporation authority; excludes other London boroughs |
| Manchester | `gb-hmlr-manchester` / `gml-snapshot` | Manchester City Council authority; excludes other Greater Manchester authorities |
| Madrid | `es-dgc-inspire-cp-wfs` / `catastro-wfs` | Bounded official DGC parcel windows |
| Barcelona | Same DGC WFS | Bounded official DGC parcel windows; promoted from an earlier unsuccessful search |
| Savar | `bd-dlrs-dhamsona-bds-sheet-001` / `dlrs-sheet` | Only 108 draft-survey plots in Dhamsona BDS sheet 001 |

HMLR's anonymous official downloads require a publisher-scoped session and allowlisted
S3 redirect. A complete authority ZIP is checked for bounded size and CRC, then parsed
incrementally with namespace-aware Saxes and proj4. The complete native index lives
only in memory for five minutes; a failed refresh drops availability rather than
serving stale geometry as current. Distinct authority prefixes avoid routing a London
or Manchester parcel into Birmingham's broader legacy prefix. OSGB36 transformation
uses an approximately five-metre Helmert approximation, without OSTN15. These are
registered-title index polygons, not definitive legal boundaries. Manchester's archive
contains 120,989 polygons; the combined UK standalone proof peaked at about 712 MiB
with the default heap. Production process headroom must be checked before deployment;
this batch has not been deployed. See the recorded memory experiments in `gb-runtime.json`.

Spain's WFS returns GML, with projected UTM30/31 windows. It ignores startIndex and can
report misleading numberReturned when count truncates a reply, so the adapter omits
count, startIndex and hits, and requires actual members to equal numberMatched. Exact
reads use native 14-character cadastral references. Positive viewport identities are
reused for at most 60 seconds in a bounded memory cache; unknown or expired identities
require GetParcel. Absence is never inferred from an HTTP200 exception report. Parallel
exact probes produced ECONNRESET; sequential probes passed 160 Madrid exact IDs before
the sustained test returned HTTP403. Subsequent laptop requests remained blocked. Both
failures are retained, and existing source-status UI and cooldown handling expose them.
Earlier small direct exact tests passed all five Madrid and eleven Barcelona references.
The reduced-traffic adapter passes gateway and binding fixtures; fresh live acceptance
from this network remains affected by the recorded block.

DLRS serves a small complete sheet through a fixed anonymous POST. Native Dag_No is
scoped by survey, office, mouza and sheet; FID and the repeated Id field are not identity.
The verified 108-member sheet is transiently cached, with count, geometry and uniqueness
checks. A changed member count requires a coverage recheck and fails unavailable.
Other Bangladesh candidates remain held for technical reasons: the Dhaka sheet has a
zero placeholder, and the Chattogram candidate has duplicate plot IDs and lies near
Anwara outside the city proper. This does not claim those cities lack parcel data.

The new GML and DLRS adapters are fixed-publisher adapters. Custom-URL discovery still
supports the generic formats listed in `frontend/parcel-source-formats.html`; arbitrary
GML archives or DLRS POST endpoints are not automatically accepted as custom sources.
All five cities use the same canonical WGS84 viewport, exact-ID and footprint contract,
including proposal binding without querying a parcel table. No ZIP, GML or parcel geometry
is imported into the database or committed as batch evidence. Source conditions remain
informational. Evidence: `research/batch-seven-live-cities-2026-10-04.json` and its linked
publisher records. The full serial headless suite passed 7,290 tests, with six skipped.

## U.S. capital research and five-city batch (2026-10-06)

All 50 state capitals plus Washington, D.C. have fresh, capital-scoped research in
`research/us-capitals-2026-10-06/`, with `index.json` separating data discovery from
runtime readiness. Forty have observed capital-area polygon samples; 38 have initial
native identity proof or full acceptance, while Harrisburg and Olympia still need
identity work. Eleven have documented map/service/download leads without an obtained
capital polygon sample. Timeouts, TLS/DNS failures, denied requests, zero samples,
misprojected samples and unfetched archive leads remain in the per-source attempt history.
A different format is adapter work, never evidence that parcel data does not exist.
Cole County's official `CC_Parcels.zip` remains an alternative download lead for
Jefferson City; its contents have not yet been inspected.

| New city | Publisher/native identity | Retained IDs exact-resolved |
| --- | --- | ---: |
| Montgomery | City GIS / PID; padded ParcelNo is display only | 375 |
| Juneau | City and Borough GIS / complete tax_id geometry groups | 689 |
| Phoenix | Maricopa County Assessor / APN including letter suffixes | 733 |
| Little Rock | Arkansas GIS Office / parcelid restricted to Pulaski County | 420 |
| Sacramento | County active parcel base / full 14-character PARCEL_NUMBER | 837 |

Every source passed 18 grid cells, completeness checks, forced small transport pages,
exact reads of every retained native identity with matching geometry, footprint reads
and authoritative proposal binding. Evidence is metadata and aggregates only in
`research/us-capitals-live-batch-2026-10-06.json`. Initial failures remain linked there:
Montgomery repeated a terminal offset page, Sacramento's shortened APN10 collided,
and Juneau required complete geometry components plus numerical normalization.

The ArcGIS adapter now explicitly supports native-key count/OID manifests for servers
without paging. Source-controlled `nativeGeometryMode: parts` expands every observed
native key to all its components before publishing a canonical union, so viewport and
exact reads agree even when the view touches only one component. This requires complete
OID manifests for both paths; ordinary sources still reject conflicting geometry for
one identity. Juneau normalizes components to nine decimal degrees before union and
excludes UNASSIGNED/blank placeholders. Each group represents the municipal tax_id,
not independently identified legal lots. Invalid or incomplete components fail unavailable.
Juneau has a shared two-query limit across viewport/exact/footprint calls; queued calls
respect the existing provider cooldown. Automatic custom-URL discovery does not infer
this specialized grouping policy from arbitrary duplicate native keys.

A headed-browser check loaded 402 Juneau groups across nine grid cells with no source
warning, opened a parcel action menu, then panned and retained 529 groups across twelve
cells without a warning or page error. Earlier uncapped parallel requests had timed out;
those failures are recorded alongside the successful retry. All five keep the shared
canonical contract, source-health UI and source attribution; buildings default to OSM.
No parcel table import is required, and existing imported cities retain their DB defaults.

Configured U.S. cities now represent eight states (AK, AL, AR, AZ, CA, CO, FL, NY), plus
D.C.; this is not statewide completeness. Seven of 51 capitals are configured, leaving
44 to integrate: 31 have initial native sample proof, two need identity adapter work,
and eleven need further access/format investigation. Overall there are 49 app cities
and 39 executable provider descriptors. The original 200-city cohort is unchanged at
32 configured of 63 verified candidates.

The full serial headless suite passed 7,402 tests with six skipped; its only failure was
the new evidence filenames violating the established lowercase path convention. After
normalizing those filenames, all 78 focused adapter, concurrency, capital-binding,
research-history and generated-coverage tests passed, including the final precision checks.

## Ten more U.S. capitals (2026-10-06)

Hartford, Dover, Atlanta, Honolulu, Boise, Springfield, Baton Rouge, Augusta,
Annapolis and Boston are configured live parcel cities. Each passed 18 initial and
shifted grid cells, forced small-page completeness, exact reads of every retained
native key with matching geometry, footprint reads and complete source binding.
The 180 cell checks exact-resolved 5,997 identities. Metadata, aggregates and retained
failures are linked from `research/us-capitals-batch-two-live-2026-10-06.json`.
No parcel geometry or ownership data was imported into parcel tables or committed as
this batch's research evidence.

| City | Native identity and source scope | Exact-resolved IDs |
| --- | --- | ---: |
| Hartford | Connecticut 2025 Parcel_ID; fixed Hartford filter and complete identified groups | 158 |
| Dover | Delaware FirstMap PIN; fixed Kent County filter | 441 |
| Atlanta | Fulton County ParcelID; letters and internal spaces preserved, DeKalb excluded | 246 |
| Honolulu | Hawaii compilation tmk; fixed Honolulu County filter | 484 |
| Boise | Idaho/Ada County PARCEL_ID; fixed Ada County filter and complete groups | 345 |
| Springfield | City parcel/zoning view; complete 11-digit assessor PIN groups | 999 |
| Baton Rouge | EBRGIS ASSESSMENT_NUM; complete assessor-account footprints | 1,018 |
| Augusta | Maine GeoLibrary MAP_BK_LOT; fixed Augusta town filter | 432 |
| Annapolis | City GIS PIN; publisher describes a development version | 1,010 |
| Boston | Current city FeatureServer LOC_ID groups; FEE polygons only, MAP_PAR_ID display | 864 |

Hartford, Boise, Springfield, Baton Rouge and Boston use the existing explicit
complete-parts policy and shared two-query limit. Every observed native key is expanded
to all matching source components before ground is published. These source-defined groups
do not assert that each component is a separate legal lot. Source notices state group
and coverage restrictions. Hartford's single-space placeholder and Baton Rouge's all-zero
placeholder are excluded; other missing or invalid keys still fail unavailable. Atlanta's
letters and internal double spaces are preserved. Augusta's map/lot strings, including
spaces, remain scoped by municipality.

Boston uses the current official FeatureServer instead of historical Parcels09.
Its corresponding MapServer returned count 33 against 34 unique OIDs for one bounded
query; the FeatureServer returned 34/34 and passed all acceptance checks. Count equality
was retained. LOC_ID is the MassGIS locational polygon identifier; MAP_PAR_ID is the
assessor-map display reference. Water, rights of way and TAX-only polygons are outside
the configured FEE source.

Technical investigations remain source-linked: Tallahassee queries and the advertised
ZIP returned 403 or timed out; Topeka failed ordinary TLS certificate verification;
Frankfort's repeated MAPNUM/PARCEL_ID maps to different parcel labels without a proven
replacement identity or current-ground rule. Lansing's old source was Lansing, Kansas.
The actual Ingham viewer proxy reset and its backing service required a token; a public
2025 Ingham layer is a new metadata lead requiring publisher and capital verification.
Des Moines has a dated 2017 university-mirror parcel sample, with publisher provenance
and full runtime acceptance pending alongside the official Polk County atlas lead.
None of these outcomes establishes absence of data. Source conditions are informational.

Indianapolis and Saint Paul passed additional reserve checks and remain unconfigured
for the next batch. Indianapolis exact-resolved 988 county-supplied local_id feature
identities, with county_id 49 fixed and state_parcel_id display text; its initial conflicting
state_parcel_id attempt is retained. Saint Paul exact-resolved 926 Ramsey County ParcelID
values. Proposed descriptors are saved in their acceptance files.

Totals: 17 of 51 capitals configured (16 state capitals plus D.C.), 34 remaining;
18 represented states plus D.C., 21 U.S. app cities, 59 app cities overall and 49 executable
provider descriptors. These are configured city providers, not statewide completeness.
The original 200-city cohort remains 32 configured of 63 verified candidates.

All 259 focused headless tests passed across 19 files, covering gateway/binding,
multipart expansion from a one-component viewport, routing, source health, projections,
translations, research history and generated coverage. A dedicated headed Boston browser
loaded 452 retained parcels in nine cells, opened an action menu through a pointer click,
then streamed to 844 retained parcels across fifteen cells without source warnings or
page errors. The browser was closed after verification.


## U.S. capitals: third live batch (2026-10-06)

Indianapolis, Des Moines, Lansing, Saint Paul, Jefferson City, Helena, Lincoln,
Concord, Trenton and Santa Fe are configured through live adapters. All ten passed
18 initial/shifted grid cells, forced small-page completeness, exact reads of every
retained native key with matching geometry, footprint reads and complete authoritative
binding: 180 cells and 8,604 exact-resolved identities. Final app namespaces are covered
by gateway, binding and deep-link tests. Metadata, aggregate diagnostics and failed
attempts are linked from `research/us-capitals-batch-three-live-2026-10-06.json` and
source registry history. No parcel geometry or ownership data was imported or saved as
research payloads.

| City | Native identity and configured scope | Exact-resolved IDs |
| --- | --- | ---: |
| Indianapolis | IndianaMap local_id; fixed Marion County county_id 49, state_parcel_id display | 988 |
| Des Moines | Iowa HSEM university mirror, 2017; county-qualified STATEPARID groups | 441 |
| Lansing | Ingham County 2025 PARCELNUM; Eaton/Clinton areas outside this feed | 369 |
| Saint Paul | Ramsey County ParcelID | 926 |
| Jefferson City | Official hosted City/Cole County base map PID | 377 |
| Helena | Montana cadastral PARCELID; unidentified NULL-key rows excluded | 839 |
| Lincoln | City/Lancaster County hosted TaxParcels PARCELID | 799 |
| Concord | NH GRANIT/NHDES nh_gis_id; fixed town and explicit ambiguous-key exclusion | 373 |
| Trenton | NJOGIS composite PAMS_PIN | 2,716 |
| Santa Fe | Santa Fe County parcel_number through City GIS | 776 |

Des Moines explicitly states the mirror's 2017 date. Duplicate rows with the same
STATEPARID also share UNPARCELID and PARCELNUMB; complete source groups are assembled
with the established parts policy, OID manifests on both reads, nine-decimal precision
and a shared two-query limit. This presents assessment parcel groups without claiming
each component is an independently identified legal lot. Lansing's public publisher
was verified as the Ingham County Drain Office, publishing Equalization assessment data.
It uses OID manifests without geometry grouping.

Helena's server includes rows with NULL PARCELID. The shared attribute contract now
supports explicit `attributeNotNull`, validates allowed published fields, applies the
same IS NOT NULL scope to viewport/exact/footprint queries and rejects responses that
ignore that scope. Other invalid identities still fail unavailable. Its app metric
projection is WGS84 UTM zone 12. Concord's observed nonunique key 07046-0 spans five
disjoint rows with null U_ID/DisplayId. Publisher semantics do not establish a single
multipart parcel; the key is excluded from the identified-parcel scope, with the initial
conflict and diagnosis preserved. Arbitrary duplicates are not inferred to be parts.

Tallahassee still returns access-denied HTML, Topeka fails trusted TLS, and Frankfort's
native-key collision remains unresolved. Jackson's CMPDD endpoint fails Node chain
verification (including system CA mode), although plain curl with normal TLS succeeds.
Carson City polygons are available through Nevada's public service, but the same scoped
bbox returns count 5 versus six manifest objects and geometry rows. These technical
failures are saved; none establishes absence of parcel data. TLS verification and
completeness checks stay enforced. Source conditions remain informational.

Albany passed 18 cells and 767 exact native IDs. Its proposed descriptor is saved in
`research/us-capitals-batch-three-albany-reserve-2026-10-06.json` for the next batch;
its source contains 2024 tax data published May 2026. Lincoln precedes Albany in the
saved queue and fills this batch's tenth slot.

Totals: 27/51 capitals configured (26 state capitals plus D.C.), 24 remaining;
28 represented U.S. states plus D.C., 31 U.S. app cities, 69 app cities overall and
59 executable provider descriptors. The research cohort now has 45 capital polygon
samples, 42 with native sample proof, and six published leads without an obtained
capital polygon sample. City providers do not imply statewide completeness. The
original 200-city cohort remains 32 configured of 63 verified candidates.

All 382 focused headless tests passed across 20 files. A dedicated headed Des Moines
browser loaded 231 parcels across nine cells, opened an action menu with a pointer
click, then streamed to 395 retained parcels across fifteen cells. The dated source
notice was visible; the settled pan had no source warnings or page errors. The browser
was closed after verification.


## U.S. capitals: fourth live batch (2026-10-06)

Albany, Raleigh, Bismarck, Columbus, Salem, Nashville, Austin, Salt Lake City,
Montpelier and Richmond are configured through live adapters. Every city passed
18 initial and shifted grid cells, independent count agreement under forced small
pages or complete object-ID manifests, exact retrieval of every retained native ID
with matching geometry, footprint reads and complete authoritative binding. This
batch covered 180 cells and exact-resolved 8,805 native identities. Metadata, aggregate
diagnostics and every failed attempt are retained in
`research/us-capitals-batch-four-live-2026-10-06.json` and source-linked registry history.
No geometry was imported into parcel tables or saved in research payloads.

| City | Native identity and configured source scope | Exact-resolved IDs |
| --- | --- | ---: |
| Albany | NYS SWIS_SBL_ID; fixed Albany County, live service declares 2024 data published May 2026 | 767 |
| Raleigh | NC OneMap parno; fixed Wake County FIPS 37183 and county namespace | 732 |
| Bismarck | ND GIS Hub GISID; fixed Burleigh County and county namespace | 508 |
| Columbus | Franklin County Auditor PARCELID; WebMercator FeatureServer with complete OID manifests | 1,556 |
| Salem | Marion County TAXLOT; West Salem in Polk County excluded | 460 |
| Nashville | Metro Nashville/Davidson County APN | 2,119 |
| Austin | Official City TCAD layer PID_10; Travis County scope | 444 |
| Salt Lake City | Utah compilation PARCEL_ID; fixed County=SaltLake | 1,154 |
| Montpelier | VCGI SPAN assessment accounts; complete account geometry and identified shapes only | 581 |
| Richmond | VGIN's safe-integer VGIN_QPID, independent of transport OBJECTID | 484 |

Albany's live MapServer explicitly describes 2024 assessment data. The official
file-geodatabase metadata describes primarily 2025 data, also published May 2026;
the endpoint-specific notice preserves the distinction. This is recorded in
`research/us-capitals-batch-four-albany-metadata-2026-10-06.json`.

Columbus's original MapServer returned count 22 against 21 manifest objects for one
bbox. Its FeatureServer and WebMercator offset reads repeated or omitted OIDs. The
WebMercator FeatureServer returned consistent independent counts/manifests, and
existing object-ID modes passed all viewport, exact and binding checks. Pagination
failures are retained; neither counts nor identity checks were weakened.

Vermont's official VCGI documents define SPAN as the School Property Account Number
and describe one Grand List assessment record that may contain multiple mapped lots.
The first scoped forced-page cell had 13 source rows representing 11 SPAN accounts;
the repeated sampled account had three identical geometries. Across a bounded
18-cell envelope, all 643 identified rows shared parcel/Grand List year 2025, type
PARCEL and MATCH status, with no mixed years among 21 repeated groups. The explicit
assessment-account descriptor expands every native account to all rows through both
OID manifests, normalizes geometry to nine decimal degrees and uses a shared
two-query limit. It exact-resolved 581 complete accounts. NULL SPAN shapes sampled
as exempt road/rail/water have no replacement identity and are consistently excluded
with `attributeNotNull`. The footer states 2025 assessment accounts, possible multiple
lots and unidentified-shape exclusions. Legal-lot identity is not inferred from SPAN.
Official semantics and aggregate evidence are linked in
`research/us-capitals-batch-four-reserve-vt-groups-2026-10-06.json`.

Oklahoma City's county endpoint returned no polygons in 18 cells; two official city
mirror queries returned HTML on bounded retries. Harrisburg's fixed Dauphin DEP subset
and official January 2024 city snapshot both conflicted on native keys. Providence's
PlatLot conflicts, and its municipal alternative timed out with ordinary TLS. Columbia's
vendor-hosted layer technically passed 14 TMS identities, but contains only 456 polygons;
publisher lineage and municipal-assets versus broader cadastral scope remain unclear.
Pierre's current District III feed returned 404/canceled item metadata; an older trail
project mirror lacks confirmed parcel lineage. These remain technical/source-scope
investigations, distinct from absent data. Source terms are informational.

An initial Raleigh temporary descriptor used a research explanation as an ID regex;
it incorrectly rejected valid keys. Its local validation failure is explicitly labelled
and retained alongside the corrected passing descriptor. Incorrect case fields and
case-sensitive scope corrections are recorded separately from provider failures.

Charleston passed 18 cells and 766 exact native IDs, with a complete proposed descriptor
saved in `research/us-capitals-batch-four-reserves-2026-10-06.json` for the next batch.
Its live service declares Tax Year 2023, retained in the reserve notice.

Totals: 37/51 capitals configured (36 state capitals plus D.C.), 14 remaining;
37 represented U.S. states plus D.C., 41 U.S. app cities, 79 app cities overall and
69 executable providers. Research has 47 capital polygon samples, 43 with native sample
proof, and four leads without an obtained capital polygon sample. These are city-provider
counts, not statewide completeness. The original 200-city cohort remains 32 configured
of 63 verified candidates.

All 402 focused headless tests passed across 21 files, including configured gateway,
source-only binding, numeric native identity, exact/viewport group agreement, county
filters, projections, deep links, membership, translations, history and generated
coverage. A dedicated headed Montpelier browser loaded 265 assessment parcels across
nine cells, opened a parcel menu with a pointer click, then retained 1,153 parcels across
50 cells after selection/view changes and a pan. The settled map had no source warning
or page error. Its source notice was checked and the browser was closed after use.


## U.S. capitals: final remaining batch (2026-10-06)

All 14 remaining jurisdictions were processed. Eleven sources passed and are now
configured; Frankfort, Oklahoma City and Pierre retain specific technical holds.
Research is complete for the 51-jurisdiction cohort; integration is 48/51, not 51/51.
No source conditions blocked integration and no parcel geometry was imported.

Strict live acceptance covered 198 viewport cells and 6,067 exact native identities,
including forced small-page reads against independent counts, stable geometry after
panning, footprint queries and complete authoritative source binding. Final aggregate
proof is `research/us-capitals-batch-five-live-2026-10-06.json`; original failed reads,
metadata, scope and identity diagnoses remain linked from each source in registry history.

| Capital | Native identity and source scope | Exact native IDs |
| --- | --- | ---: |
| Carson City | PIN; State compilation · source date January 2026 | 837 |
| Charleston | CleanParcelID; Tax Year 2023 · assessment mapping | 766 |
| Cheyenne | statepidn; Laramie County assessment parcels · unidentified shapes excluded | 733 |
| Columbia | tms; Partial source: 456 polygons · update year not established | 14 |
| Harrisburg | PID; September 2026 · complete native PID parcel groups | 846 |
| Jackson | PARNO; MDEQ Hinds County compilation · update year not established | 307 |
| Madison | PARCELID; V12 2026 compilation · Dane County | 546 |
| Olympia | PARCEL_NO; Active assessor-property footprints · may include multiple lots | 342 |
| Providence | CAMA_LINK; 2011–2018 canopy-study mirror · identified CAMA-link groups | 463 |
| Tallahassee | TAXID; November 2025 parcel-based mirror | 933 |
| Topeka | PIN; Shawnee County assessment parcels | 280 |

Carson City exposes a provider reprojection bug: the same WGS84 envelope returned
count 61 versus 62 distinct OIDs. Four-corner native NAD83 UTM 11 envelope queries
reconciled the manifests. ArcGIS now optionally accepts `boundsSrid` and
`boundsProjection`, projects every viewport corner locally, and still returns WGS84
geometry with native parcel identities. Strict counts remain required. This descriptor
passed all 837 exact identities; no OID was promoted to parcel identity.

Cheyenne's planning overlays had null geometry in both JSON and GeoJSON. Its real county
basemap MapServer disagreed on counts/manifests; the FeatureServer sibling reconciled
those reads. Assessment scope excludes null account numbers, including an unidentified
railroad placeholder. Olympia uses the documented 11-digit assessor-property number,
complete source components and active `STATUS_IND=A`; these are property footprints
and may span multiple legal lots. Madison consistently scopes county-local PARCELID to
Dane County. Harrisburg retains complete components of publisher-defined unique PID
parcel groups from the September 18, 2026 official snapshot.

Providence's blank PROPID grouped unrelated polygons across the city. Its numeric
CAMA_LINK is used instead, with RIGIS parcel-to-CAMA linkage semantics; equivalence to a
separate municipal numeric PropertyID catalogue is explicitly not asserted. Null/blank
links are excluded consistently across viewport, exact and binding reads. The official
canopy-study mirror is dated 2011–2018, item modified February 2025, and current cadastral
currency is not inferred from that modification. Complete identified native-link groups
passed. Columbia's publisher metadata confirms Richland/Lexington tax-assessment parcel
lineage, but the source contains only 456 polygons. The map footer and descriptor clearly
state partial coverage and unestablished update year.

Jackson's CMPDD endpoints send an incomplete certificate chain. A public Go Daddy
intermediate was verified against Node's normal roots and hostname, without disabling
TLS. Once reachable, both city and 2024 county overlays conflicted on dpin geometry.
The official MDEQ Hinds County source passed with PARNO and ordinary verified HTTPS;
no new runtime certificate is required. The existing source-scoped HTTPS transport now
preserves POST method/form bodies for long ArcGIS requests and exposes Retry-After.
Topeka uses genuine county PIN, after repeated local PARCELNUM suffixes failed.
Tallahassee uses the official November 2025 parcel-based land-use mirror. Charleston
retains the explicit Tax Year 2023 service label.

| Held capital | Remaining technical blocker |
| --- | --- |
| Frankfort | Native parcel/map identifiers conflict across ground/labels; usable current native identity remains unresolved. Municipal map alternatives lack cadastral layers; a same-name hosted mirror was in Illinois. |
| Oklahoma City | The original hosted layer covers a small patch and has no parcels in the sampled center. Correct city feeds return Incapsula HTML access blocks. |
| Pierre | District III feed is canceled/404; officially linked Beacon GIS returns 403. Older project mirror parcel lineage is unverified. |

These holds are recorded as integration work, not evidence that parcel data does not
exist. Source terms remain informational. No pending/unprocessed capital entries remain.
Totals: 48/51 capitals configured, 47 states plus D.C. represented, 52 U.S. app cities,
90 app cities overall and 80 executable providers. Research has 49 obtained capital
polygon samples with native sample proof and two leads without an obtained sample.
The original 200-city cohort remains 32 configured of 63 verified candidates.

All 446 focused headless checks passed across 25 files, covering the final gateways,
source-only binding, projection, complete groups, fixed scope, identity routing, source
failures, translations, history and generated coverage. Independent PROJ values check
four-corner projection within metre-scale datum differences; the live gate verifies
counts and exact geometry using the configured transform.

A dedicated headed browser verified Jackson loading 251 parcels across nine cells,
a pointer click opening its parcel menu, and a pan increasing retained coverage to
281 parcels across 12 cells. Carson City then loaded 302 parcels across nine cells
through the native-projection adapter, with rendered outlines and the January 2026
source notice checked visually. Both views had no source alerts or page errors.
The task-owned browser was closed after inspection.
