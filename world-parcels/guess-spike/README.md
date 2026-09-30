# Guess parcels: Zagreb CDOF spike

This is a local experiment for the **estimated parcels** option in [`world-parcels.md`](../../world-parcels.md). It does not enter the cadastral repository or claim ownership evidence. Prediction reads imagery, OSM-sourced building footprints and roads, and optional Overture river/lake/sea polygons. Cadastral parcels are exported to a separate file and opened only by `evaluate.py`.

## Inputs and method

- Each sample is one 153.6 × 153.6 m City of Zagreb CDOF 2022 cached WMS tile in EPSG:3765. The tile is stored on a requested 0.15 m grid; that does **not** establish the original acquisition resolution. The raster stays in the existing local cache and is not checked into this repository. [City WMS listing](https://geoportal.zagreb.hr/Linkovi.aspx).
- OSM building footprints come from `overture_building_footprint` rows with `osm_id`; roads come from `osm_road`. Road centre lines are buffered using tagged widths when present, otherwise simple class defaults. Overture water polygons are used only for classes that can plausibly form a large barrier; pools and small ponds are excluded. These two sample tiles have no mapped water polygons. OSM-derived results require [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).
- At 0.6 m raster spacing, each OSM building footprint is a seed. The baseline gives non-road, non-water cells to the nearest building footprint. The second candidate uses multisource shortest paths with a cost for crossing strong CDOF colour edges. Both keep seed buildings intact and mask mapped roads/water. Raster contours are vectorized into EPSG:3765 GeoJSON; `validate.js` repairs self-touches and rejects invalid polygons. Each feature is labelled `estimated`, retains its method and building seed, and has `confidence: unvalidated`.
- All cadastral queries are read-only. The GeoJSON outputs, imagery previews, ground truth, and metric files are ignored local artifacts under `output/`.

## Measured samples

Boundary precision and recall count predicted/actual raster boundary pixels within 2 m of the other line. The cadastral reference is the union of each parcel's boundary pixels, independent of parcel record order. F1 is the harmonic mean. This is an exploratory geometric measure, not a calibrated parcel accuracy or ownership measure.

| CDOF tile | Character | OSM buildings | Cadastral parcels touching tile | Distance F1 | Image edge F1 | OSM footprints overlapping ≥2 cadastral polygons by ≥10% each |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `2971_33018` | Residential mix | 42 | 56 | 0.551 | 0.530 | 17 |
| `2980_33040` | Hillside/construction mix | 27 | 50 | 0.426 | 0.488 | 12 |

The [first comparison](output/tile_2971_33018/comparison.png) and [second comparison](output/tile_2980_33040/comparison.png) show the CDOF seed view, both estimates, and cadastral holdout. The imagery edge candidate helps on the construction-heavy tile and hurts on the residential tile: roof shadows, garden texture, and bare ground are strong visual edges but usually not legal boundaries. The distance baseline cuts diagonally across open land and produces many small pieces beside dense roads. Neither candidate is ready as a default app layer.

The building rule needs nuance. The footprint-overlap numbers above use rasterized OSM features and current cadastral polygons; overlapping cadastral records, building grouping, registration, and imagery/cadastre dates can contribute. They are nevertheless large enough that *one OSM building feature must never cross a guessed parcel* is an unreliable hard rule. On these samples the guess imposes zero building splits by construction while the cadastral holdout shows many multi-parcel overlaps.

These methods also cannot discover empty parcels without a seed. They do not locate setbacks, ownership, easements, or boundaries hidden under trees. A guessed boundary near a road is sensitive to the OSM centre line and assumed width. There is no per-polygon calibrated confidence or manual correction UI yet.

## Reproduce

Requires local PostgreSQL `geodata` credentials in `cadastre-data/.env`, the CDOF cache at `zagreb-parkiralista/data/tiles/cdof2022`, Python packages `numpy`, `Pillow`, `scipy`, `opencv-python`, and the existing backend Node dependencies. Run from this repository root:

```sh
bash world-parcels/guess-spike/extract.sh 2971 33018
python3 world-parcels/guess-spike/guess.py \
  world-parcels/guess-spike/output/tile_2971_33018/input.json \
  /Users/simun/Code/zagreb-parkiralista/data/tiles/cdof2022/tile_2971_33018.tif \
  world-parcels/guess-spike/output/tile_2971_33018
python3 world-parcels/guess-spike/evaluate.py \
  world-parcels/guess-spike/output/tile_2971_33018/input.json \
  world-parcels/guess-spike/output/tile_2971_33018/truth.json \
  world-parcels/guess-spike/output/tile_2971_33018
python3 -m unittest discover -s world-parcels/guess-spike -p 'test_*.py'
```

`guesses.geojson` is the distance baseline; `imagery-experiment.geojson` is the image edge candidate. `metrics.json` and `comparison.png` are the review artifacts. The CDOF source is publicly viewable, but redistribution terms for copied imagery were not established in this spike; keep raster previews local until those terms are checked.

## Next experiment

1. Label boundary **strokes** on several varied tiles: fences, walls, hedge lines, field edges, curbs, riverbanks, and observed parcel corners. Fit short straight or orthogonal segments where evidence supports them, then close a planar graph into polygons. Keep vacant plots and shared/attached buildings as explicit cases.
2. Test a model only as a source of visible feature masks, not a source of cadastral truth. [Meta's SAM 3 setup](https://github.com/facebookresearch/sam3) currently specifies a CUDA-capable GPU and gated checkpoints; this laptop spike did not run it. Prompts for fences, hedges and driveways would need to beat the no-model baseline on withheld tiles.
3. Evaluate several held-out neighbourhood types, boundary distance by feature type, polygon coverage/topology, and confidence calibration. Only then add manual corrections and an explicitly estimated layer to the app. Source imagery rights and OSM/Overture attribution need to be resolved for any publication.
