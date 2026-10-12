# ParcelBench: the yardstick for parcel recognition from imagery

The October 2026 spike in [`../guess-spike/`](../guess-spike/README.md) trained SAM 3 heads and a SegFormer boundary model on Zagreb tiles for ten days and never beat a 150-line OSM heuristic. It also never had a stable yardstick: the test tiles were reused and swapped, the metric was redefined three times, and validation and test rankings disagreed. Coinbase's fraud-agent series (Build, Evaluate, Own; October 2026) got the order right: freeze a benchmark drawn from real outcomes, decide the product metric, layer the model on the rules you already have, and only then post-train a small specialised model against a deterministic reward. This directory is that order applied to parcels.

Everything here runs on the laptop in seconds. Training does **not**: it runs on a rented GPU (user decision, 2026-10-12), see [Compute](#compute).

## Principles

1. **One frozen benchmark, one scorer.** A city manifest fixes the tiles, their strata, the reference hashes and the scoring parameters. Every number comes from `score.py`. The final split is scored once per milestone and the result goes into the ledger; the selection split chooses checkpoints, thresholds and cleanup.
2. **Four product metrics, reported together.** Parcel F1 at IoU ≥ 0.5, area-weighted recall, boundary F1 at 2 m, and shape precision. Area-weighted recall is our dollar-weighted recall: recovering ten large parcels is worth more to a visitor than ten slivers.
3. **The learned model is layered on the rules, never a replacement.** The OSM building-distance baseline stays as the first line. A model adds boundary evidence where OSM has none. The comparison that matters is baseline + model against baseline alone, on the same tiles.
4. **Narrow model output, deterministic reconstruction.** The model predicts boundary probability, distance-to-boundary and interior; code builds the planar graph, closes polygons and owns topology. SAM 3 producing 410 overlapping instance masks per eight tiles was the opposite design.
5. **Objective tied to the metric.** Checkpoints are selected only by the benchmark's product metrics, never by a training loss or a line-only score. Boundary pixels are rare, so the loss must weight them, the way a fraud reward is balanced for class imbalance.
6. **Change one thing at a time.** Data size, learning rate, encoder freezing and cleanup are separate experiments with the same initialisation. The spike's 32-to-96-tile expansion changed data, optimisation state and cleanup together and could not say anything about data.
7. **Small specialised model, trained end-to-end, on rented compute.** The spike kept 833 of SAM 3's 848 million parameters frozen because the laptop had 16 GB. That was a hardware constraint presented as a recipe. Coinbase post-trained a 9B open model on one GPU for under $100 and beat the frontier model on every metric.
8. **Version the whole stack.** Model weights, cleanup and reconstruction are one unit; the ledger records a recipe hash with every row. Cleanup moved the spike's numbers as much as training did.

## Practice regions: choosing donors for uncovered cities

Delineation customs follow legal and survey traditions and the land itself (climate, soil, irrigation, field size), and these span regions, often whole countries (user observation, 2026-10-12). A city without an open cadastre is therefore very likely to share its parcel-defining practice with a cadastre-covered city a hundred kilometres away in the same country, and plausibly with one in the same climate class across a border. That is both the hypothesis the benchmark must test and the rule for picking training data.

`practice_regions.py` ranks, for every researched city without a verified parcel source, the covered cities most likely to share its practice: **same country, then same Köppen-Geiger class, then same Köppen group, then distance**. Köppen classes are sampled from Beck et al. (2023), 1991–2020, 0.1°, CC BY 4.0 (figshare 10.6084/m9.figshare.21789074); the raster stays out of git, the sampled classes are in `practice-regions.json`. Coverage means a verified city sample, a verified countrywide source, or a region-wide source for the city's state in a federal country.

Result on the UN top-200 queue (registry of 2026-10-12):

| Donor tier | Targets |
| --- | ---: |
| A: a covered city in the same country | 75 |
| B: same Köppen class within 1000 km, other country | 21 |
| C: same Köppen class, farther | 31 |
| D: same Köppen group only | 1 |

Targets with a same-country donor within 300 km: 26. Targets with a same-class donor within 1000 km: 63. The one group-only case is Pyongyang (Dwa; nearest same-group donor Almaty, 4058 km). Across all 1,515 researched cities: 1,039 targets, 628 in tier A.

| Köppen group | Covered cities | Uncovered top-200 targets |
| --- | ---: | ---: |
| tropical (A) | 64 | 37 |
| arid (B) | 55 | 34 |
| temperate (C) | 287 | 45 |
| continental (D) | 69 | 12 |

Two consequences. First, training regions are chosen by donor tier, not by convenience: the tropical and arid groups carry most of the product need and the fewest covered cities, so the benchmark must gain a tropical and an arid city early. Second, evaluation is tiered the same way: within-country transfer (easy), same-class cross-country (medium), cross-group (hard). A learning curve that rises within a country but not across climate groups is a real finding, not a failure.

Reserved refinements, not yet sourced: legal/survey tradition per country (JuriGlobe families, Torrens versus deeds, colonial survey lineage) and soil group (WRB). The manifest keeps `practice_region.legal_tradition` for this.

## What is frozen: `manifests/zagreb-v1.json`

Frozen 2026-10-12 from the spike's expanded dataset manifest (SHA-256 recorded in the file). City of Zagreb CDOF 2022 imagery, current cadastral geometry from `public.parcel`, EPSG:3765, 153.6 m tiles.

| Part | Tiles | Parcel instances | Use |
| --- | ---: | ---: | --- |
| selection | 16 (4 blocks × 4 density strata) | 544 | checkpoint, threshold and cleanup selection |
| final | 16 (4 blocks × 4 density strata) | 570 | scored once per milestone, recorded in the ledger |
| training pool | 96 | 3,121 | the only tiles training may use |
| exhausted | 50 | — | the spike's smoke and pilot tiles; diagnostic only |

Blocks are at least 500 m from each other and from the exhausted tiles; no parcel source id crosses a split. Strata are parcel counts per tile: low < 12, medium 12–25, high 25–45, dense ≥ 45.

Known weakness, kept on purpose: at 153.6 m, 359 of the 570 final references touch a tile edge. The scorer flags them `clipped` and reports the interior subset separately; clipped parcels stay in the counts so recall is never inflated by dropping them. Cities added later use tiles of at least 300 m.

Freezing is reproducible: `freeze_manifest.py --run --koppen-class Cfa` (Zagreb samples as Cfa in Beck 2023). It refuses to overwrite an existing manifest without `--force`; a benchmark that moves is not a benchmark, and a new version gets a new name.

## Metrics: `score.py`

Vector-based (shapely), tile CRS in metres, deterministic: features are sorted geometrically before anything is computed, so feature order and float summation order cannot change a result. Parameters are recorded in every output and `pool` refuses to mix them.

| Metric | Definition |
| --- | --- |
| `precision`, `recall`, `parcel_f1` | one-to-one assignment maximising IoU (Hungarian); a pair counts at IoU ≥ 0.5; F1 = 2·matched / (predictions + references) |
| `area_weighted_recall` | area of matched references / area of all references (clipped to the tile) |
| `area_weighted_precision` | area of matched predictions / area of all predictions |
| `interior_recall`, `interior_area_weighted_recall` | the same on references that do not touch the tile edge |
| `boundary_precision`, `boundary_recall`, `boundary_f1` | dissolved polygon boundaries with the 1 m tile-edge band removed; a line counts when within 2 m of the other side |
| `coverage_of_reference` | predicted union ∩ reference union / reference union |
| `overlap_fraction` | predicted area counted twice / tile area (a usable fabric has 0) |
| `visibility_<class>_recall` | recall per reference `visibility` property (strong, partial, weak, uncertain) when present |
| `buildings_intact_fraction`, `buildings_split_fraction` | with footprints: ≥ 90% of a building in one prediction; ≥ 10% in two or more |

Headline quartet: `parcel_f1`, `area_weighted_recall`, `boundary_f1`, `precision`. Selection rule: `parcel_f1` on the selection split, ties by `area_weighted_recall`. Pooling is micro (counts summed, ratios recomputed), overall and per density stratum.

## Baseline rows

The rules baseline is the spike's OSM building-distance partition (`../guess-spike/guess.py`, no imagery, no model), one region per building seed, regenerated on the frozen tiles by `osm_baseline.py` and vectorised. It produced the same 304 predictions on the final split that the spike counted with its raster scorer; the vector scorer matched 77 of them where the raster scorer matched 85, so the two scorers agree to within the IoU-threshold edge.

| Split | Refs | Preds | Matched | Parcel F1 | Precision | Recall | Area-w. recall | Interior recall | Boundary F1 | Coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| selection | 544 | 209 | 49 | 0.130 | 0.234 | 0.090 | 0.119 | 0.132 | 0.335 | 0.821 |
| final | 570 | 304 | 77 | 0.176 | 0.253 | 0.135 | 0.124 | 0.194 | 0.430 | 0.811 |

Final split by stratum: low F1 0.042, medium 0.202, high 0.202, dense 0.170. The baseline has nothing to say where there are few buildings; that is where imagery evidence must come from. Rows live in `results.jsonl`; `ledger.py show` prints them.

## Running an experiment

1. Train on the GPU box using only `training_pool` tiles (and donor-city pools once they exist).
2. Predict one GeoJSON FeatureCollection of polygons per tile, in the tile CRS, after reconstruction and cleanup.
3. Score every tile: `score.py tile --prediction p.geojson --reference <dataset>/<truth> --bbox …` (or `--input <dataset>/<input.json>`), then `score.py pool *.score.json`.
4. Record it: `ledger.py add --benchmark zagreb-v1 --split selection --method <name> --metrics pooled.json --recipe-files <training script> <config>`.
5. Compare with the baseline rows and with baseline + model. The final split is scored only when the selection result is the best so far and the recipe is frozen.

Learning-curve protocol: same initialisation, same recipe, training sets of roughly 100, 1,000 and 10,000 tiles drawn from at least three practice regions, each scored on every city's selection split. A rising curve justifies scaling; a flat curve on visibly supported parcels is the signal to narrow the product to assisted mapping.

Layered-model protocol: inputs are RGB plus OSM road and building channels (missing layers zeroed at training time so the model tolerates absent OSM); outputs are boundary, distance-to-boundary and interior maps; reconstruction seeds from buildings and OSM barriers exactly as the baseline does and only adds predicted boundaries where their probability clears a threshold chosen on the selection split.

## Growing the benchmark

Adding a city: open cadastre with a stable id and a known snapshot date; imagery whose terms allow training use, with a known acquisition date within a year or two of the cadastre; a metric CRS; tiles of at least 300 m; four density strata; blocks separated by at least 500 m; source ids disjoint across splits; a `practice_region` block (country, Köppen class, legal tradition). The exporter from the spike (`prepare_sam3_expanded.py`) already does the Zagreb half of this; a second city needs an imagery adapter and the same screens.

Candidate order, by practice-region value and data availability (candidates, not decisions):

1. A second Croatian city (Split or Osijek): same country as Zagreb, same DKP source, state DOF imagery; the within-country transfer test.
2. A European donor with fully open imagery and cadastre: France (IGN BD ORTHO + Etalab PCI), Spain (PNOA + Catastro INSPIRE) or the Netherlands; a same-class, cross-country test.
3. A tropical or arid donor, because that is where 71 of the 128 uncovered top-200 targets sit and where covered cities are fewest: South Africa (erven), Rwanda (21 region-wide districts), Bogotá, São Paulo or an Indian state map. Imagery rights are the gate; open high-resolution imagery is rare outside Europe, North America and Australia.

## Layered model v0: `layered/`

The first learned model built to the principles above. It never replaces the rules baseline; it feeds it.

- **Inputs:** RGB tile plus three OSM channels (buildings, roads buffered by width, water) rendered by the same
  `guess.py` helpers the baseline uses. OSM channels are zeroed at random during training (`--osm-dropout`) so
  the model tolerates cities without OSM. Training tiles get their OSM through sidecar files written by
  `layered/export_osm_inputs.py` (read-only query against the local geodata database), which leaves the
  dataset manifest and the frozen benchmark hash untouched.
- **Targets** (`layered/targets.py`): parcel boundary (tile-edge band cleared, as in the scorer), parcel interior,
  and distance-to-boundary clipped at 12 m. **Model** (`layered/model.py`): a pretrained timm encoder with a
  light U-Net decoder; `convnext_tiny` by default, any timm encoder works.
- **Reconstruction** (`layered/reconstruct.py`): the baseline's OSM seeds and road/water barriers, with the
  predicted boundary probability as the crossing cost in the same shortest-path partition, optional extra seeds
  from predicted interiors that hold no building (empty lots), optional hard barrier above a threshold.
  Threshold and options are chosen on the selection split only.
- **Training** (`layered/train.py`): AdamW, cosine schedule, mixed precision on CUDA, flips and rotations,
  checkpoint every epoch, `--resume`, a step journal, selection by parcel F1 through `score.py`, the final split
  only through `--evaluate-only --split final`. `--smoke` runs the whole path on two tiles on a CPU in seconds.

```sh
PY=../zagreb-parkiralista/pipeline/.venv/bin/python; B=world-parcels/parcel-bench
DS=$B/../guess-spike/output/parcel-expanded-check/dataset
$PY $B/layered/export_osm_inputs.py --dataset $DS --split train --run     # once per dataset
$PY $B/layered/train.py --smoke --no-pretrained --dataset $DS --output /tmp/smoke --run
# on the GPU box (after gpu/sync.sh push and gpu/bootstrap.sh):
#   gpu/job.sh start v0 .venv/bin/python world-parcels/parcel-bench/layered/train.py --run \
#     --dataset data/dataset --output runs/v0-convnext_tiny --epochs 30 --eval-every 2 --workers 6 --eval-workers 8
#   gpu/job.sh log v0 30
#   .venv/bin/python world-parcels/parcel-bench/layered/train.py --evaluate-only --split final \
#     --dataset data/dataset --output runs/v0-convnext_tiny --run       # once, at a milestone
# back on the laptop: gpu/sync.sh pull <ssh-url> v0-convnext_tiny, then ledger.py add with the printed command
```

## Compute

Training runs on a rented GPU box; the laptop is for scoring, tests and docs. `gpu/` holds a provider-agnostic kit, written on macOS and not yet exercised on a CUDA host:

- `gpu/bootstrap.sh`: venv, requirements, GPU check (exits non-zero if PyTorch sees no CUDA device).
- `gpu/job.sh`: start, status, log, stop for jobs that outlive the SSH session (the Linux stand-in for the laptop's `run-job`).
- `gpu/requirements.txt`: the stack the spike used, with CUDA wheels from PyPI on Linux.

`gpu/sync.sh push <ssh-url>` sends this directory, `../guess-spike/*.py` (the exporter and baseline), and the training subset of the exported dataset (about 55 MB for Zagreb; the 13 GB of feature caches and SAM 3 adapters on the laptop are not needed for the new direction). What to bring back: `results.json`, per-tile GeoJSON predictions and the pooled scores; weights stay on the box or in object storage. Guardrails: checkpoint every few updates, resume on restart, `job.sh status` before leaving, and stop the instance when nothing is running.

## Commands

```sh
PY=../zagreb-parkiralista/pipeline/.venv/bin/python   # the laptop ML environment (shapely, rasterio, scipy)
B=world-parcels/parcel-bench
$PY -m unittest discover -s $B -p 'test_*.py'
$PY $B/freeze_manifest.py --koppen-class Cfa            # dry run; --run writes, --force overwrites
$PY $B/osm_baseline.py --dataset $B/../guess-spike/output/parcel-expanded-check/dataset --split final --run
$PY $B/score.py tile --prediction p.geojson --reference truth.json --input input.json --output p.score.json
$PY $B/score.py pool runs/x/*.score.json --output runs/x/pooled.json
$PY $B/ledger.py add --benchmark zagreb-v1 --split selection --method x --metrics runs/x/pooled.json --recipe-files train.py
$PY $B/ledger.py show
$PY $B/practice_regions.py --koppen koppen/1991_2020/koppen_geiger_0p1.tif --legend koppen/legend.txt --run
```

The Köppen raster: `koppen_geiger_tif.zip` (131 MB) from the figshare record above; only `1991_2020/koppen_geiger_0p1.tif` and `legend.txt` are needed. Generated predictions and scores go under the ignored `output/`.

## Status

Done 2026-10-12: scorer with 19 behavioural tests, ledger, Zagreb manifest frozen, rules baseline recorded on both splits, practice-region donors computed for all researched cities, GPU kit written, layered model v0 built with OSM sidecars for all 96 training tiles and an end-to-end CPU smoke test (train, resume, evaluate-only).

v0 milestone (2026-10-12, RTX 4090 on Vast.ai, 30 epochs in about two minutes): selection parcel F1 0.196 versus the baseline's 0.130; final split, scored once, parcel F1 0.253 versus 0.176, precision 0.290 versus 0.253, recall 0.225 versus 0.135, area-weighted recall 0.227 versus 0.124, boundary F1 0.458 versus 0.430. A 200-epoch run of the same recipe did not beat it on selection (0.189), so training length is not the lever; data is. Rows are in `results.jsonl`.

Next: the learning curve (same recipe, more tiles from more regions) and the second Croatian city.
