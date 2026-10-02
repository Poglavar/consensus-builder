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
keep using bounds, IDs and footprints. New ArcGIS cities need descriptors and city configuration;
WFS, OGC API Features and provider-specific proxy protocols can add adapters behind this gateway.
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
