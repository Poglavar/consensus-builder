# Location first: where you are decides what loads

Living plan (started 2026-10-17). Update the status column as phases land.

## Why

A link carrying Zagreb coordinates (`?at=45.81,15.97,19`) opened a blank 3D scene: the app took its
city from `?city=` or the stored pointer (default `new_york`) and never from `?at=`, so every data
source was asked New York's questions about Zagreb. The deeper problem is that the city id is used as
the key for things that only depend on coordinates.

User direction, 2026-10-17:

- `city` and `at` are either-or, and there must be a rule for when they disagree.
- Everything that can work off geography works off geography (OSM, Overture, Google, water,
  terrain, tiles do not care about cities).
- Things that need a city (cadastral parcels) work it out from the location, with a sane rule at
  borders (Ciudad Juárez vs El Paso).
- `city=zagreb` becomes an alias for the coordinates of Zagreb's centre.
- Headless and headed tests cover the change.

## Concepts

| Term | Meaning |
|---|---|
| **View** | `{lat, lon, zoom}`. The only location a URL needs (`?at=`). |
| **Jurisdiction** | The city config whose parcel data applies at a point, or none (explore). Derived, never typed. |
| **Coverage** | The area a jurisdiction claims. Today a circle (`parcels.liveRadiusKm`, capped at 60 km) or a countrywide country (HR); later declared areas per parcel source (phase 3). |
| **Geography source** | A source that answers by coordinates alone: buildings, trees, water, roads, terrain, tiles. |

There is **one** resolver, `world/world-coverage.js` (`tierAt` / `liveCitiesAt`). It already runs in
the browser (globe, search) and on the server (`backend/proposals/publication-city.js`, the M8
publication-city rule in `projections.md`). Boot uses the same function, so the city a view opens in
and the city a publication is filed in can never disagree.

## URL rules

Reading, first match wins:

1. **A record deep link** (`focusProposal`, `proposalShare`, `parcel`, `shared`, `bets`, `scene`,
   `activity`) puts the view on that record and keeps its stored city (records are immutable). Unchanged.
2. **`?at=` present** → jurisdiction = resolver(at). A `?city=` alongside it is ignored when it
   disagrees, with one console line saying so (`city=new_york ignored: at= lies in zagreb`).
3. **Only `?city=`** (id or short code) → view = that city's centre and default zoom; jurisdiction =
   that city. Old links keep working.
4. **Neither** → the stored city's centre, as today; a first visit opens the globe, as today.

Outside every coverage the jurisdiction is **explore** (no parcels, geography still loads). Distance
is used only to *suggest* the nearest covered city there, never to pick one. Explore is never asked
for: a legacy `?city=explore` beside `?at=` is just the point (user, 2026-10-17: drop the mode, use
the coordinates), and alone it opens explore at its last view. A failing parcel source does not need
an escape into explore: the city view degrades on its own (the parcel-register notice).

Writing: the app writes only `?at=` (map-core already does on every `moveend`). After boot the
address bar drops `city=` (and the legacy `city=explore`), so every copied link is a plain location.

Moving the camera across a coverage edge inside a session: geography follows the camera without
asking (phase 2). Parcels, proposals and the local database stay with the boot jurisdiction until
the user switches (the existing switch prompt, offered once the centre is well past the edge), since
a switch reloads the page and may interrupt an edit.

## Border rule

Coverage circles ignore borders, so a point in El Paso could fall in a Juárez circle. Rule (phase 3):

- A city's coverage is its circle **clipped to its own country**.
- Among the coverages containing the point, the **smallest area wins** (a city source inside a
  national one), then the nearest centre (several cities on one source differ only in label).
- Phase 3 replaces circles with declared source areas where they exist; the precedence stays.

The clip needs finer outlines than we have. Tried in phase 1 with the Natural Earth 110 m outlines
in world-coverage.json: 11 of the 650 city centres fall outside their own country's outline there
(Geneva, Aachen, Maastricht, Enschede, Jerusalem, Modiin, Livingstone) or have no outline at all
(Hong Kong ×3, Macau, San Marino), so the clip broke exactly the border cities it is for. It waits for
phase 3 (finer outlines or declared source areas); phase 1 keeps today's circles. No border pair like
El Paso / Juárez is configured today.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | URL and boot: jurisdiction from the location, `at` wins, `city` is an alias | done 2026-10-17 |
| 2 | Geography sources by coordinates only (backend + 3D + 2D buildings) | done 2026-10-17 |
| 2b | Coverage at least 10 km, not 3–8 km sample circles | done 2026-10-17 |
| 3 | Declared coverage per parcel source; border precision | planned |
| 4 | Proposals by geography: binding, lists, counts, markets, plans by site; city a derived label | planned |

### Phase 1: URL and boot

Built:

- `WorldEntryModel.resolveEntry` (pure): the URL rules above → `{ cityId, view, source, cityParam,
  ignoredCity, dropCityParam }`.
- `WorldCoverage.jurisdictionAt` = the first of `liveCitiesAt`, which is also what the server files a
  city-less publication under and what a globe pick opens (`tierAt` now uses `liveCitiesAt`).
- `frontend/data/boot-coverage.js` (53 KB, from `scripts/build-boot-coverage.mjs`, rerun by
  `build-world-coverage.mjs`): live cities + Croatia's outline, loaded before `city-config.js` with
  `world-coverage.js`. The full JSON is 875 KB, too heavy for boot; a test pins identical
  `liveCitiesAt` answers and that the file matches the JSON.
- `city-config.js` boots from the entry, logs an ignored `city=`, stores the chosen city (not
  explore), exposes `getBootEntry()`; the dead `/geo/default-city` client path is gone.
- `map-core.js` drops `?city=` with its first `?at=` write. AI-scene share links take the city from
  the city manager, not the address.

Deferred: the border clip and its audit script (see Border rule).

### Phase 2: geography by coordinates

Built: `backend/jurisdiction.js` (the shared rule on the server); the building registry picks its
provider from the request geometry (no Zagreb default; a body `city` is ignored); trees anywhere
(Zagreb, New York and explore had none); `/decor/layers?bbox=`; `/buildings/osm` labels by the box;
floor models keyed by the city at the geometry. Browser: `CityConfigManager.cityAt` /
`getCityConfigAt`; the building client routes and picks the source by the request's place and sends
no city; the 2D building layer (GDI vs provider) follows the view's centre. Planned below for the
record:

Backend:

- `buildings/index.js`: providers declare coverage (Zagreb GDI and NYC from their tables' extents,
  the way `streets/near.js` uses `ST_EstimatedExtent`); `forRequest({ source, geometry })` picks the
  provider whose coverage contains the request, else the worldwide default. The city field is
  ignored for provider choice (old clients keep working). Removes the "no city means Zagreb" default
  and the EPSG:3765 transform of far-away geometry.
- `/buildings/osm`: bbox only; the staged label lookup goes through the existing scope ladder.
- `/decor/near`: trees by geometry (the ladder already ends unlabelled), so Zagreb, New York and
  explore get trees where the table has them. `/decor/layers?bbox=` instead of `?city=`.
- The floor-model join keeps a city, because the city is part of a floor model's stored identity;
  it is resolved from the geometry by the shared resolver instead of read from the request.

Frontend:

- Stop sending `city` to `/buildings/*` and `/decor/*`; send geometry (already sent).
- The 3D scene key and `nearbyDataScope` key on the area, not the city.
- The building source route (`building-source-client.js` `routeFor`) comes from the jurisdiction at
  the requested point (phase 1 makes this location-derived already; check the explore and
  out-of-coverage cases).

### Phase 3: declared coverage per parcel source

- Catalogue schema: `coverage` on a source, one of `{ bbox }`, `{ admin1: [ISO 3166-2] }` (46 sources
  already state `discovery.jurisdiction`), `{ country }`, or a polygon reference (HMLR already has
  per-authority land-scope polygons).
- Capture extents automatically where the service publishes one (ArcGIS `extent`/`fullExtent`, OGC
  `collection.extent.spatial.bbox`) in a resumable script that writes to the catalogue.
- The resolver: sources whose coverage contains the point, smallest first; within the chosen source,
  the nearest city centre. Circles remain the fallback for sources without a declared area.
- Finer country outlines (Natural Earth 10 m admin-0) for the border cities the phase-1 audit lists.

### Phase 2b: coverage sized to the city

User, 2026-10-17: 3 km is far too small (Zagreb is 20 km+ across). The `liveRadiusKm` values (3, 6,
8 km) record where qualification sampled the source, not the city's extent.

Built: every declared radius is at least 10 km (`coverageRadiusKm` in build-world-coverage.mjs);
larger declared radii stand and undeclared cities keep the 60 km cap. Tried and dropped: sizing from
the UN WUP 2025 urban-centre area (×2 its equal-area radius gives Zagreb 14 km, Paris 42 km). It
claimed neighbouring municipalities that research had deliberately kept out (Bogotá's circle took
Soacha, Toronto's Markham and Mississauga; their tests pin it). A city's real extent is the source's
declared area, phase 3.

### Phase 4: proposals by geography, stray defaults

User, 2026-10-17: which city a proposal is "filed under" should not matter once the switch is done;
proposals are geography-first.

- Binding takes the parcel source from the site's location (the city at the site), never from the
  view or a requested city, so the "publish it from <city>" refusal goes away.
- `/proposals/count|summary`, `/markets`, `/plans` by area (site geometry; `proposal.site` has a GIST
  index; explore already lists proposals by box). `proposal.city` becomes a derived label.
- The browser's per-city database is the last coupling (one IndexedDB per city); decide whether
  records move to one store keyed by place.
- Defects found in the survey, fixed where they are:
  - `ens_plan.city` stores the raw request (`zg`), so `/markets?city=zagreb` misses those plans.
  - `area-monitors.js` prefix inference tests `NY-`/`CO-`, but ids are `US-NY-`/`US-CO-`, so those
    monitors default to Zagreb.
  - `ens/slug.js` maps every `HR-` parcel to Zagreb (Split and Šibenik too).
  - `/geo/default-city` defaults everything outside HR/RS/AR to Zagreb (only the dead client path calls it).
  - `normalizeCityCodeForApi` (frontend `proposals/core.js`) maps back only zg/zgb/bg/ba, while
    `resolveCurrentCityCode` emits ny/st/si/….

## Tests

Every phase lands with its tests. Targeted runs while iterating; full suites only with a yes.

Headless unit (vitest, `backend/test/`):

- `resolveEntry` table: at only (Zagreb point → zagreb; mid-ocean → explore), city only (id and short
  code), both agreeing, both conflicting (at wins, `ignoredCity` set), legacy `city=explore`, a
  record deep link outranking both, malformed `at`, unknown city, stored only, neither.
- Invariant over all 650 configs: the resolver at each city's own centre returns that city (catches
  twins across a border and circles swallowing a neighbour's centre).
- Border cases with synthetic outlines: a point just inside each side of a border resolves to that
  side's city; a city circle inside a countrywide-live country beats the country.
- Backend and browser agree: `resolvePublicationCity` and `resolveEntry` give the same city for a
  set of sample points (they share the module; the test pins it).
- Phase 2: provider choice by geometry (Zagreb, NYC, Bogotá, open ocean) with a stub pool; trees
  without a city; `/decor/layers` by bbox; no EPSG:3765 transform outside its domain.
- Phase 3: catalogue `coverage` schema validation; nested and adjacent source areas.

Headless Playwright (mocked API, `e2e/tests/`):

- `/?at=<Zagreb>` with New York stored: Zagreb's parcel endpoint is called, the address bar has no
  `city=`.
- `/?city=zagreb&at=<New York>`: New York's endpoint; console notes the ignored city.
- `/?city=zg`: opens at Zagreb's centre, address bar rewritten to `?at=`.
- `/?at=<mid-ocean>`: explore banner, no parcel requests.
- A proposal deep link still opens on the proposal.
- Phase 2: 3D requests carry no city; explore gets trees from the mocked decor.
- Existing specs that encode the old behaviour (`city-switching.spec.ts` default city,
  `world-and-ground.spec.ts` arrivals) are updated, not deleted.

Headed (a launched Chrome over agent-browser, checked by eye):

- The link that went blank on 2026-10-17 shows buildings and traffic.
- A New York link, an explore point, and a city-only short-code link, each in 2D and 3D.

## Decisions

- 2026-10-17: `at` wins over `city`; `city` is a read-only alias for its centre; the app never
  writes `city=`.
- 2026-10-17: jurisdiction by containment, distance only suggests. Circles keep nearest-centre order
  in phase 1 (smallest-area-first would refile overlapping publications for little gain); smallest
  area first applies to declared source areas in phase 3, with the country clip.
- 2026-10-17: explore is derived, never asked for; `?city=explore` is legacy.
- 2026-10-17: a session keeps its boot jurisdiction for parcels/proposals/storage; geography follows
  the camera.
