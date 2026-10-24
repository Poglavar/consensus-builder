# InteriorViewer 1.0.0

The maintained source of the shared architectural viewer is this package. Generated browser artifacts live in `frontend/vendor/interior-viewer/`:

- `interior-geometry.js` exposes `InteriorGeometry` for ordinary geometry consumers.
- `interior-meshes.js` exposes `InteriorMeshes`; load geometry first. This contains no walking stack.
- `interior-viewer.js` exposes the self-contained `InteriorViewer`; load it on apartment entry.

All artifacts support `require()`; package imports use `src/index.cjs`. They derive from the same
source modules, so the small browser entry points do not establish copied implementations. Build with
`npm --prefix packages/interior-viewer run build` using the repository backend's pinned esbuild.
Three.js is always supplied by the caller; it is never imported, bundled or fetched.

`geometry` retains the building-floor-plans API and schema validation. `meshes` retains
`createBuildingGroup`, `createLocalUnitGroup`, `setCutaway`, `disposeGroup`, `summarize`, and
`renderCutaway`. Its optional geometry argument defaults to this package's geometry API.
`createLocalUnitGroup(THREE, architecture, geometry, {colors})` accepts per-part colors.

```js
const interior = InteriorViewer.attach({
  THREE, scene, camera, renderer, controls, host, architecture,
  render: invalidate, animate: addHostAnimator,
  placement: {position: [100, 200, 12], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]},
  walking: true, labels
});
// Return host camera ownership before disposing the attachment.
interior.dispose();
```

`architecture` is a validated architectural record or `{architecture: record}`. Model XY is
metres, drawings have y-down normalized coordinates, and local geometry is y-up with Z-up.
Local slab top is Z=0; storey elevation and host ground datum belong to `placement`.
Placement accepts a finite invertible Matrix4/16-element `matrix`, or position/quaternion/scale.
No placement is inferred from a building ID. Host projection scale must be supplied explicitly.

`attach` returns `root`, `group`, the host context, optional `navigation`, `walkers`, `personView`
and idempotent `dispose`. It starts no frame loop and never disposes the host camera, renderer,
controls, scene environment or other scene objects. Walking requires the camera, renderer,
controls, host and `animate({active, update})` hook, returning an unregister function. Call the
host's render invalidation after input and give walking exclusive camera ownership. `personView`
exposes `enter(index)`, `exit()`, `active()` and `update()`. Exiting restores the captured camera
and controls. Navigation is ground-level swept-body clearance; stairs and raised platforms
block walking. It is separate from unrestricted flying-camera traversal.

`navigation`, `people`, and `personView` (also `walking`) expose the extracted pure/path and
optional figure/controller APIs for consumers that already own their scene orchestration.
Walking labels: `people` (names array), `firstPerson`, `personView(name)`, `back`, `overview`,
`choosePerson`, `walkStick`, `walkHint(name, coarse)`, `noRoute`; standalone additionally uses
`view`. Defaults are English. Styling remains the host's responsibility.

`await mountStandalone(host, architecture, {THREE, OrbitControls, walking, labels, colors})`
owns its renderer, camera, controls, resize/visibility observers and a single demand frame loop.
The returned controller has the same context and `dispose`. Optional `presentation:true` adds
local drafting edges and an eye-level ceiling. `env` is injectable for testing; `signal` cancels
the wrapper. No controls library, data source, stylesheet, service URL or location is inferred.

`presentation.mount(context, options)` adds only model-local edges/ceiling; call its `update`
on the host frame hook and dispose it before disposing the mesh group. `look.mount(context,
{host, ownScene:false}, env)` provides the extracted wood/sky presentation separately. Its default
leaves scene environment and renderer tone mapping untouched. A standalone owner may explicitly
set `ownScene:true` and supply `RoomEnvironment` to enable scene lighting presentation; previous
values are restored on disposal. Solar controls and room-schedule UI remain consumer concerns.

Extraction combines current application geometry with the catalogue's negative stair/platform
levels, datum landing deduplication and per-kind colors, while retaining the application's 2 mm
floor-band join tolerance. Walking, figures, person controls and wood/sky algorithms are extracted
from the catalogue implementation. There is one maintained source and three scoped generated artifacts;
consumer globals are thin namespace adapters. Application-owned source retains its existing
repository license; no third-party Three.js source is copied into this package.
