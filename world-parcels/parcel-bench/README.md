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

Adding a city: open cadastre with a stable id and a known snapshot date; imagery whose terms allow training use, with a known acquisition date within a year or two of the cadastre; a metric CRS; tiles of at least 300 m; four density strata; blocks separated by at least 500 m; source ids disjoint across splits; a `practice_region` block (country, Köppen class, legal tradition). The exporter from the spike (`prepare_sam3_expanded.py`) did the Zagreb half of this; `export_city.py` now does it for any Croatian city from a WMS orthophoto and the countrywide parcel table (pre-screen of the tile grid in the database, watermark-free 3×3 block fetches into a tile cache, the pool screens, held-out 2×2 blocks per stratum 500 m apart with disjoint parcel ids, the rest as training pool, a spike-format manifest that `freeze_manifest.py --city <slug>` freezes). Croatian government imagery (City of Zagreb CDOF, the state DOF) is public-sector data free for research use including model training, verified by the project owner on 2026-10-12, so a second Croatian city needs only the imagery adapter, not a rights check.

Candidate order, by practice-region value and data availability (candidates, not decisions):

1. A second Croatian city (Split or Osijek): same country as Zagreb, same DKP source, state DOF imagery; the within-country transfer test.
2. A European donor with fully open imagery and cadastre: France (IGN BD ORTHO + Etalab PCI), Spain (PNOA + Catastro INSPIRE) or the Netherlands; a same-class, cross-country test.
3. A tropical or arid donor, because that is where 71 of the 128 uncovered top-200 targets sit and where covered cities are fewest: South Africa (erven), Rwanda (21 region-wide districts), Bogotá, São Paulo or an Indian state map. Imagery rights are the gate; open high-resolution imagery is rare outside Europe, North America and Australia.

## Training pool v2: `manifests/zagreb-pool-v2.json`

The learning curve needs far more training tiles than the frozen manifest's 96, drawn by one rule rather than by the spike's block design. `export_pool.py` builds them from the same CDOF 2022 tile grid (the parking repo's JPEG tile cache: 3,002 tiles, 1024 px, quality 85, the same pixels as the spike's GeoTIFF export) and the current parcel table, applying the spike's tile screens (5..160 clipped parcels, cadastre coverage ≥ 80%, overlapping parcel area ≤ 5%, no no-data pixels) and the benchmark's separation rules (≥ 500 m from every selection and final tile, no parcel source id shared with them, exhausted spike tiles left out). The frozen 96 training-pool tiles and the 32 held-out tiles are hard-linked from the spike dataset unchanged and hash-verified, so the pool dataset is a superset of the frozen one and `train.py --pool` replaces the training pool without touching the held-out splits. `--train-tiles N --seed S` then draws a seeded nested random subset (the first N of one permutation per seed), which is what a learning curve needs.

Result (2026-10-12): 2,143 tiles with 79,336 clipped parcel instances (25× the frozen pool's 3,121), by stratum low 340 / medium 489 / high 596 / dense 718; the closest pool tile to a held-out tile is 554 m away. Rejected: 432 within 500 m of a held-out tile, 362 by parcel count, 15 sharing a parcel id with a held-out tile, 18 exhausted. The tracked manifest carries every tile's bbox, parcel count, stratum and image/truth hashes; the dataset itself (444 MB) stays in the ignored `output/pool/zagreb-pool-v2/dataset` and the exporter rebuilds it in two minutes from the cache and the database.

Rights: Croatian government imagery (City of Zagreb CDOF, the state DOF) is public-sector data free for research use including model training, verified by the project owner on 2026-10-12; the earlier "redistribution terms unverified" caveat is withdrawn.

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
- **Reconstruction** (`layered/reconstruct.py`): the baseline's OSM seeds and road/water barriers plus extra seeds
  from predicted interiors that hold no building (empty lots). Frozen on 2026-10-12 to a watershed that floods the
  predicted distance-to-boundary map from the seeds and merges regions under 120 m² into their largest neighbour;
  the first recipe's shortest-path partition with the boundary probability as crossing cost, and a hard barrier
  above a threshold, remain selectable. Threshold and options are chosen on the selection split only
  (`layered/recon_study.py` re-runs any finished run's saved probability maps under named variants).
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

Training runs on a rented GPU box; the laptop is for scoring, tests and docs. `gpu/` holds a provider-agnostic kit, exercised on rented CUDA hosts:

- `gpu/bootstrap.sh`: venv, requirements, GPU check (exits non-zero if PyTorch sees no CUDA device).
- `gpu/job.sh`: start, status, log, stop for jobs that outlive the SSH session (the Linux stand-in for the laptop's `run-job`).
- `gpu/requirements.txt`: the stack the spike used, with CUDA wheels from PyPI on Linux.

`gpu/sync.sh push <ssh-url>` sends this directory, `../guess-spike/*.py` (the exporter and baseline), and the selected dataset. Bring back training recipes and results, both best and resume checkpoints, per-tile probability maps and GeoJSON predictions, pooled scores and logs. Verify hashes against a remote file manifest before destroying the rental. Rebuildable caches can be omitted. Guardrails: checkpoint every few updates, resume on restart, check `job.sh status`, and destroy the temporary instance after the completed work is backed up and verified.

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

Pool v2, learning curve and OSM-withheld diagnostics:

```sh
$PY $B/export_pool.py --run                      # laptop: JPEG tile cache + local geodata DB, two minutes, resumable
# on the box, one lane per seed (the tile cache is shared and written atomically):
#   gpu/job.sh start curve-s1 bash world-parcels/parcel-bench/gpu/curve.sh \
#     world-parcels/parcel-bench/manifests/zagreb-pool-v2.json data/dataset runs/curve "96 200 400 800 1600" "1" --workers 3 --eval-workers 4
gpu/sync.sh pull <ssh-url> curve && $PY $B/layered/curve_summary.py --ledger-add   # table + one ledger row per run
$PY $B/layered/train.py --run --evaluate-only --split selection --osm-mode none --dataset $DS --output <run>   # or model-blank
```

Saved-checkpoint imagery sensitivity (nine RGB conditions, both frozen selection sets; no training):

```sh
$PY $B/layered/imagery_study.py \
  --arm source $B/output/runs/round2/zagreb-n1600-s1 $B/output/runs/round2/zagreb-n1600-s2 $B/output/runs/round2/zagreb-n1600-s3 \
  --arm coastal $B/output/runs/split/split-only-s1 \
  --manifest $B/manifests/zagreb-v1.json --manifest $B/manifests/split-v1.json \
  --dataset $B/output/pool/hr-pool-v1/dataset --output $B/output/imagery-study-20261013 \
  --device mps --run
```

The study freezes input, checkpoint and code hashes, verifies completed cases before resuming, and writes
`report.json` / `report.md` with paired geographic-block intervals. Choose a new output directory if the
code or inputs change. `--cases` can restrict conditions; a fresh clean baseline is always included.
The source arm has three checkpoints and the coastal arm one; synthetic perturbations are a sensitivity
diagnosis, not a measurement of real satellite performance. See `PLAN.md` step 11.

## Expanded selection v2

`manifests/zagreb-v2.json` and `manifests/split-v2.json` preserve every v1 selection and final record,
and add eight separated 2×2 selection blocks per city. Each selection set now has 48 tiles in 12 blocks.
Zagreb has three blocks per density bin. Split has one low, three medium, four high and four dense blocks;
the cached eligible area has no additional low-density block. This is a geographically broader selection
set, not a representative city sample.

The added tiles previously belonged to training. Old cadastral checkpoints are invalid on v2. All new
arms start from ImageNet and use the purged pools: 1,623 Zagreb tiles and 395 Split tiles. No training tile
is within 500 m of selection/final or shares their parcel IDs; exhausted diagnostic tiles are excluded.
`layered/exposure.py` records training and selection geometry in checkpoints, including donor ancestry,
and enforces separation during initialization, resume and scoring. Resuming also checks the frozen
manifest, dataset, selected tile IDs, code recipe and training arguments before changing the run record.

The split is reproducible from metadata alone (existing frozen output must match exactly):

```bash
$PY expand_selection.py --parent manifests/zagreb-v1.json \
  --dataset output/pool/hr-pool-v1/dataset/manifest.json --output manifests/zagreb-v2.json \
  --quotas '{"low":2,"medium":2,"high":2,"dense":2}' --run
$PY expand_selection.py --parent manifests/split-v1.json \
  --dataset output/pool/hr-pool-v1/dataset/manifest.json --output manifests/split-v2.json \
  --quotas '{"medium":2,"high":3,"dense":3}' --run
```

`gpu/plans/selection-v2-resolution.json` defines three seeds each for a fresh baseline and resolution
augmentation in both cities. `--resolution-aug-prob 0.5 --resolution-aug-max-gsd 1.0` changes RGB alone;
rotation, flipping, OSM dropout, targets and epoch shuffle are paired by seed. Every checkpoint is chosen
on clean selection, then compared on clean and additionally resampled 0.5 m / 1 m images. Final splits
are reserved for a later milestone. Absolute v1/v2 scores are not a treatment comparison because both
the training pool and selection composition changed.

Completed 2026-10-14: all 12 runs finished 30 epochs, with 48 selection ledger rows. At additional 1 m
resampling, Zagreb F1 improves 0.237 → 0.280 (95% paired block difference +0.024 to +0.062); Split
changes 0.205 → 0.216 (−0.007 to +0.026). Zagreb clean precision falls 0.513 → 0.465, so the
augmentation does not pass the rule for changing the default. Exploratory Zagreb → Split transfer
improves 0.156 → 0.195 (+0.016 to +0.062), which warrants a separate donor comparison. Intervals
condition on three fitted seeds and 12 blocks, without multiple-comparison adjustment. The baseline
remains the default, both final splits are unscored for this round, and the rental is destroyed.
Full guard metrics, seed ranges, validation evidence and spend are in [PLAN.md](PLAN.md#learned-newest-first).

The longer-schedule trial also completed on 2026-10-14 (`gpu/plans/selection-v2-longer.json`): three
fresh 60-epoch Zagreb fits versus those saved 30-epoch baselines, with identical data, seeds, runtime
packages and ImageNet weights. Clean F1 changes 0.293 → 0.297, difference +0.004 (95% paired block
interval −0.006 to +0.012), below the seed spread. Clean Split transfer changes 0.156 → 0.159
(−0.008 to +0.017). Additional 1 m resampling lowers mean F1 0.237 → 0.221 (−0.025 to −0.003),
largely because of seed 2. These intervals condition on three fitted seeds and 12 blocks, without
multiple-comparison adjustment. The 60-epoch runs selected epochs 18/24/30; none found a new best
after epoch 30. Keep the 30-epoch default. This compared complete cosine schedules with different
numbers of checkpoint evaluations; it did not extend the saved weights. Twelve selection rows were
added, all six checkpoints and the full backup were verified, and the rental was destroyed. Final
splits remain reserved. Scores and curves are in `output/runs/selection-v2-longer-comparison.json` and
`output/runs/selection-v2-longer-learning-curves.png`; the full evidence is in `PLAN.md`.

## Status

Done 2026-10-12: scorer with 19 behavioural tests, ledger, Zagreb manifest frozen, rules baseline recorded on both splits, practice-region donors computed for all researched cities, GPU kit written, layered model v0 built with OSM sidecars for all 96 training tiles and an end-to-end CPU smoke test (train, resume, evaluate-only).

Milestone 1 (2026-10-12, RTX 4090 on Vast.ai, 30 epochs in about two minutes): selection parcel F1 0.196 versus the baseline's 0.130; final split, scored once, parcel F1 0.253 versus 0.176, precision 0.290 versus 0.253, recall 0.225 versus 0.135, area-weighted recall 0.227 versus 0.124, boundary F1 0.458 versus 0.430. A 200-epoch run of the same recipe did not beat it on selection (0.189), so that schedule was not retained. Rows are in `results.jsonl`.

OSM dependence of the v0 checkpoint (2026-10-12, selection split, ledger rows `…-osm-model-blank` and `…-osm-none`): with the model's OSM input channels zeroed the result is unchanged (parcel F1 0.196, area-weighted recall 0.239 versus 0.234), so the model reads the imagery, not the OSM layers. With no OSM at all (no building seeds, no road or water barriers, predicted interiors as the only seeds) it reaches parcel F1 0.120, precision 0.266, area-weighted recall 0.221 and boundary F1 0.301, against the OSM rules baseline's 0.130 / 0.234 / 0.119 / 0.335, which cannot run at all without OSM buildings. For a city without OSM footprints the learned model alone is already about the baseline with twice its area-weighted recall; recall of small parcels (0.077) is what it loses.

Learning curve (2026-10-12): `gpu/curve.sh` runs the v0 recipe unchanged (convnext_tiny, 512 px, 30 epochs, selection eval every 2 epochs, checkpoint chosen by selection parcel F1) on seeded nested random subsets of pool v2 of 96, 200, 400, 800 and 1,600 tiles, three seeds each (the seed sets both the subset and the initialisation), three lanes in parallel on one RTX 4090 at about 42 tiles/s per lane. Every run gets a ledger row (`layered/curve_summary.py --ledger-add`, method `layered-v0-convnext_tiny-30ep-n<N>`); the summary table is `output/runs/curve/curve.md`. Results (selection split, 16 tiles, 544 references; mean over three seeds, min–max in brackets; about 85 minutes of one RTX 4090 for all fifteen runs):

| Training tiles | Seeds | Parcel F1 mean (min–max) | Precision | Recall | Area-weighted recall | Boundary F1 | Best epochs |
|---:|---:|---|---:|---:|---:|---:|---|
| 96 | 3 | 0.196 (0.187–0.207) | 0.238 | 0.166 | 0.218 | 0.384 | 18, 26, 26 |
| 200 | 3 | 0.210 (0.206–0.213) | 0.257 | 0.177 | 0.257 | 0.397 | 22, 16, 10 |
| 400 | 3 | 0.210 (0.203–0.222) | 0.245 | 0.183 | 0.230 | 0.411 | 18, 22, 4 |
| 800 | 3 | 0.209 (0.200–0.222) | 0.246 | 0.181 | 0.224 | 0.427 | 24, 20, 28 |
| 1600 | 3 | 0.224 (0.219–0.231) | 0.267 | 0.192 | 0.240 | 0.440 | 26, 20, 22 |

The curve rises, but slowly: 16× the data lifts parcel F1 by 0.03 (0.196 → 0.224) with a flat stretch from 200 to 800 tiles, while boundary F1 rises at every doubling (0.384 → 0.440) and recall with it. The pixel model keeps learning from more Zagreb tiles while the instance metric lags. Reconstruction and image support were candidate explanations; the reconstruction study below subsequently measured an improvement. The completed visibility audit describes support in this imagery but cannot establish a recoverability ceiling. Seed spread is about 0.02 on this split, so single runs cannot be compared: the first milestone's 0.196 sits inside the 96-tile spread.

Milestone 2 (2026-10-12, final split scored once, for the best selection run only: 1,600 tiles, seed 2, recipe ca0f60e2): parcel F1 0.302 versus 0.253 (milestone 1) and 0.176 (baseline); precision 0.331, recall 0.277, area-weighted recall 0.344 versus 0.227, interior recall 0.403 versus 0.299, boundary F1 0.523 versus 0.458; 478 predictions for 570 references. Weights in the ignored `output/runs/curve/n1600-s2/best.pt`.

Reconstruction study (2026-10-12, `layered/recon_study.py` on the saved selection probability maps of the 1,600-tile seed-2 run, 50 named variants in three rounds, selection split only): the shortest-path partition was the bottleneck. Flooding the predicted distance map with a watershed from the same seeds lifts parcel F1 from 0.231 to 0.274; merging regions under 120 m² into their largest neighbour adds precision for 0.294 (precision 0.382, recall 0.239, area-weighted recall 0.355, interior recall 0.332). Thresholds, crossing-cost weights, a 512 px grid and seed-area rules moved the partition by at most 0.02; hard barriers halve the score; without interior seeds recall collapses (0.131). Re-scoring every curve run's saved maps shows the gain is systematic and makes the curve monotonic:

| Training tiles | Partition (old recipe) mean | Watershed (frozen) mean (min–max) | Watershed area-weighted recall mean |
|---:|---:|---|---:|
| 96 | 0.196 | 0.222 (0.209–0.244) | 0.240 |
| 200 | 0.210 | 0.237 (0.229–0.249) | 0.289 |
| 400 | 0.202 | 0.245 (0.235–0.256) | 0.276 |
| 800 | 0.209 | 0.266 (0.255–0.281) | 0.320 |
| 1600 | 0.224 | 0.283 (0.265–0.294) | 0.339 |

Milestone 3 (2026-10-12, same weights as milestone 2, reconstruction frozen to the watershed before one final scoring, recipe a87fb45b): final parcel F1 0.347 versus 0.302 (milestone 2), 0.253 (milestone 1) and 0.176 (baseline); precision 0.410, recall 0.302, area-weighted recall 0.361, interior recall 0.436, boundary F1 0.587; 420 predictions for 570 references. Run dir `output/runs/n1600-s2-watershed` (weights hard-linked from the curve run).

Resolution control (2026-10-12, selection split, ledger row `…-n1600-watershed-gsd0.5`): the same weights and recipe with the Zagreb imagery box-downsampled to 0.5 m and back score parcel F1 0.239 against 0.294, precision 0.334, boundary F1 0.474. The model's own input grid is 0.3 m. This measures sensitivity to additional resampling of these images; it does not isolate how much of another city's performance gap comes from its native resolution, sensor or processing.

Split, `manifests/split-v1.json` (2026-10-12): `export_city.py --city split` pre-screened a 64 × 41-tile core grid (2,624 tiles) in the parcel table, fetched the 1,361 tiles that passed through 348 watermark-free 3×3 block requests to the DGU DOF 2023/24 WMS, and all 1,361 passed the full screens (strata low 95 / medium 184 / high 441 / dense 641; Split is denser than Zagreb). Held out: 8 blocks of 2×2 tiles, one per stratum per split, 500 m apart with disjoint parcel ids (16 selection tiles with 379 references, 16 final with 587); training pool 896 tiles with 45,898 instances. The merged pool `manifests/hr-pool-v1.json` (3,039 tiles, Zagreb 2,143 + Split 896, `merge_datasets.py`) serves joint training against either city's frozen manifest.

Split rows (ledger, benchmark `split-v1`): the OSM rules baseline reaches parcel F1 0.038 on selection and 0.029 on final with 97 predictions for 379 and 587 references; OSM building footprints are sparse in Split (coverage 0.57 and 0.67). The milestone-3 Zagreb weights and recipe, zero-shot, reach selection parcel F1 0.134 (precision 0.243, recall 0.092, area-weighted recall 0.365, boundary F1 0.398, 144 predictions). Area-weighted recall is similar to Zagreb's while many small parcels are missed. Sparse seeds and imagery are candidate explanations; the resolution control cannot causally divide the cross-city gap between them. With no OSM at all (ledger row `…-osm-none`) the same weights fall to 0.053 on Split, establishing the value of those footprints for this checkpoint, without identifying the remaining performance limit.

Within-country transfer (2026-10-12, one seed each, v0 recipe with the watershed, 30 epochs, checkpoint chosen on Split's selection split; about 40 minutes of one RTX 4090):

| Training data | Split selection F1 | Split precision / recall | Split area-weighted recall | Zagreb selection F1 |
|---|---:|---|---:|---:|
| OSM rules baseline (no training) | 0.038 | 0.093 / 0.024 | 0.137 | 0.130 |
| Zagreb 1,600 tiles, zero-shot (milestone 3) | 0.134 | 0.243 / 0.092 | 0.365 | 0.294 |
| Split 896 tiles only | 0.220 | 0.337 / 0.164 | 0.472 | 0.207 |
| Zagreb 2,143 + Split 896 jointly | 0.216 | 0.320 / 0.164 | 0.435 | 0.264 |

Training on the target city's own tiles is what moves Split (0.134 → 0.220); adding 2,143 Zagreb tiles to Split's 896 adds nothing on Split at this seed and costs Zagreb 0.03 against the Zagreb-only model, while a Split-only model transfers to Zagreb at 0.207, about the same loss as the other direction. So within one country and legal tradition, the model still learns the local fabric (parcel sizes, building density, 0.5 m imagery) more than a shared delineation practice, at least at this data scale and with a shared recipe. Split milestone 1 (final split, scored once for the Split-only run): parcel F1 0.139, precision 0.259, recall 0.095, area-weighted recall 0.195, boundary F1 0.419, against the baseline's 0.029; Split's final blocks are denser than its selection blocks (mean 11 / 22 / 39 / 76 parcels per tile against 5 / 15 / 28 / 47), which is why both numbers sit below selection. Run dirs `output/runs/split/{split-only-s1,joint-s1}`, ledger benchmark `split-v1`.

Round 2 (2026-10-13, 36 runs on one RTX 4090 through `gpu/queue_runner.py` and `gpu/plans/round2.json`, three seeds per arm, recipe a7936b17, paired tile-bootstrap intervals from `bootstrap.py`). On Split's selection split: Zagreb model zero-shot 0.122; Split-only 0.197 with 50 tiles, 0.210 with 896; fine-tuning the Zagreb model instead of ImageNet weights changes the mean by at most 0.004, without a resolved gain; joint Zagreb + Split 0.214. Fifty target tiles buy +0.075 (interval +0.023 to +0.115); the next 846 buy +0.013 (−0.030 to +0.044). That comparison does not resolve a gain from additional labels with this recipe; it does not rule one out. On Zagreb's selection split joint training costs 0.035 (interval 0.010 to 0.065) against Zagreb-only 0.287. The tested per-city reconstruction changes did not clear the improvement bar (61 variants, three seeds). Both selection sets have only four geographic blocks, so tile-bootstrap intervals understate geographic uncertainty. Ledger methods `layered-v0-convnext_tiny-30ep-r2-*`.

The visibility audit is complete (`visibility_audit.py`, 150 sampled selection reference instances per city, all machine-labelled). Strong / partial / weak image support is associated with recall, but the small classes and aggregate edge statistic do not establish an accuracy ceiling or verify individual labels.

Imagery sensitivity (2026-10-13, 72 frozen-checkpoint evaluations, selection only, local MPS inference):

| Model on its own city's selection set | Seeds | Clean F1 | Resample to 0.5 m | Resample to 1 m |
|---|---:|---:|---:|---:|
| Source-city model | 3 | 0.287 | 0.234 | 0.193 |
| Coastal-city model | 1 | 0.220 | 0.197 | 0.167 |

The source model loses 0.053 at 0.5 m (95% paired geographic-block interval −0.088 to −0.002) and
0.094 at 1 m (−0.136 to −0.026). Blur and all tested shifts also hurt both models on their own cities.
Coastal haze and several cross-city changes are unresolved. Only four blocks per city and one coastal
checkpoint limit generalization; intervals average fixed seeds and are unadjusted for multiple comparisons.
The study changes RGB alone at model input and cannot measure accuracy on a different sensor or imagery
provider. Full metrics, per-block differences and hashes: `output/imagery-study-20261013/`; ledger methods
`layered-imagery-*`. No final split was scored.

The bounded reconstruction diagnostic (`plans/reconstruction-v3.json`, completed 2026-10-15) verified
816 tile units against frozen inputs. Rim 1 plus the original source-only configuration chooser passes
the Split own-city development gate: F1 0.2268 → 0.2607, change +0.0340 with a 95% paired block interval
of +0.0157 to +0.0533. Its Zagreb-to-Split gain fails the precision guard, and Zagreb's own-city result
fails both the F1 interval and precision guards, so this remains a Split specialization. Exact-map,
marker/surface and no-merge probes are diagnostic only. Full per-seed, clipped/interior, density and
association results: `output/reconstruction-study-20261015/report.json`.

The three fresh margin-0 fits are also complete (`gpu/plans/selection-v3-margin.json`). Split transfer
F1 improves 0.1561 → 0.1928, a change of +0.0367 with a 95% paired block interval of +0.0167 to
+0.0667, but fails the precision guard (−0.0330, interval −0.0842 to +0.0304). Margin 2 remains the
default. Every journal, selected checkpoint/configuration, saved map and actual target-cache proof
was verified; no final split was scored. Full results: `output/runs/selection-v3-margin-comparison/`.

The six fresh matched-donor fits are complete under
`gpu/plans/selection-v3-donors.json`, with common margin 2 and rim 0. Audited Zadar and Zagreb pools
each contain 632 tiles and 27,344 parcel instances, matched exactly by tile parcel count. Source-city
selection stayed separate from the paired Split development comparison. Nearby Zadar averages F1
0.1958 versus 0.2064 for the matched Zagreb donor: change −0.0106, 95% paired block interval
[−0.0247, +0.0074]. Precision falls by 0.0517 [−0.0684, −0.0304], and the interior-recall and seed
robustness checks also fail. Retain the existing donor policy. The F1 difference remains unresolved;
this result does not establish a general effect of climate or proximity. The twelve new selection rows
and `output/runs/selection-v3-donors-comparison/` preserve the full comparison. All 1,795 donor output
files passed byte-for-byte verification, and the GPU rental was deleted after backup. Šibenik's 48
untouched final tiles remain unscored because the development policy failed advancement.

The living plan is `PLAN.md`, including actual spend and the recovery-related rental-time overrun.
Colour augmentation, target fine-tuning and larger encoders remain deferred.
Broader selection, resolution augmentation and the longer-schedule trial are complete; the baseline
default remains unchanged. Real satellite transfer, Ljubljana and a Spanish Csa city remain pending.
