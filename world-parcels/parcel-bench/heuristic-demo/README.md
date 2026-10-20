# Autokatastar plot playground

A small browser demonstration of plausible plot divisions from prepared aerial imagery and
mapped buildings, roads and water. Every output plot is a four-sided rectangle. It offers three locations, image-edge sensitivity and
street-alignment controls, manual seeds and dividing lines, local saved edits, and GeoJSON export.
It is separate from the human annotation app and the frozen ParcelBench evaluations.

## Run locally

From the repository root, with the existing source crops and backend dependencies present:

```sh
python3 world-parcels/parcel-bench/heuristic-demo/prepare.py --run
node world-parcels/parcel-bench/heuristic-demo/server.mjs
```

Preparation needs Python `pyproj` and `shapely`. It verifies existing image hashes, copies local
`proj4` and its license, and caches two bounded Overpass
requests. It reuses the existing Croatian context sidecar. Failed network requests remain explicit;
`--retry-overpass` retries a saved failure. Successful caches are reused without network access.
The source crops must already exist: `output/target-review-v1/` for Mozambique and Nepal and
`output/city/zadar/dataset/` for Croatia. Preparation does not download aerial imagery.

Open <http://localhost:8793>. `DEMO_PORT` changes the loopback preview port. The server serves only
the playground, prepared bundle, and the annotation app's shared image viewer, with `no-store`
headers. Raw download caches and annotation records are outside its served routes.

Prepared images, source responses and browser libraries live in ignored
`world-parcels/parcel-bench/output/heuristic-demo-v1/`. The browser makes no external requests and
performs all plot computation in a Web Worker; it does not use an LLM, SAM, a GPU service, or a
trained model. The small RGB filter is plain JavaScript, using box smoothing and colour gradients
of the kind available in OpenCV; OpenCV itself is not a dependency.

## What it does

1. Reduce each 153.6 m square image to a 512 × 512 processing grid, with 0.3 m cells.
2. Rasterize mapped water and buffered road centrelines as barriers. Use mapped positive widths
   where present, otherwise explicit road-class defaults. Bridges and tunnels are not ground road
   barriers. Building footprints remain seed regions; conflicting water takes precedence and warns.
3. Choose an orthogonal frame per connected ground block, blending nearby building and street
   directions. Conservatively resample ground into that frame: a rotated cell is usable only when
   every source cell touched by its bounds belongs to the same block. Building-cell envelopes and
   manual points become anchors. Infeasible envelopes remain reserved and unassigned.
4. Recursively split the frame with straight, axis-aligned cuts that do not cross an anchor.
   Whole-line image-edge support, child proportions and the balance of anchor counts choose cuts;
   there is no nearest-seed distance or equidistance objective. Large open spaces use a 650 m²
   target to stop subdivision, not a required output area.
5. Fit a maximal interior rectangle inside each leaf, containing its anchors. Overlapping envelopes
   can share a plot. Non-slicing arrangements fit groups one at a time while reserving other groups.
   Every emitted plot has four corners, right angles and an aspect ratio at most 4:1. Open-ground
   plots require at least 40 m² and 3 m width. Road/water edges, crop corners and incompatible
   building arrangements can leave gaps; an infeasible fit stays unassigned instead of cutting a roof.
6. Display and export the same vector rectangle. Raster labels are derived from these polygons for
   coverage reporting; vectors own boundaries, hit testing and metric area. Plots never acquire
   extra corners by clipping to an irregular block boundary.

The **Location selector** changes examples. **Follow image edges** favours straight cuts along
visible colour changes. **Street alignment** blends building and road directions; it changes
orientation, while the rectangle constraint stays mandatory. **Add a building seed** supplies a
point anchor where another plot is desired. **Draw a dividing line** takes two points, extends the
line through the current ground block and rejects lines crossing mapped buildings. It is a straight
divider, not a freehand trace. **Explore plots**, **Undo**, **Reset edits**, layer switches, pan and
zoom support comparison. **Export plots** downloads the completed result with provenance, controls
and edits. The UI reports covered buildings, open-ground plots and assigned ground; warnings count
unassigned building anchors and rectangles containing multiple buildings.

Local corrections are keyed by recipe, sample, imagery hash and feature-cache hash. Undo history
is session-local. A changed source or recipe starts a fresh draft rather than migrating old edits.
`illustrative-plots-v3` exports contain one `Polygon` with one closed five-position ring per feature,
`shape: rectangle`, `source_feature_ids` for every grouped building, `anchor_kind`, `anchor_count`,
`estimated: true` and `accuracy: unvalidated`. Numbered plot IDs are local to a recomputation.
Areas measure the displayed rectangle in the source metric coordinate system. The export records
shape constraints and assigned/unassigned coverage. Rectangularity is defined in the source metric
CRS; longitude/latitude angles are not the same as metric right angles.

Intentional contract change, 2026-10-20: `browser-heuristic-v3` replaces distance growth and shared-arc
simplification with rectangular subdivision. The earlier output path, TopoJSON runtime dependency
and v2 draft identity are removed; v2 drafts are not migrated. This implements the user's request to
require four-sided, roughly rectangular plots and drop equidistance requirements. Strict rectangles
trade away complete coverage, particularly around curved roads, cropped roofs and shifted mapping.

## Sources and limits

- Magoanine C west houses, Mozambique, and Baniyataar houses and fields, Nepal: existing reviewed
  Open Imagery Network crops, with source URLs, acquisition dates and CC BY 4.0 metadata retained.
  Nearby OSM context comes from small Overpass queries; its own snapshot timestamp is retained.
- Zadar, Croatia: existing DGU DOF 2023/24 crop and cached geodata sidecar. The local manifest does
  not record redistribution terms. Review the source terms before publishing this image bundle.
- Source imagery and OSM can differ in date and registration. Missing, overlapping or shifted
  footprints affect results. One footprint seed does not establish a separate property; sheds can
  create excessive divisions. Image edges also describe roofs, trees, shadows and surface texture.
  Open-ground rectangles are geometric suggestions. Roads use approximate widths. Unmapped roads and water
  are not semantically detected by the RGB gradients.

These are three prepared examples, not arbitrary-location coverage or a measured accuracy result.
The always-visible disclaimer and the export describe illustrative, editable plots rather than
surveyed boundaries. No training, human-review labels, or cadastral records enter this recipe.

## Checks

Run only the targeted files:

```sh
node --test world-parcels/parcel-bench/heuristic-demo/test/core.test.mjs world-parcels/parcel-bench/heuristic-demo/test/geometry.test.mjs
python3 world-parcels/parcel-bench/heuristic-demo/test/test_prepare.py
node --test world-parcels/parcel-bench/heuristic-demo/test/browser.test.mjs
```

The first two commands are headless unit checks: thirteen JavaScript cases and two Python cases.
The last is one headless Playwright integration case, using the repository's `e2e` dependency and
an ephemeral loopback server. It requires the prepared bundle and installed Chromium.
It exercises three real examples, worker exports, control changes, saved seeds, undo and narrow
layouts, and fails on uncaught browser errors. Downloads are also copied to
`/tmp/heuristic-demo-exports/` for inspection.

Historical v2 result (superseded by the rectangle contract): on 2026-10-20 the targeted checks passed. Independent Shapely checks of the three default v2 downloads
and one changed-control download found all geometries valid, with overlap and source-grid area
errors below 0.001 m². Default examples produced 96, 45 and 43 plots respectively. Headed Chrome
inspection is separate visual evidence; this does not establish measured plot accuracy.

Development run record: the initial seven-case headless core unit run had two incorrect fixture
expectations; correcting the fixtures gave seven passes. The combined ten-case JavaScript
headless unit run and two-case Python headless unit run passed. The first headless browser file
passed its integration case and a trivial listener subtest; the final run passed the single
integration case after removing that subtest and consolidating UI copy. A restricted localhost
bind required rerunning with local-network permission, and a stale process poll ran no tests.
No full suite was run and no completed test run was stopped.

Straightening run record: three geographic-export headless unit cases passed, followed by three
new straightening cases (after correcting a syntax error and an assertion that had incorrectly
required individual plot areas to stay unchanged). The combined six geometry cases then passed.
The targeted headless browser integration case passed for all locations, vector display, GeoJSON,
saved corrections and phone widths. Independent Shapely checks of all four actual browser exports
passed validity, overlap and reported-area checks. The targeted 13-case JavaScript and two-case
Python headless unit runs passed. Adding road-frontage cleanup exposed a too-small tolerance in its
new test: a raster stair can exceed three-quarters of a cell. With the exterior tolerance set to one
cell, all seven geometry/straightening headless unit cases passed, and the single headless browser
integration case plus independent Shapely artifact checks passed again. Default border vertices
fell from 6,706 to 1,887 (Mozambique), 5,746 to 1,702 (Nepal), and 7,689 to 1,980 (Croatia).
No full suite was run and no completed run was stopped.

Rectangle run record (2026-10-20): the three geographic-export headless unit cases first failed
because a test read coverage outside `demo.stats`; correcting that path gave three passes.
The new nine-case core headless unit run had one overly narrow edge-location assertion; checking
that the cut favours the visible edge over the equidistant midpoint gave nine passes.
After adding street-orientation and metric-cell checks, the targeted two-file JavaScript
headless unit run passed all 13 cases; the Python preparation file passed both cases.
The single headless Playwright integration case first rejected negligible projection-roundtrip
slivers as overlaps. Independent Shapely measured a maximum of about 0.00000002 m²; an area-based
1e-6 m² tolerance fixed the assertion. The case then passed, and passed again after final export
statistic names and the vendor bundle were updated. No full suite was run and no run was stopped.

The three default v3 examples produce 52, 42 and 31 rectangles, assigning 75.4%, 65.3% and 63.3%
of ground cells respectively. They cover 62/94, 6/32 and 19/35 visible mapped building anchors.
The remaining anchors are explicitly unassigned; these counts are heuristic coverage, not accuracy.
Independent Shapely checks of actual browser downloads found valid four-corner polygons, maximum
pair overlap below 1e-6 m² and reported-area error below 1e-5 m². No mapped building over 1 m²
was split or partially covered by more than 5% in the three default exports and the sensitivity
variant. Headed Chrome inspection covered all three examples and a 390 px phone layout.

The UI uses shared semantic panels, fields, actions, disclosures, notices and metrics.
`public/styles.css` owns presentation and palette roles, including the colours read by the raster
overlay. `public/strings.mjs` owns English UI copy; this standalone tool shares the annotation app's
English-only language scope.
