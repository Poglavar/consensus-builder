<!-- Current implementation and verification of camera flights and shared apartment interiors. -->
# Camera flights

The model-view camera button opens the flight editor. Its initial point captures the current
camera. Move with WASD, rise/lower with R/F, roll with Q/E, and aim with the arrow keys or pointer
drag. Alt-drag rolls. Touch controls offer the same movement and aiming actions. Flight motion
passes through obstacles. Level horizon is an explicit action.

Add view captures position and orientation. Numbered points support selection, update, height,
travel/hold time, reorder and removal. Overview shows the path and draggable nodes while keeping
the recorded camera separate. Look directions contains independent look keys and timed spins.
A full turn inserts intermediate quaternion keys so matching endpoints retain the turn.
View changes adds timed x-ray, generated-layout and floor-cutaway cues.

Play, pause, stop and scrub use one absolute-time evaluator. Undo/redo covers authored changes;
the title and local draft are saved on this device. Share flight requires every applied design
to be published already, then verifies publication and a durable readback before showing a link.
The read-only player restores exact design membership, settings and interior snapshots, with no
autoplay. Edit a copy opens a private editable version.

Find interiors uses visible registered floor geometry. Select an apartment and Enter apartment
to place the camera inside it; capture that position as any route point to start or finish there.
Explore apartment loads walking on demand. Back to flight restores the captured flight camera.
The player offers exploration only when its camera is inside a retained unit and the current eye
position is walkable. Missing unit boundaries expose a floor entry, without inventing apartment
identity. A unit with invalid placement or no walkable entry reports the problem.

## Record and ownership

`frontend/js/camera-flight.js` is the DOM-free `camera-flight/v1` validator and evaluator.
Its strict schema includes sorted design CIDs, initial model view, frame, route, look keys,
interior snapshots and view cues. Limits are 256 route points, 4096 look keys, 256 cues,
64 interiors and 600 seconds. The horizontal frame is the existing local transverse Mercator
anchor in east/north metres, bounded to a 60 km radius. Z is true metres above flat model ground;
it is not sea-level elevation. FOV is fixed per flight between 20 and 100 degrees.

Position follows centripetal Catmull–Rom interpolation with a per-segment arc-length table.
Compilation rejects curved paths leaving the frame bound, including overshoot between points.
Orientation interpolation is independent. Repeated seeks are independent of frame cadence.
The scene adapter converts projected horizontal axes and full quaternion orientation, retaining
true vertical metres and suitable near/far planes.

The host grants one explicit camera lease. Ordinary orbit, auto-rotation, clipping updates and
map picking yield to the lease. Playback, free-camera editing and walking share the existing
renderer and frame hooks. Pause/idle unregisters unnecessary work; hiding the page pauses
playback. Disposal removes hooks, listeners, owned route/snapshot resources and returns camera,
controls and view settings. Asynchronous loads and view cues have cancellation/version guards.

Interior snapshots freeze architectural geometry and geographic registration for playback.
They retain generated status and source revision when present, independently of authored floor
models. Unit extraction retains real door/window geometry, source entry coordinates and floor
heights. Buffered crops include boundary walls; collinear seam spurs are removed before geographic
buffering so a generated union cannot collapse a crop to the spur.

## Shared viewer

`packages/interior-viewer` owns the geometry, meshes, navigation, walking, people and presentation
source. See its README for the attachment and standalone APIs. Build with
`npm --prefix packages/interior-viewer run build`; esbuild comes from the backend lockfile.
Three.js, placement, data and labels come from the consumer.

Normal model rendering loads only scoped geometry and mesh artifacts. Flight/player/editor code
is lazy. The full `interior-viewer.js` artifact loads only on requested walking. The companion
catalogue uses that identical artifact via six small adapters; its SHA-256 receipt records the
version. It remains the owner of data loading, Croatian labels, solar controls and room UI.
Embedded attachment preserves the host renderer/environment and starts no separate loop.
Standalone attachment owns and disposes its renderer, controls and one demand frame loop.

## Storage and deployment

`POST /flights` accepts `{content: record}`; `GET /flights/:cid` returns `{cid, content}`.
The backend validates schema, floor models and compilation before pinning, verifies canonical
content addresses, requires all referenced designs to exist, and verifies stored readback.
The 10 MiB publication limit includes interior snapshots. Invalid records return 400, unknown
flights 404, missing designs or exhausted pinning quota 409, and unavailable storage 503.
No credentials or upstream request bodies are returned in storage errors.

`backend/db/camera-flight.sql` creates `consensus.camera_flight`; deployment runs this additive
DDL before API restart. `/flights/<cid>` is a frontend entry route. Existing generic nginx SPA
fallback already serves it. Backend selection is transport configuration and is excluded from
flight content. Existing experimental drafts are validated against the single current contract;
there is no compatibility reader or data migration.

## Verification

- Ten new targeted headless unit files: 177 passing before the real-data crop regression; the
  affected crop file then passed all 14 tests, giving 178 new passing cases in total.
- Six targeted headless Playwright scenarios passed: lazy loading, two captured views, phone
  edits/undo/reorder, independent spins/cues, playback/scrub/control restoration, durable sharing
  into a fresh browser, and apartment walking/return. Publication uses a spec-local durable API
  fixture; no production flight was published.
- Nine affected companion headless unit files passed, 118 tests, including artifact integrity,
  HTTP delivery, architectural geometry and walking/presentation behavior.
- Existing affected headless unit files for map sharing, named plans, route parsing, floor plans
  and x-ray wiring passed. Two existing world-entry assertions fail identically at the base
  revision: the old expected building source and retired Activity action names. They are outside
  the flight implementation.
- Three further targeted headless unit files passed, 25 tests, for generated layouts, duplicate
  classic globals and home-path guarding. The frontend route file passed all 41 tests after
  adding valid/malformed flight-link cases.
- A dedicated headed browser verified the real 17-design Digbeth composition through the local
  API, with 214 real source buildings returned in the tested bbox. The browser resolved the
  intended backend. Flights completed both outside-to-apartment and apartment-to-outside;
  sampled host-frame poses moved along the route and ended at the saved positions. Walking
  returned exactly to the saved player pose; close restored ordinary controls. Dark-theme
  contrast was inspected and corrected. This is visual/state verification, not a performance
  benchmark. The local composition uses previously published local design revisions.

No full unit or browser suite, production publication, push or deployment was performed.

During targeted iteration, initial failures exposed a restoration clamp and the real irregular
unit crop; both have regression coverage and passing checks. Other failed/stopped browser
iterations corrected spec setup (collapsed disclosures, ordinary orbit input and a localStorage
seed on about:blank) or a diagnostic static server dropping asset connections. Runs used one
browser worker and stopped at the first failure while debugging. Two existing world-entry
assertions were separately reproduced at the base revision. No full suite ran.

The companion's real apartment page was also inspected in the same dedicated headed browser:
its shared geometry adapter, apartment rendering, localized walking/return controls and versioned
artifact URL worked without page errors. The local catalogue API returned seven projects and
110 apartments. Both consumers' full artifact bytes and the companion receipt match. The
verification browser was closed afterward.
