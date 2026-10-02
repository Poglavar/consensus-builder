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
