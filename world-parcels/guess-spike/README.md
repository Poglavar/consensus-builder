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

## Learning and boundary-model checks

`sam3_tiny_fit.py` tests whether the same frozen-encoder SAM 3 adaptation can learn four contiguous **training** tiles, starting from the original checkpoint. A 240-update run at learning rate 1e-4 increased mean training boundary F1 from 0.120 to 0.686 and one-to-one shape matches from 6/54 to 44/54 at score threshold 0.3. At threshold 0.05 it matched 51/54 shapes, but boundary F1 fell to 0.398 because additional masks introduced many extra and overlapping edges. This demonstrates learning on known examples; it is not a generalization result or a clean planar parcel network.

The diagnostic records raw query scores, image-presence probabilities and their product, which is the score used by Transformers SAM 3 postprocessing. Initially, the presence gate kept three of these four tiles entirely below the 0.3 threshold. After training, presence probabilities were close to one. Both score gating and mask geometry therefore matter. The runner saves checkpoint/provenance hashes, per-update losses and local API cost, periodic threshold sweeps and overlays under the ignored output directory; `--resume` validates the saved recipe.

`parcel_boundary_train.py` trains a SegFormer-B0 encoder and a new three-class output head for background, parcel interior and boundary. It loads the public `nvidia/mit-b0` encoder locally at revision `80983a413c30d36a39c20203974ae7807835e2b4`; the model has 3,714,915 parameters. RGB imagery is its only inference input. Full 1024-pixel COCO parcel annotations are converted to semantic boundaries before pooling to the 256-pixel target grid, avoiding artificial ambiguous seams caused by pooling each instance independently. Actual overlapping annotations and the outer three-pixel margin are ignored. Class weights come from training pixels only; these particular tiles have complete cadastral coverage and no supervised background pixels.

Interior components seed a flood whose cost is the predicted boundary probability. The ignored outer margin cannot connect the seeds. This reconstruction produces separate, non-overlapping raster instances; thin parcels and incomplete boundary strokes can still be lost or joined. Direct boundary-probability F1 and reconstructed parcel boundary/shape metrics are reported separately. A high boundary score alone does not establish accurate parcel polygons.

Use `--train-tiles 4 --evaluate-split none --no-augmentation` for a training-only learning check. The geographic pilot uses all 32 training tiles and selects its epoch and threshold on the eight validation tiles. Its final comparison reuses the eight previously inspected test tiles; it is exploratory, not a pristine holdout. Both runners require `--run` and explicit local paths. Checkpoints, probability grids, GeoJSON, imagery and reports remain ignored under `output/parcel-learning-check/`. `parcel_model_report.py` assembles location-grouped review artifacts without copying model weights or feature caches into its served folder.

The completed comparison used 12 epochs (384 updates) at learning rate 1e-4 for each model. SAM 3 used frozen encoders and no augmentation; SegFormer trained its encoder/head with horizontal and vertical flips. SAM 3 selected epoch eight by validation parcel-boundary F1 at fixed score threshold 0.3. SegFormer selected epoch ten and boundary threshold 0.3 by validation **reconstructed parcel** boundary F1. Neither model used the comparison tiles to select its checkpoint or thresholds.

| Method on the eight previously explored comparison tiles | Parcel boundary F1 at 2 m | Shape matches at IoU ≥ 0.5 | Coverage | Overlapping area | Raw predictions |
| --- | ---: | ---: | ---: | ---: | ---: |
| OSM building-distance baseline | 0.378 | 51/366 | 84.3% | 0.0% | 157 |
| SAM 3 decoder/head, 12 epochs at 1e-4 | 0.430 | 62/366 | 65.0% | 35.9% | 410 |
| SegFormer-B0 boundary/interior model | 0.189 | 8/366 | 100.0% | 0.0% | 127 |

SAM 3 improves boundary proximity and recovers more true shapes, but only 15.1% of its raw candidates match a reference parcel, compared with 32.5% for the OSM baseline. Its overlays contain many extra fragments and overlapping masks. It is not a coherent parcel fabric. The boundary model's direct line F1 is 0.457, much higher than its reconstructed parcel F1: line agreement does not establish correct polygon separation. These results support further supervised work but not use as an automatic parcel layer.

The SegFormer tiny fit reached direct training line F1 0.962 after 240 updates. Selecting for raw lines chose threshold 0.5 and produced poor parcel separation. The report reselects its reconstruction threshold to 0.3 using only those training tiles, improving reconstructed training boundary F1 to 0.795. The geographic run therefore uses reconstructed parcel F1 for validation selection. The superseded partial run is retained locally; no previous artifacts were deleted. Final checkpoint reload reproduced all eight SegFormer prediction grids and the metrics without repeating any training updates. Generated artifacts and executed source snapshots remain ignored, and all training/inference API charges were $0.

## SAM 3 mask-quality refinement

`sam3_quality_refine.py` starts from the stronger pilot's best adapter and keeps the image, text and context encoders frozen. The new experimental loss uses a 256×256 mask grid, extra BCE weight along target boundaries, detached matched-mask IoU as the query confidence target, and a penalty for predicted pairwise overlap beyond the reference overlap. Targets use the same GeoJSON rasterizer as evaluation; one empty subpixel training sliver is omitted from losses and recorded in the recipe. Test reference counts remain unchanged. This is a local refinement objective, not Meta's complete training recipe.

`sam3_parcel_postprocess.py` drops empty/small masks, retains each candidate's largest connected component, suppresses duplicate masks by IoU, then assigns overlapping pixels by mask probability times query score. It reassigns pixels after removing candidates that become too small. It does not fill gaps. Zero overlap is guaranteed by this assignment and must not be confused with correct parcel geometry.

Score thresholds 0.15/0.3/0.5/0.7 and minimum areas 16/64 pixels are selected on validation **whole-parcel micro F1**; boundary F1 breaks ties. The minimum-area rule can omit real small parcels. The initial checkpoint also participates in selection so extra training is not automatically accepted. Saved raw predictions use fixed score 0.3 and mask probability 0.5, letting the comparison separate learning from cleanup.

Use `--epochs 0` for the cleanup-only comparison, `--train-tiles 4 --epochs 8` for the 32-update training-only check, or `--epochs 6 --learning-rate 0.00003` for the 192-update geographic refinement. All require `--run`, explicit `--dataset`, `--cache`, `--features`, `--initial` adapter and `--output` paths. Runs checkpoint every four updates and resume with `--resume`; inputs, base weights and executed sources are hashed, and the source snapshots are preserved alongside ignored artifacts. Use a new output directory if the recipe changes. `sam3_quality_report.py --run` builds the raw/cleaned comparisons from saved arrays without loading SAM 3; its output stays under the ignored `output/` directory.

The 32-update learning check improved training-only whole-parcel F1 from 0.337 to 0.492 and matches from 15/54 to 30/54. The geographic run selected additional epoch three on validation F1 (0.117 versus the initial 0.107), but that improvement did not transfer to the previously examined comparison set:

| Method on eight comparison tiles | Boundary F1 at 2 m | Matches / references | Predictions | Shape precision | Whole-parcel F1 | Coverage | Overlap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous SAM 3, raw | 0.430 | 62/366 | 410 | 15.1% | 0.160 | 65.0% | 35.9% |
| Previous SAM 3, cleanup | 0.421 | 61/366 | 313 | 19.5% | 0.180 | 61.3% | 0.0% |
| Quality refinement, raw | 0.377 | 54/366 | 231 | 23.4% | 0.181 | 42.5% | 14.0% |
| Quality refinement, cleanup | 0.367 | 48/366 | 188 | 25.5% | 0.173 | 41.4% | 0.0% |

Cleanup preserves almost all previous matches while removing overlaps and many candidates. Additional quality training improves precision but loses recall and coverage; after cleanup it does not beat the previous adapter's whole-parcel F1. Retain the previous adapter plus cleanup as the better current SAM comparison, with score 0.3, mask threshold 0.5, IoU NMS 0.7 and minimum area 64 pixels. OSM still has higher shape precision (32.5%) and whole-parcel F1 (0.195). A larger, more varied training sample and fresh geographic holdout are needed before claiming a transferable improvement. Runs and artifacts remain under ignored `output/parcel-learning-check/`; metered training/inference API charges were $0.

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
