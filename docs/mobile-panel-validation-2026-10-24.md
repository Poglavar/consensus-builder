# Mobile panels and 3D navigation

Branch: `colosseum-worlds-fair`.

Phone click panels now have a continuous glass backing, including the handle area.
The grip is 48 × 5 px inside its existing 44 px touch target. Context sheets fit
their content up to the height selected with the handle, so collapsing a section
shrinks the sheet even after manual resizing. Navigation lists keep their allocated
scrolling viewport so long lists of design cards remain usable.

The Designs / Activity / Bets navigation row is declared for the 2D map through
the existing mode-availability mechanism. It disappears in 3D and returns in 2D.
3D also releases its bottom clearance, retaining the device's safe-area inset.

## Headed visual inspection

A dedicated background Chrome used a 390 × 844 viewport and the real published
Digbeth second-version design set. The 3D click panel had an 80% glass background
and shrank from 422 px to 140 px when its Design section collapsed. The handle
remained visible. The navigation row was hidden and the sheet reached the bottom
of the scene. Returning to 2D restored navigation; the 2D click panel also had glass
behind the handle and shrank when collapsed. Local screenshots were retained as
diagnostic artifacts. The dedicated browser and temporary server were closed.

## Headless Playwright checks

Commands ran from `e2e` against a temporary no-cache frontend, with
`--project=chromium --workers=1`. Every run was targeted; no full suites ran and
none was stopped.

| Run | Files / filter | Result |
| --- | --- | --- |
| 1 | `tests/three-stack-sizing.spec.ts` | 7 passed, 1 failed: the short-content fixture's four headings and metrics exceeded the default half-screen cap. Updated the fixture to expand that cap before asserting natural content height. |
| 2 | `tests/map-shell.spec.ts --grep 'phone sheets shrink\|bottom navigation disappears'` | 2 failed: the section test needed room above the default cap; incomplete script downloads also caused startup errors. |
| 3 | `tests/three-stack-sizing.spec.ts` | 8 passed, covering desktop and phone content sizing, scrolling, glass, handle size and collapse after resizing. |
| 4 | Same two `map-shell.spec.ts` tests | 2 failed during startup because the temporary Python server did not deliver all scripts. Replaced it with the repository-configured Node server and verified `Cache-Control: no-store`. |
| 5 | Same two `map-shell.spec.ts` tests | 2 passed: Layers shrinks on collapse; navigation disappears in 3D, releases its clearance and works again in 2D. |
| 6 | `tests/mobile-map-designs.spec.ts tests/on-map-editor-shell.spec.ts --grep 'Designs gives most\|320px block editor resizes'` | Editor resizing passed; Designs failed because its nested scrolling body lost its allocated height. Retained a fixed viewport for navigation lists. |
| 7 | `tests/mobile-map-designs.spec.ts --grep 'Designs gives most'` | 1 failed: the common sheet selector overrode the list-specific height. Routed that height through the common rule's custom property. |
| 8 | Same single Designs test | 1 passed, including card scrolling and reachable actions. |

The final relevant results are 12 passing checks: eight sizing checks, two shell
checks, one editor check and one design-list check. No deployment was performed.
