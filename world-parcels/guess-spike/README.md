# Guess parcels: Zagreb CDOF spike

This is a local experiment for the **estimated parcels** option in [`world-parcels.md`](../../world-parcels.md). It does not enter the cadastral repository or claim ownership evidence. The non-model baseline reads imagery, OSM-sourced building footprints and roads, and optional Overture river/lake/sea polygons. The SAM 3 experiment reads RGB imagery and text prompts. Cadastral parcels are exported to a separate file and used only for evaluation.

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

## SAM 3 smoke test (2026-10-02)

The unchanged `facebook/sam3` checkpoint at revision `3c879f39826c281e95690f02c7821c4de09afae7` was tested locally on Apple MPS. The 3,439,938,512-byte checkpoint was verified against its published SHA-256. The working Python environment came from the parking pipeline; the building-dating pipeline also contains a Transformers SAM 3 window/door detector, but its current virtual environment lacks the required packages.

Three fixed parcel prompts were tested at score threshold 0.3 and mask threshold 0.5. Cadastre and OSM were not supplied to SAM 3. These are the same previously explored tiles, so this is a smoke test rather than an independent benchmark. Best parcel-prompt results are selected after scoring and are descriptive, not a validated prompt-selection method.

| Tile | Best parcel prompt | Boundary F1 at 2 m | Distance baseline F1 | One-to-one parcel matches at IoU ≥ 0.5 |
| --- | --- | ---: | ---: | ---: |
| `2971_33018` | agricultural field | 0.321 | 0.551 | 4/56 |
| `2980_33040` | residential plot | 0.159 | 0.426 | 1/50 |

The literal `land parcel` prompt found two masks on the first tile and none on the second. The `building` control found 53 and 52 masks. Visual inspection shows isolated visible regions rather than a complete cadastral fabric. These results do not establish whether supervised fine-tuning would succeed.

`sam3_compare.py --help` describes the cached inputs and output paths. It runs offline by default; `--download` explicitly enables checkpoint fetching with `--auth-env`. Use the pinned revision above and an existing Python environment with PyTorch, Transformers, Hugging Face Hub, rasterio, shapely, Pillow, numpy and scipy. `--evaluate-only` regenerates comparisons from saved masks without loading the model. Raw masks, GeoJSON, per-prompt metrics, comparison PNGs and `index.html` are checkpointed under the supplied output directory. Keep both outputs and checkpoint caches inside the gitignored `output/` directory. Local inference incurred $0 in metered API charges.

`serve_comparison.py --directory <report-directory> --port 8097` serves the report on loopback with caching disabled. The report contains a metrics table and eight comparison panels; cyan indicates predictions and pink indicates cadastral reference.

## Supervised decoder/head pilot (2026-10-02)

`prepare_sam3_dataset.py` exported 48 new tiles in 12 separated 2×2 blocks: 32 training tiles (1,087 mask instances), eight validation tiles (158), and eight test tiles (366). Blocks have at least 1,228.8 m between their bounding boxes; no parcel IDs cross splits. The original smoke-test tiles and a 500 m buffer around them were excluded. Candidate tiles needed at least 80% cadastral coverage, nearly complete image data, 5–160 parcels and at most 5% overlapping reference pixels. The actual test reference coverage is effectively 100%. Current cadastral geometry and 2022 imagery can disagree in time.

`sam3_finetune.py` ran four epochs (128 updates) locally on MPS, with a fixed `land parcel` prompt and learning rate 1e-5. Image, text, geometry and DETR context encoders stayed frozen; 15,056,950 parameters in the detector decoder, query scoring and mask decoder were trained. Frozen image features were cached, then the image/text encoders were released from memory before training. This is a partial supervised fine-tune using a small Transformers training loop, not Meta's full-model training recipe.

The pilot uses Hungarian query/instance assignment, mask BCE and Dice, box L1/GIoU, focal query classification and image-level presence supervision. Box targets are derived from masks and never supplied as inference prompts. Training mask loss uses a 128×128 grid. Input preprocessing remains at the pretrained image resolution; boundary evaluation uses 256×256 and a 2 m tolerance. Training uses a fixed seed and evaluation mode, without dropout or image augmentation. No auxiliary decoder-layer or semantic-mask loss was added.

Epoch two was selected by validation mean boundary F1 (0.051). Separately, `residential plot` was selected as the unchanged model's best prompt on validation. Score threshold 0.3 and mask threshold 0.5 were fixed before test evaluation.

| Held-out method | Mean boundary F1 at 2 m | Parcel shapes matched at IoU ≥ 0.5 | Mean predicted coverage |
| --- | ---: | ---: | ---: |
| Unchanged SAM 3: `land parcel` | 0.000 | 0/366 | 0.0% |
| Unchanged SAM 3: validation-selected prompt | 0.045 | 4/366 | 4.9% |
| Fine-tuned SAM 3: `land parcel` | 0.148 | 14/366 | 17.2% |
| OSM building-distance baseline | 0.378 | 51/366 | 84.3% |

Fine-tuning improved this pilot's predictions, but most legal parcel shapes were still missing and the OSM baseline remained stronger. Test tiles span only two geographic blocks in one city. This does not establish cross-city generalization, nor does it rule out a larger/full-model fine-tune. The best checkpoint was loaded back from disk for final inference and its weights were verified to differ from the pretrained model. Focused tests pass; sample overlays and the local report were inspected.

Dataset, COCO RLE annotations, feature cache, predictions, training history, optimizer checkpoints and the approximately 60 MB `best.pt` adaptation are all ignored under `output/sam3-finetune/`. `best.pt` contains decoder/head parameters only and requires the pinned base checkpoint. The report folder contains only review artifacts, separate from weights and cached features. Metered API charges were $0.

Run `prepare_sam3_dataset.py --help` and `sam3_finetune.py --help` for explicit path arguments. The fine-tuning runner is offline, checkpoints every four updates, and resumes with `--resume`; preserve its dataset and model revision. The original recipe used `--epochs 4 --learning-rate 0.00001 --device mps`.

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
2. Test visible feature masks such as fences, hedges and driveways, or supervised parcel-mask fine-tuning, against the no-model baseline on withheld tiles. The unchanged SAM 3 parcel prompts above did not beat that baseline. [Meta's training recipe](https://github.com/facebookresearch/sam3/blob/main/README_TRAIN.md) supports custom datasets; parcel training needs segmentation targets and mask losses enabled, since the example Roboflow configuration defaults to box detection.
3. Evaluate several held-out neighbourhood types, boundary distance by feature type, polygon coverage/topology, and confidence calibration. Only then add manual corrections and an explicitly estimated layer to the app. Source imagery rights and OSM/Overture attribution need to be resolved for any publication.
