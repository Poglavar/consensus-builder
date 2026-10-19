# Autokatastar plot playground

A small browser demonstration of plausible plot divisions from prepared aerial imagery and
mapped buildings, roads and water. It offers three locations, image-edge sensitivity and
street-alignment controls, manual seeds and dividing lines, local saved edits, and GeoJSON export.
It is separate from the human annotation app and the frozen ParcelBench evaluations.

## Run locally

From the repository root, with the existing source crops and backend dependencies present:

```sh
python3 world-parcels/parcel-bench/heuristic-demo/prepare.py --run
node world-parcels/parcel-bench/heuristic-demo/server.mjs
```

Preparation needs Python `pyproj` and `shapely`. It verifies existing image hashes, copies local
`proj4` and `polygon-clipping` distributions and their licenses, and caches two bounded Overpass
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
3. Add seeds in sufficiently large unoccupied areas. These are geometric suggestions, not detected
   buildings. Small seedless fragments below 10 m² may stay unassigned.
4. Grow labels with deterministic multi-source shortest paths. RGB gradients raise crossing costs;
   a street-oriented Manhattan-distance contribution biases growth towards nearby street directions.
5. Give every four-connected output region its own plot identity. Export exact raster-cell unions
   in WGS84 longitude/latitude, retaining holes and common edges without independent smoothing.

The **Location selector** changes examples. **Follow image edges** increases the cost of crossing
colour changes. **Street alignment** changes the directional growth cost; it does not guarantee
rectangles. **Add a building seed** adds a point where a mapped building or another desired plot is
missing. **Draw a dividing line** takes two points, extends their line through the current ground
block, and rejects lines crossing mapped buildings. It is a straight divider, not a freehand trace.
**Explore plots** inspects estimated area. **Undo**, **Reset edits**, layer switches, pan and zoom
support comparison. **Export plots** downloads the current completed result with provenance and
the exact controls and edits that generated it.

Local corrections are keyed by recipe, sample, imagery hash and feature-cache hash. Undo history
is session-local. A changed source or recipe starts a fresh draft rather than migrating old edits.
`illustrative-plots-v1` exports use `estimated: true` and `accuracy: unvalidated`; numbered IDs are
local to a recomputation, not permanent parcel identities. Areas are measured in the source metric
grid. Geometry validity is not evidence of cadastral accuracy or ownership.

## Sources and limits

- Magoanine C west houses, Mozambique, and Baniyataar houses and fields, Nepal: existing reviewed
  Open Imagery Network crops, with source URLs, acquisition dates and CC BY 4.0 metadata retained.
  Nearby OSM context comes from small Overpass queries; its own snapshot timestamp is retained.
- Zadar, Croatia: existing DGU DOF 2023/24 crop and cached geodata sidecar. The local manifest does
  not record redistribution terms. Review the source terms before publishing this image bundle.
- Source imagery and OSM can differ in date and registration. Missing, overlapping or shifted
  footprints affect results. One footprint seed does not establish a separate property; sheds can
  create excessive divisions. Image edges also describe roofs, trees, shadows and surface texture.
  Fields receive invented geometric seeds. Roads use approximate widths. Unmapped roads and water
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

The first two commands are headless unit checks: ten JavaScript cases and two Python cases.
The last is one headless Playwright integration case, using the repository's `e2e` dependency and
an ephemeral loopback server. It requires the prepared bundle and installed Chromium.
It exercises three real examples, worker exports, control changes, saved seeds, undo and narrow
layouts, and fails on uncaught browser errors. Downloads are also copied to
`/tmp/heuristic-demo-exports/` for inspection.

On 2026-10-20 the targeted checks passed. Independent Shapely checks of the three default downloads
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

The UI uses shared semantic panels, fields, actions, disclosures, notices and metrics.
`public/styles.css` owns presentation and palette roles, including the colours read by the raster
overlay. `public/strings.mjs` owns English UI copy; this standalone tool shares the annotation app's
English-only language scope.
