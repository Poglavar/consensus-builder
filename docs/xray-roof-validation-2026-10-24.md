# Digbeth x-ray roof rendering

Branch: `colosseum-worlds-fair`.

The second Digbeth shared design set showed striped roofs with `xray=1`,
`suggested=1` and `proposedForm=both`. Raycasts through the striped roof hit
the warning volume and the translucent envelope at the same 9 m elevation.
Both materials used the same polygon depth bias. The envelope now has lower
depth priority in its color and invisible depth passes; neither geometry moves.

The Canal Crown generated floor model also created eight full-footprint proxy
bands between its independently rounded floors, ranging from floating-point
residuals to 1 mm. Floor coverage now tolerates joins within 2 mm, including the
ground and roof boundaries. Genuine uncovered storeys retain their proxy. The
previous roof-only 2 mm height subtraction is removed.

## Verification

Headless unit tests, with one worker:

1. `npx vitest run test/building-floor-plans.test.js test/three-floor-plans.test.js test/three-xray-wiring.test.js --maxWorkers=1`
   — 40 passed, 4 failed. The existing x-ray rebuild harness lacked
   `nearbyBuildingsRevision`; the new regression tests passed.
2. Same three-file command — 40 passed, 4 failed. After adding the revision
   fixture, the same harness exposed a missing `refreshClickStackFigures` stub.
3. `npx vitest run test/three-xray-wiring.test.js --maxWorkers=1`
   — 18 passed after bringing the harness up to date. The other two files had
   passed all 26 tests in both preceding runs and were unchanged afterward.

No full suites ran, and none of these runs was stopped.

Headed Chrome visual inspection used the local frontend and published Digbeth
designs from the public backend. The supplied camera and a lower camera angle
show clean warning roofs and visible floor interiors after a fresh reload.
Scene inspection found zero tiny proxy bands, down from eight. Massing material
depth bias is 2 and building material depth bias remains 1, including clones.
Screenshots are local diagnostic artifacts; no frame-timing claim is made.

This is a rendering change. Published design geometry, dimensions and storage
contracts are unchanged. No deployment was performed for this task.
