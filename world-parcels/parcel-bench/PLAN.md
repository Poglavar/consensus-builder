# ParcelBench plan

<!-- The living work plan for parcel recognition from imagery: steps, the loop each step follows, what
counts as success, how we check, ETA and spend. Updated as steps finish and as results change the plan;
README.md stays the design of record and results.jsonl the ledger. -->

Last updated 2026-10-14 (expanded selection frozen; fresh baseline and resolution-augmentation comparison in preparation). Status values: todo · running · done · dropped (with the reason).

## Where we stand (2026-10-13)

| Benchmark | OSM rules baseline | Best model | Best model's split |
|---|---:|---:|---|
| `zagreb-v1` final | 0.176 | 0.347 (milestone 3) | scored once per milestone |
| `split-v1` final | 0.029 | 0.139 (Split milestone 1) | scored once per milestone |
| `split-v1` selection, Zagreb model zero-shot | 0.038 | 0.134 | the "city without cadastre" number |

Parcel F1 counts a parcel as recovered when one prediction overlaps it at IoU ≥ 0.5. The model is the
layered v0 recipe (convnext_tiny encoder, U-Net decoder, RGB + OSM rasters in; boundary, interior and
distance maps out; watershed reconstruction). The method holds up; absolute quality is not yet usable.
Round 2 now has three seeds and paired intervals. The v1 selection sets contain only four geographic
blocks; tile-level intervals understate geographic uncertainty. Each v2 now has 12 blocks (48 tiles),
with the original final sets preserved. Every v2 arm must be refit from ImageNet initialization: the added
selection tiles appeared in prior full-pool training. Those old checkpoints cannot validate v2. The visibility audit describes image
support but does not measure a recoverability ceiling. More data, image quality, training and reconstruction
remain hypotheses to compare; a nonsignificant gain does not identify which one limits performance.

Croatia is the best case for imagery: low-altitude aircraft orthophotos at 0.15–0.5 m. Most of the world has
only satellite imagery (0.3–0.5 m commercial at best, 1–10 m free, haze, off-nadir lean, older dates), so every
claim about uncovered cities is read against satellite-like input (step 11). Sources and licences: `IMAGERY.md`.

## The loop every step follows

1. Change one thing (data, model, targets, reconstruction or augmentation).
2. Train on the rented GPU (never the laptop), three seeds whenever the expected effect is smaller
   than the seed spread (about 0.02 on Zagreb selection).
3. Score on the selection split only; one ledger row per run with recipe hash and seed.
4. Keep the change only if the mean gain exceeds the seed spread and the bootstrap interval, and no
   guard metric (precision, area-weighted recall, boundary F1, per-stratum F1) regresses.
5. After a few kept changes: freeze the recipe, score each final split once, record a milestone.
6. Destroy the GPU instance; update this file (status, what we learned, spend).

Cost basis (measured 2026-10-12, RTX 4090 at about $0.40/h): fifteen curve runs took about 85 minutes
in three lanes, two Split runs about 40 minutes; a 1,600-tile 30-epoch run is about $0.10.

## Steps

| # | Step | Where | Status |
|---|---|---|---|
| 1 | Bootstrap confidence intervals in the scorer | laptop | done 2026-10-13 (`bootstrap.py`) |
| 2 | Transfer table with three seeds | GPU | done 2026-10-13 (round 2) |
| 3 | Split learning curve and Zagreb-donor fine-tune curve | GPU | done 2026-10-13 (round 2) |
| 4 | Per-city reconstruction settings | laptop | done 2026-10-13: no lever |
| 5 | Visibility audit (image support) | laptop + vision model | done 2026-10-13 (machine labels; interpretation corrected) |
| 6 | Zagreb model levers, one at a time | GPU | todo |
| 7 | Milestone 4 on both final splits | GPU or laptop | todo |
| 8 | Ljubljana and a Spanish Csa city | laptop + GPU | todo |
| 9 | Serving check (CPU inference) | laptop | todo |
| 10 | Product decision: show guesses where the score clears a bar | the user | todo |
| 11 | Satellite domain: score and train for satellite-like input | laptop + GPU | (a) done; (b) expanded splits frozen, GPU setup running; (c) real imagery pending |
| 12 | Nearby same-climate donor: a Dalmatian (Csa) city's tiles scored zero-shot and few-shot on Split | laptop + GPU | todo |

**1. Bootstrap confidence intervals.** Resample tiles to give every pooled score a 95% interval and the
minimum detectable effect per benchmark. Success: every comparison in the ledger reads as a difference
with an interval. If Split's selection interval is wider than about ±0.05, enlarge Split's selection
set as `split-v2` before tuning anything on Split. Check: unit test that a known spread produces the
expected interval; re-score existing runs. ETA 2 h, $0.

**2. Transfer table, three seeds.** Split-only and joint at seeds 2 and 3 (seed 1 exists), plus the
Zagreb curve's n1600 seeds 1 and 3 scored zero-shot on Split. Success: the order Split-only > joint >
zero-shot on Split selection holds with separated intervals, or it flips; either way it becomes a
result instead of a single-seed reading. ETA 0.5 GPU-h, about $0.30.

**3. Split curves.** Split-only at 100, 200 and 400 tiles (896 comes from step 2), and the Zagreb
milestone weights fine-tuned on 50, 100, 200, 400 and 896 Split tiles, three seeds each. This is the
few-shot test of the practice-region thesis: how many target-city labels a donor saves. Success: a
measured saving with intervals, e.g. fine-tuned at 200 tiles matching Split-only at 896. ETA about
2 GPU-h, about $1.

**4. Per-city reconstruction.** On saved selection probability maps: threshold and minimum region per
city (Split picked 0.5 where Zagreb picked 0.3), and seed-density-aware seeding for OSM-sparse cities.
Success: at least +0.02 on Split selection with an interval excluding zero and no Zagreb loss. ETA 2 h,
$0.

**5. Visibility audit.** Completed with a vision model as requested by the user: 150 uniformly sampled
selection reference instances per city, including clipped parcels, with strong / partial / weak / uncertain
image support. Compare recall within each class and report the small class denominators. The sample,
machine judgments and aggregate edge signal do not establish an accuracy ceiling or validate individual
labels. Weak support also does not mean zero recoverability at IoU 0.5: context and shape priors can help.
No user labelling or spot-check is required. Actual spend: $0 billed, $7.05 estimated plan-use equivalent.

**6. Zagreb levers, one at a time, three seeds each.** In order: the full 2,143-tile pool with a longer
schedule; scale and colour augmentation (for 0.5 m cities such as Split); flip/rotate test-time
averaging (no training); convnext_small. Success: each kept only by the loop's rule. Failure signal:
three rejections in a row triggers reassessment of data, targets and optimization; it does not prove a data limit. ETA
about 3 GPU-h, about $1.50.

**7. Milestone 4.** Freeze the recipe, score both final splits once. Proposed targets: Zagreb final
≥ 0.38, Split final ≥ 0.20.

**8. Third and fourth cities.** Candidates with open sub-metre imagery and open parcels are listed in
`IMAGERY.md` (France, Netherlands, New Zealand, Spain, Slovenia). Ljubljana (shared Austro-Hungarian cadastral tradition and a climate
like Zagreb's, but another country) and a Spanish Csa city (Catastro + PNOA, Split's climate, another
legal tradition). Training rights checked before any download. Success: a donor × target table, three
seeds, saying whether a same-tradition or a same-climate donor saves more target labels. ETA 0.5–1 day
per exporter, about 2.5 GPU-h, about $1.20.

**9. Serving check.** CPU time per tile for model plus watershed, measured on the laptop. Success: a
city's tiles can be guessed in acceptable time on a server CPU. ETA 30 min, $0.

**10. Product decision.** Whether to show guesses, flagged as estimates, in cities whose held-out score
clears a bar the user sets.

**11. Satellite domain.** (a) Score the frozen benchmarks with the imagery degraded to satellite-like input
(0.5 m and 1 m, blur and haze, a few metres of misregistration) to measure the drop; (b) train with that
degradation as augmentation and keep it only by the loop's rule on both the clean and the degraded
selection splits; (c) score on real satellite imagery where open parcels exist: Satellogic EarthView 1 m
(CC BY 4.0) over a benchmark city, or Google imagery once a written permission is on file (its terms bar
bulk download, caching, tracing and ML training without one; see `IMAGERY.md`). Success: a measured
clean-to-satellite gap and an augmentation that narrows it without costing the clean score. ETA about 1 day,
about 2 GPU-h, about $1.

Step 11(a) uses `layered/imagery_study.py`: clean input, additional 0.5 m / 1 m resampling, Gaussian blur
with sigma 0.3 m, 15% uniform haze, and separate 2 m shifts east / west / north / south. Each case changes
RGB alone at the model input; OSM, weights, selected reconstruction and reference geometry stay fixed.
Selection splits only; a paired geographic-block bootstrap and per-block differences accompany the scores.
Three source-city checkpoints and one coastal-city checkpoint are available locally; their training arms
are reported separately. Reflection at image edges and synthetic haze/blur limit realism; coarser sampling
cannot establish performance on a different sensor, date or provider. This diagnosis is permitted local
analysis; any training remains on rented GPUs. Do not tune on these four blocks and call the same score a
fresh test. Expand geographic selection coverage before the next model-selection round: use blocks and
spatial buffers absent from every compared checkpoint's training data, or refit all arms after freezing
the larger split. Reassigning previously trained tiles would not create new held-out evidence.

The first step 11(b) comparison is frozen in `gpu/plans/selection-v2-resolution.json`: three seeds per
city and arm, all 1,623 eligible Zagreb / 395 Split training tiles, 30 epochs, the existing encoder,
optimizer and reconstruction, and clean selection checkpoint choice every two epochs. The only changed
training setting is a 50% probability of RGB-only box down/up-sampling, with GSD sampled uniformly from
the 0.3 m model input grid to 1.0 m. Rotation, flipping, OSM dropout and targets stay paired by seed.
Compare clean, 0.5 m and 1.0 m inputs with paired 12-block intervals and report seed ranges. These are
synthetic resolution tests; real satellite transfer remains unmeasured. Do not compare v2 absolute
scores with v1 to claim a training gain: both the holdout composition and training pool changed.

**12. Nearby same-climate donor.** The direct test of the practice-region thesis that round 2 could not
make (Zagreb and Split differ in climate as well as distance): export a Dalmatian Csa city 60–120 km from Split
(Šibenik or Zadar; same national parcel table and DGU imagery, so `export_city.py` covers it), train on it, and
score on Split's selection split zero-shot and as a fine-tune donor at 50 tiles. Success: a paired difference
against the Zagreb donor (0.122 zero-shot) whose interval excludes zero supports a benefit from this nearby
same-climate donor on these blocks. Quantify label savings against the target-only learning curve; an
unresolved difference leaves the donor effect uncertain. ETA about
half a day (export) plus 1 GPU-h, about $0.50.

## ETA and spend

| Steps | Wall time | GPU | Spend |
|---|---|---|---|
| 1–4 | about 1 working day | about 2.5 h | about $1.30 |
| 5–7 | about 1 day (plus the labelling hour, if chosen) | about 3 h | $1.50–4.50 |
| 8–9 | 2–3 days | about 2.5 h | about $1.20 |
| Total | 4–5 working days | about 8–11 h with overhead | about $4–7 |

Spend log: 2026-10-12 $1.40; 2026-10-13 round 2 (36 runs, 105 min of queue, about 2.4 h of box) $1.20.
Vast.ai credit after round 2: $7.38. Credit before the v2 run: $7.3517. The first empty rental was terminated after a stalled image pull;
the current RTX 4090 is $0.5333/hour including 60 GB storage. Startup is still in progress after
switching to the provider's own PyTorch 2.13 image. Actual spend will be reconciled after termination.
2026-10-13 imagery sensitivity: 72 fixed-checkpoint evaluations, about 10 minutes of local analysis,
$0 billed; no new training or GPU rental.

## Learned (newest first)

- 2026-10-14, validation expansion: `expand_selection.py` deterministically selects eight additional
  2×2 blocks per city from cached training metadata, with at least 500 m separation and disjoint parcel
  source IDs. The original 16 selection and 16 final records are preserved. Zagreb has three selection
  blocks in each density bin; Split has one low, three medium, four high and four dense blocks because
  no further eligible low-density block exists. This covers more geography but is not a probability
  sample of either city. Training drops from 2,143 to 1,623 Zagreb tiles and 896 to 395 Split tiles;
  the Zagreb purge includes 30 exhausted diagnostic tiles in addition to the 490 spatial/identity removals.
  New checkpoint exposure records include ancestral training and selection geometry; training, resume,
  initialization and scoring reject contamination, missing ancestry on v2, and changed resume recipes.
  Both actual old city checkpoints were verified to fail the v2 check before prediction. No v2 final
  imagery has been scored. New manifests: `manifests/{zagreb,split}-v2.json`.

- 2026-10-13, step 11(a): `layered/imagery_study.py`, nine RGB conditions, 32 unique selection images,
  four checkpoints (three source-city seeds, one coastal-city seed), 72 evaluations / 1,152 tile predictions.
  Results: `output/imagery-study-20261013/report.md`; recipe and artifact hashes are saved alongside it.
  - Source model on its own city: clean F1 0.287; 0.5 m resampling 0.234, change −0.053 (95% paired
    block interval −0.088 to −0.002); 1 m 0.193, change −0.094 (−0.136 to −0.026). Gaussian blur,
    haze and each 2 m shift also reduce the mean. Precision, area recall and boundary F1 fall too.
  - Coastal model on its own city, one available checkpoint: clean 0.220; 0.5 m 0.197, change −0.023
    (−0.061 to −0.004); 1 m 0.167, change −0.054 (−0.063 to −0.033). Blur and shifts reduce recovery;
    haze is unresolved (+0.002, −0.006 to +0.008). Seed variability remains unmeasured for this arm.
  - Cross-city models start lower and show different sensitivity. For example, the source model on the
    coastal city falls only 0.122 → 0.114 at 1 m; apparent gains from several shifts have intervals
    spanning zero. A weak transfer model's small degradation is not evidence of better imagery robustness.
  - The study supports testing augmentation, not claiming it works. These are additional transforms at
    the model input, not new satellite observations. Only four geographic blocks per city; seeds are
    averaged, intervals are conditional on these checkpoints and unadjusted for multiple comparisons.
    Expand genuinely unseen selection geography before the next training comparison. Final splits were
    not scored and no model was promoted.

- 2026-10-13, step 5 (visibility audit, 150 sampled selection references per city, labelled by GPT-6.1 Sol through
  Codex CLI on the ChatGPT plan: $0 billed, $7.05 metered equivalent; `visibility_label.py`). In this sample,
  7–8% of reference instances were labelled as having a fully visible outline; partly visible: Split 59%, Zagreb
  49%; weak support (open ground, canopy, through buildings): Split 33%, Zagreb 42%. The image-edge statistic
  follows the same aggregate ordering: the median photo edge
  on the cadastral line versus beside it is 1.31 / 1.17 / 0.98 for strong / partial / weak (Split) and 1.20 / 1.16 /
  0.98 (Zagreb), weak showing little aggregate edge contrast against nearby offsets. Recall by class, three seeds: Zagreb model on Zagreb strong
  0.50–0.58, partial 0.33–0.36, weak 0.02–0.05; Split model on Split strong 0.27–0.45, partial 0.25–0.26, weak
  0.04–0.06. Correction on continuation: these are machine-labelled image-support classes, not proof of an
  intrinsic recall ceiling. Strong has only 11 / 12 instances; weak has 50 / 63. The edge statistic is
  convergent aggregate evidence, not independent verification of the labels. Conditional recall suggests
  remaining errors even on supported outlines; it does not establish which new model or data source will help.

- 2026-10-13, round 2 (36 runs, three seeds each, recipe a7936b17; tables in
  `output/runs/round2/*curve*.md`, intervals in `output/runs/round2/reports/`), Split selection F1:
  - Zagreb model zero-shot 0.122 (0.104–0.141 over seeds); Split-only with 50 tiles 0.197, 896 tiles 0.210;
    joint Zagreb + Split 0.214. Fifty labelled target tiles close most of the gap (+0.075, interval +0.023 to
    +0.115); 18× more Split tiles add only +0.013 (−0.030 to +0.044). The tested recipe shows no resolved gain
    over that range; the interval also allows a useful positive effect. Resolution (0.5 m), sparse OSM seeds,
    density, visibility and optimization remain candidates (steps 5, 11).
  - Starting from the Zagreb model instead of ImageNet gains nothing at any Split size (50 to 896 tiles:
    −0.001 to +0.004, every interval about ±0.025). A distant same-country donor does not substitute for
    local labels at all; step 12 tests a nearby same-climate one.
  - On Zagreb selection: Zagreb-only 0.287, joint 0.253 (−0.035, interval −0.065 to −0.010), the fine-tuned
    model keeps 0.236, Split-only 0.201. Mixing cities in one model costs the city with more data.
  - Step 4 confirmed on all three Split seeds: the frozen recipe at the per-run threshold wins or ties every
    alternative; the 20 m² seed variant that led by 0.004 on one seed loses on another.

- 2026-10-13: imagery sources vetted (`IMAGERY.md`). All free web basemaps (Google, Esri, Mapbox, Bing, MapTiler,
  HERE) bar bulk download, caching and ML training in their current terms; open national aerial programmes
  (France, Netherlands, Spain, Switzerland, Slovenia, Czechia, NZ, NAIP and others) allow training; the only
  free sub-metre-ish satellite source with an open licence is Satellogic EarthView (1 m, CC BY 4.0, 2022).

- 2026-10-13, step 4: on Split's selection maps (split-only seed 1) the frozen watershed recipe with its per-run
  threshold choice (0.5 for Split, 0.3 for Zagreb) is within 0.004 of the best of 61 per-city variants
  (threshold × small-region merge × seed size); the best (20 m² seeds) is ahead in every replicate but by
  +0.004, far under the +0.02 bar. The threshold the trainer already picks per run is the per-city setting.
- 2026-10-13, step 1: tile-bootstrap intervals (`bootstrap.py`, 2,000 replicates, paired across arms). A single
  arm's selection F1 is uncertain by about ±0.08 (16 tiles); a paired difference by about ±0.04, so arms are
  compared by their paired difference, never by overlapping single intervals. Split, one seed: Split-only
  beats the Zagreb model zero-shot by +0.086 (+0.032 to +0.152); Split-only vs joint is a tie (+0.004,
  −0.039 to +0.042). Zagreb curve, three seeds: n1600 vs n200 +0.014 (−0.008 to +0.029), ahead in 90%.
  Intervals are tile-level only: tiles sit in four 2×2 blocks per split, so they understate uncertainty about
  the whole city; more held-out blocks (a v2 of each benchmark) is the remedy if decisions hinge on it.

- 2026-10-13: plan written from the results through Split milestone 1; see README.md "Status".
