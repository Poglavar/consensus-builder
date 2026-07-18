# UPU Borovje – zona jug → consensus-builder proposals

Recreates the real Zagreb city plan **"UPU Borovje – zona jug"** (public
consultation 23.6.–22.7.2026, [experience](https://experience.arcgis.com/experience/bf96116622ca4cdebf37e98c1d04880f/))
as consensus-builder proposals, programmatically.

The city publishes the plan as **georeferenced raster tiles** (ArcGIS hosted, max
LOD 19 ≈ 0.30 m/px) plus a vector cadastral-extent FeatureServer and PDF
provisions. `extract-plan.py` vectorizes the rasters; `build-and-upload.mjs`
turns the geometry into proposals and POSTs them to the backend.

## Pipeline

```
python3 extract-plan.py --step all      # tiles → data/*.geojson (+ overlay-*.png diagnostics)
node build-and-upload.mjs --dry-run     # build 21 proposals, print summary
node build-and-upload.mjs --apply       # POST to http://localhost:3000 (deterministic ids upu-borovje-*)
```

`proposal_id` is UNIQUE server-side and there is no update route - to refresh
already-uploaded proposals, delete the rows first:
`delete from proposal where proposal_id like 'upu-borovje%'`.

## What gets extracted (committed in `data/`)

| File | Source | Content |
|---|---|---|
| `parcels.geojson` | FeatureServer (vector) | 174 parcels, KO Žitnjak (335550), with app `parcelId` `HR-335550-<broj>` |
| `buildings.geojson` | sheet 4 raster | 12 building envelopes M1-1…M1-12, named via `kazete-mapping.json`, floors from PP rules |
| `zones.geojson` | sheet 1 raster | 5× Z1 park + 1× R2 recreation, planar-partitioned along drawn boundary lines |
| `corridors.geojson` | sheet 1 raster | 3 street-land polygons (IS corridors) |
| `parcelation.geojson` | sheet 1 raster | 20 new-parcel slices (građevne čestice per kazeta, parks, streets) |
| `parcel-fixes.geojson` | local parcel DB | current cadastre where the UPU snapshot is stale (4304 → 4304/1…/6) |

## What gets created in the app

- **11 building proposals** (M1-1…M1-11; M1-12 is the existing housing row, kept
  as-is by the plan, so nothing is generated). Heights = floors × 3.5 m per the
  plan's provedbena pravila: PP-1 P+3, PP-2 P+4, PP-3 P+8 (tower), PP-4 P+5.
- **6 park proposals** (5× Z1 + the central R2 recreation zone — modeled as a
  park until a dedicated playground/sports-field structure kind exists).
- **3 road proposals** — first-class road proposals driven by `definition.polygon`
  (the real street-land geometry; `_buildChildFeaturesFromDefinition` carves
  parcels directly from the corridor polygon, no centerline required).
- **1 land-readjustment proposal** (`p-upu-borovje-parcelacija`) — the plan's new
  parcelation as a reparcellization: one građevna čestica per building
  (multi-kazeta blocks split by nearest building envelope), one parcel per
  park/recreation zone, streets as prometne površine. M1-12 keeps its existing
  parcels (PP-5), so that area is excluded.

## Extraction notes

- Building envelopes: grey-fill segmentation + Moore boundary trace + RDP;
  near-rectangular shapes snap to min-area rectangles (IoU ≥ 0.88).
- Zones and corridors: **planar partition** — the drawn boundary lines (plus the
  parcel-union obuhvat clip) partition the sheet into cells, classified by hatch
  color measured on the eroded cell interior (hatch bleeds across thin lines).
- Georeference verified against the vector parcels: alignment ≈ 0.3 m.

## Sequencing: the parcelation goes first

The plan is a package: the reparcellization mints one građevna čestica per
building/zone/street, and every other proposal anchors to those NEW parcels
(`parentParcelIds` = the synthetic child ids, precomputed here). This mirrors
the real plan and avoids parcel-occupancy conflicts between kazete that share
one big source parcel today. Mechanics: the parcelation's proposal id starts
with `p-` so its children get `...#p-...` ids, which the shared-plan queue
classifies as DERIVED parents — it waits for the earlier apply in the link to
create them instead of fetching them from the server. Open the plan with the
parcelation first in the id list.

## Named proposal links

`/proposals/:ids` accepted only numeric server ids; `frontend/js/proposals/core.js`
now also accepts slug ids, so the whole plan opens with a deterministic link
(`/proposals/upu-borovje-m1-1,…?city=zagreb`).
