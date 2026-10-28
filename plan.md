<!-- Implementation plan and progress for shareable camera flights and reusable apartment interiors. -->
# Flying camera

## Status and scope

Implementation completed on the feature branch after user authorization. The delivery record is in `docs/flying-camera.md`.
Push and deployment require a separate request.

- Branch: `flying-camera`.
- Worktree: `../consensus-builder-flying-camera`.
- Base: `c0f660d952bacdfdf9f27c7a2b13f446ae54b43c` from `colosseum-worlds-fair`.
- Planning date: 2026-10-24.
- Existing uncommitted changes in the source worktree are excluded.

The sequence below records the accepted implementation scope. Current definitions are in
`vocabulary.md`, updated alongside the implementation. Follow the project's preference for one current contract;
record intentional experimental contract breaks instead of adding legacy compatibility paths.

## Intended outcome

People can compose, preview, save and share a camera flight through a plan's 3D view.
They place ordered camera positions connected by a smooth curve, and independently control
where the camera points at any moment. The camera has unrestricted pitch, yaw and roll and
passes freely through walls and other obstacles.

The related interior work extracts the Novogradnje apartment renderer and walkthrough controls
into one self-contained module that both applications load on demand. A later integrated
milestone lets a flight start or finish inside an apartment and lets the viewer take over
interactive exploration there.

### Scope for the first usable flight release

- Existing model 3D view, with the current x-ray and generated-layout rendering available.
- Add/update/reorder/remove route points, height adjustment, smooth trajectory and editable timing.
- Independent look keys, including deliberate full rotations and turns while stationary.
- Play, pause, scrub, stop, undo/redo, local draft save and a shareable published flight.
- Responsive controls and a useful touch interaction at 320–400 px.
- Flight playback owns the camera explicitly and restores ordinary controls on exit.

Recommended defaults: silent playback, level initial horizon, fixed field of view, constant
cruising speed and gentle departure/arrival easing. These are defaults, not camera restrictions.

Narration, a music editor, video export, collision avoidance, automatic route finding, door
animation and a general cinematic production system are outside the first release. One common
optional music track can be added after playback is reliable; its inclusion is not decided here.
Photorealistic tile flights should follow the bounded model-view release, once route loading
and camera ownership are verified with that additional consumer.

## Findings to preserve

### X-ray links already work

The existing URL parameters are `3d`, `xray=1`, `suggested=1`, and optionally
`suggestedExisting=1`. An explicit `camera` also prevents the shared Digbeth view from
opening as an isolated view of its first design.

The live Digbeth check during investigation displayed seven generated building interiors and
84 floor instances. Those are observed counts, not a permanent correctness fixture. Generated
layouts remain suggestions; red volumes report slices where the minimum core does not fit.

`MapShare.capture()` does not currently include x-ray, suggested layouts or floor cutaway,
and the x-ray setters do not synchronize those settings into the address bar. Therefore a
manually constructed link works while a newly generated Share link loses those choices.
Named plan validation also has an explicit settings allowlist that must be updated if these
settings become part of a saved view.

### Reuse exists, but the viewer is not yet a package

Both applications have architectural geometry and Three.js rendering modules. The apartment
catalogue contains extracted copies and additional presentation, lighting, person navigation
and first-person controls. Consolidation must preserve the newer consumer behavior rather
than choosing one copy by filename alone.

Existing floor geometry includes walls, slabs, openings, door leaves, stairs and railings.
Apartment first-person controls already support walking and touch input, but are upright,
constrain pitch and do not expose roll. They are not the unrestricted flight controller.

Generated floor models contain apartment IDs and metadata, but the renderer batches geometry
by floor and material. Apartment picking, individual unit geometry and a useful entry pose
need an explicit bridge; the presence of an apartment count is not that bridge.

### The map camera needs a fuller contract

The saved map camera contains a geographic ground target, heading, downward pitch and range.
It cannot express arbitrary eye position, elevated target, roll or a camera looking upward.

`three-mode.js` exposes scene internals and frame hooks, but its render loop still updates
OrbitControls and adjusts near/far planes. Disabling pointer input alone is insufficient:
playback must prevent all other camera writers from overriding its pose or clipping settings.

Map geometry uses projected coordinates while local apartment geometry uses metres. Verify
the actual horizontal scale, vertical scale, ground datum and root transforms in both renderers.
Do not infer a uniform scale from a comment or copy the orbit-camera conversion unchanged.

## Source map

| Concern | Existing entry points |
| --- | --- |
| X-ray state and scene/camera integration | `frontend/js/three-mode.js` |
| Lazy loading and mode ownership | `frontend/js/map-mode-loader.js`, `frontend/js/map-mode-transition.js` |
| Current view links and named plans | `frontend/js/map-share.js`, `frontend/js/plan-record.js`, `frontend/js/named-plans.js` |
| Share UI and URL entry | `frontend/js/proposals/dialog-share.js`, `frontend/js/proposals/core.js`, `frontend/js/proposals/sharing-routes.js` |
| Architectural schema and geometry | `frontend/js/building-floor-plans.js` |
| Building and local-unit meshes | `frontend/js/three-floor-plans.js` |
| Generated interiors | `frontend/js/default-floor-plans.js`, `frontend/js/default-floor-plan-context.js`, `frontend/js/default-floor-plan-rooms.js` |
| Publication/storage patterns to inspect | `backend/routes/plans.js`, `backend/storage/pinning.js` |

In the sibling apartment catalogue, inspect `frontend/viewer.js`,
`frontend/js/floor-plan-review-renderer.js`, `apartment-person-view.js`,
`apartment-people-navigation.js`, `apartment-people.js`, `apartment-scene.js`,
`apartment-sun.js`, `apartment-presentation.js`, and `docs/extraction-manifest.json`.
The catalogue's shared-file route is delivery plumbing, not an independent package boundary.

## User interaction

1. Enter the flight editor from model 3D. The existing view becomes the starting editor view.
2. Move and aim the camera, then choose **Add view**. Save both position and look direction.
3. Add more views. Show numbered route nodes, the interpolated curve and a thumbnail sequence.
4. Select a node to move it horizontally, adjust its height, update from the current view,
   reorder or delete it. Offer explicit move and look modes to avoid accidental edits.
5. Scrub to any time, rotate the camera in place and choose **Add look**. This adds an
   orientation key without altering the position curve.
6. Adjust travel time or insert a hold. A hold can include a turn while position stays fixed.
7. Use **Play**, **Pause**, **Stop** and **Share flight**.

Provide an overview for editing the path and a through-camera preview. Keep the overview's
inspection camera distinct from the recorded flight pose, so inspecting a node cannot
silently rewrite the shot. A simple view switch is sufficient initially; multiple live canvases
are unnecessary. Include **Level horizon** as an explicit reset, not a pitch/roll constraint.

## Implementation boundaries

### Camera and flight core

Keep record validation, timing, interpolation and edit operations in plain modules with no DOM,
canvas, framework, network or application-global dependencies.

A flight record contains:

- Schema version, label and a reference to the selected published design set or named plan.
- A geographic anchor and explicit local metric frame, with documented vertical datum.
- Ordered route points with stable IDs and travel/hold timing.
- Independent orientation keys at explicit times; normalized quaternion pose plus sufficient
  intermediate keys to preserve intentional turns, including 360 degrees or more.
- Initial view state: model mode, display settings, x-ray flags and floor cutaway.
- References to required interior model revisions or generated presentation snapshots.
- A fixed field of view initially; the pose API carries it so camera restoration is complete.

Use a centripetal Catmull–Rom curve for position, with distance-based sampling so uneven point
spacing does not create unintended speed changes. Handle two-point paths, stationary holds
and duplicate points deliberately. Smooth through intermediate nodes; only stop when requested.

Interpolate orientation independently. Shortest-path quaternion interpolation alone loses a
complete turn whose endpoints match. Capture additional intermediate orientation keys during
authoring, with angular steps below 180 degrees, and preserve them when saving and editing.

Evaluate pose from an absolute playhead time. Scrubbing to a time must give the same result
as playing to it, independent of frame rate. Pause on page hiding and preserve the playhead.

Add a narrow scene adapter for camera capture/apply, frame scheduling, view-state restoration
and scene readiness. Use the host renderer and its frame loop. Camera ownership is explicit:
orbit, interactive walking, editor free camera or flight playback, with one writer at a time.

### Shared interior module

Extract one small versioned module with two entry points:

- A geometry/scene attachment entry point accepting the host's Three.js instance, scene root,
  coordinate transform and lifecycle hooks.
- A standalone viewer wrapper that owns a renderer, camera, controls and resize/visibility
  handling when no host scene is supplied.

Expose optional walking controls and presentation separately. The host supplies data, labels,
theme values, location and placement. Avoid hardcoded catalogue URLs, automatic API requests,
a second copy of Three.js, or a second animation loop inside consensus-builder.

Ownership must be explicit: dispose only owned geometry, materials, listeners and resources;
do not dispose host/shared assets. Embedded presentation must not silently overwrite the
city scene's environment, renderer tone mapping, sunlight or camera.

Both consumers should use the same versioned module artifact. Choose its smallest practical
repository/package location at extraction time; do not establish another pair of copied sources.

### Saved flights and interiors

Keep a flight separate from authored design geometry and agreement records. Reuse the existing
content-addressed publication approach where appropriate; a saved edit produces a new version.

A shared flight must load its intended design composition, settings and required interiors
before playback. Surface missing or mismatched assets; do not silently substitute a different
layout. Start playback on an explicit Play action.

Generated layouts are currently ephemeral and can change as source inputs or generation rules
change. Store an immutable generated presentation snapshot with the flight, explicitly marked
as generated and outside the authored floor-model registry. Reference the selected model
revision for an evidence-backed interior.

## Delivery sequence

### 1. Complete x-ray view sharing

Capture live x-ray, suggested-layout, suggested-existing and cutaway state centrally.
Serialize/restore it through map shares and named plan views, including explicit false/off
values so previous URL or local state cannot leak into a restored view.

Acceptance: open the same saved Digbeth view in a fresh browser; flags, cutaway and composition
match, and no unintended first-design isolation hides the floor plans.

### 2. Establish full camera pose and deterministic playback

Implement the pure flight record/evaluator and scene adapter. Add explicit camera ownership,
free pose capture/apply, suitable clipping distances and cleanup. Prove a short hardcoded flight
first, including looking upward, passing through a wall and a stationary full turn.

Acceptance: repeated seek/play gives identical poses; orbit and autorotation cannot fight the
flight; stopping or leaving 3D releases hooks and restores working controls.

### 3. Build the minimal editor

Add view capture, route visualization, node selection/move/height, independent look keys,
travel/hold controls, thumbnails, undo/redo and the playhead. Lazy-load editor code on entry.

Use the existing semantic UI categories, external CSS and localization. Keep essential actions
visible without hover; provide touch alternatives to dragging in 3D.

Acceptance: a person can create, revise and replay a short flight without entering coordinates
or opening developer tools. Reordering/deleting points maintains a valid record and predictable timing.

### 4. Add draft saving and shareable playback

Save local drafts, then add validated publication/read paths using the existing storage patterns.
Bind a flight to its design snapshot and interior assets. Support read-only playback without
loading the editor UI. Keep editing ownership and immutable published versions explicit.

Acceptance: another fresh browser opens the same flight, restores required view settings and
plays the same route/look sequence. Failed saves do not appear successful.

### 5. Extract the shared interior viewer

Compare the two implementations and preserve supported architectural geometry and catalogue
behavior with characterization coverage. Extract geometry, optional walking and standalone
presentation, then switch both consumers to the shared artifact.

This milestone can proceed independently once the camera/scene adapter contract is settled;
the basic flight editor does not depend on completing extraction.

Acceptance: both consumers render the same representative apartment geometry, walking still
works in the catalogue, and opening/closing the embedded viewer repeatedly leaves no duplicate
loops, listeners or WebGL resources. The normal map does not download the optional viewer stack.

### 6. Connect apartment entry and continuous flights

Retain apartment boundaries and unit geometry from the generator or source adapter.
Bind each selectable apartment to a building identity, floor elevation, model revision,
placement transform and a valid entry pose.

Transform interiors into the same scene as the surrounding plan. A plan with unknown placement
can still have a standalone apartment viewer, but must not claim a correctly aligned continuous
flight into the building. Load the needed interior before the camera reaches it.

Add a small set of timed view-state cues for x-ray/cutaway and interior presentation. Avoid
rebuilding whole geometry every animation frame. At the end, offer **Explore apartment** to
hand camera control to interactive viewing without a visible teleport.

Acceptance: one flight starts inside and exits to the plan; another arrives from outside and
finishes inside. Position, scale, floor elevation, visibility and camera clipping remain coherent.
Flight motion continues to ignore obstacles; existing walk navigation remains a separate mode.

## Verification

Planning task: read back this document, check whitespace and personal-identity rules, verify
branch/worktree/base and commit only `plan.md`. No application test run is needed for this document.

Future implementation uses focused headless unit tests for:

- Flight validation, route edits, undo/redo and serialization.
- Curve endpoints, distance sampling, repeated points, holds and timing boundaries.
- Independent orientation keys, pole crossings, roll and complete/multiple turns.
- Deterministic seek, pause/resume and camera-owner transitions.
- Metric/world transforms, rotated apartment placement and floor/ground elevations.
- View-state round trips and exact interior revision/snapshot selection.
- Cancellation, repeated mount/dispose and unavailable assets.

Existing relevant headless unit test files include `backend/test/map-share.test.js`,
`named-plans.test.js`, `map-mode-transition.test.js`, `three-xray-wiring.test.js`,
`three-floor-plans.test.js` and `three-snapshot-navigation.test.js`.
Add narrowly scoped flight/editor tests rather than running every file listed after every edit.

Use targeted headless browser specs for editor behavior and a dedicated headed browser for
visual inspection of actual flight motion, full rotations and interior transitions.
A stationary screenshot does not prove smooth playback. Check on a quiet host and close
verification browsers afterward. Full unit or browser suites require explicit approval.

Before sharing a local preview, verify the listening checkout, resolved backend and actual
source-data capabilities for this flow. Include a verified backend override if no local API runs.

## Resolved implementation decisions

- Canonical source is `packages/interior-viewer`; pinned esbuild produces scoped browser artifacts.
- Flight XY uses the existing local metric frame and Z is true metres above model ground.
- `camera-flight/v2` is published through `/flights` with canonical CID verification and durable readback.
- 2026-10-28 rework (before any flight was published, so v1 has no reader): route points own their
  orientation; holds carry whole turns; looks between views are anchored to a view and a segment
  fraction; cues are anchored to a view; travel time derives from one cruise speed unless a point
  overrides it; the editor starts in orbit mode and shows one timeline strip of views, holds, looks,
  cues and the playhead.
- Both consumers use the same full viewer artifact; the companion records its SHA-256 receipt.
- Playback and editor have separate lazy entry points; walking is a further optional load.
- Music, narration, video export and photorealistic tile flights remain outside this release.

Rough sizing from inspection: a basic editor prototype is a few focused development days;
a usable editor with undo, saving and sharing is about a week. Shared-viewer extraction and
reliable apartment transitions are another one to two weeks, depending on placement quality.
These are planning estimates, not completed work or a delivery commitment.

## Resume point

All six delivery stages are implemented. See `docs/flying-camera.md` for controls, storage, validation and deployment requirements. Push and deployment have not been requested.
