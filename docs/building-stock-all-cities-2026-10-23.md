# Building stock queries across cities

The NYC failure was a missing provider capability: both NYC providers returned nearby meshes but
had no footprint or per-region demolition method. Zagreb also lacked the per-region method used
by Freeform review. The Overture database provider, browser tiles, OSM and custom sources already
implemented the three-method contract.

Both NYC feeds now expose polygon footprints and intersecting stock through the shared footprint
engine. Stock queries retain unknown-height buildings; heights stay null when not measured, and
feet are converted to metres when present. IDs match the corresponding mesh IDs. Holes remain
holes, and a sliver intersection remains a candidate for the shared partial-demolition rules.
ArcGIS independently counts each queried box, because the service may impose a cap below the
requested record limit. A cap, malformed response or failure invalidates coverage. Source reads
are cached for five minutes in bounded provider-local caches.

Zagreb's new bulk method queries observed GDI footprints, retaining their object IDs and repairing
invalid polygons before intersection. It does not substitute the legal cadastre used by urban-rule
footprint queries. A cap voids every region. Custom-source polygon queries now flag their answer
as incomplete when the requested box was shrunk. A configured Overture fallback can answer a
truncated server read, while its own incomplete/unavailable flags remain intact. An authoritative
empty server demolition scan still remains empty.

NYC's source footprint option is exposed in the map controls. The provider contract test resolves
every configured city, including configured custom sources, and requires all three methods. It
also checks both NYC feeds, HTTP response support, source identities/heights, unknown heights,
sliver intersections, courtyards, empty regions, malformed data, source failures and service caps.

Live read-only checks:

- NYC ArcGIS: the repaired method and running local HTTP endpoint returned City Hall, ID 1079147,
  measured height 36.5725 m, supported and not truncated.
- Dedicated background headed Chrome: New York, backend explicitly resolved to the running local
  API, and 120 real parcels in the test bounds. Freeform's initial footprint review showed one
  partial cut and enabled acceptance. Taking the whole 38,200 m² parcel showed two full removals
  and one partial cut, with acceptance enabled. The building kept its 400 m² footprint.
- Zagreb: a read-only database transaction executed the new spatial SQL and returned 88 GDI
  objects in the sample bounds, without truncation.
- Paris: a browser request selected its location's Overture tile source and returned one
  intersecting footprint, supported and not truncated, while the session remained in New York.
- The alternate Socrata feed accepted its stock query but returned no buildings in the NYC
  sample. This publication's known source coverage limitations are why ArcGIS remains the default;
  API capability does not assert that a source has captured every real-world building.

Targeted validation runs (none stopped; no full suite):

1. Headless unit: 79 cases in seven files passed (`building-stock-contract`, `buildings-providers`,
   `osm-3d-provider`, `custom-building-source`, `building-source-client`, `overture-tiles`,
   `city-building-sources`).
2. Headless unit: 70 cases in five files; nine HTTP cases failed because the sandbox refused
   loopback listeners. The other 61 passed. These files were `building-stock-contract`,
   `buildings-under`, `custom-building-source`, `building-source-client`, `demolition-bulk-prefetch`.
3. Headless unit: the same 70 cases in five files passed with loopback access.
4. Headless unit: 33 cases in three files passed after the final tile-coverage and source-registration
   additions (`building-stock-contract`, `building-source-client`, `city-building-sources`).
5. Headless Playwright: seven cases in `freeform-land-take.spec.ts` and
   `observed-buildings-display.spec.ts` passed, one worker and no retries.
6. Headless Playwright: both cases in `observed-buildings-display.spec.ts` passed after adding NYC
   source-control/display coverage, one worker and no retries.

The vocabulary change shares a file with concurrent work and remains uncommitted. The tested
checkout also contains the earlier Freeform wiring and unrelated concurrent changes. No push or
production deployment is part of this change.
