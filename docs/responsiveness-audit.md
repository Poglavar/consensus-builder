<!-- Runtime performance contracts and representative workloads for the Colosseum map and planning workflows. -->
# Consensus Builder responsiveness

## Lists and selection

The map badge and Designs list share the first page of the public index. The badge uses the API total plus local-only designs. The list displays 50 cards at a time. Search immediately filters the available records and then queries the public index by title, author or content identifier. Load more continues from each feed's own offset. Local records are indexed once per store revision and backend. An applied local copy has priority when several copies share an identifier.

The list reuses cards through search, sorting and selection. A selected row stays busy while its map preview is being read. Only the current selection may draw or open an inspector. Agreements and property offers load independently under the same tab. [Lists](../frontend/js/lists-panel.js) · [Design index](../frontend/js/proposals/design-sync.js) · [Design API](../backend/routes/designs.js)

## Opening the map

The production stage combines the map's styles in declaration order. The bundle, optional critic styles and locale dictionaries use content-derived URLs. Road drawing, the building-block dialog and individual critics load from their controls. Shared corridor geometry, keyboard shortcuts and progress indicators remain available to the map. The globe starts its coverage and Three.js core reads together. Model mode requests its additional loaders when needed. [Static build](../frontend/build-static.cjs) · [Optional tools](../frontend/js/optional-tools-loader.js) · [Globe](../frontend/js/world/globe.js)

A compact plan link verifies its plan and reads the same-origin application shell in parallel. Its saved city, language, layers and camera are restored before the application opens its workspace. Explicit URL settings take precedence. The app consumes the same verified plan for that backend and content identifier. [Compact entry](../frontend/js/plan-entry.js) · [View restoration](../frontend/js/named-plans.js)

## Plan stats, Compare and Apply

Plan stats opens with the plan title and exact member count when known. Compare opens with its columns in selection order and measures up to two at once. Authored figures, land classification and apartment layouts appear as their inputs become available. Closing the dialog cancels outstanding preparation and stops late results from repainting. Completed geometry can be reused for the same ground and scope. Prepared snapshots have a short freshness window and depend on the plan revision, backend, parcel sources and local store revision.

Analysis, private Apply and draft links share the same member binding. Browser providers receive members grouped by city, source and snapshot. Server-backed binding uses at most six concurrent member reads. Responses retain member order. Private Apply reports completed designs in a notice that stays visible when the plan panel closes. Cancel stops binding before any map changes. Once binding finishes, the existing progress dialog takes over while the ordered parcel mutation runs. [Plan analysis](../frontend/js/plan-analysis.js) · [Plan figures](../frontend/js/proposals/plan-stats.js) · [Apply](../frontend/js/plan-workspace.js)

## Map movement and editing

Building cell arrivals and removals publish changed footprint IDs. The 2D building layer processes them in animation-frame slices with an eight-millisecond work target. Global presentation changes can still reconcile the whole layer. Dog, Hare and Beaver take their panels' visible extent into account when framing an assessment. An explicit route or location control can still move the camera.

Road preview geometry follows the latest pointer event each frame. The price and acquisition difficulty share the underlying parcel measurements. Upload handlers await exclusive asynchronous writes before returning a stored model, image or metadata URL. [Building layer](../frontend/js/map-core.js) · [Critic camera](../frontend/js/proposals/critic-tour.js) · [Road drawing](../frontend/js/road-drawing.js) · [Upload storage](../backend/routes/file-storage.js)

## Representative workloads

- Use Alatau at 43.7984° N, 77.0911° E, zoom 16. In an empty workspace and then with Courtyard's 113 designs imported, search for “garden”, clear the query, and select Courtyard followed by Garden streets with the first read held back. Check the final result set, keyboard focus and the plan actually drawn.
- Open imported and published Courtyard in Plan stats. Compare the parcel counts, land and new buildings, then close a dialog while its inputs are pending. Measure time to the dialog and time to populated figures separately.
- Apply the private Courtyard plan from a fresh browser workspace, then unapply its members and repeat in the same tab. Time parcel binding and the subsequent map update separately. Hold a binding request to check that Cancel still works after closing the plan panel, leaves the authored map intact, and allows a retry.
- For cold startup use a fresh browser profile and the locally staged production build. Record the viewport, network latency and throughput, resource body sizes and readiness. For a compact 3D link count main-document navigations and backend plan reads separately.
- For dense footprint rendering start at 45.8116° N, 15.9786° E, zoom 18 in Zagreb. Pan 2,050 pixels east and back. Record full scans, incremental IDs processed and the longest rendering slice. A revisited cached viewport should incur no cell repaint.

Production latency percentiles, physical-phone GPU performance, wallet confirmation times and database query costs need their own measurements.
