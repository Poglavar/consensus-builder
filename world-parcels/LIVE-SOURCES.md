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
