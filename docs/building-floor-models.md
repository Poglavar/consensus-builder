<!-- Storage, source-adapter and rendering contract for optional architectural interiors. -->
# Building floor models

X-ray displays authored architectural interiors when a building has evidence for them. Buildings without a model continue through the existing exterior renderer, with the same Built/Planned settings. No developer, city or project name participates in the runtime renderer.

## Where floor plans are stored

There is one stored floor-plan format: the published plan document in `buildings.floor_plan` (cadastre-data, schema `api/src/domains/floor-plans/document.js`), served by `GET /api/floor-plans`, `/api/floor-plans/summaries` and `/api/floor-plans/:id`. zagreb-novogradnje's publication import is its only writer; this app only reads it. A document names the buildings it belongs to in `buildingRefs`: `{ city, source, ownerId: '', buildingId }` for a native building, and `{ city, source: 'proposal', ownerId: <public proposal id>, buildingId: <feature id>, footprintSha256 }` for a proposal building, where `footprintSha256` is `fingerprint` (`backend/buildings/floor-models.js`, canonical-JSON SHA-256) of the footprint the plan was drawn for.

A proposal building's id is its stable `sourceFeatureId`, or `dgu-building:<dguBuildingId>` / `source-layer:<sourceLayerId>` when the reconstruction retains those provider identifiers. A survey building uses the provider's native `object_id` and the `floorModelSource` returned by `/buildings/near`. Custom feeds have separate hashed source identities, so their local building ids cannot collide.

`consensus-builder.building-floor-plans.v3` is the in-memory structure the X-ray renders, built from published documents by `backend/buildings/published-floor-model.js` (`publishedPlansToFloorModel`). It is no longer a stored format, except in the frozen registry below and in the committed restatement archives (`restatements/pionir-paron/*/proposal.geojson`, `properties.floorPlans`), which are evidence and authoring output, not a read path.

**The old registry.** `consensus.building_floor_model` held one versioned model per `(city, source, owner_id, building_id)`; nothing reads or writes it any more, and its DDL is gone. Its 9 current rows, all proposal buildings (Pionir: Borongajska–Čavićeva ×6, Savica F1–F3, Lovinčićeva, Španjsko sjever A–F), were moved onto their published drawings by zagreb-novogradnje `backend/scripts/bind-proposal-floor-plans.mjs` (2026-11-20): each drawing, matched by source URL and page, gained the proposal reference, the registry's registration (`accuracyM` null: its residual measured outline fit, not position), the envelope storeys its levels lacked (Lovinčićeva's basement) and its storeys' units. A typical floor is one drawing for several storeys (B3's levels 2–8), so each of its units names its storey in `level`. The converter then gives all 9 buildings the registry's layouts, corners, storeys, elevations and units (648 apartments). `backend/db/migrations/2026-11-20-drop-building-floor-model.sql` drops the table once that release is deployed and the bindings are published; it refuses while any registry layout has no published plan with the matching proposal reference and a registration.

The model contains:

- WGS84 registration corners, placement method and accuracy notes.
- Reusable floor layouts: wall and slab polygons, openings, door hinges, stairs, landings and railings, plus their metric dimensions.
- Storeys referencing those layouts, each with its level, elevation, elevation basis, source evidence and units (apartments, shops, offices, garages).
- Source URLs/checksums and optional PDF page/crop metadata. Non-PDF sources use the same contract without page or crop fields.
- Explicit inference notes. Estimated dimensions are not measurements.

This is a parametric architectural model, not a stored triangle mesh or a raw PDF. Source adapters extract and review geometry offline. The browser converts the saved polygons and dimensions into meshes when X-ray is enabled, shares geometry between repeated layouts, and disposes it when disabled. It never parses a PDF. The source files and reviewed extraction manifests remain the reproducibility evidence.

The common schemas and validation live in `frontend/js/building-floor-plans.js`; `three-floor-plans.js` only creates and manages Three.js objects. Pionir's PDF interpretation is confined to its authoring scripts. Another supplier needs an adapter to the same schema, not another renderer.

## Published floor plans of native buildings

Floor plans of existing buildings live in one shared database, `buildings.floor_plan` (cadastre-data), served by `GET /api/floor-plans`. Each plan is one unit or one whole floor, lists the native buildings it belongs to (`buildingRefs`: `{city, source, ownerId, buildingId}`) and its own map `registration`. UGT **reads** these plans and stores no copy.

**Floor plans are never bulk-loaded.** `POST /buildings/cell` and `POST /buildings/near` give a building with plans only a marker, `floorPlansAvailable: { origin: 'publication', city, source, storeys: [levels], units }` (well under 200 bytes), read cheaply from the publication's compact summaries (`GET <publication>/floor-plans/summaries`). The model itself comes from `GET /buildings/floor-model?city=<namespace>&source=<floorModelSource>&buildingId=<id>`: the published plans converted (503 when the publication did not answer, `{ model: null }` when there are none). The browser asks for it only while X-ray is on and the building is within 200 m of the camera (3D distance, so a high overview loads nothing), nearest first, two requests at a time; it abandons requests for buildings that leave 300 m and drops their interiors there, or when X-ray goes off (`frontend/js/floor-plan-proximity.js`, wired in `three-mode.js` `updateFloorModelLoads`). Only the affected building changes: an arrival adds that building's floor-plan group and hides its shell, a drop disposes the group and shows the shell again (`reconcileExistingFloorPlans`; the pure decision is `reconcileFloorPlanGroups`). Toggling X-ray rebuilds nothing for existing buildings; it rebuilds the designs only when X-ray replaces some of their solids (a design with an authored model, or Suggested layouts on), and building rebuilds no longer widen to every family while X-ray is on. Proposal reads still embed their proposal's authored models (`attachProposalFloorModels`).

Which plans a city reads is configuration, not code. A city's `floorModels.published` (in `frontend/data/city-configs.js`) lists source adapters in priority order; each maps one of the app's building sources (`buildingSource`, the `floorModelSource` its records carry) to the publication's reference namespace (`city`, `source`), with optional `buildingIds` rules where the two spell an id differently:

```js
floorModels: { namespace: 'zagreb', published: [
    { adapter: 'floor-plan-publication', buildingSource: 'zagreb-3d', city: 'zagreb', source: 'zagreb-3d' },
    { adapter: 'floor-plan-publication', buildingSource: 'dgu-3d', city: 'zagreb', source: 'dgu-building' },
    { adapter: 'floor-plan-publication', buildingSource: 'osm-3d', city: 'zagreb', source: 'osm',
        buildingIds: [{ match: '^w(\\d+)$', ref: 'way/$1' }, { match: '^r(\\d+)$', ref: 'relation/$1' }] }
] }
```

The server reads every city's light configuration (`frontend/data/city-index.js`) and registers these entries in the `building-details` source registry (`backend/buildings/floor-models.js`). The browser only sends `floorModelNamespace`; the publication's base URL is server configuration (`FLOOR_PLAN_PUBLICATION_API_URL`, default `https://zagreb.lol/api`), and a city entry carrying a URL is refused. A city without `published` gets no published plans. Another city plugs in its own publication namespace, or another adapter, the same way.

- `backend/buildings/floor-plan-publication.js`, the adapter: markers from the summaries (up to 200 buildings per request, pages of 500), a model from one building's full plans (pages of 100); three requests at a time, 8 s each; each building's marker and model (or none) kept for 10 minutes in the process. A failed request is logged, leaves those buildings without published plans, and is not cached; `/buildings/cell` then serves that cell without caching it.
- Markers read cadastre-data's `GET /api/floor-plans/summaries`: the same filters as `/api/floor-plans` (`city`, `source`, `nativeBuildingIds` ≤ 200), `limit` up to 500, answering `{ plans: [{ id, buildingId, scope, floor, levels, unitId, quality, registered, buildingRefs, updatedAt }], limit, offset, hasMore }` (about 400 bytes a plan, against ~14 KB for a full plan). A publication without that route answers 404: cells then carry no publication markers (the failure is logged) and X-ray shows no published plans.
- `backend/buildings/published-floor-model.js`, the converter: one building's plans become one `building-floor-plans.v3` model. A storey with a whole-floor plan shows it (it already composes the flats and the corridor); a storey with only unit plans shows them merged into one layout; unit plans list the storey's apartments either way. All plans are expressed in one frame: the reference plan's quad when the others lie inside it, else the rectangle bounding them all, so each point stays where its own registration put it. Elevations come from the plan's `building.envelope.storeys` (estimated unless documented); walls are fitted to the storey height. A storey lists the floor plan's units whose `level` is that storey (a one-storey plan also those without a level), else its unit plans. Plans without a registration, valid architecture or envelope storey are skipped and counted in `floorPlans.publication.skipped`. Review status is not a gate: approximate plans are shown, and the X-ray note says alignment is approximate.
- A native building's model has one source, the publication: `origin: 'publication'` with the plan ids and `version: null`.

## Uploaded building models

A proposed building drawn from an uploaded glTF model (`properties.modelUrl`) needs no floor model: when the model has interiors, X-ray opens it with a horizontal [model section](vocabulary.md#model-section) at the chosen storey, found in the model's own horizontal surfaces (`frontend/js/model-section.js`). With no storey chosen the cut opens the ground storey. The cut is a clipping plane on the model's materials (`applyModelSection` in `three-mode.js`), which also swap the facade skin for the model's own tinted materials, so toggling X-ray or the floor cutaway rebuilds nothing; the model's levels join the floor cutaway's list. A [georeferenced model](vocabulary.md#georeferenced-building-model) keeps its storeys below ground, which show only at a basement cutaway (`renderCutaway` keeps the cut models and hides the rest).

## Estimated layouts

A proposed building without a registered model can show a generated default interior in X-ray when
**Estimated layouts** is on (`?suggested=1`): a point-access stair-and-lift core entered from the
street-facing facade, two apartments per core, blind party walls, one core per ~240 m² of floor.
The shared interior-viewer planner (`frontend/vendor/interior-viewer/interior-planner.js`) produces the same v3 contract with `suggested: true` and layout
sources of `kind: 'generated'`; the validator accepts such sources only inside a suggested model, the
renderer draws them in a cooler palette, and they are never stored (the shared publication refuses
suggested or generated geometry as evidence). A slice whose
footprint cannot hold the minimum core is painted red instead. Office buildings, towers and buildings
of stepped parts get a central core instead (stairs, lifts and toilets through every storey; open-plan
offices with a reception at the lifts, flats off a corridor along the lifts; the planner's central-core scheme).
Design, parameters and their regulatory basis: [`floor-plans.md`](floor-plans.md).

## X-ray display and work limits

Detailed interiors are selected by camera distance and frustum before drawing: at most 24 buildings
within 200 m, 96 storeys in total, eight storeys per building, and one million architectural and
warning-overlay triangles. The nearest eligible storeys win. The selected cutaway remains an upper
limit. Other storeys and distant buildings keep coarse massing; these limits do not change authored
models, unit counts or calculated quantities. Camera movement changes visibility and shared coarse
bands in place, without generating layouts or rebuilding exterior buildings.

Native-model requests have two concurrent slots and at most 24 resident answers, with the existing
200 m load / 300 m unload hysteresis. Hidden Built layers, Photo view and X-ray off stop these reads.
With **Estimated layouts** on, **Existing buildings too** extends estimates to visible existing
buildings. This option appears when the Built layer is visible. X-ray, estimates and their scope
are saved in the view URL. Suggested existing interiors are generated for at most 24 nearby buildings in view. Their footprint
request covers the camera's 200 m neighbourhood, independently of the wider exterior-building radius.

Estimated layouts use the same pure planner in one worker, with one outstanding calculation and a
10-second watchdog. Disabling suggestions or X-ray, leaving model view, or disposing the scene stops
outstanding calculation. The worker retains at most 64 generated results, bounded by 16 MiB of
serialized content with a 4 MiB per-result ceiling. Old entries are evicted individually. Parcel
panels retain scalar summaries rather than full floor models. Mesh construction yields between
small part batches; cancelled or failed construction releases partial geometry.

Street lookups are deduplicated, limited to two concurrent reads and 64 recent cells, and restricted
to nearby visible buildings. A settled batch refreshes the planned family once, without clearing
unrelated layouts or rebuilding exterior buildings. The frontage is already part of the layout key.

Hover uses the existing batched geometry and one temporary surface overlay. Apartments highlight
blue; surfaces outside the retained apartment boundaries use neutral grey-and-white hatching.
Slabs, landings and treads retain their own elevations, and apartment boundaries and slab holes
clip the non-apartment regions. Regions are prepared once per reusable layout in the cooperative
build queue and shared between storeys; pointer movement performs no polygon clipping. Hidden
subtrees are excluded from picking, and unchanged camera/pointer states do no new picking work.
The blue overlay sits above the red warning patches even in a straight-down view. Generated
north-only apartments show **North orientation only** beside the pointer. Warning patches are
batched once per storey. Clicking an apartment region or choosing it from the dropdown selects its
storey's unit, opens the cutaway at that level and highlights the unit until selection changes.
The building selection outlines the exterior shell. Selecting a unit releases that outline.
Apartments in a local design can be inspected by clicking or using the same floor and apartment
picker. Publishing the design gives its apartments addresses for sharing and offers.
When detailed estimated storeys are visible,
they replace that building's source shell for drawing and picking in both Solid and Transparent
modes. Other buildings and distant shells keep their normal display. **Copy apartment link**
opens the same building and unit in X-ray. Shared space retains the usual map selection.

`xrayBuilding` names the building by city, building source and source ID, or by published design CID
and building feature ID (the immutable revision's building index when no feature ID is available).
`unit` names the storey level and unit ID, using `::` between escaped components. Suggested units
also carry a SHA-256 fingerprint prefix of their registration, elevation and apartment region. If
regeneration changes a unit's boundary or elevation, the old link cannot silently select the new
unit occupying the same slot. Estimated layouts and links are read-only, with no authored record,
editing operation or MCP editing schema changes.

## Read paths

`GET /proposals/:id`, `POST /proposals/batch` and parcel-scoped proposal reads join models onto building features as `properties.floorPlans` and `properties.floorModel` (`{ city, source: 'proposal', ownerId, buildingId, version: null, updatedAt, origin: 'publication', footprint, publication }`). `attachProposalFloorModels` asks the publication once per proposal (`/floor-plans?city=<city>&source=proposal&ownerId=<proposal>&nativeBuildingIds=…`, only for cities that publish floor plans) and takes a plan only when its reference's `footprintSha256` is the fingerprint of the building's current footprint, so a reshaped building shows none. Models are derived read data, stripped when a proposal is saved (`proposals/archive-state.js`), so publishing a copied or cached proposal stores no copy.

`POST /buildings/near` and `POST /buildings/cell` attach only the `floorPlansAvailable` marker to native buildings. Altered or demolished buildings do not receive the original interior. Stable source identity, rather than proximity, owns the attachment.

`GET /buildings/floor-model?city=<city>&source=<source>&buildingId=<id>` reads one native model from the publication. A proposal identity (`source=proposal&ownerId=<public-proposal-id>`) answers `{ "model": null }`: a proposal building's model comes with its proposal. Absence returns `{ "model": null }` with HTTP 200; a publication that did not answer returns 503 rather than falsely claiming no evidence exists.

## Writing floor plans

Floor plans are written only to the shared publication, by zagreb-novogradnje's publication import; this app has no floor-plan writer. The proposal seeds (`backend/scripts/seed-*-proposal.mjs`) and the restatement authoring scripts (`scripts/reconstruct-*.py`, `pionir_floor_architecture.py`) still write `building-floor-plans.v3` into the committed restatement archives (`properties.floorPlans`, carried over by `proposals/building-floor-plans.js` `attachBuildingFloorPlans` only while a building's footprint is unchanged); those archives are authoring output and evidence, not a store the app reads.

The current authored Pionir corpus covers 67 storeys across nine owners and four sites. Missing storeys and proxy intervals remain explicit and are never cloned. Shared below-ground models are attached once under their explicit owner: Savica under F3 and Lovinčićeva under C1. Savica raster traces are reviewed source evidence, not survey geometry; ramps retain flat plan footprints because no vertical profile is known; Lovinčićeva labels do not imply modeled stair runs. Native identities remain source-specific (`sourceFeatureId`, `dguBuildingId`, or `sourceLayerId`).
