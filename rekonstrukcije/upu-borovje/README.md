<!-- This folder preserves the source-derived geometry and reproducible proposal generator for UPU Borovje – zona jug. The committed GeoJSON is the canonical local reconstruction artifact. -->

# UPU Borovje – zona jug → consensus-builder proposals

Recreates the real Zagreb city plan **"UPU Borovje – zona jug"** (public
consultation 23.6.–22.7.2026, [experience](https://experience.arcgis.com/experience/bf96116622ca4cdebf37e98c1d04880f/))
as consensus-builder proposals, programmatically.

The city publishes the plan as **georeferenced raster tiles** (ArcGIS hosted, max
LOD 19 ≈ 0.30 m/px) plus a vector cadastral-extent FeatureServer and PDF
provisions. `extract-plan.py` vectorizes the rasters; `build-and-upload.mjs`
turns the geometry into proposals and POSTs them to the backend.

Archive provenance: the tracked extraction files were imported from branch `upu-borovje` at
commit `9828995` on 2026-08-11. Its separate worktree remains intact because that branch has not
been merged into `main`.

## Pipeline

Run these commands from this folder:

```
python3 extract-plan.py --step all      # tiles → data/*.geojson (+ overlay-*.png diagnostics)
node build-and-upload.mjs --dry-run     # build 22 proposals, print summary
node build-and-upload.mjs --apply       # POST to http://localhost:3000 (deterministic ids upu-borovje-*)
```

`repair-imported-proposals.mjs` is a separate, dry-run-by-default migration for the historical
database rows 633–651 and 699. It is retained beside the reconstruction because its assumptions and
fixed record identifiers are specific to this import; it is not part of a clean new upload.

`apply-clean-topology.mjs` is the historical August topology migration. It rebuilt the
ground from the actual UPU extent, smooths the collector road to ten intentional edges, stores two connected road
polygons and split the non-road ground into three connected readjustments. Its writer predates
the flat cadastral model and must not be rerun against current rows.

For the current local database, use `repair-flat-plan.mjs`. It preserves all 22 identities and the
17 plot boundaries, removes the obsolete coordinated-plan runtime behavior, clips building edges
to their intended plots, and recomputes the one flat cadastral declaration per record:

```
PGHOST=127.0.0.1 node repair-flat-plan.mjs --dry-run
PGHOST=127.0.0.1 node repair-flat-plan.mjs --apply
```

Every changed row is backed up in `public.proposal_borovje_flat_backup` in the update transaction.
The repair checks cadastral coverage, connected valid ground geometry, gaps, overlaps and canonical
record serialization before committing. A second run makes zero changes. The fresh-upload generator
uses the same `flat-plan.mjs` projection, so rebuilding does not restore obsolete runtime metadata.

## What gets extracted (committed in `data/`)

| File | Source | Content |
|---|---|---|
| `parcels.geojson` | FeatureServer (vector) | 178 parcels, KO Žitnjak (335550), with app `parcelId` `HR-335550-<broj>` |
| `buildings.geojson` | sheet 4 raster | 12 building envelopes M1-1…M1-12, named via `kazete-mapping.json`, floors from PP rules |
| `zones.geojson` | sheet 1 raster | 5× Z1 park + 1× R2 recreation, planar-partitioned along drawn boundary lines |
| `streets.geojson` | sheet 2a raster | 6 named road axes (collector + crossings), junction vertices shared |
| `parcelation.geojson` | sheet 1 raster | 20 new-parcel slices (građevne čestice per kazeta, parks, streets) |
| `parcel-fixes.geojson` | local parcel DB | current cadastre where the UPU snapshot is stale (4304 → 4304/1…/6) |

The six GeoJSON files above are committed in this folder as the canonical reconstruction geometry.

## What gets created in the app

- **11 building proposals** (M1-1…M1-11; M1-12 is the existing housing row, kept
  as-is by the plan, so nothing is generated). Heights = floors × 3.5 m per the
  plan's provedbena pravila: PP-1 P+3, PP-2 P+4, PP-3 P+8 (tower), PP-4 P+5.
- **6 park proposals** (5× Z1 + the central R2 recreation zone — modeled as a
  park until a dedicated playground/sports-field structure kind exists).
- **2 connected street-network road proposals** (`upu-borovje-ulice` and
  `upu-borovje-ulice-split-1`) — 6 named centerlines extracted from **sheet 2a (Prometni i komunikacijski
  sustav)**, which draws the roads explicitly: the collector is the red-hatched
  planned-road band (centerline smoothed to eleven vertices / ten edges while retaining its broad curve), the
  IS-1/IS-2 crossings are clean colored cells (straight PCA axes). Crossing
  endpoints are junction vertices in the collector polyline. Per-class cross-sections: SP 19 m (lanes +
  cycleway + sidewalks + verges), IS-1 18 m shared surface, IS-2 9 m pedestrian.
- **3 connected land-readjustment proposals** (`p-upu-borovje-parcelacija`, `-2`,
  `-3`) — the road network divides the non-road plan into three disconnected
  blocks, so each block is a separate readjustment with its own saved
  `poolGeometry`. Together they contain 17 real plots: one per M1 building area,
  park or recreation zone. The road proposals own the complementary `IS` ground;
  no outside cadastral remainder or street sliver is promoted into a plot.

## Extraction notes

- Building envelopes: grey-fill segmentation + Moore boundary trace + RDP;
  near-rectangular shapes snap to min-area rectangles (IoU ≥ 0.88).
- Zones and corridors: **planar partition** — the drawn boundary lines (plus the
  parcel-union obuhvat clip) partition the sheet into cells, classified by hatch
  color measured on the eroded cell interior (hatch bleeds across thin lines).
- Georeference verified against the vector parcels: alignment ≈ 0.3 m.

## Sequencing and tessellation

The plan is an ordinary package, grouped for provenance by `reconstructionPlanId: upu-borovje`.
Roads apply first, then the three readjustments subdivide their connected non-road blocks, retaining
all cadastral remainders. Buildings occupy those plots (`goal: buildings`, `typologyType: single`
for the geometry editor), followed by parks and recreation. Do not restore `coordinatedPlanId`:
that historical mode deliberately omitted remainders needed by the other blocks and roads.

Verified locally on 2026-09-05: **22/22 applied**, also after full rebuild and reload; all 11 buildings
and 6 parks are present. Only M1-11 (25.462 m² / 1.102%) and M1-9 (0.052 m² / 0.009%) needed edge
trimming in the saved data. PostGIS measures 73,635.281 m² of authored ground, 0.002173 m² of boundary
rounding gap and 0.000002 m² overlap. The actual applied fabric has 0.013 m² of rounding-scale gaps
inside the original UPU extent. No building was moved or removed.

An applied browser copy is intentionally retained when the same link is reopened. After repairing
server rows, use a clean browser origin (`http://127.0.0.1:8080` instead of `http://localhost:8080`),
or unapply the old local copies before reopening the link; do not erase unrelated local proposals.

`apply-clean-topology.mjs` refuses to write unless the canonical mesh verifies:
every plot and road is connected, no plot is smaller than 150 m², the three
readjustment pools are connected, and road plus plot union has no gap, overlap
or area outside the UPU extent.

## Named proposal links

The frontend accepts numeric row IDs, or one registered named-plan slug. Individual proposal slugs
are API identifiers, not a supported comma-separated frontend route. The repaired local plan is:

`http://127.0.0.1:8080/proposals/633,1304,1305,699,641,638,639,643,640,642,637,635,644,636,634,645,646,647,648,649,650,651?city=zagreb`
