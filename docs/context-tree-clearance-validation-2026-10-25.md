# Context trees and designed roads

Branch: `colosseum-worlds-fair`.

The 3D context-tree renderer previously placed every point returned by
`POST /decor/near`, without checking applied designs. It now excludes tree bases
inside or on the boundary of an applied corridor's authoritative surface footprint.
It uses the shared proposal geometry reader's `road-definition` feature, including
disconnected pieces and junction geometry, rather than the observed site, source
parcel or a guessed centerline buffer. Polygon holes remain clear of the exclusion.

Source tree points are retained unchanged. The instance meshes are rebuilt after a
committed fabric change, so unapply restores those points and reapply excludes them
again without fetching scenery. Nearby trees keep their original positions and
deterministic appearance. Authored park and corridor trees use separate renderers.
This changes rendering, without changing published designs or source-tree data.

## Verification

All targeted checks passed; none was stopped. No full suites ran.

- Headless unit tests, from `backend`:
  `npx vitest run test/three-site-ground.test.js --maxWorkers=1`
  — 8 passed. Coverage includes inside/boundary/nearby trees, polygon holes,
  disconnected footprint pieces, multiple corridors, unapplied roads, source-point
  preservation, invalid coordinates, and rejecting unrelated site geometry.
- Headless Playwright, from `e2e`, against the temporary no-cache frontend:
  `npx playwright test tests/three-context-trees.spec.ts --project=chromium --workers=1`
  — 1 passed. The test draws and applies a road through a source-tree point and
  leaves another nearby point outside it, then unapplies and reapplies the road.
  Trunk/crown instance counts change from one each to two each and back without
  another scenery request or a change to the authored road definition.
- Headed Playwright, same single specification with `--headed`:
  — 1 passed. This run also verifies the retained instance's geographic position
  and captures the applied/unapplied views. The screenshots were inspected: the
  applied road has no context tree at the inside point, while the outside tree
  remains. The background browser closes with the test.

A separate headed inspection loaded the published Digbeth second-version scene
with the public backend. That response provided no visible context-tree instances,
so the visual exclusion check used the controlled scenery response in the headed
regression above. The dedicated inspection browser and temporary frontend were
closed. No deployment was performed.
