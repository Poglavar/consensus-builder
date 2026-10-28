# Road construction frames and Google 3D

Branch: `colosseum-worlds-fair`.

The reported Hyderabad private plan contained 51 designs, including 12 roads. Their
canonical OSM nodes, junctions and saved footprints were in Hyderabad, but every
road retained a construction frame approximately 8,036 km away. The detailed road
renderer correctly rejected coordinates outside the frame's 60 km domain. Model
view still displayed flat road footprints; Google 3D could not build the detailed
terrain-following corridors. Google imagery itself loaded and grounded correctly.

`DesignRecord.validate` now checks canonical road nodes and saved footprint
coordinates against any declared construction frame. Invalid provenance or
out-of-domain geometry returns `design-road-frame` with an instruction to prepare
the road again. This enforces the existing construction-frame contract in
`projections.md`; it does not reinterpret malformed records during rendering.
The ordinary authored road edit path already rebuilds the footprint and frame
from edited canonical nodes.

A corrected private artifact was prepared locally for visual verification. It
retains all 51 members: 39 unchanged records and 12 new road revisions identifying
their original CIDs. Each road's frame was derived from its current canonical
inputs; its saved footprint and site were preserved exactly. The original
immutable preview was not changed. No corrected artifact was uploaded or
published as part of this verification.

## Verification

- Targeted headless unit tests, from `backend`:
  `npx vitest run test/design-record.test.js test/mcp-edit.test.js --maxWorkers=1`.
  The first run passed 37 tests. After adding the cross-city editing regression,
  the same two-file run passed 38 tests. No full suites ran and neither run was
  stopped. Coverage includes valid frames, distant frames, moved nodes, moved
  footprints and proper frame recomputation when editing a road into another city.
- Dedicated background headed Chrome inspection reproduced the missing roads on
  the original hosted preview, then inspected the corrected local artifact at the
  supplied Hyderabad camera. Roads became visible over Google imagery.
  Diagnostics reported 12 applied roads, 32 terrain-following profiles, 1,033
  stations, 800 corridor objects, no missing entries and no fitting failures.
  Google tiles were grounded, with 36 visible tiles and no failed requests.
  The before and after screenshots were inspected.

No deployment was performed.
