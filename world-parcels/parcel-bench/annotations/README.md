<!-- Annotation protocol for an image-only diagnostic of preserved physical/use divisions. -->
# Visible-division diagnostic v1

Frozen before this comparison on 2026-10-19. `visible-divisions-v1.json` contains **27 separation
pairs and nine same-surface pairs** on the nine images already selected in the settlement pilot by
minimum, median and maximum building-footprint coverage per region. They were reviewed from raw
imagery without cadastral overlays or the compared polygons. These are **agent-draft annotations**,
not human-verified labels. This purposive Croatian development sample cannot establish performance
in African/Asian villages or provide a population confidence interval. Some sampled tiles are dense.

A separation pair places two anchors inside areas divided by a discernible physical/use edge:
hedge, wall, path, road, crop transition or enclosure edge. It does not assert different owners.
A same-surface pair samples one visibly continuous roof/field as a secondary fragmentation check.
Both relations have confidence and image evidence; confidence is descriptive, with no outcome-based
filtering. Unmarked/occluded edges are unassessed. Review corrections require a new annotation
version; never silently overwrite the frozen labels after seeing outcomes.

Coordinates are continuous **image-edge pixel coordinates**: top-left is `(0, 0)`, x increases right,
y down; anchors must be strictly inside `(0, width) × (0, height)`. The metric bounding box is the
outer image extent, with x mapped linearly and y inverted. Image bytes, dimensions and extent must
match the manifest. No pixel-centre offset, snapping, tolerance buffer or geometric repair applies.

Score the final Polygon/MultiPolygon features, each treated as one selectable identity regardless of
its properties or component count. Both anchors uniquely covered by one feature means joined; two
different features means separated. Any multiply covered anchor is ambiguous (including shared-edge
anchors); otherwise any missing anchor means uncovered. Invalid geometries fail scoring. Do not count
ambiguity or abstention as successful separation. Report all denominators, pair coverage, conditional
false-merge rate, same-surface splits, feature count, union coverage and overlap area. The affected
area is the **union of whole features responsible for observed false merges**, deduplicated within
one tile/output. It is not the area of misassigned ownership. Across seeds, areas are repeated outputs.
Pair probes do not measure boundary-length recall or exhaustive plot accuracy. There is no weighted
composite score or promotion threshold, and a fine grid cannot be declared a winner from these probes.

## Frozen comparison

Use saved `selection-v5-settlement/uniform-n1020-s{1,2,3}/selection-eval` maps and each run's already
selected configuration (`t0.5-seeds1-hard0`, `t0.3-seeds1-hard0`, `t0.3-seeds1-hard0`). Downsample
512→256 with `INTER_AREA`; use existing OSM inputs and the unchanged production reconstruction.
Compare `min_region_m2=120` against `min_region_m2=0`; hold all other parameters fixed (distance
watershed, interior seeds, minimum interior area 40 m², keep-out 2 px, seed rim 0, hard barrier off).
The treatment disables only **small-region merging**: grouping disconnected fragments by seed and
existing vectorization filters remain. Before scoring a tile, require the control GeoJSON to exactly
reproduce the saved production collection as parsed JSON. A mismatch stops the run.

Run all nine images × three seeds × two variants. Show per-seed and per-image changes, including
unchanged pairs and coverage changes; retain the actual polygons, input/source hashes and probe
outcomes. No retraining, inference, new paid rental, runtime fallback or model promotion is involved.
The next product benchmark still needs independent target-settlement imagery and human review,
with visible-boundary traces, unsupported divisions and editing effort beyond these sparse probes.
