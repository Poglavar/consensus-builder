# Overture 3D scenery (generic city source)

A generic 3D source for cities that have **no bespoke local model** (unlike Zagreb's LOD2 mesh or
NYC's live footprint feed). It ingests features from [Overture Maps](https://docs.overturemaps.org/)
open data into **one Postgres table (`overture_feature`)** and serves them to the Three.js view. Layers
so far:

- **Buildings** — footprints + heights (`theme=buildings`) extruded to flat-top **LOD1** blocks.
- **Trees** — individual tree points (`theme=base/type=land`, subtype `tree`) rendered as instanced
  trunk+crown scenery, toggleable in the 3D panel.

**One table for all layers** (discriminated by a `layer` column), so adding a layer needs no new DDL
and the whole dataset is a single table to copy to prod. The frontend renders a scenery toggle only
for layers a city actually has (via `GET /decor/layers`). First city wired up: **Belgrade**.

## Why Overture (not Overpass)

Belgrade (and most non-US/EU-member cities) has no open, authoritative LOD2 city model. The national
geoportal (RGZ/GeoSrbija) has accurate 2D footprints but no published 3D model, and its cadastre is
contract-gated. Overture merges OSM + ML data into a clean, versioned, S3-hosted GeoParquet — same
delivery for buildings and trees, no live Overpass dependency (Overpass is rate-limited and flaky).

Coverage is uneven (it reflects OSM): central Belgrade buildings are ~90% `num_floors`-tagged but
**city-wide ~12%** (187k buildings); trees are **~3.2k city-wide**, concentrated in the mapped centre
(parks/boulevards) and sparse in the periphery. Good for central context; thinner at the edges.

This is the same quality tier as the NYC provider: **footprint/point + attribute, not a true mesh**.

## Architecture

```mermaid
flowchart LR
  O[Overture S3 GeoParquet] -->|DuckDB extract, city bbox| N[city-layer.ndjson]
  N -->|batch UNNEST upsert, layer col| T[(overture_feature)]
  T -->|layer='buildings' + extrude| Pb[overture-3d provider] --> R[/buildings/near/]
  T -->|layer='trees'| Pt[overture-trees provider] --> D[/decor/near/]
  T -->|DISTINCT layer| L[/decor/layers/]
  R --> F[Three.js 3D view]
  D --> F
  L -->|which toggles to show| F
```

Ingest locally (needs DuckDB) → copy the one `overture_feature` table to prod (no DuckDB on prod) via
`scripts/copy-overture-to-prod.sh`.

Files (under `backend/`):

| File | Role |
|------|------|
| `overture/overture-feature-ddl.sql` | **The one table.** `overture_feature(city, layer, overture_id, geom, height_m, num_floors, properties jsonb, …)`, PK `(city, layer, overture_id)`. |
| `buildings/overture-cities.js` | **The generalization point.** One entry per city: ingestion bbox + height-extrusion fallbacks. Also `effectiveHeight()`. Shared by all layers. |
| `buildings/overture-3d.js` | Buildings provider (`layer='buildings'`). `near()` → `{ object_id, z_min, z_max, faces[] }`. |
| `decor/overture-trees.js` | Trees provider (`layer='trees'`). `near()` → `{ trees: [[lng,lat], ...] }`. |
| `routes/decor.js` | `POST /decor/near` (scenery near a point) + `GET /decor/layers?city=` (which scenery layers a city has). |
| `scripts/ingest-overture.js` | One layer-parameterized ingestion CLI (`--layer buildings\|trees`) → `overture_feature`. |
| `scripts/copy-overture-to-prod.sh` | `pg_dump -t overture_feature` from local → a target you pass via `PROD_DATABASE_URL`. |
| `buildings/index.js` | Wires every `overture-cities.js` key to the buildings provider automatically. |

Frontend: `three-mode.js` renders both layers. Buildings need only `buildings.source: 'overture'` on
the city config. Scenery layers (trees, future parks/water) are **data-driven toggles**: on entering
3D, the panel calls `GET /decor/layers?city=` and renders a checkbox per available layer that also has
a frontend renderer (`DECOR_LAYERS` registry). Trees are an instanced layer (two draw calls), persisted
in `cb_3d_trees_enabled` (default ON), reusing the buildings near-query + radius slider. Tree heights
are assigned deterministically per point (Overture has no tree height).

## Adding a city

1. Add an entry to `backend/buildings/overture-cities.js` (bbox + `floorHeightM` + `defaultHeightM`).
2. Set `buildings.source` to non-`'none'` in that city's `frontend/js/city-config.js` block.
3. Ingest each layer:
   ```bash
   node scripts/ingest-overture.js --city <id> --layer buildings
   node scripts/ingest-overture.js --city <id> --layer trees
   ```

No new provider code, route changes, or renderer changes — the trees toggle and providers are city-generic.

## Ingestion

Requires the **DuckDB CLI** for the extract phase (`brew install duckdb`, or download the binary and
pass `--duckdb /path`). The load phase uses the app's `PG*` env (set `PGHOST=localhost` when running on
the host against local docker).

```bash
# Full city, per layer
node scripts/ingest-overture.js --city belgrade --layer buildings
node scripts/ingest-overture.js --city belgrade --layer trees

# Small smoke box first (recommended), then inspect before the full run
node scripts/ingest-overture.js --city belgrade --layer trees --bbox 20.455,44.808,20.470,44.818

# Phases run independently
node scripts/ingest-overture.js --city belgrade --layer trees --extract-only
node scripts/ingest-overture.js --city belgrade --layer trees --load-only --in tmp/overture-belgrade-trees-<rel>.ndjson
```

- **Restartable**: each load upserts on `(city, layer, overture_id)`, so a re-run refreshes in place.
- **Refresh to a new Overture release**: `--release <ver>` (default tracks the latest known monthly).
- **Building height fallback** (at render time, per `overture-cities.js`): measured `height` →
  `num_floors × floorHeightM` → `defaultHeightM`.

## Deploy to prod (no DuckDB on prod)

Ingest locally, then copy the single table up:

```bash
PROD_DATABASE_URL='postgres://user:pass@host:5432/db' ./scripts/copy-overture-to-prod.sh
```

It `pg_dump`s `overture_feature` (schema + data, version-matched via the local container) and replaces
it on the target. One table covers every layer and every city you've ingested.

## Status / TODO

- [x] Single `overture_feature` table for all layers; one layer-parameterized ingestion CLI.
- [x] Buildings + trees providers (one shared table, `layer` discriminator); Belgrade verified e2e.
- [x] Data-driven scenery toggles via `GET /decor/layers`; verified in-browser (render + on/off/on).
- [x] `copy-overture-to-prod.sh` so prod needs no DuckDB.
- [x] Unit tests (`backend/test/buildings-providers.test.js`).
- [ ] i18n the scenery toggle labels (match the surrounding hardcoded control labels for now).
- [ ] Schedule a periodic ingest+copy refresh (monthly, tracking Overture releases).
- [ ] More layers on the same table/endpoint: parks/greenery + water polygons (flat ground decals).
- [ ] ML height gap-fill (e.g. GlobalBuildingAtlas) for buildings with no floors tag in the periphery.
