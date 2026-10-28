# 3D life: schematic people and vehicles in model mode

Living plan for branch `3d-life` (worktree `consensus-builder-3d-life`, off `colosseum-worlds-fair`
344ee8fe, 2026-10-15). Merged back into `colosseum-worlds-fair` on 2026-10-15 (85892322, after
merging that branch in first; no conflicts). Update the status marks as steps land.

## Goal

Bring life into the simplified 3D ("model") view: to-scale, schematic people walking on sidewalks,
footways and plazas, and cars, buses and motorcycles driving along roads, moving randomly with no
behaviour logic beyond "stay on your path and don't drive into the vehicle ahead". No big performance
cost, nothing of Station3D recreated.

## What existed before (2026-10-15 research)

- CB's 3D model mode had nothing moving. The render loop is on-demand and keeps running only while a
  frame hook is registered (`registerThreeModeFrameHook`, three-mode.js); only photo mode used it.
  Static figures only: the statue and the stick-figure sidewalk textures.
- The "people in the 3D sim" memory is Station3D (`~/Code/station3d`): 32 ambient pedestrians, six
  meshes each, off by default in walk mode (H toggles them); road vehicles are a GTA-mode capability.
  The yellow-man button in CB only opens zagreb.lol/prijevoz?st3d=walk in a new tab.
- The traffic simulator built on `main` 2026-10-14/15 is a 2D Leaflet-canvas page (zagreb.lol/promet/
  simulator), extracted to `~/Code/zagreb-promet-simulacija` by 670a98d5. No pedestrians, not 3D.
- Station3D's layers are not portable as code (`world/pedestrians.js` 1,665 lines / 35 imports,
  `world/cars.js` 4,899 lines / 42 imports, one Group per agent). Its constants and the instanced-crowd
  pattern (`world/campaign-crowd.js`: 240 people in five InstancedMesh draws) are what we reuse.

## Scene facts the design rests on

- Frame: X east, Y north, Z up. XY is EPSG:3857 metres minus the scene origin, so XY is inflated by
  k = 1/cos(lat) (about 1.43 in Zagreb) while Z is true metres. The life group therefore works in
  TRUE metres internally and is mounted with `scale(k, k, 1)`, the same trick the photo tiles use.
  Speeds, lengths and spacing stay in m and m/s; nothing is hand-scaled.
- Heights: parcels z 0, corridor lane strips z 0.05 (sidewalk/verge/median +0.15 kerb), corridor
  markings 0.24, square paving 0.06, park grass 0.06 and park paths 0.075. Grade-separated corridor
  spans get their tent z from `gradeElevationAtXY`.
- Applied corridors expose typed lane spans (`corridorStripSpans`: driving/bus/cycleway/parking/
  sidewalk/verge/median/rail with signed offsets, positive left of the drawing direction; the right
  kerb carries forward traffic) and an offset-line helper (`buildCorridorOffsetLine`) in the corridor's
  own metric frame.
- Existing streets are not drawn in 3D. `GET /osm-road?bbox&crs=EPSG:4326` returns `osm_road`
  centrelines with `highway_type`, `width_meters` and full `tags` (lanes, oneway, sidewalk), capped at
  8,000 features, Croatia only (468k ways locally, 159k footway/path/pedestrian/steps).
- Parks (`window.parks`) carry `decorations.paths` LineStrings; squares (`window.squares`) are flat
  polygons with point decorations (fountain, stalls, statues, trees, benches).
- Trees are the instancing precedent: two `InstancedMesh` draws for thousands of trees.

## Design

Four classic scripts, three of them pure and node-tested:

1. `frontend/js/life/life-graph.js` (pure). From plain data in TRUE metres builds the directed drive
   `tracks` and the paint lists for the walkable surface:
   - corridor lanes: one directed track per driving/bus lane (forward along the drawing direction,
     backward reversed); the driving/bus/parking/rail spans together are the carriageway, every
     other span (sidewalk, verge, median, cycle path) is kerb-height walking space;
   - OSM roads (the same feature shape whether they come from `/osm-road` or Overpass): driveable
     classes (motorway … residential and their `_link`s; no service) split at shared vertices (0.5 m
     snap key), lanes from `lanes` or a class default, `oneway` respected (yes/1/true/-1/reverse),
     lane centres at 3.5 m on the city's side of the road, the carriageway as wide as `width` or lanes×3.5;
     the side comes from `CityConfigManager.getDrivingSide()`: a city config's own `drivingSide`
     (`'left'` or `'right'`), else left for the countries that drive on the left (read from the region
     of the city's `currency.locale`: `en-GB`, `en-IN`, `ja-JP` and so on), else right. Applied
     corridors keep the lane directions their profile records;
     a 4.5 m sidewalk band outside the carriageway on each side unless `sidewalk=no|none|separate`;
     footway/path/pedestrian/steps/cycleway/track/living_street as walking bands, closed
     `area=yes` pedestrian ways as walking polygons;
   - park lawns and plazas as walking polygons, park paths as bands, ponds and plaza furniture
     (fountain, stalls, statues, benches, trees) as blocked; buildings, water and lakes as blocked.
   Tracks connect through node ids, so a driver reaching the end of one picks another outgoing
   track. Turns (2026-10-17): `junctionCurve` trims both lanes back by the tangent length of the
   vehicle's turn radius (car 7 m, bus 11 m, moto 6 m; hairpins and U-turns turn at the node) and
   joins them with a tangent cubic Bézier; drivers brake to √(2.5 m/s² · R) for it. Vehicles steer
   like a bicycle model: the front axle rides the path, the rear axle trails it at the wheelbase (a
   tractrix, so a bus's rear wheels cut inside the corner and never slide sideways), and the front
   wheels show the steering angle. A corridor's loose end
   within 8 m of an OSM node is merged into it so traffic flows between proposal and street.
2. `frontend/js/life/life-surface.js` (pure). The user's rule, 2026-10-15: **walkable = everything
   that is not a car lane and not a building, structure or water footprint.** A grid (1 m cells,
   coarser for big scenes, at most 1.5M cells) classifies each cell as blocked, open, preferred
   (sidewalk bands, footways, plazas, lawns) or carriageway. Paint order: preferred, then
   carriageways over it, then footprints over everything. A walking leg may never enter a blocked
   cell and may cross carriageway only in runs under 14 m (a street crossing, not a stroll down the
   road). Destinations are sampled within 40 m, 85% of them in preferred cells, so most people keep
   to streets and plazas while open ground stays allowed. Each cell also carries the walking height
   (ground, plaza paving, park path, corridor kerb).
3. `frontend/js/life/life-agents.js` (pure). Deterministic (seeded) population and stepping:
   - vehicles: car 86% (4.4×1.8×1.5 m), bus 6% (12×2.5×3.2 m), motorcycle 8% (2.1×0.6×0.95 m plus
     rider); cruise 8–24 m/s by road class; random non-U-turn exit at nodes; per-track following with
     a 2 m standstill gap and 0.9 s headway, so vehicles never overlap on a track; dead end respawns;
     one vehicle per 45 lane-metres up to the cap;
   - people: one per 250 m² of preferred walking space (plus 5% of open ground) up to the cap.
     Allocate that density to authored park, square and corridor walking space first, then
     distribute the remaining budget across the loaded neighbourhood, so a large OSM context
     does not leave the design empty. Buildings, carriageways and obstacles remain excluded;
     1.0–1.5 m/s, straight legs to random surface destinations, pauses of 2–8 s, walk-cycle phase
     from distance walked; `replaceSurface` repaints under the crowd when footprints arrive late and
     only moves whoever now stands inside one;
   - caps 100 vehicles / 64 people, halved on small screens.
   - this allocation is shared rendering behavior for human-authored and MCP-authored designs;
     it adds no editing operation or authored-record field, so no MCP schema change is needed.
4. `frontend/js/three-life.js` (three.js). One `InstancedMesh` per part: vehicle bodies, cabins/window
   bands, wheels (four per vehicle), person heads, torsos, arms (two per person), legs (two per
   person); per-instance colour; motorcycle riders reuse the person parts. Limbs swing as
   `sin(stride)·0.55`, stride 5.2 rad per metre walked (Station3D's values). One frame hook steps the
   simulation with the real dt clamped to 0.1 s and writes matrices straight into the instance
   attribute arrays. The hook is unregistered when the layer is off, hidden (photo mode) or the scene
   is disposed, so the loop goes back to on-demand.
   At dusk and night (`setNight`, the lamps' darkness from the sun's altitude) two more draws switch
   on: unlit headlamps and red tail lamps (four per vehicle, two on a motorcycle) and an additive
   pool of headlight on the road ahead of each vehicle. By day both are hidden and not rewritten.

Streets come from OSM everywhere, through one endpoint: `/osm-road` answers from the ingested
`osm_road` table where the city has rows, and otherwise (a scene-sized bbox with no rows) from the
backend's shared Overpass chain in `backend/roads/osm-road-overpass.js` — the paid Tracestrack
instance first (`TRACESTRACK_API_KEY` in backend/.env, local and prod; the key never reaches a
browser), then the public server, with the per-cell cache, throttle and cool-off of
`osm-reference.js`. The response carries `source: 'osm_road' | 'overpass'`. Only when the backend
cannot answer does the browser ask a public Overpass instance itself (three instances in turn,
clipped to about 3 km, 60 s each), so the layer survives our server being down; failing that, life
runs on proposals and plazas only. The population rebuilds once the ways arrive.

Integration points in three-mode.js: build after corridors and structures in `initScene`, rebuild
with `refreshStructures3D`, repaint the surface when context buildings and water arrive. Toggle
"People and traffic" in the model-mode layer panel (preference `cb_3d_life_enabled`, default on),
`?life=0|1` override, off under `?reduceMotion`. A `?fps=1` frame-time readout for model mode (hook
ms and render ms, worst frame per second window) so the cost is measured, not assumed.

| Budget | Value |
|---|---|
| People cap | 64 |
| Vehicle cap | 100 |
| Draw calls added | 7 (9 at dusk and night) |
| Target CPU per frame | under 1 ms on a quiet laptop |

## Phases

- [x] P1 Plan recorded, pure graph + surface + agents modules with tests (2026-10-15).
- [x] P2 Renderer + frame hook; vehicles on applied corridors and OSM lanes.
- [x] P3 OSM streets via `/osm-road` with the Overpass fallback; people on the walkable surface.
- [x] P4 Motorcycles with riders, buses; toggle, i18n (en/hr/sr/es), reduced-motion and `?life=` gates.
- [x] P5 `?fps=1` readout in model mode.
- [x] P6 Browser verification in a launched headed Chrome; tests green; committed on `3d-life`.

## Measured 2026-10-15 (laptop, host load 26–35 from other sessions' browsers, so timings are upper bounds)

Zagreb main station, 300 m building radius, 523 OSM ways, 425 context buildings:

| Item | Value |
|---|---|
| Population | 100 vehicles, 64 people |
| Life layer per frame | 0.1–0.8 ms (simulation + matrix writes) |
| Draw calls added | 7 |
| Surface paint (1 m cells, 87k blocked cells from 11k roof faces) | 55–65 ms, once per scene and once per footprint arrival |
| Graph + surface build | 18–22 ms |
| Frame rate with the layer on | 120 fps, worst frame 2–12 ms depending on the view |

Battery: with the layer on, the view renders continuously instead of on demand. The toggle turns
that off entirely (the hook is unregistered: the readout stops updating, the group is hidden and
emptied; toggle on rebuilds), the loop pauses while the tab is hidden, and when only hooks keep the
loop alive with nothing moving, frames are paced at 30 fps rather than the display's rate; any
interaction or invalidation returns to full rate at once. Car colours avoid grey and near-white so
vehicles never blend into the grey buildings or the pale ground. Belgrade (no ingested roads) exercises the Overpass path: Tracestrack answered the
scene's cells in 5.4 s with 2,324 ways (399 inside the scene; 100 vehicles on 31 km of lanes, 64
people, 271 buildings blocked), while from the browser the public overpass-api.de took 37 s for a
3 km box under load and both public mirrors returned 500 that afternoon, which is why the browser
path is the last resort only.

## Deferred

- Photo mode: the only height sampler lives inside applied-corridor support; people and cars there
  come later, on applied roads only.
- Cities without `osm_road` (Belgrade, NYC, SF, Oxford): life runs on proposed corridors, parks and
  plazas only. Overture transportation segments via cadastre-data would be the shared-table route.
- Signals, right-of-way, crossings, car–person interaction, pairs and dogs: not planned.
- Drawing existing streets in model mode: the abstract grey-slab view is deliberate; not changed.
