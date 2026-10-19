<!-- Prospective geometry contract for rebuilding the failed contour outputs from unchanged label rasters. -->
# Exact cell partition diagnostic v1

Frozen 2026-10-19 **after** the original visible-division comparison exposed invalid polygons,
**before** scoring this candidate. The image annotations remain frozen at SHA-256
`0b396045716cca0098ed8275899fdc1e1d6d2261417ee3284ae9d8c6ba191215`.
This is a new offline geometry experiment, not a revision of the original comparison or its gates.

The original contour outputs are invalid in 18/27 controls and 23/27 outputs without small-region
merging. Only four matched outputs can be scored under the strict polygon contract. OpenCV contours
and their independent approximation can self-intersect; the historical cadastral scorer uses
`make_valid` before measuring. Do not apply that repair silently in the new task.

Use **the exact saved integer label rasters** from all 54 original reconstructions. Build one feature
per positive label by taking the union of its occupied, closed raster cells; zero stays unassigned.
Use horizontal row runs as equivalent rectangles to keep the construction bounded. Union in integer
grid coordinates before transforming to the metric image extent; no simplification, snapping,
buffering, geometry repair or contour-area filter. Keep every positive cell, including small
components. A feature may be a MultiPolygon; disconnected parts of one seed remain one output
identity so that this experiment does not also change the seed identity contract.

Required geometry checks on every output: all polygonal features valid; union area equals occupied
cell area; no positive-area overlaps; every source cell centre rasterizes back to its original label;
no geometry outside the tile (numerical tolerance 1e-6 m² for area comparisons). The deterministic
synthetic tests include holes, diagonal contact, a one-cell bridge, adjacent regions, an isolated cell,
empty background and non-square grids/extents. No shape may be dropped to pass validation.

Compare `cell-120m2` and `cell-no-small-region-merge` with the **same cell vectorizer**. This isolates
the small-region cleanup while both outputs use the new geometry contract. Compare each to the
original validity findings separately: cell polygons preserve assigned raster area that the old
contours and small-component filters can discard. They will have staircase boundaries at 0.6 m;
visual smoothing and component regrouping are outside this experiment.

Score all 27 separation and nine same-surface probes across all three seeds with the unchanged
strict scorer. Report per-seed/per-image joins, coverage, ambiguity, same-surface splits, feature
count and deduplicated implicated feature area. Annotation status remains agent-draft; the nine
Croatian images remain purposive development diagnostics, not new target-settlement validation.
No numeric promotion threshold is introduced. A reduction in observed merges must be interpreted
with coverage, fragmentation, geometric validity and the small fixed sample. No runtime integration,
new model selection, inference or paid training is authorized by this experimental result.
