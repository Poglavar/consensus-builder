# Boundary preservation diagnostic — 2026-10-19

<!-- Outcome and reproduction record for the frozen marker/surface comparison and target imagery packet. -->

**Compact interior markers fix two of the six sampled joins, both in seed 1; they do not solve the
remaining misses.** Boundary-guided flooding alone trades one fixed join for one new join. Every
candidate introduces at least one ambiguous anchor assignment under the frozen scorer, so none is
promoted. No new training, model inference, rental or application change was made.

This is nine previously inspected Croatian development images, 27 separation probes and nine
same-surface checks, repeated across three saved model seeds. The 81 separation evaluations are
**not 81 independent images**. All annotations remain agent-draft. Results do not establish target
village accuracy, boundary-length recall or cadastral correctness.

## Fixed comparison

The [prospective plan](../plans/visible-boundary-v1.json), code, inputs and dependency versions were
hashed before the first candidate run: 86 files, fingerprint
`8061f428e24a44bd99de4512086ec790da1f161f959fd06ca9b5960468941dab`.
The [tracked evidence receipt](visible-boundary-v1.json) includes the freeze, all tile results,
artifact hashes, per-seed summaries and every paired change. Full artifacts are in
`output/visible-boundary-v1/`.

All four arms use the same saved probability maps, selected per-seed threshold, OSM building
markers and road/water barriers. Probability maps are reduced from 512 to 256 pixels with area
resampling; cell spacing is 0.6 m. Small-region merging stays disabled. Final geometry uses the
unchanged exact-cell constructor; there is no smoothing or geometry repair.

- **Native markers:** existing learned-interior component admission, exactly reproduced.
- **Core markers:** erode the eligible free-interior mask twice with a four-neighbour cross, then
  admit its four-connected components with the existing 40 m² minimum and two-pixel building
  exclusion. Original building marker pixels and identities remain fixed. Erased/rejected cores
  get no replacement marker.
- **Distance surface:** watershed on `1 − distance_probability`.
- **Boundary surface:** watershed on the raw boundary probability; no extra hard barrier.

Erosion happens **before component admission**. It can break a thin connection or move a component
away from the building-exclusion band, making previously rejected areas eligible. Thus “core” is a
complete marker recipe, not simply a smaller copy of every native marker. Across these tiles it
actually increases admitted marker pixels from 462,761 to 522,580 and interior markers from 297 to
445. The experiment isolates this recipe from surface choice; it does not separately attribute its
effect to bridge breaking, image-rim removal or changed building proximity.

## Results

Each arm has 27 valid tile outputs and 81 separation evaluations.

| Marker / flood surface | False joins by seed 1 / 2 / 3 | Total joins | Separated | Ambiguous separation pairs | Same-surface joined / ambiguous | Features |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Native / distance — control | 3 / 1 / 2 | 6 | 75 | 0 | 27 / 0 | 858 |
| Core / distance | 1 / 1 / 2 | 4 | 76 | 1 | 27 / 0 | 1,006 |
| Native / boundary | 3 / 1 / 2 | 6 | 75 | 0 | 26 / 1 | 858 |
| Core / boundary | 1 / 1 / 2 | 4 | 77 | 0 | 26 / 1 | 1,006 |

No pair is uncovered. No uniquely assigned same-surface pair is split, but the one ambiguous
same-surface result remains unresolved. These sparse checks cannot establish absence of excessive
subdivision elsewhere. The ambiguities are exact shared-edge contacts: the anchor lies on two
polygon boundaries, with zero intersection area between those polygons. They are retained as
ambiguous under the original `covers`-based scoring contract; no anchor or tolerance was changed.

All changes relative to native/distance:

| Image / probe / seed | Core / distance | Native / boundary | Core / boundary |
| --- | --- | --- | --- |
| `tile_3022_33074` S3 / 1 | joined → separated | joined → separated | joined → separated |
| `tile_3238_31368` S1 / 1 | joined → separated | unchanged joined | joined → separated |
| `tile_2620_31790` S1 / 1 | unchanged separated | separated → joined | unchanged separated |
| `tile_2620_31790` S2 / 2 | separated → ambiguous | unchanged separated | unchanged separated |
| `tile_2620_31790` C1 / 2 | unchanged joined | joined → ambiguous | joined → ambiguous |

Every other probe outcome is unchanged. The core recipes' remaining four joins are
`tile_3238_31368` S1 in seed 3 and `tile_2620_31791` S3 in all three seeds.

## Where separation is lost

All nine image/boundary/starting-marker sheets were inspected; all outputs remain available in the
[local gallery](../output/visible-boundary-v1/review/index.html). The following are diagnostic
observations, not new reference labels or a measured physical-boundary recall score.

- At `tile_3238_31368` S1, seed 1 has a visible learned ridge but both anchors originally share
  marker 24 through a connection elsewhere in that component. Core markers put them in different
  components (27 and 31), and both flood surfaces then separate them. Seed 3 has a much weaker
  predicted divider at this crop edge; both anchors still share marker 25 after erosion. A change
  of flood surface cannot split pixels already fixed to that same marker.
- At `tile_3022_33074` S3, one original anchor is unseeded and one belongs to marker 4. Both changing
  marker admission and changing the flood surface can recover separation. This is not the same
  failure as two anchors already sharing a marker.
- At `tile_2620_31791` S3, both anchors are unseeded in both marker recipes for all three model
  seeds. The learned map shows a tree-row response, but every tested reconstruction still assigns
  the two field anchors to one feature. Boundary response somewhere along the connector is not
  enough to ensure two distinct final regions. Marker placement/admission and boundary continuity
  remain unresolved here.

The stored connector maxima/quantiles describe model probabilities along the anchor line. They do
not establish that the predicted ridge follows the actual divider, closes an enclosure, or has
physical support. Likewise, boundary responses around many roofs and roads in the other six images
are visually apparent, but those observations do not quantify complete boundary recall.

## Geometry and secondary costs

All **108 serialized polygon outputs** passed validity, area conservation, overlap and cell-centre
label round-trip verification. All 27 native/distance controls exactly reproduced the previous
no-small-region-merge label arrays, probe results and geometry metrics. All four arms retain the
same covered area: approximately 571,828.68 m² summed across 27 outputs. Each feature is connected
in this particular cohort; feature and connected-component counts are equal.

All 561 supplied rasterized building masks across 27 outputs remain covered by one output feature
in every arm. This checks the retained OSM input masks, not completeness or accuracy of image-visible
buildings, and not the exact continuous source footprint outside its rasterization.

| Marker / surface | Internal shared edges, m | Edges with mean adjacent boundary probability < 0.3, m | Mean boundary probability on shared edges |
| --- | ---: | ---: | ---: |
| Native / distance | 37,284.0 | 978.6 | 0.782 |
| Core / distance | 43,125.6 | 4,465.2 | 0.725 |
| Native / boundary | 41,086.2 | 663.6 | 0.773 |
| Core / boundary | 49,965.6 | 4,756.8 | 0.710 |

These lengths count each internal edge between distinct positive raster labels once, excluding
exterior and unassigned-ground edges. **Low model probability is not proof of an unsupported
physical cut.** Still, the large increase alongside 148 additional features is a concrete review
cost. In particular, core admission often adds regions around an existing building seed, splitting
a previously combined building/yard region. Such finer subdivisions can be acceptable for the
product; they need image review rather than a blanket size-based removal rule.

## Target-region review packet

Five unlabelled 153.6 m × 153.6 m crops have been prepared, each 1024 × 1024 pixels at 0.15 m output
spacing, with 100% valid source-mask coverage. Small COG windows were read; no full-scene TIFF or
model prediction was downloaded/generated. The [manifest](../annotations/target-review-v1.json)
records source metadata, crop extents, dates, resolution, attribution and SHA-256 hashes.

| Source record | Crops | Source GSD | Acquisition window (UTC) | Preview/crop assessment |
| --- | ---: | ---: | --- | --- |
| [Magoanine C, Mozambique](https://api.imagery.hotosm.org/stac/collections/openaerialmap/items/66a799fd6fc2560001637543) | 2 | 0.0449 m | 2024-07-28 to 2024-07-29 | Houses, enclosed yards and partly undeveloped ground |
| [Djonasse, Mozambique](https://api.imagery.hotosm.org/stac/collections/openaerialmap/items/67c56b387cc97654af432cab) | 2 | 0.0898 m | 2024-01-29 | Houses, walled plots and open ground |
| [Baniyataar, Nepal](https://api.imagery.hotosm.org/stac/collections/openaerialmap/items/6a7d3b3b782d06d7d0eb4d8d) | 1 | 0.0222 m | 2026-07-05 to 2026-07-06 | Houses, access roads and cultivated/green strips |

Each official item declares CC BY 4.0; source-specific attribution is retained in the packet.
[OpenAerialMap's licence terms](https://openaerialmap.org/legal/) also specify attribution to Open
Imagery Network contributors. These UAV sources have finer native detail than common satellite
basemaps; the nominal output spacing does not establish satellite-transfer performance.

Open the [local review packet](../output/target-review-v1/review.html) or
[contact sheet](../output/target-review-v1/windows-contact.png). **Human review and annotations are
pending.** Five crops from three records are not five independent settlements; the two Mozambique
records are geographically nearby. No rural-village representativeness or holdout designation is
claimed. A fourth preview from Mangochi was excluded because it showed agricultural ground without
a clear housing cluster. Bangladesh camp records found during scouting were not included as generic
village examples.

## Decision and verification

Keep this as a completed diagnostic. The promising change is the **marker recipe**, but its gains
are confined to one saved model seed and it adds many weakly model-supported edges. Do not adopt a
boundary-only flood switch or promote the combined candidate from this result.

Next, review the new target imagery and freeze image-derived annotations and geographic roles.
For the next reconstruction experiment, address starting regions that bridge a divider and areas
that receive no suitable marker, with explicit boundary-continuity diagnostics. Retain every
regression and ambiguous assignment. Additional human-marked boundary traces are needed to measure
physical boundary recall and unsupported cuts independently of the model's own probabilities.
No further model training is justified by this bounded comparison alone.

Nine targeted **headless unit tests** in `test_boundary_preservation.py` passed. They cover bridge
splitting, erosion without substitute markers, fixed OSM masks, independently controlled flood
surfaces, unseeded anchor semantics, edge/building diagnostics and freeze/resume/input checks. The
first attempted command used an incorrect working-directory prefix and failed to import the test
file; zero tests ran in that attempt. No full unit or browser suite was run or stopped. All 108
study outputs were checked, and all 18 review sheets plus the five-crop contact sheet were rendered.
Routine test/review scripting and catalog lookup used a `gpt-6-luna` worker; the primary agent reviewed
the protocol and outcomes. Rental cost: **$0**; new training/inference runs: **0**.

Reproduce from `world-parcels/parcel-bench` with the project's Python environment:

```sh
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 python -m unittest -v test_boundary_preservation.py
python boundary_preservation_study.py --freeze
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 python boundary_preservation_study.py --run
python boundary_preservation_review.py
python target_review_packet.py --fetch
python target_review_packet.py --render
```

The study refuses a changed freeze, input, code or dependency version. It checkpoints each complete
seed/image job and resumes only when its saved polygon/grid artifact hashes agree. `--fetch` reuses
hashed cached previews and crop images; public-network access is needed only for missing records.
The target packet stays unlabelled and outside any training/evaluation manifest.
