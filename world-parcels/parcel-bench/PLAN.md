# ParcelBench plan

<!-- The living work plan for parcel recognition from imagery: steps, the loop each step follows, what
counts as success, how we check, ETA and spend. Updated as steps finish and as results change the plan;
README.md stays the design of record and results.jsonl the ledger. -->

Last updated 2026-10-19 (plausible imagery-derived plots; missed divisions and false merges take priority over extra subdivisions). Status values: todo · running · done · dropped (with the reason).

## Current product target: plausible plots where cadastre is unavailable

User clarification, 2026-10-19: when UrbanGameTheory loads an arbitrary village, especially in
Africa or Asia, and no usable cadastral source exists, infer plausible plot boundaries from the
imagery and available buildings/roads. Exact recovery of registered cadastral parcels is not the
product requirement. Cadastre was intended to supply examples of boundaries, not force every
visible enclosure to reproduce a registered parcel. This clarification supersedes cadastral parcel
F1 as the sole product objective; it does not relabel or invalidate frozen historical experiments.

Further user clarification: **joining two distinct plots across a missed boundary is much worse
than subdividing one plot into several plausible regions**. Separate vegetable beds, a courtyard
and a house can remain separate selectable plots even when they share an owner or cadastral parcel.
The segmentation need not infer their common ownership or consolidate them into one compound.
Preserving discernible physical/use divisions is the priority; extra subdivisions are a secondary
editing burden. Disjoint subdivision is distinct from overlapping masks that assign the same ground
to several plots, which still require resolution.

Proposed next work, before further model tuning or rental:

1. Annotate discernible physical/use divisions and areas that must remain separated in the imagery.
   Accept finer garden, courtyard, house and field subdivisions within a larger enclosure; an exact
   compound count is not required. Record ambiguous/occluded boundaries and multiple plausible
   subdivisions separately. Freeze annotation rules and matching tolerances before an experiment.
2. Create a small human-reviewed imagery benchmark across independent target settlements,
   prioritizing African/Asian villages and growth edges and retaining Croatian diagnostic controls.
   Label visible divisions, plausible plot groupings and ambiguous/occluded portions separately.
   Review the imagery before showing cadastral overlays, then record agreement/disagreement with
   cadastre. Freeze development/holdout geography, annotation rules, candidate settings and decision
   criteria before comparing results. Target imagery is needed even where parcel servers are absent;
   the current Croatian-only cohort cannot validate this product scenario.
3. Use cadastre as selective auxiliary supervision. Visible, aligned cadastral edges can teach
   boundary evidence; invisible/uncertain cadastral edges should not be compulsory visual targets.
   Verified physical divisions absent from cadastre must not be trained as background merely
   because they are not registered boundaries. Imagery-derived labels are needed to resolve those
   cases. Automated edge agreement can propose weak labels but is not proof of visibility. Existing
   cadastral interior/distance targets also require review, rather than changing only the scorer.
4. Compare the existing learned boundary maps with SAM 3 mask proposals on the same new imagery
   task. SAM's text/visual prompts support testing compounds and land-use regions; its overlapping
   object masks are candidate evidence, not a finished non-overlapping plot partition. The earlier
   cadastral spike does not settle performance on this reframed target. Reuse existing saved maps
   only where the image/crop/recipe are compatible; do not silently apply old cadastral gates to
   choose the new winner. Freeze the actual model/checkpoint, prompts and output handling per trial.
5. Reconstruct a fine-grained, non-overlapping partition with shared edges and larger surrounding
   context. Preserve supported candidate divisions; require evidence before removing a divider to
   join regions. Use roads, tracks, entrances and plausible access as soft contextual evidence, not
   a requirement that every polygon touches a mapped road. Resolve overlaps and crop joins without
   silently erasing a real separation. Explicitly compare removal of the automatic 120 m² merge:
   small regions alone are not an error under this product objective. Building count does not fix
   plot count, and common ownership must not be inferred from a proposed grouping. Leave unresolved
   ground unassigned or explicitly uncertain rather than force a confident join or division.
6. Make false merges across annotated real divisions the primary error, measured on the final
   polygons, alongside recall of visible boundaries. Report how often annotated neighbouring areas
   are joined and the area affected. Boundary-length recall alone is insufficient: a short gap can
   connect two otherwise well-outlined plots. Track excess subdivisions, unsupported edge length,
   building cuts, overlaps, geometric validity, covered area and editing effort as secondary checks.
   Select an operating point that emphasizes preventing false merges while bounding fragmentation;
   freeze any numeric cost weights/thresholds before scoring instead of inventing an error ratio.
   An arbitrary pixel grid must not win through perfect separation. Report abstentions/uncertainty
   and whole-settlement variation. Cadastral overlap remains secondary; retain held-out settlements.

Candidate application output is an inferred, editable plot layer with imagery/model provenance and
boundary support/uncertainty, separate from sourced cadastral records and ownership. This is a
proposed implementation direction; no runtime fallback, new benchmark, model change or training
run has been implemented or evaluated under this product contract yet.

Research supports separating visibility from registration: [CadastreVision](https://doi.org/10.1016/j.isprsjprs.2024.08.005)
explicitly distinguishes visible and non-visible cadastral boundaries. [SAM 3](https://github.com/facebookresearch/sam3)
supports concept and visual prompting and returns instance masks; using those masks as plot proposals
still requires a grouping and reconstruction policy. Neither source establishes performance in our
target villages or makes arbitrary segmentation equivalent to plausible physical plots.

The [CadastreVision repository](https://github.com/jeroengrift/cadastrevision), inspected 2026-10-19,
provides benchmark-preparation and cadastral/topographic overlap-analysis workflows in FME, plus
sample extents and dataset links. Its overlap analysis is directly relevant to identifying which
cadastral lines have physical support. It is a research/data preparation resource, not an already
integrated village plot segmenter. Its README flags unpublished 8 cm imagery and classified-reference
outputs; actual availability must be checked at the linked data release before depending on them.

## Product priority: suburban and village communities

User decision, 2026-10-19: prioritize suburban and village communities, where the user expects most
growth. Dense urban centres are a secondary comparison. The geographic priority is high-growth areas in
Africa and Asia; the user authorized training with the data already available while regional labels
remain sparse. Future sampling, training pools, headline
metrics and advancement decisions must reflect this use case.

The target includes established low-rise suburbs, village and ribbon settlements, and their growth
edges with large or partly undeveloped plots. Settlement type is separate from cadastral parcel
density: a compact village can contain many small parcels, while a low-count tile can contain a
farm, park, industrial site or vacant tract. Land around a community can be relevant to growth;
parcel count alone cannot establish that context.

Next work extends the completed existing-data proxy audit below, before the proposed
confidence-versus-coverage comparison:

1. Audit existing blocks for settlement context using imagery, building pattern and available
   settlement/land-use evidence, recording the classification method and uncertain cases. Report
   independent communities/blocks, parcel counts, plot sizes and clipped/interior references per
   context. Keep parcel-count density as a separate descriptive variable.
2. Where coverage is insufficient, freeze an additional development cohort of independent suburban,
   village and settlement-edge sites before reading model outcomes. Choose sampling and headline
   weights prospectively so dense centres or one large community cannot dominate the target result.
   Check geographic buffers and source IDs against every compared checkpoint's exposure. Previously
   trained tiles require fresh refits; reserved final sets and untouched confirmation cities stay sealed.
3. Run the saved-output precision-versus-coverage analysis on adequately represented target contexts.
   Report suburbs and villages separately, with precision, parcel/area recall, retained prediction
   coverage and whole-community/geographic-block uncertainty. Dense-centre scores are secondary.
   Audit training-pool representation before the next training experiment.

Current evidence is not settlement-stratified: both v2 manifests label parcel count only. Zagreb's
low-count selection group has 12 tiles in three blocks, 114 references and 16 interior references;
Split's has four tiles in one block, 21 references and zero interior references. These groups cannot
be renamed suburbs/villages or used alone to support a target-community claim. The 153.6 m tile
contract also needs review for larger plots: new export geometry must preserve useful image detail
and report clipping explicitly. Any revised contract is a separate frozen cohort/experiment.
The current `export_city.py`/`export_pool.py` code screens out tiles with fewer than five or more
than 160 parcel intersections. Audit that eligibility rule for the new target cohort: it can omit
large-plot settlement edges. Keep imagery, coverage and geographic-separation checks independent
of the parcel-count choice. The frozen Split export does not record its screen-parameter receipt;
the cutoff is established by current/contemporaneous exporter code and corroborating sample counts.

Existing manifests, scores, trial gates and decisions remain historical evidence under their original
protocols. This priority does not retroactively promote a treatment that failed its frozen gate.

## Existing-data settlement pilot (2026-10-19)

Status: **complete; targeted sampling not adopted**. The protocol was frozen before rental under
`gpu/plans/selection-v5-settlement.json` (SHA-256
`7c9c38987b3d3c34a82f78e28bc58d3cfd475836f352b3c7a23df603b83c4e25`; recipe `8d1993998759908e`).
This executes the user's request to train on available data. The local labelled image datasets cover
Croatia, not Africa or Asia. No regional transfer or confirmed-village performance can be inferred.

### Completed comparison and decision

All six fresh fits completed 30 epochs and 5,100 optimizer updates each. On the 46-tile lower-rise
proxy development cohort, targeted sampling reduced mean parcel F1 from **0.2458 to 0.2384**. Its
targeted-minus-uniform difference was **−0.0074**, with a paired whole-block 95% interval of
**−0.0204 to +0.0052**. The interval does not establish a population-level loss, and the treatment
does not meet the prospectively required improvement. All three paired seed changes were negative
(−0.0031, −0.0018, −0.0174); the median was −0.0031 and the mean after dropping the best seed
was −0.0102. All seven advancement checks failed, including the precision and recall guards.
**Keep uniform sampling and raw RGB; no model is promoted to production.**

| Primary macro metric | Uniform, three-seed mean | Targeted, three-seed mean | Targeted − uniform | Paired 95% block interval |
|---|---:|---:|---:|---:|
| Parcel F1 | 0.2458 | 0.2384 | −0.0074 | −0.0204 to +0.0052 |
| Precision | 0.3705 | 0.3531 | −0.0174 | −0.0423 to +0.0055 |
| Parcel recall | 0.1918 | 0.1873 | −0.0045 | −0.0141 to +0.0043 |
| Interior recall | 0.2170 | 0.2063 | −0.0107 | −0.0268 to +0.0067 |
| Area-weighted recall | 0.3117 | 0.3106 | −0.0010 | −0.0270 to +0.0275 |
| Boundary F1, diagnostic | 0.5327 | 0.5250 | −0.0077 | −0.0134 to −0.0014 |

These are region-balanced, then geographic-block-balanced metrics, not pooled parcel counts. The
F1 gate requires a mean gain of at least 0.01, an interval strictly above zero, a positive median
seed gain and a positive mean after dropping the best seed. The lower interval endpoints also
failed the precision (greater than −0.02), interior-recall and area-recall (greater than −0.01)
guards. The bootstrap conditions on the three fitted seeds and reused development cohorts; it
does not quantify training-seed or new-community uncertainty.

| Region, proxy cohort | Uniform macro F1 | Targeted macro F1 | Change |
|---|---:|---:|---:|
| Zagreb | 0.2789 | 0.2779 | −0.0010 |
| Split | 0.2363 | 0.2256 | −0.0107 |
| Zadar | 0.2223 | 0.2117 | −0.0106 |

All six fits also completed their three planned 48-tile full-source selection evaluations using
the proxy-selected checkpoint/configuration. Their raw pooled mean F1 changed Zagreb
0.2716 → 0.2637, Split 0.2306 → 0.2256 and Zadar 0.1791 → 0.1767. These are secondary
comparisons. Every source city occurs in training, so none is a zero-shot transfer result.
No reserved final set or untouched confirmation city was scored.

The sampled journals contain exactly 30,600 training draws per fit. Uniform sampling visited all
2,699 eligible tiles in every seed and assigned 43.48–43.84% of draws to the proxy. Targeted
sampling assigned 74.88–75.08% to the proxy and visited 2,629–2,644 unique tiles, leaving
55–70 eligible candidates undrawn per fit. Candidate exposure remains conservatively all 2,699
tiles for separation checks. Reweighting the existing proxy therefore supplied no demonstrated
gain; this does not establish that better labelled target communities or regional data would fail.

The temporary worker is destroyed and its absence was rechecked. All **3,543 output files
(7,123,132,102 bytes)** passed SHA-256 recovery verification; all twelve best/last checkpoints
passed metadata and finite-weight checks. Observed account debit after the post-closure check
was **$0.5855**, within the $1 cap, with no top-up. The quoted $0.50/hour rate over the
72.31-minute rental window gives a separate $0.6026 estimate. Per-fit allocations range
$0.0682–$0.0892, with $0.1419 allocated to setup/recovery outside active fits; these divide
the quoted shared-worker rate and are not provider invoices. Billing timing and network/storage
charges can differ from that estimate.

Frozen analysis and reproducible provenance are in
`output/runs/selection-v5-settlement-comparison/report.json` and `report.md`; actual sampled
coverage and cost allocations are separate `training-coverage.json` and `cost-allocation.json`
artifacts in that directory. The selection-only ledger adds 24 rows: six primary proxy evaluations
with macro metrics recorded separately from raw counts, plus eighteen full-source evaluations.
The ledger links checkpoint, recipe, plan, comparison, cost and verified-backup hashes.

Validation: **34 targeted headless unit tests across five files passed**, covering features,
sampling, exposure, analysis and GPU preparation. Production-size CUDA preflight passed both
arms' train/resume/evaluate flows (six flows, eight optimizer updates in total). One initial
headless unit-test invocation used the wrong working directory and failed import before loading
tests; its corrected run passed. No full suite or browser suite was run, and no run was stopped.
A `gpt-6-luna` worker at low reasoning independently checked the saved arithmetic and frozen
gate decisions. The next data task is verified suburban/village and growth-edge coverage,
especially Africa/Asia, including sparse and large-plot sites excluded by the current proxy/export.

### Frozen cohort, audit and protocol

The metadata audit uses the eligible IDs in the frozen manifests, rather than stale source-export
split tags: 1,623 Zagreb, 395 Split and 681 Zadar training tiles, 2,699 total. It joins cached OSM
building/road/water geometry with public [DGU RGI settlement boundaries](https://rgi.dgu.hr/geoserver/rgi/wfs).
The three bounded WFS requests succeeded on 2026-10-18 UTC; their original responses and SHA receipts
are retained under `output/settlement-study-20261019/context/`. Administrative names do not establish
village/suburb type. Two bounded OSM place-node requests failed (HTTP 502/500); no type labels were
inferred from those failed requests. The data-source catalogue and WFS capabilities were unavailable
through the browsing tool; successful source feature downloads provide the actual coverage evidence.

The prospectively frozen **lower-rise morphology proxy** requires at least three intersecting OSM
building footprints, union footprint coverage at most 25%, median full footprint area at most 350 m²,
at least 60% clipped footprints at most 250 m², and water coverage at most 10%. It describes footprint
pattern, not measured height, residential use, village status or completeness of OSM. Compact
communities can have many cadastral parcels. Sparse growth edges with fewer buildings are not covered
by this proxy; the original export also screened out tiles with fewer than five parcel intersections.

| Region | Eligible train | Proxy train | Proxy development tiles | Original blocks represented |
|---|---:|---:|---:|---:|
| Zagreb | 1,623 | 733 | 10 | 6 |
| Split | 395 | 193 | 25 | 10 |
| Zadar | 681 | 249 | 11 | 5 |
| Total | 2,699 | 1,175 | 46 | 21 |

The new cohort (`manifests/settlement-v1/`) filters existing selection geography by that rule before
any new model outcomes. Its 2,383 reference intersections include 1,056 interior references. Every
block has interior references, with small denominators reported explicitly. These remain development
sites within the existing communities, not new-community or new-city confirmation. All six fits start
from the pinned ImageNet initialization. The full candidate pool is rechecked against **all** original
selection/final tiles for the 500 m buffer and shared source IDs. Original finals are retained as
reserved metadata; Šibenik remains untouched.

The cohort contains 1,327 clipped references. By region, reference/interior counts are Zagreb
495/206, Split 1,210/555 and Zadar 678/295. Median tile-level median reference intersection areas
are 284.93, 237.71 and 163.54 m² respectively; these are clipped intersections, not full legal
plot sizes. Twenty-nine of the 46 proxy tiles fall in the existing dense parcel-count stratum,
reinforcing that footprint pattern and cadastral density are different variables. The 21 primary
blocks share no reference source IDs with one another.

A qualitative audit after the freeze inspected nine purposive images: minimum, median and maximum
OSM footprint coverage in each region. Housing, gardens and community edges appear alongside
courtyard complexes, possible shed/construction or industrial contexts, and OSM undercoverage.
The contact sheet, sample IDs and observations are retained under the context output directory.
This is not a random validation sample, cannot estimate classification accuracy, and establishes
neither building height nor suburb/village type. No cohort, sampling weight or gate changed after
that inspection.

Each arm uses 30 epochs, 1,020 replacement draws per epoch, batch 6 and 170 optimizer updates per
epoch. The uniform arm gives each eligible tile equal probability. The targeted arm allocates 75% to
the proxy and 25% to other contexts, then equal region mass within context; administrative community
mass is proportional to the square root of its tile count, then uniform within community, with a cap
of five times the uniform tile probability within each context/region and rebalancing of the remaining
mass. This bounds repetition of tiny communities. Both arms retain positive probability for every tile;
actual draw counts and unique coverage are journalled, rather than assuming every candidate was used.
Sampling probabilities are the only treatment factor. Raw RGB, margin-2 targets, architecture,
augmentation, initialization, schedule and reconstruction search stay matched across paired seeds.

Checkpoint/configuration selection uses equal weight per region and per original geographic block
within that region, on proxy tiles only. Raw pooled counts/metrics remain separate. The same macro
score is primary in the comparison, averaged over three fixed fitted seeds. A paired bootstrap samples
whole blocks within each region (2,000 replicates, seed 0), retaining duplicate draws; precision,
interior recall and area recall keep the existing non-inferiority guards. No region, dense centre or
parcel-rich block dominates by having more references. Original 48-tile selection evaluations in all
three regions are secondary and use the proxy-selected checkpoint/configuration. This is conditional
on reused Croatian development geography, not selection-adjusted evidence or uncertainty over new
regions, new communities, imagery sources or training seeds.

Training runs only on the rented CUDA worker. Exact runtime, source, input and pretrained weight
hashes are frozen before rental; two-tile production-size CUDA training/resume/evaluation checks precede
the six fits. Existing credit only, no top-up; cap $1, quoted rate at most $0.50/h, maximum rental 105
minutes, 65-minute main queue timeout and a 100-minute compute-stop guard. Copy completed fits while
later fits run, verify every recovered output hash and checkpoint metadata, then close only this rental.
No final scoring, production promotion, push or deployment is part of the pilot.

## Where we stand (2026-10-19)

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
with the original final sets preserved. All 12 fresh v2 runs are complete: resolution augmentation helps
coarsened Zagreb imagery and Zagreb-to-Split transfer, but lowers clean Zagreb precision. The default
recipe stays unchanged. Three fresh 60-epoch Zagreb fits also failed the retention rule: clean F1 changes
0.293 → 0.297 with an interval crossing zero, while additional 1 m resampling lowers mean F1. No final
split was scored in either comparison. Every v2 arm must be refit from ImageNet initialization: the added
selection tiles appeared in prior full-pool training. Those old checkpoints cannot validate v2. The visibility audit describes image
support but does not measure a recoverability ceiling. More data, image quality, training and reconstruction
remain hypotheses to compare; a nonsignificant gain does not identify which one limits performance.

The isolated RGB trial is complete under `gpu/plans/selection-v4-normalization.json` (SHA-256
`fe834629bdf2f4367ea25c0655dbb1a30241db6a1605e3830b9ea64d68ad1700`). It compared three fresh
30-epoch Zagreb fits using the actual pretrained ConvNeXt RGB mean/std against the immutable raw-RGB
controls. OSM channels, margin-2 targets, initialization, source-only checkpoint/configuration selection,
and schedule stayed matched. Primary evidence is Zagreb-to-Split selection transfer, with the existing
F1 and precision/interior/area-recall guards; Zagreb selection is secondary. Transfer F1 changed
0.1561 → 0.1528 and precision 0.3701 → 0.3338, failing advancement and the precision guard.
Keep raw RGB. All artifacts passed recovery verification, the rental is closed, and observed spend
was about $0.41 against the $1 cap. No final split or untouched city was scored.
`gpu/normalization_preflight.py` verifies the actual 512 px encoder transformation on CUDA;
`layered/normalization_analysis.py` verifies the recovered artifacts and paired block comparison.

Croatia is the best case for imagery: low-altitude aircraft orthophotos at 0.15–0.5 m. Most of the world has
only satellite imagery (0.3–0.5 m commercial at best, 1–10 m free, haze, off-nadir lean, older dates), so every
claim about uncovered cities is read against satellite-like input (step 11). Sources and licences: `IMAGERY.md`.

## The loop every step follows

1. Change one thing (data, model, targets, reconstruction or augmentation).
2. Train on the rented GPU (never the laptop), three seeds whenever the expected effect is smaller
   than the seed spread (about 0.02 on Zagreb selection).
3. Score on the selection split only; one ledger row per run with recipe hash and seed.
4. Apply the prospectively frozen development gate: mean F1 gain ≥ 0.01, paired geographic-block
   interval strictly above zero, positive median seed gain and positive mean after dropping the best
   seed. Precision, interior recall and whole-tile area recall have explicit non-inferiority guards.
   Report boundary and density diagnostics, including small denominators. A fixed-configuration
   correctness change can meet its separate non-inferiority gate without claiming a quality gain.
5. Freeze the complete supported policy before fresh confirmation (F1 gain ≥ 0.02 plus the interval
   and guard checks). Repeated selection scores do not replace fresh evidence. A numbered stage
   finishing does not automatically authorize consuming a final split.
6. Destroy the GPU instance; update this file (status, what we learned, spend).

Cost basis (measured 2026-10-12, RTX 4090 at about $0.40/h): fifteen curve runs took about 85 minutes
in three lanes, two Split runs about 40 minutes; a 1,600-tile 30-epoch run is about $0.10.

## Steps

| # | Step | Where | Status |
|---|---|---|---|
| 1 | Bootstrap confidence intervals in the scorer | laptop | done 2026-10-13 (`bootstrap.py`) |
| 2 | Transfer table with three seeds | GPU | done 2026-10-13 (round 2) |
| 3 | Split learning curve and Zagreb-donor fine-tune curve | GPU | done 2026-10-13 (round 2) |
| 4 | Per-city reconstruction settings and seed connectivity | laptop | bounded saved-map diagnostic complete; Split-specific candidate passes development guards |
| 5 | Visibility audit (image support) | laptop + vision model | done 2026-10-13 (machine labels; interpretation corrected) |
| 6 | Zagreb model levers, one at a time | GPU | 60-epoch, margin-0 and RGB normalization trials done; none adopted |
| 7 | Milestone 4 on both final splits | GPU or laptop | todo |
| 8 | Ljubljana and a Spanish Csa city | laptop + GPU | todo |
| 9 | Serving check (CPU inference) | laptop | todo |
| 10 | Product decision: show guesses where the score clears a bar | the user | todo |
| 11 | Satellite domain: score and train for satellite-like input | laptop + GPU | (a) done; (b) resolution trial done, not adopted; other degradations and (c) real imagery pending |
| 12 | Nearby Dalmatian donor: zero-shot development on Split and untouched-city confirmation | laptop + GPU | zero-shot comparison done; advancement failed; untouched confirmation and target fine-tuning deferred |
| 13 | Suburban/village coverage audit and settlement-focused development cohort | metadata + rented GPU | existing-data audit and six-fit proxy pilot done; targeted sampler not adopted; verified village and Africa/Asia cohorts pending |

### Agreed reconstruction and transfer sequence (2026-10-15)

Four Claude CLI review rounds ratified the protocol in `plans/reconstruction-v3.json` and the archived
review under `output/reviews/claude-consensus-20261015/`. The user authorized execution. The saved
three-seed, 30-epoch ConvNeXt controls, 153.6 m tile contract, all clipped references and geographic
separation remain fixed. The review changes the next experiments from colour/longer tuning to:

1. A CPU-only saved-map diagnostic: a one-pixel seed-connectivity rim on the 256 grid, the original
   six source-only configurations, native-threshold factorial controls, exact-map controls, a full
   learned/truth-marker × learned/exact-surface comparison and one no-merge diagnostic. Freeze all
   code/input hashes first; verify the original control scores and seeds-off negative controls.
   Report 12-block paired intervals, every seed, clipped/interior recall, marker associations,
   split/merge cases and density strata. Truth substitutions are probes, not accuracy ceilings.
2. A fresh three-seed target-margin-zero arm is the presumptive first training treatment. A strong
   marker/surface diagnosis may move one targeted treatment ahead of it. Change one factor, keep
   target metadata and cache identities explicit, and verify the generated targets. RGB normalization
   was tested separately with three fresh fits using the actual pretrained configuration; the
   normalization trial failed advancement on 2026-10-19 (results below).
3. Compare a nearby donor with a nested Zagreb subset under matched recipe, label count and budget,
   with configuration selection on source data only. Zadar is the provisional donor and Šibenik the
   provisional untouched target. Freeze roles after imagery/density/exposure eligibility checks and
   before model scoring. Split is development geography; donor holdouts are not new-city confirmation.
   A city-specific win remains a specialization. Defer target fine-tuning and the conditional DINOv3
   challenger until evidence supports them.

`layered/reconstruction_study.py` owns freezing and resumable per-tile scoring;
`layered/reconstruction_analysis.py` owns source-only choice, block intervals and the declared gates.
The rim affects only free-interior connectivity, never OSM markers, barriers or the flood domain.
No default changes automatically. The prepaid GPU balance was checked at 08:22 UTC: $5.1650,
with no active rental; the diagnostic itself uses no GPU credit.

The diagnostic finished all 816 tile units, verified every native saved-map control and retained all
clipped references. Its source snapshot and 1,805 frozen input/code hashes are preserved under
`output/reconstruction-study-20261015/`; later training changes do not rewrite that evidence.

| Development track | Original F1 | Rim-1 source-chooser F1 | Change and 95% block interval | Decision |
|---|---:|---:|---|---|
| Zagreb → Split | 0.1561 | 0.1825 | +0.0264 [+0.0126, +0.0515] | fails precision guard (change −0.0478, interval −0.0921 to +0.0040) |
| Zagreb own-city | 0.2927 | 0.3111 | +0.0184 [−0.0244, +0.0700] | fails F1 interval and precision guards |
| Split own-city | 0.2268 | 0.2607 | +0.0340 [+0.0157, +0.0533] | all development checks pass; specialization only |

Split's three F1 changes are +0.0364, +0.0352 and +0.0303. The original per-run settings with only
rim 1 fail the Split area-recall guard; the bounded source chooser is part of the passing candidate.
No general default is replaced. On exact target maps, seeds ON plus the rim raises F1 from 0.4355
to 0.6002 in Zagreb and 0.3759 to 0.5155 in Split; seeds OFF is exactly unchanged. These are probes,
not deployment scores. The marker/surface substitutions have large interactions: neither substitution
alone explains the remaining errors. Removing the 120 m² merge does not improve the common learned
configuration's mean F1 in any of the three main tracks. Under identical common reconstruction,
resolution augmentation still improves Zagreb-to-Split F1 by +0.0417 [+0.0126, +0.0678], so the earlier
gain was not solely caused by different selected reconstruction settings. All intervals remain conditional
on these three fits and twelve reused geographic blocks.

The three fresh 30-epoch fits in `gpu/plans/selection-v3-margin.json` are complete. Margin 0 was
the only training treatment; original rim-0 reconstruction and the source-only checkpoint/configuration
chooser stayed fixed, along with data, seeds, runtime and pretrained weights. Each journal contains
8,130 updates and fifteen source-selection evaluations. The actual 512-pixel cache proof retained 182
boundary pixels on the outer rim that margin 2 erased, with identical interior targets and input arrays.
All 900 output files (2.28 GB), including best and last checkpoints, were copied and hash-verified.

| Margin-0 comparison | Control F1 | Margin-0 F1 | Change and 95% block interval | Decision |
|---|---:|---:|---|---|
| Zagreb → Split, primary | 0.1561 | 0.1928 | +0.0367 [+0.0167, +0.0667] | fails precision guard: −0.0330 [−0.0842, +0.0304] |
| Zagreb own-city, secondary | 0.2927 | 0.3140 | +0.0212 [−0.0196, +0.0772] | fails F1 interval and precision guards |

All three primary F1 changes are positive (+0.0648, +0.0089, +0.0363); area-weighted and interior
recall also improve. The complete predeclared gate still fails because precision non-inferiority is
unresolved. Retain margin 2. This is a result for the whole source-selected policy: the margin-0 fits
selected interior seeds ON, whereas the immutable controls selected them OFF. No final split was
scored. The six new selection ledger rows and `output/runs/selection-v3-margin-comparison/report.json`
retain every seed, density stratum, clipped/interior count, source choice and artifact hash.

City roles are frozen in `plans/nearby-donor-v1.json`: Zadar donor (12 development blocks, four
reserved blocks) and Šibenik conditional untouched confirmation (12 final blocks, no development or
training). Both use strict density strata and 500 m/source-ID separation. Both exports passed actual
imagery, file-hash, source-ID and geographic-separation audits against eleven historical manifests.
Zadar has 681 eligible training tiles, 48 source-selection tiles and 16 reserved final tiles; Šibenik
has only 48 final tiles and remains unscored.

`gpu/plans/selection-v3-donors.json` freezes six fresh fits, all completed, using the failed primary margin gate
to select common margin 2 and keeping rim 0. Exact parcel-count matching produces 632 tiles and
27,344 parcel instances per donor, with identical low/medium/high/dense counts of 74/93/205/260.
Unique cadastral IDs differ (22,987 distant, 19,845 nearby); the matched annotation budget counts
tile-level parcel instances, not distinct parcels. Both arms train for 30 epochs and 3,180 updates
per seed. Each source chooses its own checkpoint/configuration on its 48 source-selection tiles;
the paired target comparison uses the same 48 reused Split selection tiles. Only a passing complete
development gate permits separately frozen Šibenik confirmation, requiring at least +0.02 F1 and
all remaining guards. Exporting confirmation imagery does not authorize using its model outcomes
for development decisions.

The matched-donor comparison fails advancement. The table averages three seed-pooled Split selection
scores; intervals use 2,000 paired resamples of the same twelve whole geographic blocks.

| Split transfer metric | Distant Zagreb donor | Nearby Zadar donor | Nearby minus distant, 95% block interval |
|---|---:|---:|---|
| Parcel F1 | 0.2064 | 0.1958 | −0.0106 [−0.0247, +0.0074] |
| Precision | 0.3917 | 0.3400 | −0.0517 [−0.0684, −0.0304] |
| Interior recall | 0.1533 | 0.1402 | −0.0131 [−0.0354, +0.0110] |
| Area-weighted recall | 0.2821 | 0.3364 | +0.0543 [−0.0013, +0.1245] |
| Boundary F1 | 0.4653 | 0.4562 | −0.0090 [−0.0195, +0.0047] |

Seed F1 differences are −0.018870, +0.000907 and −0.013917. The mean-gain, positive-interval,
median-seed and drop-best-seed checks fail, as do the precision and interior-recall guards;
only the area-recall guard passes. The F1 difference remains unresolved, while the precision interval
is entirely negative. This comparison does not support switching to the nearby donor. Its source
regions bundle geography, cadastral fabric and imagery, so it does not isolate a climate effect or
establish a general limit on nearby donors.

Mean F1 falls by 0.0067 in the high-density stratum and 0.0188 in the dense stratum. The low-density
increase of 0.1622 comes from one block with only 21 references, all clipped and none interior;
its interior recall remains null. Across the full selection set, the 1,033 clipped and 763 interior
references remain included. Source-selected epochs are 16/18/16 for Zagreb and 8/14/12 for Zadar;
their own-city scores describe different geographies and are not a paired comparison.

All six journals satisfy 30 epochs, 3,180 updates and fifteen source-selection evaluations. All 576
saved tile-score records were repooled, every selected own-city metric matched its training record,
and all 1,795 donor artifacts (4.60 GB), including best/last checkpoints and actual cache proofs,
passed SHA-256 verification. The twelve selection ledger rows and
`output/runs/selection-v3-donors-comparison/report.json` retain every seed, guard, source choice,
density stratum, clipped/interior count and artifact hash. Šibenik confirmation was not frozen or
run because development failed; all final splits remain unscored in this study. Keep the existing
default and donor policy. These intervals condition on three fitted seeds and reused Split blocks.

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

**6. Zagreb levers, one at a time, three seeds each.** The eligible v2 pool has 1,623 training tiles.
The longer schedule and first resolution trial are complete and were not adopted. Keep the saved
three-seed 30-epoch controls. The 2026-10-15 sequence above replaces the queued colour augmentation,
test-time averaging and larger-encoder trials with bounded reconstruction/target work and nearby-donor
transfer. A failed treatment closes that recipe; it does not establish a universal data or model limit.
The separate RGB normalization comparison is also complete and failed its advancement and precision
guards; raw RGB remains the default. This does not establish equivalence or rule out other model/data changes.

The first schedule comparison completed on 2026-10-14, frozen in `gpu/plans/selection-v2-longer.json`: three fresh Zagreb
fits at 60 epochs versus the saved 30-epoch baselines, seeds 1–3, 1,623 training tiles and the same
48 selection tiles. Epoch count is the only changed training argument. The cosine learning-rate
schedule spans 60 epochs; evaluation remains every two epochs, so the longer recipe has more
checkpoint-selection opportunities. This is a comparison of complete schedules, not an extension
of converged weights. The saved baselines peaked at epochs 22, 12 and 22, so the existing curves
show no consistent late improvement. Clean Zagreb F1 and its precision/area-recall/boundary/density
guards decide retention; clean Split transfer and resampled Zagreb imagery are secondary. Runtime
packages and ImageNet weights were pinned to the baseline records. The 60-epoch fits selected epochs
18, 24 and 30; none found a new best after epoch 30. The gain is unresolved and smaller than the seed
spread, so retain 30 epochs. All artifacts are verified locally and the rental is destroyed. Final splits
remain unscored; results, guard metrics and actual spend are below.

**7. Milestone 4.** Freeze the recipe, score both final splits once. Proposed targets: Zagreb final
≥ 0.38, Split final ≥ 0.20.

**8. Third and fourth cities.** Candidates with open sub-metre imagery and open parcels are listed in
`IMAGERY.md` (France, Netherlands, New Zealand, Spain, Slovenia). Ljubljana (shared Austro-Hungarian cadastral tradition and a climate
like Zagreb's, but another country) and a Spanish Csa city (Catastro + PNOA, Split's climate, another
legal tradition). Training rights checked before any download. Success: a donor × target table, three
seeds, saying whether a same-tradition or a same-climate donor saves more target labels. ETA 0.5–1 day
per exporter, about 2.5 GPU-h, about $1.20.
Select suburban, village and growth-edge communities within candidate regions as the primary sites;
an administrative city name or its dense centre is not itself a representative target sample.

**9. Serving check.** CPU time per tile for model plus watershed, measured on the laptop. Success: a
city's tiles can be guessed in acceptable time on a server CPU. ETA 30 min, $0.

**10. Product decision.** Whether to show guesses, flagged as estimates, in cities whose held-out score
clears a bar the user sets.
Evaluate that bar separately on the primary suburban/village contexts, including the amount of useful
land and parcel coverage retained. An aggregate city score must not hide weak target-community quality.

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

The first step 11(b) comparison completed on 2026-10-14, frozen in `gpu/plans/selection-v2-resolution.json`: three seeds per
city and arm, all 1,623 eligible Zagreb / 395 Split training tiles, 30 epochs, the existing encoder,
optimizer and reconstruction, and clean selection checkpoint choice every two epochs. The only changed
training setting is a 50% probability of RGB-only box down/up-sampling, with GSD sampled uniformly from
the 0.3 m model input grid to 1.0 m. Rotation, flipping, OSM dropout and targets stay paired by seed.
Compare clean, 0.5 m and 1.0 m inputs with paired 12-block intervals and report seed ranges. These are
synthetic resolution tests; real satellite transfer remains unmeasured. Do not compare v2 absolute
scores with v1 to claim a training gain: both the holdout composition and training pool changed.
The resolution-only trial is complete, not the broader satellite work. Keep the baseline recipe because
the augmentation loses clean precision; retain its checkpoints for a separately defined donor-transfer
comparison. Detailed results and the uncertainty limits are below.

**12. Nearby same-climate donor.** The zero-shot phase is complete under the matched six-fit protocol
above. Zadar did not clear the development gate against the equally sized Zagreb donor; Šibenik remains
untouched. The matched Zagreb control's F1 is 0.2064; the earlier full-pool value of 0.156 uses a different
training budget and source-selected policy and is not this comparison's control. Target fine-tuning and
label-savings curves remain deferred and would need a new frozen comparison using v2 holdouts. The old
v1 donor score and target-only curve cannot be compared directly with v2. This completed experiment
does not establish a general effect of climate, distance or target-label savings.

## ETA and spend

| Steps | Wall time | GPU | Spend |
|---|---|---|---|
| 1–4 | about 1 working day | about 2.5 h | about $1.30 |
| 5–7 | about 1 day (plus the labelling hour, if chosen) | about 3 h | $1.50–4.50 |
| 8–9 | 2–3 days | about 2.5 h | about $1.20 |
| Total | 4–5 working days | about 8–11 h with overhead | about $4–7 |

Spend log: 2026-10-12 $1.40; 2026-10-13 round 2 (36 runs, 105 min of queue, about 2.4 h of box) $1.20.
Vast.ai credit after round 2: $7.38. The v2 round used two concurrent jobs on an RTX 4090 at
$0.5611/hour including 60 GB storage. Credit decreased from $7.3517 to $6.1831, about $1.17 including
two failed image-pull rentals, setup, evaluation and transfers; this is an account-balance change, not
an itemized invoice. All three rentals were destroyed, and the provider inventory was empty at
2026-10-13 22:25 UTC. Verification and the balance receipt are in `output/runs/selection-v2-rental.json`.
2026-10-13 imagery sensitivity: 72 fixed-checkpoint evaluations, about 10 minutes of local analysis,
$0 billed; no new training or GPU rental.
2026-10-14 longer schedule: three 60-epoch fits plus nine fixed-checkpoint imagery evaluations,
about 65 minutes of training and evaluation and 104 minutes of rental at $0.45/hour including storage.
The slow backup accounts for much of the extra rental time. Credit decreased from $6.1640 to $5.1650,
about $1.00 including setup, compute and transfers (account-balance change, not an itemized invoice).
The GPU was destroyed and inventory was empty at 10:18 UTC; the balance was checked again at 10:22 UTC.
Receipt: `output/runs/selection-v2-longer-rental.json`.

2026-10-15 reconstruction and transfer sequence: the saved-map diagnostic used no GPU credit.
Three margin-0 fits took 41 minutes of queue time, followed by six matched-donor fits in 28 minutes,
both with two lanes. The corrected rental cost $0.4622/hour including storage. The account balance
fell from $5.1650 to $3.7294, about $1.44 including two failed startups, setup, compute and recovery;
this is an account-balance change, not an itemized invoice. All 2,695 trial output files (6.87 GB)
were hash-verified locally before the approved rental deletion at 13:03 UTC; the 13:20 UTC balance
check confirmed no active rentals. Receipts: `output/reconstruction-study-20261015/gpu-support/`.

Operational deviation: all training finished at 11:34 UTC, but repeated SSH failures, slow artifact
recovery and deletion approval delayed closure beyond the frozen 11:44 UTC study deadline. The
corrected rental lasted about 2 hours 52 minutes. The time bound was missed; the $1.50 spending cap
was met. The delay added no training, selection opportunities or final scoring. Future transfers must
retain partial files, retry failed connections and use a separate recovery reserve.

## Learned (newest first)

- 2026-10-19, step 6, RGB normalization: three fresh 30-epoch fits (seeds 1–3, 1,623 Zagreb
  training tiles, recipe `29c8f10720f75e57`) versus the immutable raw-RGB controls
  (`48de5c48dab295de`). RGB alone uses the pinned pretrained mean/std; OSM, margin-2 targets,
  initialization, schedule and source-only checkpoint/configuration selection stay matched.
  Both cities use 48 selection tiles in 12 geographic blocks. Differences are normalized minus raw,
  with 2,000 paired whole-block bootstrap replicates and the same draws across all three fitted seeds.

  | Selection set | Raw mean F1 | Normalized mean F1 | Difference (95% block interval) |
  |---|---:|---:|---|
  | Split transfer, primary | 0.1561 | 0.1528 | −0.0033 [−0.0127, +0.0080] |
  | Zagreb own-city, secondary | 0.2927 | 0.2944 | +0.0017 [−0.0098, +0.0167] |

  The primary gate fails: seed F1 changes are −0.0097 / +0.0288 / −0.0290, median −0.0097,
  and mean after dropping the best seed −0.0194. Split precision falls 0.3701 → 0.3338,
  difference −0.0364 [−0.0599, −0.0132], failing the −0.02 lower-interval guard. Interior recall
  changes −0.0026 [−0.0199, +0.0086], failing its −0.01 guard; area-weighted recall changes
  +0.0405 [−0.0025, +0.1035], passing its guard. Boundary F1 changes −0.0142
  [−0.0254, +0.0002]. The small own-city F1 change also fails advancement; Zagreb precision
  falls 0.5128 → 0.4651, difference −0.0477 [−0.0813, −0.0206]. Retain raw RGB.

  | Seed | Raw selected epoch/config | Normalized selected epoch/config | Raw Split F1 | Normalized Split F1 |
  |---|---|---|---:|---:|
  | 1 | 22 / t0.3-seeds0-hard0 | 30 / t0.3-seeds0-hard0 | 0.1432 | 0.1335 |
  | 2 | 12 / t0.3-seeds0-hard0 | 18 / t0.3-seeds1-hard0 | 0.1564 | 0.1852 |
  | 3 | 22 / t0.3-seeds0-hard0 | 28 / t0.3-seeds0-hard0 | 0.1687 | 0.1397 |

  These are complete source-selected policies: seed 2 selected interior seeds ON; the chooser was
  unchanged and never used Split scores. Split interior matches (763 references) change
  72/83/87 → 67/97/72, and clipped matches (1,033 references) 91/95/105 → 84/132/86.
  Its high/dense-bin mean F1 changes −0.0119/−0.0073. Low-density F1 rises 0 → 0.1714, but
  that stratum has only one block and no interior references; its interior recall stays missing.
  Density summaries are descriptive. The intervals condition on these fitted seeds and repeatedly
  used selection geography; they do not include model-selection adjustment, new-fit uncertainty or
  new-city uncertainty. This failed recipe does not establish a recoverability ceiling.

  Verification: four targeted headless unit runs passed (15, 4, 19 and 5 tests; 20 distinct cases;
  none stopped). The 15-test run selected `test_rgb_normalization`, `test_train.ModelTests`,
  `test_train.SubsetTests` and `test_target_config`; the 19-test run added `test_normalization_analysis`.
  The other two runs selected only the four- then five-case analysis test file, with assistance from
  GPT-6 Luna at low reasoning. No full unit or browser suite was run. A two-tile CUDA smoke check covered
  training, resume, evaluation and conflicting-override rejection. The actual 512 px GPU input proof
  has zero measured RGB-transform error, unchanged OSM/cache arrays and identical initial learned
  parameters. All six actual best/last checkpoints were read back and checked. Every fit completed
  8,130 updates and 15 source-selection evaluations; all 576 candidate/control tile scores were
  repooled. The 902-file backup (2,275,550,799 bytes) passed SHA-256 verification before rental
  closure. Six selection rows were appended to `results.jsonl`; no final split was scored.

  Queue time was about 31 minutes with two lanes, following cache preparation. The rental was
  closed at about 20:56 UTC on 2026-10-18 (2026-10-19 locally), within the one-hour training and
  1.75-hour rental bounds. The observed account debit was about $0.41, including setup, GPU,
  storage and transfers, against the $1 cap; this is a balance change rather than an itemized invoice.
  No account top-up was made, and the post-closure inventory was empty.

  Artifacts: `output/runs/selection-v4-normalization/`, `output/runs/selection-v4-normalization-runtime/`,
  `output/runs/selection-v4-normalization-comparison/report.{json,md}`, and receipts under
  `output/normalization-study-20261018/gpu-support/`. Create the comparison output directory before
  running `layered/normalization_analysis.py --run --plan-sha256` with the frozen SHA above.

- 2026-10-14, step 6, longer schedule: three fresh 60-epoch Zagreb fits versus the saved 30-epoch
  baselines, seeds 1–3, 1,623 training tiles, the same 48 selection tiles and recipe `48de5c48dab295de`.
  Epoch count is the only changed training argument; the longer cosine schedule and twice as many
  checkpoint evaluations are part of the treatment. Means below average the three seed-pooled scores;
  parentheses show seed min–max. Differences are 60 minus 30 epochs, with 2,000 paired 12-block
  bootstrap replicates. Intervals condition on the fitted seeds and are unadjusted for multiple comparisons.

  | Selection condition | 30-epoch F1 (seed range) | 60-epoch F1 (seed range) | Difference (95% block interval) |
  |---|---|---|---|
  | Zagreb, clean | 0.293 (0.290–0.297) | 0.297 (0.288–0.305) | +0.004 (−0.006 to +0.012) |
  | Zagreb, resampled 0.5 m | 0.272 (0.265–0.280) | 0.273 (0.262–0.282) | +0.001 (−0.005 to +0.008) |
  | Zagreb, resampled 1 m | 0.237 (0.236–0.238) | 0.221 (0.182–0.243) | −0.016 (−0.025 to −0.003) |
  | Split, clean zero-shot | 0.156 (0.143–0.169) | 0.159 (0.148–0.165) | +0.003 (−0.008 to +0.017) |

  Decision: retain the 30-epoch default. The primary clean F1 gain is unresolved and below both seed
  ranges' widths (0.007 for 30 epochs, 0.017 for 60). Clean precision rises 0.513 → 0.528, difference
  +0.015 (−0.004 to +0.026); area-weighted recall changes by +0.001 (−0.016 to +0.013), and boundary
  F1 by +0.004 (−0.0003 to +0.0073). Clean Zagreb density-bin means do not fall, but directions differ
  across seeds. These checks do not establish equivalence or a recoverability ceiling.

  The secondary 1 m F1 loss is largely seed 2 (0.236 → 0.182); the other two seeds improve slightly.
  Mean precision falls 0.426 → 0.401, difference −0.025 (−0.044 to −0.004), and boundary F1 falls
  0.457 → 0.444, difference −0.013 (−0.023 to −0.004). Its high/dense-bin mean F1 drops by
  0.012/0.028. Split clean dense-bin F1 falls 0.005 despite the small positive overall mean.
  Density differences are descriptive, and synthetic resampling does not measure real sensor transfer.

  All three fits completed 60 epochs and 16,260 optimizer steps, with 30 selection evaluations each;
  selected epochs were 18/24/30 versus 22/12/22 for the baselines. All six best/last checkpoints were
  loaded and checked, all 720 tile-score outputs were repooled, and 15 saved polygon outputs were
  independently re-scored with the canonical scorer. The 2,230-file backup (3.34 GB) passed SHA-256
  verification before rental destruction. Twelve distinct selection rows were added, covering clean
  own-city, clean transfer, 0.5 m and 1 m for each seed; duplicate clean imagery-study evaluations were
  not added again. No final split was scored.

  Artifacts: `output/runs/selection-v2-longer/`, `output/runs/selection-v2-longer-imagery/`, and
  `output/runs/selection-v2-longer-{comparison,audit,rescore,transfer-verification}.json`.
  Learning curves: `output/runs/selection-v2-longer-learning-curves.png`; analysis scripts and receipt
  hashes: `output/runs/selection-v2-longer-analysis/`. Colour augmentation is next.

- 2026-10-14, step 11(b), resolution augmentation: 12 fresh ConvNeXt-Tiny runs, 30 epochs each,
  three seeds per city and arm, recipe `48de5c48dab295de`. Means below are over three seed-pooled
  scores; brackets show seed min–max. Differences use 2,000 paired geographic-block bootstrap
  replicates over 12 blocks. These 95% intervals condition on the fitted seeds, are unadjusted for
  multiple comparisons, and do not measure uncertainty across new cities or sensors.

  | City | RGB input | Baseline F1 (seed range) | Augmented F1 (seed range) | Difference (95% block interval) |
  |---|---|---|---|---|
  | Zagreb | clean | 0.293 (0.290–0.297) | 0.292 (0.282–0.300) | −0.001 (−0.009 to +0.012) |
  | Zagreb | resampled 0.5 m | 0.272 (0.265–0.280) | 0.283 (0.279–0.286) | +0.011 (+0.004 to +0.020) |
  | Zagreb | resampled 1 m | 0.237 (0.236–0.238) | 0.280 (0.276–0.286) | +0.043 (+0.024 to +0.062) |
  | Split | clean | 0.227 (0.219–0.231) | 0.230 (0.224–0.236) | +0.003 (−0.008 to +0.011) |
  | Split | resampled 0.5 m | 0.218 (0.213–0.228) | 0.226 (0.221–0.229) | +0.007 (−0.006 to +0.020) |
  | Split | resampled 1 m | 0.205 (0.201–0.208) | 0.216 (0.212–0.219) | +0.011 (−0.007 to +0.026) |

  Decision: keep the baseline default. Zagreb clean precision falls 0.513 → 0.465, difference
  −0.048 (−0.073 to −0.027), and 0.5 m precision falls 0.030 (−0.057 to −0.012). Clean area-weighted
  recall improves by 0.025 (+0.006 to +0.050), so the clean F1 average hides a precision/recall tradeoff.
  Split's F1 gains remain unresolved; intervals crossing zero establish neither equivalence nor a
  recoverability ceiling. Its mean precision and area recall fall slightly, with intervals crossing zero.
  Density checks are descriptive: Split low/medium F1 declines in all three conditions (clean deltas
  −0.018/−0.008), and Zagreb clean medium/dense declines by 0.005/0.004. Split low density has only
  one block; the other cited bins have three. Seed directions disagree in 15 of 24 city/case/bin cells.

  Exploratory clean-input transfer is promising in one direction: Zagreb → Split F1 0.156 → 0.195,
  difference +0.039 (+0.016 to +0.062); seed ranges 0.143–0.169 and 0.177–0.224. Area recall improves
  by 0.077 (+0.034 to +0.134), boundary F1 by 0.052 (+0.031 to +0.074), and precision by 0.033
  (−0.017 to +0.082). Dense-bin F1 improves in all three seeds, but the low-bin gain comes from one
  seed on its single block. Split → Zagreb is unresolved: 0.218 → 0.215, difference −0.004
  (−0.014 to +0.011). This supports a follow-up donor-transfer comparison, not a general replacement.

  Artifacts: `output/runs/selection-v2-resolution/`, `output/runs/selection-v2-imagery/{zagreb,split}-v2/`,
  and `output/runs/selection-v2-cross-city.json`. The ledger adds 48 distinct selection rows: 24 clean
  own/cross-city evaluations and 24 same-city resampled evaluations. Both best and resume checkpoints,
  probability maps, polygons, scores, input/code hashes and runtime records were copied locally;
  all 8,890 transferred files (9.06 GB) match the sealed manifest. Independent checks recomputed the
  pooled scores from all 1,728 study tile results and rescored 36 saved polygons, including newly added
  selection geography. The 41 pure/forward checks and rented-GPU training/resume/ancestry checks passed.
  No final split was scored, no model was promoted, and no GPU remains rented. Resampled orthophotos
  still do not establish real satellite performance.

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
