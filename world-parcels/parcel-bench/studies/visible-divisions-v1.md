<!-- Results and reproduction instructions for the first imagery-division diagnostic. -->
# Visible divisions: small-region cleanup is not the cause of the sampled misses

2026-10-19. **Completed offline diagnostic; no model or runtime promotion.** Turning off the
120 m² small-region merge preserved the same annotated divisions as leaving it on. It added
features and coverage but did not resolve the observed false joins. The comparison also exposed
invalid contour polygons; an exact-cell geometry candidate now preserves the region rasters with
valid, non-overlapping polygons. No training, inference or GPU rental was needed ($0 rental cost).

## Frozen evidence and limits

The [image-only annotations](../annotations/visible-divisions-v1.json) contain 27 separation pairs
and nine same-surface checks on nine previously selected Croatian development images. The images
were selected by minimum/median/maximum building-footprint coverage, then annotated before viewing
the compared polygons. These are **agent-draft labels**, not a human-reviewed benchmark. Three
model seeds reuse the same 27 divisions: **81 evaluations are not 81 independent boundaries**.
The sample includes dense neighbourhoods and cannot validate African/Asian village performance.

The [original protocol](../annotations/README.md) was frozen first. Saved model maps and existing
selected configurations were reused unchanged; all **27 control GeoJSON collections exactly
reproduced** their saved production outputs as parsed JSON. No checkpoint or threshold was retuned.
Image, OSM, map, label-raster, source-code and result hashes are retained in the reports. The tracked
[evidence receipt](visible-divisions-v1.json) includes per-output results and the dependency versions.

## Geometry defect and bounded correction

The original contour outputs contained invalid, self-intersecting polygons in **18/27** control
outputs and **23/27** outputs without small-region merging. Strict scoring rejected the entire
invalid output. Only four seed/image pairs were valid in both variants; their 12 separation probes
had one joined pair under either setting. The other 69 probe evaluations per variant remained
excluded, not credited as correct. This incomplete comparison cannot decide the treatment.

The historical `guess.py::vectorize` uses OpenCV contours with independent approximation and small
component/hole filters. `score.py::load_features` repairs invalid shapes with `make_valid` for the
historical cadastral metrics; those measurements do not establish raw output validity.

A [second protocol](../annotations/cell-partition-v1.md) was frozen after that finding and before
scoring the new candidate. [cell_partition.py](../cell_partition.py) unions occupied raster cells
along their shared integer lattice, then transforms to the metric extent. It preserves every
positive cell, including small components, and keeps one output feature per seed label. It performs
no geometric repair or smoothing. This is a new offline geometry contract; the historical
reconstruction/scorer and frozen experiments were left unchanged.

**All 54 candidate outputs passed** polygon validity, zero overlap/outside area within 1e-6 m²,
occupied-area conservation and a complete cell-centre label round trip. Maximum area error was
1.91e-8 m². Boundaries retain staircase detail at the 0.6 m reconstruction grid. The contour filters
are absent in both candidate variants, so their comparison isolates small-region merging.

## Comparison with valid cell polygons

| Measure across nine images × three seeds | 120 m² cleanup | No small-region merge |
| --- | ---: | ---: |
| Valid outputs | 27/27 | 27/27 |
| Annotated division preserved | 75/81 | 75/81 |
| Joined across annotated division | 6/81 | 6/81 |
| Uncovered / ambiguous separation pairs | 0 / 0 | 0 / 0 |
| Same-surface probes split | 0/27 | 0/27 |
| Output feature count, summed across repeated evaluations | 774 | 858 |
| Covered tile area | 89.92% | 90.25% |
| Area of features implicated in observed joins, summed across seeds | 26,242.2 m² | 26,242.2 m² |

False-merge counts by seed were **3, 1 and 2 of 27** in both variants. Every individual probe outcome
was unchanged, not only the pooled count. Removing cleanup added 84 features (+10.9%) and 2,062.44 m²
of covered area across the repeated outputs. The additional regions are not automatically errors;
the nine same-surface probes are too sparse to establish a general fragmentation cost. Feature area
is deduplicated within each tile/output but repeats geography across seeds; it is not misassigned
ownership area. Pair probes do not measure visible-boundary length recall or exhaustive plot accuracy.

The six failures occur on **three distinct field/garden divisions**:

| Image / probe | Seeds with a join | Visual evidence |
| --- | --- | --- |
| `tile_3022_33074` / S3 | 1 | Crop versus exposed construction ground |
| `tile_3238_31368` / S1 | 1, 3 | Pale and dark cultivated beds |
| `tile_2620_31791` / S3 | 1, 2, 3 | Agricultural strips separated by a tree row |

Post-comparison inspection found that all six anchor pairs belong to the same **connected** polygon,
so disconnected-component grouping is not the cause in these cases. In the two cultivated-bed
failures, both anchors already share one learned interior seed before the watershed. The other
failures have at least one anchor outside the initial seed masks. Changing a final size cleanup
cannot supply these missing upstream separations.

## Next bounded work

Use exact-cell geometry for the next offline boundary/seed diagnostic. Investigate why the interior
seeds and watershed join these supported field divisions, while retaining all nine images and
coverage/fragmentation checks. Do not tune only against the three discovered misses or declare
no-small-region merging generally ineffective from this small sample. Before training for the new
product objective, expand to independent target settlements with human-reviewed visible divisions,
ambiguous areas, boundary traces and editing evidence. Runtime integration remains proposed.

## Reproduce and review

From this directory, with the existing scientific Python environment active:

```sh
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 python visible_division_study.py \
  --dataset output/pool/nearby-donor-v1/dataset \
  --runs output/runs/selection-v5-settlement \
  --output output/visible-divisions-v1/comparison
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 python visible_partition_study.py \
  --source output/visible-divisions-v1/comparison \
  --output output/visible-divisions-v1/cell-partition
python visible_division_review.py \
  --dataset output/pool/nearby-donor-v1/dataset \
  --study output/visible-divisions-v1/cell-partition \
  --output output/visible-divisions-v1/review
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 python -m unittest \
  test_visible_divisions.py test_cell_partition.py test_visible_division_study.py
```

The final targeted **headless unit test** run passed 27 tests across the three named files. Earlier
bounded worker runs passed 11, then 12 scorer tests, and 15 cell/summary tests. No full suite or
browser test was run; none was stopped. Tests and routine review were delegated to `gpt-6-luna`
(low reasoning); the primary agent owned geometry decisions, source edits, results and Git.

Nine image review sheets are retained locally. The three with observed failures were inspected:
[crop/construction edge](../output/visible-divisions-v1/review/tile_3022_33074.png),
[cultivated beds](../output/visible-divisions-v1/review/tile_3238_31368.png),
[tree-row division](../output/visible-divisions-v1/review/tile_2620_31791.png).
Each sheet shows raw imagery, both variants and all three seeds. PNGs and full generated polygons
remain in ignored `output/`; the reproducible source, frozen labels and evidence receipt are tracked.
