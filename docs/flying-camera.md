<!-- Current implementation and verification of camera flights and shared apartment interiors. -->
# Camera flights

The model-view camera button opens the flight editor in **orbit mode**: the ordinary map controls
move the camera, and **Add view** records the camera exactly as it is, position and direction.
Views are numbered. The camera flies a smooth curve between views at the flight's **cruise speed**;
a view can override its travel time, hold for a while, and turn a whole number of times about the
vertical (or pitch/roll about itself) during that hold. **Use current view** replaces the selected
view with the camera as it is now. Flight motion passes through obstacles.

One **flight timeline** strip shows every numbered view at its arrival time, holds as bars (dashed
when they turn), looks between views as diamonds, view changes as ticks, and the playhead. Clicking
a view marker or a route-list entry selects that view and seeks to it. The range slider scrubs.

**Free camera** switches to the fly mode: drag to look, WASD/R/F/Q/E to move and roll, Shift for
speed; **Fine camera controls** holds step buttons, numeric yaw/pitch/roll and the free-camera
speed for phones. **Show whole route** frames the path from above in orbit mode. **Level horizon**
removes roll. Entering an apartment or applying a numeric aim leaves orbit mode, because orbit
controls would otherwise re-aim the camera at their target.

**Looks between views** are optional: scrub to a moment strictly between two views, aim, **Add look
here**. A look is anchored to the segment that departs a view, at a fraction of that segment, so it
moves with its views when the route is edited or retimed and disappears with its view. **Save x-ray
change at this view** records the current x-ray / generated-layout / cutaway settings as a cue that
applies from the selected view's arrival; one cue per view.

Play, pause, stop and scrub use one absolute-time evaluator. Undo/redo covers authored changes;
the title and local draft are saved on this device. Share flight requires every applied design
to be published already, then verifies publication and a durable readback before showing a link.
The read-only player restores exact design membership, settings and interior snapshots, with no
autoplay. Edit a copy opens a private editable version.

**Automatic flight** writes the route for you. *Fly around* chooses one applied design (the one in
design view, when there is one) or the whole plan. **Generate flight** replaces the route, looks and
view changes as one undoable edit; **Try another** reruns with a random seed.

- One design: the camera starts well outside and flies in, then orbits 1¼ times from about
  2.2× its height down to about half its height, every view aimed at the design's mid-height. A
  design without buildings is orbited around its outline.
- A plan: the first and last stops are the two buildings farthest apart (a random pair for Try
  another). The camera orbits the first descending, follows a path to the last that passes the
  plan's other designs in order, and orbits the last climbing. With fewer than two buildings,
  designs stand in with their outline centres, and with none at all two points of the outline are
  used.
- Obstacles are whatever the scene draws, not a particular building source. The model scene is
  rendered straight down with an orthographic camera into a 2-byte decimetre height map, reduced
  to the top height per 2 m metric cell (`camera-flight-scene.js`). The path is A* over that grid
  at a cruise altitude of 15 m, keeping 6 m from anything taller and paying extra within 16 m, so
  it keeps to streets. If no path exists it climbs (25, 40, 60, 90, 130 m, then over everything).
- The playback curve itself is checked, not only the views: every metre of every segment must clear
  the 3 m-dilated heights by 2 m. A failing path segment takes back the grid cells it skipped;
  anything else climbs. An orbit view also climbs until no neighbour hides its target.
- Cruise speed is set so the flight lasts about 50 s (4–30 m/s). Generation leaves design view
  first, because the player shows every applied design.

The generator is DOM-free (`camera-flight-auto.js`); only the height render and building boxes
read the live scene.

Find interiors uses visible registered floor geometry. Select an apartment and Enter to place the
camera inside it; Add view then also saves an x-ray cue at that view, so a flight can start or finish
indoors. Explore apartment loads walking on demand. Back to flight restores the captured flight
camera. The player offers exploration only when its camera is inside a retained unit and the current
eye position is walkable. Missing unit boundaries expose a floor entry, without inventing apartment
identity. A unit with invalid placement or no walkable entry reports the problem.

## Record and ownership

`frontend/js/camera-flight.js` is the DOM-free `camera-flight/v2` validator and evaluator. Its
strict schema includes sorted design CIDs, initial model view, frame, FOV, cruise speed, route,
looks, interior snapshots and cues. Limits are 256 route points, 4096 looks, 256 cues, 64 interiors
and 600 seconds; cruise speed is 0.1–200 m/s and a derived travel time is at least 0.5 s. The
horizontal frame is the existing local transverse Mercator anchor in east/north metres, bounded to
a 60 km radius. Z is true metres above flat model ground; it is not sea-level elevation. FOV is
fixed per flight between 20 and 100 degrees.

A route point is `{id, position, quaternion, travelSeconds: null | s, holdSeconds, turn: null |
{axis, turns}}`. `CameraFlight.timeline(record)` resolves everything to absolute seconds: arrival and
departure per view, travel per segment (arc length over cruise speed unless overridden), the derived
orientation keys (each view's quaternion at arrival, a repeat at departure for a still hold, evenly
spaced intermediate keys for a turn so a full rotation is never shortcut, and each look at its
fraction of its segment) and each cue at its view's arrival. Validation runs the timeline, so a
curve leaving the frame or an over-long flight is a validation error, not only a compile error.

Position follows centripetal Catmull–Rom interpolation with a per-segment arc-length table.
Orientation interpolation is independent of position. Repeated seeks are independent of frame
cadence. The scene adapter converts projected horizontal axes and full quaternion orientation,
retaining true vertical metres and suitable near/far planes.

The pre-release `camera-flight/v1` shape (absolute-time look keys, mandatory per-point travel,
spin-as-keys) was replaced on 2026-10-28 before any flight had been published. There is no v1
reader; `consensus.camera_flight` checks for the v2 schema and old local drafts fail validation and
are ignored.

The host grants one explicit camera lease. Ordinary orbit, auto-rotation, clipping updates and
map picking yield to the lease; in orbit mode the session re-enables the orbit controls itself,
targeting the ground under the camera's aim. Playback, free-camera editing and walking share the
existing renderer and frame hooks. Pause/idle unregisters unnecessary work; hiding the page pauses
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
The 10 MiB publication limit includes interior snapshots. Invalid records return 400 with the
validator's message, unknown flights 404, missing designs or exhausted pinning quota 409, and
unavailable storage 503. No credentials or upstream request bodies are returned in storage errors.

`backend/db/camera-flight.sql` creates `consensus.camera_flight`; deployment runs this additive
DDL before API restart. `/flights/<cid>` is a frontend entry route. Existing generic nginx SPA
fallback already serves it. Backend selection is transport configuration and is excluded from
flight content. Drafts are validated against the single current contract; there is no
compatibility reader or data migration.

## Verification

Verification record for the 2026-10-28 rework (orbit-first editing, point-owned orientation,
cruise speed, timeline strip); the original delivery's checks are in the git history of this file.

- Eight targeted headless unit files (`backend/test/camera-flight*.test.js`, run from `backend/`
  with `npx vitest run <files>`): 169 tests passed. `camera-flight.test.js` and
  `camera-flight-edit.test.js` were rewritten for the v2 model; the session and API fixtures were
  converted to the v2 shape (cues anchored to inserted views at the same absolute times).
- Eight guard files (i18n coverage/locale/style, duplicate/undeclared/self-wrapping globals, home
  paths, CSS structure/conflicts): the failures that remain are pre-existing on this branch and
  unrelated to flights — `feedback.*` keys missing from the locales, a `#three-click-stack`
  selector conflict, and the i18n style ratchets (Title Case 33, case conflicts 61, duplicate
  groups 315 against baselines 30/57/289), all at identical counts on the committed HEAD. The one
  duplicate this change had added ("Timeline") was renamed to "Flight timeline".
- The targeted headless Playwright file `e2e/tests/camera-flight.spec.ts` (run from `e2e/`, one
  worker, six scenarios): all six passed — the look/turn/cue scenario was rewritten for anchored
  looks, turns during holds and per-view cues, and the play/scrub scenario now checks that a
  seeked pose stays exact while orbit controls arm until the first canvas drag. Earlier iterations
  of the same file failed on three of my own assertions (turn-angle sum, slider step quantising
  the playhead, mode after explicit poses) and once lost its static server mid-run; one spec run
  launched from the repo root ran zero tests (the config lives in `e2e/`). No run was stopped.
- Headed Chrome (agent-browser over CDP, closed afterwards) against this worktree's own backend
  (`dev.sh`, local database) on the Birmingham model view: the editor opened in orbit mode with
  the orbit controls enabled; two orbit moves plus Add view produced three distinct views with
  `travelSeconds: null`, unit quaternions and speed-derived arrivals (0 / 15.0 / 23.2 s); the
  timeline strip showed three numbered markers and two thumbnails; selecting view 3 from its
  marker seeked to 23.2 s; choosing a yaw turn gave it a 6 s hold, a dashed hold bar and the
  caption "hold 6 s · 1 × Left / right"; scrubbing to the middle of segment 1 enabled Add look
  here, which stored `{after: route-1, fraction: 0.5}` and one look marker; Save x-ray change
  stored one cue at view 3 with a flag marker above the view; Play advanced the clock in real
  time with the orbit controls disabled and Pause stopped it; reloading and Restore draft brought
  back the same three views, look and cue with no page errors. Verified by reading state after
  each action, not by watching motion; smoothness of the actual flight is not asserted here.

Automatic flights (2026-10-28):

- Targeted headless unit file `backend/test/camera-flight-auto.test.js` (7 tests): level look-at,
  design orbit (descends, stays on radius, aim within 3° throughout playback, no sample inside a
  building), plan tour through the one street in a row of 80 m towers, the line-of-sight climb, the
  no-building and seeded variants, and an obstructed straight route. Two mutation checks went red
  and back to green: disabling obstacle avoidance failed the tower-row test; disabling the sight
  climb failed the neighbour test.
- The other camera-flight unit files and the guard files were rerun: no new failures. The i18n
  ratchets and missing `feedback.*` keys are unchanged at the pre-existing counts above.
- Targeted headless Playwright file `e2e/tests/camera-flight.spec.ts` (7 scenarios including the
  new Generate flight one, which renders the real height grid and checks that the generated
  curve clears it): all 7 passed.
- Headed Chrome against this worktree's backend on a 17-design Birmingham plan: whole plan →
  61 views, 53 s at 22 m/s; height grid 244×327 cells in 30 ms; orbit views lifted to 72 and 88 m
  where a 54 m neighbour hid the 18 m first building; path at 15 m; final orbit centred on the last
  building. Try another showed the busy spinner. Frames were checked at seeked times, not in motion.

No full unit or browser suite, production publication, push or deployment was performed.
