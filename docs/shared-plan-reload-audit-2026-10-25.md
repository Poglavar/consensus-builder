# Shared ground designs after reload

The supplied Learning courtyard plan reproduced the missing parks and square on a same-profile
reload. The first load had eight applied records, two runtime parks and one runtime square, with
their visible 3D ground meshes. Reload retained the eight applied flags and the buildings but
left both structure collections empty.

The designs carry the parcel-free city label `sulaimani`, while the plan has no saved city and
the shared-route boot used its default city context. Import accepts that label through
`CityConfigManager.foreignCityFor`, but startup replay required a literal city match. The shared
route then reused the already-applied records without reconstructing their missing live output.
The tree-rendering changes present in the checkout were separate from this startup filtering bug.

Startup replay now uses the same existing source-context eligibility rule for parcel-free
records as import. Explicit cadastral references still determine eligibility first, and designs
from incompatible configured cadastral contexts remain excluded. No records, CIDs or applied
flags are rewritten to repair the display.

## Targeted verification

- Manual headed Chrome: reproduced the first-load/reload difference, then reloaded the same
  disposable profile with the fix. All eight records remained applied and both parks and the
  square returned as runtime objects and visible ground meshes. The browser was closed.
- Headless Vitest, three files: the first run had 35 passes and one new regression-harness
  failure because the harness omitted the browser's city-manager namespace. With that namespace
  supplied, all 36 tests passed. The new regression covers accepted place labels, compatible
  source contexts, foreign contexts and authoritative cadastral references.
- Headed Playwright, first run of three selected cases: desktop named-plan arrival plus two
  reloads passed. The run was stopped during extreme host load; mobile was interrupted and the
  shared-camera case had not run.
- Headed Playwright, remaining two selected cases: mobile arrival plus two reloads and the
  shared-camera composition case both passed. Each reload case verifies two parks, a square,
  a lake and a building in the runtime and visible 3D scene, with zero cadastral bindings.
- Updated the older camera regression's selection assertions to retain the whole composition,
  following the current selection contract. Mobile reload screenshot visually inspected.

No full test suite or deployment was run. The glossary was updated locally and remains mixed
with another session's consultation definitions, so it is excluded from this scoped commit.
