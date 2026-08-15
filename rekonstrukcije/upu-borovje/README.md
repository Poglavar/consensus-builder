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
node build-and-upload.mjs --dry-run     # build 19 proposals, print summary
node build-and-upload.mjs --apply       # POST to http://localhost:3000 (deterministic ids upu-borovje-*)
```

`repair-imported-proposals.mjs` is a separate, dry-run-by-default migration for the historical
database rows 633–651 and 699. It is retained beside the reconstruction because its assumptions and
fixed record identifiers are specific to this import; it is not part of a clean new upload.

`proposal_id` is UNIQUE server-side and there is no update route - to refresh
already-uploaded proposals, delete the rows first:
`delete from proposal where proposal_id like 'upu-borovje%'`.

## What gets extracted (committed in `data/`)

| File | Source | Content |
|---|---|---|
| `parcels.geojson` | FeatureServer (vector) | 178 parcels, KO Žitnjak (335550), with app `parcelId` `HR-335550-<broj>` |
| `buildings.geojson` | sheet 4 raster | 12 building envelopes M1-1…M1-12, named via `kazete-mapping.json`, floors from PP rules |
| `zones.geojson` | sheet 1 raster | 5× Z1 park + 1× R2 recreation, planar-partitioned along drawn boundary lines |
| `streets.geojson` | sheet 2a raster | 6 road-axis segments (collector + crossings), junction vertices shared |
| `parcelation.geojson` | sheet 1 raster | 20 new-parcel slices (građevne čestice per kazeta, parks, streets) |
| `parcel-fixes.geojson` | local parcel DB | current cadastre where the UPU snapshot is stale (4304 → 4304/1…/6) |

The six GeoJSON files above are committed in this folder as the canonical reconstruction geometry.

## What gets created in the app

- **11 building proposals** (M1-1…M1-11; M1-12 is the existing housing row, kept
  as-is by the plan, so nothing is generated). Heights = floors × 3.5 m per the
  plan's provedbena pravila: PP-1 P+3, PP-2 P+4, PP-3 P+8 (tower), PP-4 P+5.
- **6 park proposals** (5× Z1 + the central R2 recreation zone — modeled as a
  park until a dedicated playground/sports-field structure kind exists).
- **1 street-network road proposal** (`upu-borovje-ulice`) — 6 interconnected
  centerline segments extracted from **sheet 2a (Prometni i komunikacijski
  sustav)**, which draws the roads explicitly: the collector is the red-hatched
  planned-road band (centerline = smoothed diameter path of the band), the
  IS-1/IS-2 crossings are clean colored cells (straight PCA axes). Crossing
  endpoints are inserted as junction vertices into the collector polyline, so
  the network is properly noded. Per-class cross-sections: SP 19 m (lanes +
  cycleway + sidewalks + verges), IS-1 18 m shared surface, IS-2 9 m pedestrian.
- **1 land-readjustment proposal** (`p-upu-borovje-parcelacija`) — the plan's new
  parcelation as a reparcellization: one građevna čestica per building
  (multi-kazeta blocks split by nearest building envelope) and one parcel per
  park/recreation zone. The separate road proposal owns the `IS` polygons, so
  street land is not duplicated inside the readjustment. M1-12 keeps its
  existing parcels (PP-5), so that area is excluded.

## Extraction notes

- Building envelopes: grey-fill segmentation + Moore boundary trace + RDP;
  near-rectangular shapes snap to min-area rectangles (IoU ≥ 0.88).
- Zones and corridors: **planar partition** — the drawn boundary lines (plus the
  parcel-union obuhvat clip) partition the sheet into cells, classified by hatch
  color measured on the eroded cell interior (hatch bleeds across thin lines).
- Georeference verified against the vector parcels: alignment ≈ 0.3 m.

## Sequencing and tessellation

The plan is a coordinated package (`coordinatedPlanId: upu-borovje`). The
readjustment first forms only its authored non-road plots and deliberately does
not mint the omitted street bands as accidental remainders. The road proposals
then fill those reserved bands from cadastral ground; their ordinary cadastral
remainders are clipped around the plots already standing there. The plot union
and road union therefore tile the plan without overlaps or gaps. Buildings,
parks and recreation proposals then resolve their live parcels geometrically.
Shared-plan loading enforces the full dependency order: land readjustment →
roads → buildings → parks and recreation.
If only part of the package is already applied, the loader first removes those
stale package members and imports every current definition before replaying the
whole package in that order.

`repair-imported-proposals.mjs` migrates the historical rows to that model. It
clips every readjustment plot by the road union, retains the former street verge
as non-road plots, and refuses to write unless PostGIS verifies: no plot/plot
overlap, no road/plot overlap, and conservation of the complete plan pool.

## Named proposal links

`/proposals/:ids` accepted only numeric server ids; `frontend/js/proposals/core.js`
now also accepts slug ids, so the whole plan opens with a deterministic link
(`/proposals/upu-borovje-m1-1,…?city=zagreb`).
