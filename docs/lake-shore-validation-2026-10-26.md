# Lake shore overlap

The shallow-water transition is a 2D overlay inside the sandy shore. Extruding both
areas unchanged into the recessed 3D basin creates two inward-facing walls along
the open water edge, from the basin floor to the shelf top. The sand and blue walls
compete at the same depth. On the Digbeth Garden lake, the overlapping footprint
was approximately 62.57 m², the entire shallow shelf.

The 3D basin now subtracts the shelf from the shore before extrusion, through the
shared parcel clipper. The resulting solids occupy separate areas and the water
edge has one visible wall. Authored geometry and 2D lake graphics are unchanged.
Without derived lake graphics, the basin draws open water without an overlapping
full-footprint shore solid. Clip failures are reported as display degradation.

Validation:

- Targeted headless unit tests, first run of `test/three-lake-basin.test.js`: five
  passed, one failed. Its ray assertion counted an occluded wall farther behind the
  shelf. Narrowed the assertion to competing hits at the nearest wall's distance.
- Final targeted headless unit run:
  `npx vitest run test/three-lake-basin.test.js test/three-structure-refresh.test.js --maxWorkers=1`
  from `backend`: 18 passed in two files. Includes real Three.js extrusion,
  disjoint areas, complete coverage, islands, multipart basins, unchanged input
  graphics, absent graphics, clip failure propagation and dependency loading.
- Headed Chrome, actual named Digbeth plan: an 80 × 50 ray grid from the same
  camera found 49 competing sand/shelf wall samples before and zero afterwards.
  A closer view of Garden lake and an opposite view of Rain lake also yielded zero.
  Both shorelines were visually clean; no browser runtime errors were reported.
- No run was stopped. No full headless unit or Playwright suite was run.

The implementation remains local and uncommitted because the renderer file also
contains active edits from other sessions. The helper, loader wiring and regression
test belong with that renderer integration.
