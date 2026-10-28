# Silent road-node placement — 2026-10-26

## Reproduction

The reported screenshot showed the 2D road tool near Garrison Lane Park, Birmingham. The supplied design was `bafkreidbnz3u72swfx3l34qfzrvejuuvmxyhyhdflw5dcogzw3yo3z24me`.

In a dedicated headed Chrome, a real mouse click on observed OSM building `w77765918` reached its SVG footprint but never reached Leaflet's map click handler. The building's inspector handler stopped propagation and then called the click stack. The click stack correctly declined selection because road drawing was active. The result was neither a node nor an error: the placement handler had never been called.

A subsequent park click placed the first node. Clicking the building again left the drawing at one node, with no pending placement and no unhandled exception. This distinguished the reported failure from obstacle validation or a stalled footprint request.

## Fix

Road and track drawing share `roadDrawingMode`. Selection handlers now check that flag before stopping propagation, allowing normal Leaflet bubbling to deliver the click to the drawing tool. The affected paths are:

- Observed building footprints in `map-core.js`.
- Ordinary parcel selection in `parcels/ui/parcel-selection.js`.
- Park, square and lake claim surfaces in `structures.js`.
- Selected unapplied design previews in `proposals/layer-render.js`.
- Immutable cadastral clones in `proposals/claims-ui.js`.

Ordinary inspection, MapPick and proposal browsing retain their existing behavior. Applied road hit targets already forward drawing clicks explicitly because their layers disable bubbling; they required no change. Draft strip and marker panes are noninteractive.

This restores the existing tool-ownership contract. It does not relax obstacle rules or change authored road geometry. Buildings encountered by a drawn edge are recorded and reviewed at Finish.

## Verification

Repeating the formerly blocked click in the real Birmingham view placed the second node, rendered the road, and reported **“1 building in the way — you decide at Finish.”** The building pool identified the source as `osm-footprints`. The browser resolved the explicitly supplied production API, and a fresh GET for the supplied design returned 200. The frontend listener served this checkout with no-store headers. No public design was changed or published.

Targeted runs, in order:

| Test type | Scope | Result |
| --- | --- | --- |
| Headless unit | New click-ownership file, first four handlers | 1 file, 4 passed. |
| Headless unit | New click-ownership file including cadastral clone | 1 file, 5 passed. |
| Headless unit | Click ownership, frontend map behavior, map edit lock | 3 files, 28 passed. |
| Headed Playwright | Road and track click delivery | 2 failed at cleanup: all four node-placement assertions passed, but the test omitted the existing discard confirmation. |
| Headed Playwright | Same road and track cases with corrected cleanup | 2 passed. |

The final headless command, from `backend/`:

```sh
node node_modules/vitest/vitest.mjs run test/road-drawing-click-ownership.test.js test/frontend-map-performance.test.js test/map-edit-lock.test.js --maxWorkers=2
```

The final headed command, from `e2e/`:

```sh
BASE_URL=http://localhost:5398 node node_modules/@playwright/test/cli.js test tests/road-drawing-click-ownership.spec.ts --headed --workers=1 --reporter=list
```

The headed cases use actual mouse clicks and real interactive building, park, parcel and cadastral-clone renderers. They assert the clicked building/park pane, delivery of each map click, increased node counts and completed placement. No full suite was run or stopped. Dedicated audit browsers were closed after verification. No deployment or push was requested.

The bounded static click-handler audit and headless handler regressions used the existing `gpt-6-luna` worker at low reasoning; the primary agent handled reproduction, source fixes, browser coverage and Git.
