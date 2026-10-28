# Frontend-owned source configuration

All data families share the registration and dispatch contract in
[`source-adapters.md`](source-adapters.md): abstraction → adapter → default or custom source.
The read-only **Sources & adapters** reference in Settings exposes the running registrations,
operation contracts and preparation schemas. Provider-specific IDs, configuration formats and
HTTP routes remain the domain interfaces; the common wrapper does not replace those identities.

The frontend owns city settings and selects every source it requests. Backend services expose named
resources and validated adapters. They do not select a source from a city, a parcel-ID prefix or
geographic coverage. A city on a saved record is caller metadata, not a backend routing instruction.

`frontend/data/city-configs.js` owns each city's parcel, building, planning and floor-evidence choices.
The browser loads `data/city-index.js` (every city, light) plus `data/cities/<id>.js` (the current city,
full), generated from it: regenerate the browser files with `node scripts/build-city-files.mjs --run` after editing it.
`CityConfigManager.getDataContext(geometry, cityId)` resolves the frontend context for a location;
`getParcelContext` returns just the publication metadata and parcel source. Source choices made by
the visitor are applied there too.

Public parcel provider definitions live in `frontend/data/source-catalog.json`; optional Atlas URL
provider definitions live in `frontend/data/planning-sources.json`. Backend adapters read those public
provider definitions for explicit-ID resolution and transport validation. Their city associations,
preferences and per-city metric metadata do not select a backend provider. Credentials, safe URL
validation, query limits, database schemas and adapter implementation remain server responsibilities.

Economic sources follow the same ownership boundary. `CityMoney` consumes the pure economic adapter
registry; `economics.sources` and per-city browser overrides select independent land, sale and
construction rates. The adapter contract, local JSON format and supported consumers are documented
in [economic-sources.md](economic-sources.md).

## Requests

- Shared building reads require `source`: `osm`, `gdi-3d`, `nyc-arcgis`, `nyc-socrata`, or a portable
  `building.…` descriptor. The frontend selects any fallback and issues the second request itself.
- Floor evidence is optional: `/buildings/near` receives the configured `floorModelNamespace`.
  The existing registry column is named `city`; its value is an explicit namespace, not geographic
  inference. Without a namespace, no evidence collection is joined.
- Binding and new publication require an explicit `parcelSourceId`: a catalogue/portable provider,
  `oss-wfs` for the Croatian database service, `parcel-nyc` for imported NYC data, or `none` for an
  intentional no-cadastre context. Missing sources are refused before dataset reads. Failed or
  incomplete sources still fail; they do not become a `none` selection.
- Planning reads name a source ID. `/planning/sources` lists services independently of consumer city;
  frontend `planning.sourceIds` controls the visible choices and their default order.
  Atlas definitions live in `frontend/data/planning-sources.json`; parcel envelopes require an explicit
  `parcelSourceId`. City entries can repeat a regional URL and archive profile: the adapter shares
  each edition's loaded data. Public district GeoJSON and selected ZIP/CSV/XLSX members use
  `product: "districts"`; Slices GeoJSON remains the default product. See [public Atlas sources](atlas-public-sources.md).
- Custom source discovery does not require an app city. An optional caller-supplied `cityIds` label
  remains portable metadata for frontend settings, not backend membership or permission.
- MCP reads require the parcel source explicitly. Building context/demolition measurement takes
  `buildingSourceId`; without it, building evidence stays unknown. Parcel studies use the caller's
  selected `planningSourceIds`. Agreement drafting takes explicit money or an ISO `currency`.
- Monitor namespaces and publication labels are accepted as record metadata. App aliases and
  geographical city selection belong to the frontend. A monitor without a namespace uses `global`.

For example, either request works for any consumer; neither needs a city identifier:

```json
{ "source": "osm", "geometry": { "type": "Point", "coordinates": [2.35, 48.86] } }
```

```json
{ "parcelSourceId": "parcel-nyc", "site": { "type": "Polygon", "coordinates": [[[ -74.0062,40.7127 ],[ -74.0059,40.7127 ],[ -74.0059,40.713 ],[ -74.0062,40.713 ],[ -74.0062,40.7127 ]]] } }
```

## Intentional contract changes

Callers that relied on omitted sources, backend city aliases, automatic city placement or the
`NYC_BUILDINGS_SOURCE` selection flag must send their choices explicitly. The old backend city
selection modules are removed. No compatibility router or record migration was added. Existing
experimental records lacking the source context needed for recalculation should be recreated.
Parcel identities themselves are unchanged by this refactor.

Croatian and imported NYC parcel datasets remain available as named backend resources; their
frontend defaults have not been switched to live official URLs by this change. OSM reads still use
staged OSM rows when available and backend Overpass otherwise. Staged deduplication is independent
of consumer city. Scenery uses geometry-scoped data without a city configuration lookup.

Offline publication/agent CLI consumers can read the frontend's money settings through
`backend/scripts/lib/frontend-city-money.mjs`; the HTTP/MCP service does not infer currency that way.

## Verification

Targeted checks and local source read-back are recorded in
[source-configuration-validation-2026-10-23.md](source-configuration-validation-2026-10-23.md).
