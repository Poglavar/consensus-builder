# Overture 3D scenery (generic city source)

A generic 3D source for cities that have **no bespoke local model** (unlike Zagreb's LOD2 mesh or
NYC's live footprint feed). It serves features from [Overture Maps](https://docs.overturemaps.org/)
and OSM open data to the Three.js view:

- **Buildings** — footprints + heights (`theme=buildings`) extruded to flat-top **LOD1** blocks,
  from `public.overture_building_footprint`.
- **Trees** — instanced trunk+crown scenery, toggleable in the 3D panel, from `public.osm_decor`:
  mapped tree points (`kind='trees'`) **plus** trees scattered through mapped green areas
  (`kind='greenery'`). See "Why trees are planted, not just read" below.

The frontend renders a scenery toggle only for layers a city actually has (via `GET /decor/layers`).
Cities wired up: **Belgrade**, **Split**, **Šibenik**.

## One ingestion, shared with zagreb-isochrone (2026-08-02)

Both tables above are **owned by cadastre-data** and read by zagreb-isochrone's Station3D world as
well as by this app. That was not always true, and the divergence was expensive:

| | this app (old) | cadastre-data |
|---|---|---|
| buildings | `overture_feature` (city, layer='buildings') | `overture_building_footprint` (city) |
| trees | `overture_feature` (layer='trees') | `osm_decor` (kind='trees') |
| ingest | `backend/scripts/ingest-overture.js` | `buildings/fetch-overture-buildings.js` |

Split existed in **both**, from two separate DuckDB pulls: 53,537 buildings each, identical height
and floor-count stats. Trees agreed to within 7 points (3,878 vs 3,885) because Overture's
`base/land` trees are themselves derived from OSM `natural=tree` — the same data, fetched twice.
Every new city had to be ingested twice to be visible in both apps, and could silently drift between
them in the meantime.

`overture_feature` and the second ingest CLI are gone. There is now one table per layer and one
ingestion, in cadastre-data. This app only declares **which slice of it a city reads**, in
`backend/buildings/overture-cities.js`.

**Cities read a `region`, not their own id.** cadastre-data ingests by AREA, so one regional pull can
serve several cities — `sibenik` reads `sjeverna-dalmacija`, the Zadar–Šibenik–Knin box already
pulled for the M606/M607/L211 railway reconstructions. Querying by city id instead would hit an empty
row set and the city would render with no buildings and no error; a unit test pins the indirection.

## Why trees are planted, not just read

Šibenik looked bare, and the instinct was that the decor load was stale or clipped. It is not — the
data does not exist. Across the whole Šibenik–Vodice strip OSM has **139** individually mapped
trees, and an Overpass count over central Šibenik returns **43**, exactly the number `osm_decor`
already holds. Overture is no help either: its `base/land` trees are themselves derived from OSM
`natural=tree`, which is why the two copies of Split agreed to within 7 points. **No reload of any
source produces more mapped trees here.**

What OSM *does* have in Dalmatia is green **areas**: **1,812** greenery polygons covering **9,830 ha**
over the same strip. So the trees provider unions two sources — mapped points, and points scattered
through greenery — which is what zagreb-isochrone's world already does with the same rows. Result at
Šibenik centre, 300 m radius: **17 → 139 trees**. Split gains too (215 → 397). Belgrade is unchanged
at 107: it has no greenery rows, so the scatter is a no-op there rather than an error.

This is **derived presentation, computed per request, and deliberately not written back** to
`osm_decor` — the isochrone plants its own from the same polygons, so stored copies would double up
in that app.

### The lattice is anchored to absolute coordinates

The one thing a scatter must not do is move when the camera does. Positions therefore come from a
lattice on absolute **EPSG:3857** metres, with the per-point jitter hashed from the integer cell
indices — never from the query point, and never from a polygon clipped to the current radius.
Clipping then only ever *removes* candidates. Verified against the live DB:

| check | result |
|---|---|
| trees shared with a query panned 100 m east | 136 of 139, identical to ~1 cm |
| radius 300 m vs radius 450 m | strict subset (139 of 234) — growing the radius only adds |
| identical query repeated | byte-identical |

3857 units are not metres away from the equator (×1.38 at Šibenik), so the step is divided by
`cos(latitude)` taken from **each polygon's own centroid** — a fixed property of that polygon, so the
spacing is stable per polygon too. Spacing defaults to 12 m and is overridable per city with
`greeneryTreeSpacingM`.

## Both radius queries needed an index prefilter

`ST_DWithin(geom::geography, …)` reads as an index lookup and is not one: the cast puts `geom` behind
a function call, so the GIST index cannot serve it and Postgres scans every row in the table
computing geodesic distances. Both providers did this. Adding an `&& ST_Envelope(ST_Buffer(…))`
prefilter — an exact superset of the circle, so results are unchanged — measured on the live DB at
300 m over Šibenik, back to back on the same box:

| query | before | after |
|---|---|---|
| buildings (734k rows) | 3,185 ms | **75 ms** (42×) |
| trees (316k rows) | 2,654 ms | **309 ms** (8.6×) |

The whole `/decor/near` request for Šibenik now takes 175 ms *including* the greenery scatter — less
than a tenth of what the old tree query alone cost.

## Why Overture (not Overpass)

Belgrade (and most non-US/EU-member cities) has no open, authoritative LOD2 city model. The national
geoportal (RGZ/GeoSrbija) has accurate 2D footprints but no published 3D model, and its cadastre is
contract-gated. Overture merges OSM + ML data into a clean, versioned, S3-hosted GeoParquet — no live
Overpass dependency (Overpass is rate-limited and flaky).

Coverage is uneven (it reflects OSM): central Belgrade buildings are ~90% `num_floors`-tagged but
**city-wide ~12%** (187k buildings); measured `height` is rarer still (275 of 187k in Belgrade, 28 of
187k across Sjeverna Dalmacija), so most buildings render on the floors-or-default fallback. Good for
central context; thinner at the edges.

This is the same quality tier as the NYC provider: **footprint/point + attribute, not a true mesh**.

## Architecture

```mermaid
flowchart LR
  subgraph cadastre-data ingestion
    O[Overture S3 GeoParquet] -->|DuckDB, area bbox| T[(overture_building_footprint)]
    J[OSM PBF / Overpass] -->|load-osm-decor.mjs| S[(osm_decor)]
  end
  T -->|city = cfg.region, extrude| Pb[overture-3d provider] --> R[/buildings/near/]
  S -->|kind='trees'| Pt[overture-trees provider] --> D[/decor/near/]
  S -->|DISTINCT kind| L[/decor/layers/]
  R --> F[Three.js 3D view]
  D --> F
  L -->|which toggles to show| F
  T --> Z[zagreb-isochrone Station3D]
  S --> Z
```

Files (under `backend/`):

| File | Role |
|------|------|
| `buildings/overture-cities.js` | **The generalization point.** One entry per city: the `region` it reads + height-extrusion fallbacks. Also `effectiveHeight()`. |
| `buildings/overture-3d.js` | Buildings provider. `near()` → `{ object_id, z_min, z_max, faces[] }`. |
| `decor/overture-trees.js` | Trees provider. `near()` → `{ trees: [[lng,lat], ...] }`. |
| `routes/decor.js` | `POST /decor/near` (scenery near a point) + `GET /decor/layers?city=` (which scenery layers a city has). |
| `scripts/copy-overture-to-prod.sh` | Push **one region's** buildings local → prod (prod has no DuckDB). |
| `buildings/index.js` | Wires every `overture-cities.js` key to the buildings provider automatically. |

Frontend: `three-mode.js` renders both layers. Buildings need only `buildings.source: 'overture'` on
the city config. Scenery layers (trees, future parks/water) are **data-driven toggles**: on entering
3D, the panel calls `GET /decor/layers?city=` and renders a checkbox per available layer that also has
a frontend renderer (`DECOR_LAYERS` registry). Trees are an instanced layer (two draw calls), persisted
in `cb_3d_trees_enabled` (default ON), reusing the buildings near-query + radius slider. Tree heights
are assigned deterministically per point (the source carries no tree height).

## Adding a city

1. **Check whether the area is already ingested** before pulling anything:
   ```sql
   SELECT city, count(*) FROM overture_building_footprint GROUP BY 1 ORDER BY 1;
   SELECT city, kind, count(*) FROM osm_decor GROUP BY 1,2 ORDER BY 1,2;
   ```
   A regional row set that already covers the city (as `sjeverna-dalmacija` covered Šibenik) is the
   one to reuse — re-ingesting it under a new name would just duplicate rows this table already has.
2. Only if it is genuinely missing, ingest **in cadastre-data**:
   ```bash
   node buildings/fetch-overture-buildings.js --run --city <region> --bbox W,S,E,N
   node api/scripts/load-osm-decor.mjs --city <region> --dir <decor-json-dir> --run
   ```
3. Add an entry to `backend/buildings/overture-cities.js` naming that `region`, plus
   `floorHeightM` / `defaultHeightM`.
4. Set `buildings.source: 'overture'` in that city's `frontend/js/city-config.js` block.

No new provider code, route changes, or renderer changes — the trees toggle and providers are
city-generic.

## Deploy to prod (no DuckDB on prod)

Ingest locally, then push the region up:

```bash
PROD_DATABASE_URL='postgres://user:pass@host:5432/geodata' \
  ./scripts/copy-overture-to-prod.sh sjeverna-dalmacija
```

**Region-scoped, not whole-table.** The old script `pg_dump --clean`'d the entire table, which was
safe while that table was this app's private one. `overture_building_footprint` is shared and holds
regions this repo never ingests (zagreb, rijeka, corridor pulls) — a whole-table replace from here
would delete all of them on the target. The script now stages one region and swaps it in a single
transaction, and refuses to run when the local region is empty (which would otherwise read as
"delete it on prod").

## Status / TODO

- [x] Buildings + trees providers, city-generic; Belgrade verified e2e.
- [x] Data-driven scenery toggles via `GET /decor/layers`; verified in-browser (render + on/off/on).
- [x] `copy-overture-to-prod.sh` so prod needs no DuckDB.
- [x] Unit tests (`backend/test/buildings-providers.test.js`), incl. the city→region indirection.
- [x] Consolidated onto cadastre-data's tables + ingestion; `overture_feature` and the duplicate
      ingest CLI removed.
- [x] Trees scattered through `osm_decor` greenery, anchored so they cannot crawl while panning.
- [x] Index prefilter on both radius queries (buildings 42x, trees 8.6x).
- [ ] Drop the now-orphaned `overture_feature` table (contents verified duplicated; see below).
- [ ] i18n the scenery toggle labels (match the surrounding hardcoded control labels for now).
- [ ] Schedule a periodic ingest+copy refresh (monthly, tracking Overture releases).
- [ ] More layers from `osm_decor`, which already carries them: hedges, benches, footpaths, and
      greenery as a rendered green ground surface (only its trees are used today).
- [ ] ML height gap-fill (e.g. GlobalBuildingAtlas) for buildings with no floors tag in the periphery.

### Dropping `overture_feature`

Nothing reads it any more (no code, no views — checked via `pg_depend`). Its contents were verified
present in the shared tables before the switch: Belgrade 187,126 buildings re-ingested into
`overture_building_footprint` (now *with* `osm_id`, which the old copy lacked) and its 3,185 trees
migrated into `osm_decor`; Split existed in both already. It is left in place only because dropping
is destructive and was not needed to finish the switch:

```sql
DROP TABLE public.overture_feature;
```
