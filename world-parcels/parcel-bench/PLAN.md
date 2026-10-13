# ParcelBench plan

<!-- The living work plan for parcel recognition from imagery: steps, the loop each step follows, what
counts as success, how we check, ETA and spend. Updated as steps finish and as results change the plan;
README.md stays the design of record and results.jsonl the ledger. -->

Last updated 2026-10-13. Status values: todo · running · done · dropped (with the reason).

## Where we stand (2026-10-13)

| Benchmark | OSM rules baseline | Best model | Best model's split |
|---|---:|---:|---|
| `zagreb-v1` final | 0.176 | 0.347 (milestone 3) | scored once per milestone |
| `split-v1` final | 0.029 | 0.139 (Split milestone 1) | scored once per milestone |
| `split-v1` selection, Zagreb model zero-shot | 0.038 | 0.134 | the "city without cadastre" number |

Parcel F1 counts a parcel as recovered when one prediction overlaps it at IoU ≥ 0.5. The model is the
layered v0 recipe (convnext_tiny encoder, U-Net decoder, RGB + OSM rasters in; boundary, interior and
distance maps out; watershed reconstruction). The method holds up; absolute quality is not yet usable.
Weak points: Split conclusions rest on one seed and 16 selection tiles, no confidence intervals yet, and
the ceiling (boundaries invisible from the air) is unknown. The Zagreb curve still rises, so data is
likelier than architecture to be the lever.

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
| 1 | Bootstrap confidence intervals in the scorer | laptop | todo |
| 2 | Transfer table with three seeds | GPU | todo |
| 3 | Split learning curve and Zagreb-donor fine-tune curve | GPU | todo |
| 4 | Per-city reconstruction settings | laptop | todo |
| 5 | Visibility audit (the ceiling) | laptop + labelling | todo |
| 6 | Zagreb model levers, one at a time | GPU | todo |
| 7 | Milestone 4 on both final splits | GPU or laptop | todo |
| 8 | Ljubljana and a Spanish Csa city | laptop + GPU | todo |
| 9 | Serving check (CPU inference) | laptop | todo |
| 10 | Product decision: show guesses where the score clears a bar | the user | todo |

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

**5. Visibility audit.** Label about 150 reference parcels per city: boundary visible, partly visible
or invisible in the imagery. Either the user labels on a small local page (about 1 h, $0) or a vision
model labels in batch with a spot check (about $1–3, cost tested on 10 items first). Success: a
visible-only ceiling, so scores are read against what is achievable, not against 1.0.

**6. Zagreb levers, one at a time, three seeds each.** In order: the full 2,143-tile pool with a longer
schedule; scale and colour augmentation (for 0.5 m cities such as Split); flip/rotate test-time
averaging (no training); convnext_small. Success: each kept only by the loop's rule. Failure signal:
three rejections in a row means the model is data-bound, and budget moves to labels and cities. ETA
about 3 GPU-h, about $1.50.

**7. Milestone 4.** Freeze the recipe, score both final splits once. Proposed targets: Zagreb final
≥ 0.38, Split final ≥ 0.20.

**8. Third and fourth cities.** Ljubljana (shared Austro-Hungarian cadastral tradition and a climate
like Zagreb's, but another country) and a Spanish Csa city (Catastro + PNOA, Split's climate, another
legal tradition). Training rights checked before any download. Success: a donor × target table, three
seeds, saying whether a same-tradition or a same-climate donor saves more target labels. ETA 0.5–1 day
per exporter, about 2.5 GPU-h, about $1.20.

**9. Serving check.** CPU time per tile for model plus watershed, measured on the laptop. Success: a
city's tiles can be guessed in acceptable time on a server CPU. ETA 30 min, $0.

**10. Product decision.** Whether to show guesses, flagged as estimates, in cities whose held-out score
clears a bar the user sets.

## ETA and spend

| Steps | Wall time | GPU | Spend |
|---|---|---|---|
| 1–4 | about 1 working day | about 2.5 h | about $1.30 |
| 5–7 | about 1 day (plus the labelling hour, if chosen) | about 3 h | $1.50–4.50 |
| 8–9 | 2–3 days | about 2.5 h | about $1.20 |
| Total | 4–5 working days | about 8–11 h with overhead | about $4–7 |

Vast.ai credit on 2026-10-13: $8.58 (spent $1.40 on 2026-10-12); top up before step 8.

## Learned (newest first)

- 2026-10-13: plan written from the results through Split milestone 1; see README.md "Status".
