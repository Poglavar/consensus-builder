# Building surroundings and vacant layout ground

New and edited building designs offer Paving and Green, with Paving selected initially. Their
saved `geometry.groundSurface` continues to contain the authored polygon and optional furniture.
Paving uses the ordinary sidewalk slabs rather than square paving, including when furniture was
edited using the square editor. The retired `none` choice is no longer an authoring option.
Published designs without a surface do not acquire invented geometry; save a revision to add it.

Current, unoccupied outputs of applied parcel layouts display patchy yellow-green grass and a
1.22 m boundary fence with posts no more than 3 m apart. Existing surviving buildings and applied
physical designs exclude a plot from this display. The scenery is derived, does not enter the
published record, and disappears when the composition occupies or removes the plot. Source
cadastre and layout remainders are excluded. Land take and ownership remain independent.

The phone editor checks exposed a sizing selector that omitted editor panels mounted directly
under the document body. The shared mobile sheet rules now include these panels. Scoped 3D
materials also retain custom shader hooks, so changing display mode preserves slab and grass
patterns.

## Verification

Only targeted checks ran. No full suite ran and no run was stopped.

| Run | Type and scope | Result |
| --- | --- | --- |
| 1 | Headless unit: building-ground, three-site-ground, three-ground, three-structure-refresh; 4 files | 48 passed |
| 2 | Headless unit: single-building-placement, single-building-map-editor, freeform-land-take; 3 files | 23 passed, 1 failed: obsolete placement fixture assumed the removed `none` treatment |
| 3 | Headless unit: same 3 placement/land-take files | 25 passed; exact cut and whole-parcel takes checked independently for both treatments |
| 4 | Headless unit: building-ground, three-site-ground, three-structure-refresh; 3 files | 43 passed, including shader-hook preservation |
| 5 | Headed Playwright: building-surroundings and vacant-layout-ground; 8 scenarios | 4 passed, 4 failed: row test timeout, two phone sizing failures, one unhandled parcel-scope confirmation |
| 6 | Headed Playwright: vacant-layout-ground; 1 scenario | 1 failed: confirmed park creation was still waiting for the parcel-scope choice |
| 7 | Headed Playwright: default surroundings, detached furniture and vacant ground; 5 scenarios | 3 passed, 2 failed: phone sizing selector still omitted body-mounted editor panels |
| 8 | Headed Playwright: two detached-phone scenarios and vacant ground; 3 scenarios | 3 passed after the CSS correction |
| 9 | Headed Playwright: vacant-layout-ground with explicit WebGL compilation; 1 scenario | 1 passed; final visual review caught and corrected a reserved GLSL variable name |

All 74 distinct headless unit checks and all eight distinct headed browser scenarios passed by the
end. The first browser run also encountered trace-file collisions with another local run; later
runs used separate temporary output directories.

The real Birmingham agreement was loaded through the local frontend using the public API. Its
17 designs produced eight vacant plots before any source-building exclusions changed that set.
The published building designs still omit surroundings, as expected for unchanged saved content.
