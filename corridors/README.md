# Corridor Generator Prototype

Standalone prototype of the algorithmic corridor proposal generator described in [../algorithmic-corridors.md](../algorithmic-corridors.md). Generates diverse, curvature-legal railway alignments Trogir → Split and outputs each as a parcel set + GeoJSON. No UI, no writes to shared tables — reads `parcel` from the local `geodata` DB and caches everything else under `data/`.

## Usage

```bash
cd corridors && npm install

node fetch-osm-layers.js --run   # OSM context layers (rail, roads, water, built-up, ...) via Overpass
node fetch-dem.js --run          # elevation grid from AWS terrain tiles (optional but recommended)
node generate.js --run           # the generator; run without --run for options
```

Outputs land in `out/<runid>/`:

- `corridor-NN.geojson` — corridor polygon + centerline with stats (length, min radius, parcel count)
- `proposals.json` — one entry per distinct proposal: the sorted parcel-id set (the proposal's identity) + per-parcel taken area
- `all-centerlines.geojson` — all accepted centerlines in one file for quick viewing (e.g. geojson.io)

## Pipeline

cost surface (cadastre coverage/fragmentation + OSM water/built-up/protected/aerodrome + DEM slope, discounts along existing rail and major roads) → Dijkstra least-cost path → arc smoothing to `--radius` → PostGIS buffer + parcel intersection → Jaccard dedupe vs accepted alternatives → iterative penalty on crossed cells → repeat.

Cells with no cadastral parcel are treated as blocked (this is what keeps routes out of the sea). First `generate.js` run builds the parcel grid in PostGIS and caches it (`data/parcel-grid.bin`); delete the cache after changing the grid/bbox in `lib/config.js`.

The DB guard refuses non-local servers (an SSH tunnel can silently forward `localhost:5432` to prod); pass `--allow-remote` only if that is intentional.
