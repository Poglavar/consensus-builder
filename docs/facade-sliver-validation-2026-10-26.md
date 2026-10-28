# Facade overlap from parcel clipping

The Digbeth Green Quarter plan's Garden Tower had competing mixed-palette facades.
Intersecting the building with a parent parcel remainder produced two microscopic
ribbons totalling approximately 0.00113 m². Extruding these to the building's 81 m
height created walls coplanar with the actual tower, using the remainder parcel's
different facade identity.

The footprint-to-shape conversion now rejects rings whose area relative to their
perimeter falls below its existing 2 cm vertex tolerance. This catches bent ribbons
as well as straight ones; consecutive vertex deduplication alone cannot do that.
Collapsed holes are omitted too. Saved parcel and building geometry is unchanged,
and real parcel seams still control facade assignment.

Validation:

- Targeted headless unit tests: `npx vitest run test/three-mesh-sanitize.test.js test/three-facade-parcels.test.js --maxWorkers=1`
  from `backend`: 10 passed in two files. Coverage includes the actual clipped
  ribbons, reversed and translated bent strips, real narrow slices, courtyard
  holes and facade identity at parcel seams.
- The initial headless unit run passed eight tests and failed two because renderer
  doubles lacked current material and resource ownership methods. Updated those
  doubles; the second run passed all ten. After concurrent facade test updates,
  a third targeted headless unit run also passed all ten.
- Headed Chrome, actual named plan with mixed facades: the same 60 × 40 ray grid
  found 169 samples hitting competing coplanar facade meshes before the fix and
  zero afterwards, also zero from the reverse angle. Visual inspection confirmed
  the tower's triangular patches disappeared; the browser reported no runtime errors.

No full headless unit or Playwright suite was run.

## Preventing the precision mismatch

The formation clipper already rounds both operands to nine decimal places before
clipping for sweep-line robustness. However, building formation copied the raw
authored land take into the new live parcel while calculating its surrounding
remainder on that grid. Facade slicing then intersected raw coordinates directly.

Building formation now materializes its take on the clipper's same grid. Facade
slicing uses the shared clipper too. Authored coordinates and published content
are unchanged. The renderer's thin-ring guard remains a final geometry check.

On a fresh replay of the actual plan, raw overlap between the formed tower parcel
and surrounding live parcels is zero, and facade intersections on the shared grid
also produce no overlap. The authored footprint retains its original coordinates.

Regression coverage includes the actual rotated footprint, checking that formed
take and remainder have zero intersection and their union has no missing or extra
land relative to the host on the clipping grid. A separate renderer test exercises
raw authored coordinates against a rounded remainder and requires one facade slice.

Targeted headless unit runs for the source correction:

- Four files (`form-building-parcel`, `clip-snapping`, `three-facade-parcels`,
  `three-mesh-sanitize`): initial run 29 passed, three failed while a concurrent
  facade shader change required updating its shader double; rerun 32 passed.
- Two additional files (`open-ground`, `clip-failure-proposals`): initial run
  46 passed, three failed because building failures were attributed to the generic
  clipper and a failure fixture allowed a retry to succeed. Added operation context
  to building clips and made the intended failure persist across retries.
- Three files (`form-building-parcel`, `open-ground`, `clip-failure-proposals`):
  final run 62 passed. No run was stopped.

The source correction is independently committable. The renderer, facade test and
glossary files also contain concurrent sessions' edits and remain in the worktree
until those changes can be committed by their owners.
