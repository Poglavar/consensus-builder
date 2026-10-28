# 3D entry refresh validation

The entry tilt previously drew before the sun's `beforeRender` hook. Nearby-building responses
could interrupt another family’s build, and the final entry policy sync could request another
complete rebuild. Builders also emptied visible groups before yielding through replacements.

Lighting now runs through the common render path, including entry and restored cameras.
Building refreshes coalesce and run sequentially, preserve their requested family, and build
replacement groups off-scene before swapping them in. Cancellation disposes unfinished groups.
Entry no longer repeats the building policy sync after initialization or warm reuse.

MCP parity: no authoring action, record, or schema changed. Human and MCP scene entry use the
same renderer; the existing scene-readiness API now includes queued refresh work. No glossary
change is required for this rendering-only change.

## Validation

All runs were targeted headless unit tests, with no stopped runs or full suites:

- Initial queue/lighting change: 3 files, 28 tests passed.
- Added replacement-group checks: 5 files, 35 passed and 4 failed. The color fixture lacked
  the parcel-arrangement dependency now used by slicing; the fixture was updated to use it.
- Updated fixture and staged-color check: 5 files, 40 tests passed.
- Added aborted-replacement check: 5 files, 41 tests passed.

Final command, from `backend`:

```sh
npx vitest run --pool=threads --maxWorkers=2 test/three-scene-work.test.js test/three-scene-readiness-wiring.test.js test/three-mode-lifecycle.test.js test/three-building-colors.test.js test/three-mode-uploaded-model-preview.test.js
```

Dedicated headed browser verification used a temporary, browser-only 70 m building in Arlington,
normal motion, and a deliberately overlapping `buildingsLayerUpdated` notification. Across 300
captured render calls, the proposal retained the same five mesh/line objects, with zero removals
and a maximum of one building-work traversal in flight. The first frame already had the sun's
position rather than the default entry light. This checks lifecycle and frame contents, not FPS.

The complete shared-camera preview URL was also opened separately. Frontend 5092 and backend
4092 were verified to run this checkout; the browser resolved the intended backend and
`arlington_va`. Scene readiness reported 667 nearby buildings, no failure or pending reasons;
the real road endpoint returned HTTP 200 and 289 features. The Life group was visible and
reduced motion was false. The final screenshot was visually inspected.

The shared `three-mode.js` also contains another task's inspector edits. Its mixed working-tree
changes are intentionally left uncommitted; the refresh helper, tests, and this record are owned
by this task.
