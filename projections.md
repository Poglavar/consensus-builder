<!-- Design of record for metric geometry anywhere on the globe: the construction frame, the publish
     artifact, binding accuracy and the test matrix. Agreed between two model reviewers over four
     rounds on 2026-10-10; implementation follows this document. -->

# Projections: correct metres everywhere on the globe

## The bug that forced this

A road corridor (centre line + 19 m cross-section) came out 28% too narrow when the app was opened
without a city. Every "metre" in the frontend goes through one pair (`wgs84ToHTRS96` /
`htrs96ToWGS84` in `map-core.js`) that projects into the ACTIVE city's metric CRS. With no stored
city the app is in New York, so Zagreb was measured in UTM 18N, 91° from that zone's meridian, where
the scale is 1.39. Measured: 19 m → 13.65 m. The same mechanism makes explore mode freeze its UTM
zone at page load, opens proposal links in whatever city is active, and silently treats degrees as
metres when a projection is missing. The backend widens road centre lines in Croatia's EPSG:3765 for
every city without a parcel provider (explore, Ljubljana, Belgrade, Buenos Aires).

## 1. Contract

- **Metres are distances on the WGS84 ellipsoid**, not terrain distances. Every projection string
  states `+datum=WGS84`.
- **Construction tolerance:** scale error ≤ 5e-5 (≤ 1 mm per 19 m) over the whole operation extent.
- **Same recipe + same frame** must reproduce a footprint within 1 mm after representation
  normalisation, with equal components, holes and topology. 2 cm is a separate dimensional sanity
  limit (profile width vs footprint width).
- **Supported domain:** latitude |φ| ≤ 85° (a product boundary, just inside Leaflet's 85.05°), and
  the geodesic diameter of the GENERATED footprint (widths, joins and buffers included) ≤ 60 km.
  Applied consistently to imports, APIs, links, editing and generated output; outside it the
  operation is refused with a clear message.

## 2. The construction frame

- Everywhere — browser and server, every city including Croatia, explore mode — construction uses a
  **local transverse Mercator, k₀ = 1, centred on the operation's canonical anchor**
  (`+proj=tmerc +lat_0=<anchor lat> +lon_0=<anchor lon> +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m`).
  Measured against a Vincenty oracle: < 0.5 mm per 19 m at Zagreb, New York, Quito, Sydney,
  Reykjavík, Svalbard (78°N), an equatorial UTM zone edge and 179.99°E; 0.8 mm at 60 km from the
  anchor. UTM's own zones err by 1–18 mm per 19 m (0.1% at an equatorial zone edge); HTRS96 reaches
  4.4e-4 at Pula. City configuration never influences construction, so adding or changing a city
  cannot change geometry.
- **Canonical anchor:** derived from the AUTHORED inputs only (centre-line vertices, the drawn site),
  never from a generated polygon. Longitudes unwrapped by shortest arc from the first vertex;
  canonical ring start, winding and multipart order are fixed before the midpoint of the unwrapped
  bbox is taken; rounded to 1e-6°; identical for ±180° representations. Output is rewrapped to
  [−180, 180] and antimeridian-crossing polygons are cut per RFC 7946 §3.1.9.
- **Frames are explicit values**, created once per operation and threaded through as dependencies
  (the `deps` pattern `corridor-geometry.js` already uses), frozen for the whole operation: an edit
  session, the apply of a plan, a server materialisation. Never a context stack, never the viewport.
  During an edit the full current extent is checked against the frozen anchor (a small building
  dragged 1,000 km is small but out of frame); exceeding the domain requires re-preparation.
- The global pair `wgs84ToHTRS96` / `htrs96ToWGS84`, `exploreProjection` and city-driven metric
  selection are **deleted**, not wrapped, so no caller can fall back to the active city's CRS.
  `local-frame.js` (fixed 110 540 m/° — 0.5% off at 45°) becomes an adapter over the frame module.
- **Dataset CRSes** (EPSG:3765 for Croatian cities and the Ljubljana table, 32634 for Belgrade, …)
  are permitted for dataset I/O, indexed candidate search and bounded-error intersections; never for
  construction or metric erosion.
- Point-to-point measurement uses an ellipsoidal inverse (no projection). Bounded gestures (snapping,
  clearance) use a frame anchored at the gesture's first point with the distortion guard. Viewport
  dependence is permitted for presentation, screen hit-testing and viewport data queries (rendering,
  camera control, visible-area fetching); construction, metre-based snapping, clearance checks and
  measurement remain independent of the viewport.

## 3. One construction path, one committed artifact

- Corridor construction (per-segment rectangles, joint wedges, per-segment profiles, union,
  levels/tunnels) is extracted from `road-drawing.js` / `corridor-geometry.js` /
  `proposal-road-geometry.js` into **one shared pure module** (UMD, node-loadable), used by the
  browser for previews and by the server as the authority.
- **`POST /proposals/prepare`** (new, idempotent, same binding implementation as
  `/proposals/binding`) materialises from the authored inputs in the canonical frame, validates
  domain and topology, computes the binding and site hash, and **signs the prepared artifact**
  (HMAC over its digest and the time of preparation, with the server's `PREPARE_SIGNING_KEY`),
  storing nothing — an unbounded free call that wrote a row each time could fill the disk (owner's
  decision, 2026-10-11). The artifact's digest covers the canonical geometry, the construction
  recipe and algorithm/dependency versions (proj4, clipping), the binding and the cadastre
  revisions it was bound against; the record carries the signed reference and the artifact to its
  publication.
- Metadata upload, minting and `POST /proposals` all reference that exact artifact (today the client
  uploads metadata and mints before the server sees anything, `proposals/create.js`). Publication
  verifies the signature and stores the prepared artifact itself, in the same statement as the
  record, so only published proposals' artifacts are kept; re-derivation at publish only VALIDATES it (≤ 1 mm, equal
  topology, 422 otherwise) and never replaces it after minting — a 0.16 mm shift across a rounding
  boundary already changes the site hash (`proposals/site-hash.js`). Validation at finalisation
  uses the prepared artifact's own pinned algorithm/dependency versions and source revisions (or
  its retained source inputs), which is what makes finalisation idempotent across retries,
  deployments and cadastre updates; every publication entry point, agents and retries included,
  carries the preparation reference.
- **Re-anchoring after an edit** is a new preparation on the final authored inputs; the
  whole-footprint displacement and topology against the preview are verified and shown before
  publication. Edits to published records remain forks, as everywhere else.
- **Provenance** is persisted on every procedurally built record:
  `constructionFrame { kind: 'local-tmerc', anchor, proj, algorithm, versions }`. The server derives
  and validates it; a client-supplied projection string is never accepted as-is. Published polygons
  stay authoritative for replay (`proposals/apply/road.js` already prefers them).
- **Publication city** (M8): a new publication belongs to the city its site lies in — the cities
  whose parcels cover the site's anchor (each city's declared live area, and a countrywide-live
  country) — never to the view it was drawn from. A site in another city on the same cadastre is
  filed there; a site only another city's cadastre covers is refused; outside every live area the
  requested city's own source decides. Stored records keep their city.
- **Cut-over** is enforced structurally only: supported protocol/algorithm version, present AND
  valid provenance, a valid preparation reference. A client build id is diagnostics and an "update
  the app" hint, never a correctness gate. Steps 3 and 4 below ship as one release boundary.
- **Errors propagate.** The frame module throws on non-finite or out-of-domain input; unions and ring
  conversions never filter out nulls (today `proposal-road-geometry.js` drops failed vertices and
  returns one surviving operand). A failed step aborts the operation and keeps the prior committed
  state; an empty result is distinguished from a failure; tests prove a partial corridor can be
  neither prepared nor published.
- **Legacy** polygon-less road rows (159 locally, ids 1–294) are flagged by a one-off migration with
  stored provenance (`legacy-centreline`). Only flagged rows use the approximate geography-buffer
  footprint; a new submission cannot enter that path by omitting its polygon.

## 4. Binding accuracy

- **Budget: 1 mm combined** on intrusion width, across projection, transformed-edge approximation,
  clipping, snapping, bisection and output rounding (the binding floor is 1 mm with a default
  tolerance of 0, `proposals/site-binding.js`; two opposing boundaries each off by 1 mm move a width
  by 2 mm).
- Candidate search and intersections may run in the dataset CRS with adaptive subdivision of
  transformed edges (stopping criterion derived from the CRS pair and domain; 50 m only as an initial
  maximum segment length; planar source edges are never resegmented along great circles). Metric
  erosion (`toleranceM`) runs in the operation frame via the canonical projection string.
- When the uncertainty interval straddles a binding threshold the computation is refined; if it
  cannot be resolved the result is reported as **unresolved** and the publication refused — never
  silently classified as absent.
- The bbox API takes WGS84 with an explicit `crs` parameter; the server densifies the boundary before
  transforming into the dataset CRS and splits queries at the antimeridian (`getBboxFromBounds` today
  sends the active metric CRS labelled as 3765).
- `routes/parcel-lj.js` keeps 3765: its table IS stored in 3765 (checked in `geometry_columns`);
  Belgrade 32634 likewise.

## 5. Determinism of derived pieces

Identical inputs give identical fabric: materialisation version; pinned proj4 (frontend 2.21.0 and
backend 2.22.0 today — aligned) and clipping/tessellation dependencies; canonical longitude, ring and
multipart representations; stable proposal order with deterministic tie-breaks; complete operands
before commit (no fetch-order dependence); computation scopes derived from the authoritative inputs
independent of batching (no batch-wide anchor); identical results for cold reload, cached reload,
sequential and batch apply of the same plan. The cadastre revision is part of the inputs: drift is
detected and reported, never hidden. Piece ids are hashes of outlines and are not durable foreign
keys (`proposals/parcel-arrangement.js`).

## 6. Scope

In scope: every stored-geometry authoring path, including the Mercator-built ones
(`single-building-geometry.js` translate, `row-house.js` drag autosave, `building-blocks.js` and
`reparcellization-slice.js` via local-frame, `proposals/gain.js` dedup distance). Deferred as its own
task: 3D rendering scale only (`three-mode.js` scene XY in EPSG:3857 vs true-metre heights — visual,
not stored).

## 7. Production audit

Read-only, started alongside the first fixtures: for each road record take perpendicular transects
through straight isolated sections, measure both boundary intersections on the ellipsoid, and report
width ratios and extremes grouped by location, creation date and declared city. Variable profiles,
junctions, tunnels, clipped footprints and polygon-less records are handled separately. A
city/location mismatch is evidence to investigate, not proof. Corrections are reviewed forks; the
originals stay. (A first area/length screening of 244 local road records found no 0.72 signature.)

## 8. Tests

Headless, throughout, with an ellipsoidal oracle (Vincenty): a 10 m and a 19 m offset measure true
at Zagreb, New York, Sydney, Reykjavík, Quito, Svalbard, an equatorial zone edge and 179.99°E, with
east–west displacement and every corridor orientation; round trips; refusal outside the domain;
preparation/publication identity; a partial corridor cannot be published; SQL parity with the shared
module; binding threshold behaviour; the 22-proposal plan applied, unapplied and reloaded identically.

Browser matrix, last, in this order: publication identity and source selection when authoring outside
the active city (explore and custom sources included); direct proposal links with fresh and stale
storage, a conflicting `?city=`, an unknown city, mixed-city plans (`world/proposal-entry.js`
supplies the current city today); storage isolation A→B→A under the existing reload contract
(`persistent-storage.js` binds a scope once); late asynchronous responses after switching location
or source; explore and navigation state (`?at=` precedence, reload, back/forward, stale focus
params); city-specific overlays and dataset grid units.

## 9. Order of work

1. Contract and failing fixtures with the oracle; start the production audit.
2. Frame module (pure, UMD, node).
3. Shared construction module; `POST /proposals/prepare`; preparation before minting; validation at
   publish. 4. Delete the global pair, thread frames through corridor/site/measure/local-frame
   callers, propagate errors. (3 + 4 are one release boundary.)
5. Bbox / dataset-CRS API, antimeridian splitting.
6. Routing, parcel-source and storage correctness (frames never follow the viewport).
7. Finish the audit. 8. Browser matrix. 3D rendering scale: separate task.

## 10. Implementation status

Milestones, each green before the next. Updated as they land.

| # | Milestone | Status |
|---|---|---|
| M1 | Frame module (`frontend/js/metric-frame.js`), shared corridor construction (`frontend/js/corridor-footprint.js`), ellipsoidal-oracle contract tests, proj4 2.22.0 in browser and backend | done 2026-10-11 |
| M2 | Construction output densified so straight-in-frame edges stay within budget when read as straight lon/lat edges | done 2026-10-11: ≤ 50 m pieces; an undivided 2 km edge at 60°N bowed 13.5 cm |
| M3 | Server binding in the operation frame; candidate search in the dataset CRS; 50 m planar segmentisation before transform; `unresolved` outcome near thresholds | done 2026-10-11: PostGIS in the frame with 64-segment arcs (band 1.5e-4·r); the turf rule for providers and the preview keeps its own 0.35 % band; 60 real sites decide identically, large intrusion widths now correct (the 8-segment arcs overstated them by up to 0.48 %) |
| M4 | Prepared artifact: `proposal_prepared` table, `POST /proposals/prepare`, digest, publish verification on every publication route; legacy polygon-less rows flagged | done 2026-10-11: content-addressed artifact (`backend/proposals/prepare.js`), signed at preparation with the server's `PREPARE_SIGNING_KEY` and stored only at publication, beside the record in the same statement (`consensus.proposal_prepared`, never updated; `deploy-backend.sh` refuses a server without the key), `POST /proposals/prepare` + `/agent/prepare` store nothing; a corridor with a centre line is refused unprepared (422 `preparation-required`) on the free and paid routes, any record carrying `preparation` is verified (inputs digest, declaration, tolerance, city, source, land, frame; re-derived to 1 mm at the pinned versions) and stores the artifact. `scripts/flag-legacy-centreline-roads.mjs`: 158 local rows flagged (1 skipped: violates the parcels-or-site constraint); production: 21 rows flagged on 2026-10-11, once, by hand from a checkout of 81ea46d3 ahead of the deploy (ids 2–5, 10, 11, 13, 55, 106–118; none blocked; a rerun changes nothing), so `deploy-backend.sh` does not run it |
| M5 | Browser create flow, scripts and agents publish through prepare | mostly done 2026-10-11: the browser prepares before every mint (create dialog, share dialog) and every upload (`publish-binding.js` `prepareForPublish`; a minted record publishes the preparation it was minted from), mints the artifact's site hash and declaration, asks before publishing corridor land > 5 cm off its preview, and keeps the published artifact locally; the scripts' `publish()` (Candlestick, Borovje v2/v3) prepares; agents publish no corridors. Browser-checked in a real page against the local API: a Zagreb street lands 0.49 mm from its preview with Zagreb active and 1.83 m with New York active (the author is asked); a real publish matched its artifact field by field. `scripts/import-transit-project.mjs` prepares each track in-process (its land was a Croatia-only 3765 buffer; a dry run rolls back; project 141: 3 acquiring spans, 661 parcels). **Open:** the v1 `rekonstrukcije/upu-borovje/build-and-upload.mjs` is superseded and already refused (retired `parentParcelIds`); preparation is required only for corridors until the agents (another session's code) call `/agent/prepare`; the full draw → create → mint click-through belongs to M10 |
| M6 | Global metric pair deleted; frames threaded through every metre site; errors propagate | done 2026-10-11: `wgs84ToHTRS96`/`htrs96ToWGS84`, `getMetricCrs`/`latLngToMetric`/`metricToLatLng`, explore's UTM zone and every city's `metricCrs`/`metricDefinition` deleted (guard: `backend/test/no-city-metric-projection.test.js`). The browser builds a corridor's land with the shared construction (`corridor-footprint.js` `footprintOfArms`/`footprintIn`; the old union builders and their swallowed failures are gone): a drawing session freezes one frame, a placed corridor uses `frameForDefinition` (its provenance, else its own centre line), and the editor, 2D/3D renderers, edge fill, junctions (cross-corridor ones per contact group) and animation take that frame explicitly. Measurement is ellipsoidal; parcel tools use one frame per operation; `local-frame.js` is the ellipsoid's affine tangent plane (kept affine for the slicer); the building editors move and rotate in true metres. Browser-checked: a street drawn while New York is active is stored 7.5000 m wide (was ~5.4 m) and byte-identical to the shared construction; editor, clearance tab and 3D render it without errors |
| M7 | Bbox API in WGS84 with explicit CRS; antimeridian split | done 2026-10-11 for the mislabelled bbox: `getBboxFromBounds` (the active city's metres labelled 3765) is gone; third-party services get `bboxInCrs(bounds, 'EPSG:3765')` (densified, CRS named), our `/osm-road` takes `bbox=…&crs=EPSG:4326` and transforms server-side, split at the antimeridian (`parseWgs84Bbox`). Parcel grid endpoints keep their source's dataset CRS by design (cells are dataset units) |
| M8 | Routing, parcel-source and storage correctness | done 2026-10-11, headless (the browser matrix is M10). **Publication identity:** a new publication is filed under the city its site lies in, never the view's (`backend/proposals/publication-city.js` over the globe's coverage, `world-coverage.js` `liveCitiesAt`): a site in another city on the same cadastre moves there (a Split site sent as `zagreb` is Split's; the artifact keeps `requestedCity`, and either city publishes it), a site only another city's cadastre covers is refused 422 `site-in-other-city` (a Zagreb street drawn with New York loaded; explore inside a live city); the binding preview places the same way. **Routing:** cities compare the data they read — cadastre source id and building source (`getCadastreKey`, `getPlaceDataKey`), not the provider kind 187 catalogue cities share — and the nearest city owns a place (the 40 km rule kept San Francisco over Oakland); unknown city ids neither dead-end nor reload forever; share links name every city; a switch goes to its target address, keeps the page left for Back and clears every route; a globe pick of a spot lands on it; use-my-location navigates. **Storage:** a record is imported only into a store on its own cadastre (`foreignCityFor`), and every link, list, search, bet and feed path sends another city's proposal to its city (`openProposalInItsCity`); a mixed-city plan refuses foreign members before fetching ground; the chain syncs add only this city's minted proposals and keep a position per city; a new drawing never takes over another draft; an unfinished drawing is kept as a draft on a switch; the city language waits for stored values. **Late responses / sources:** choosing a fallback parcel source reloads instead of mixing two parcel sets; a Schelling plan is laid out per latitude band (ids a stranger starting there derives); a route that ends early gives the parcel fetch back. Fixed a regression of M7: the EPSG:3765 bbox is computed only for the Croatian building services (it stopped Bogotá's buildings). **Follow-ups, done the same day** (owner's request): preparation is signed and stores nothing (M4); every record has a known city — `backend/scripts/fill-proposal-cities.mjs` placed the 14 local ones without (13 Zagreb, 1 Šibenik; production had none), a request naming no city is placed where its site or parcels are, and the browser places a city-less record by its parcels; minted metadata names the city and chain imports read it; the address follows the map (`?at=` on every move, `addressWithView`); the multi-tab guard is per database (a tab in another city stays writable) and a read-only tab's apply writes nothing shared but parks the change. Browser-checked: a street prepared in the page publishes with its signed artifact (stored beside the row, not in it); a pan rewrites `?at=` and a reload lands on it; a second Zagreb tab goes read-only, a Split tab does not. **Still open:** the drafts store is one localStorage blob shared by all tabs and cities (last writer wins; pre-existing) |
| M9 | Read-only production audit (perpendicular transects) | done 2026-10-11. Widths (`backend/scripts/audit-road-widths.mjs`): no wrong-frame signature in 241 local or 173 production road records; every ordinary record measures its own city's projection scale; outliers are OSM parking areas, the Borovje band records and official-plan footprints. Cities (`backend/scripts/audit-publication-cities.mjs`, every record placed by the M8 rule): production 527 records — 523 in their city, 2 Split sites filed under Zagreb (same cadastre: listing only), none bound against another city's cadastre; local 889 — 847 same, 4 moved (Zagreb → Split), 14 with no or a placeholder city, and 6 published from explore at Tokyo, a live city (bound as open ground; local rows only, ids 1348–1358). Corrections, if wanted, are reviewed forks |
| M10 | Browser matrix | done 2026-10-11 in a headed Chrome (agent-browser) against the local servers: a Zagreb street drawn with New York loaded is refused at preparation with the translated sentence naming Zagreb, nothing stored; a Split street drawn from Zagreb's view prepares as Split's (Zagreb kept as the requested city, 25 parcels, land 0 m from the preview); a Zagreb proposal link carrying `city=new_york` asks first, writes nothing to New York's store, and opens in Zagreb on "Open in Zagreb"; A→B→A keeps each city's work to itself; Back after a switch returns to the city left; Bogotá loads its own buildings (340) and parcels again; no page errors. With M6 (drawing, editor, 3D in the corridor's frame) and M5 (a real publish matched its artifact). Left to the headless tests: late answers after a source switch (now a reload), use-my-location, Schelling bands, unknown plan cities, the chain syncs |
