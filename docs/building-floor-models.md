<!-- Storage, source-adapter and rendering contract for optional architectural interiors. -->
# Building floor models

X-ray displays authored architectural interiors when a building has evidence for them. Buildings without a model continue through the existing exterior renderer, with the same Built/Planned settings. No developer, city or project name participates in the runtime renderer.

## What is saved

`consensus.building_floor_model` in PostgreSQL holds one current, versioned model per `(city, source, owner_id, building_id)`. Proposal buildings use `source = proposal`, the public proposal id as `owner_id`, and the building's stable `sourceFeatureId`, or `dgu-building:<dguBuildingId>` / `source-layer:<sourceLayerId>` when the reconstruction retains those provider identifiers. Survey buildings use the provider's native `object_id` and the `floorModelSource` returned by `/buildings/near`; `owner_id` is empty. Custom feeds have separate hashed source identities, so their local building ids cannot collide.

The JSON model contains:

- WGS84 registration corners, placement method and accuracy notes.
- Reusable floor layouts: wall and slab polygons, openings, door hinges, stairs, landings and railings, plus their metric dimensions.
- Floors referencing those layouts, each with its level, elevation, elevation basis and source evidence.
- Source URLs/checksums and optional PDF page/crop metadata. Non-PDF sources use the same contract without page or crop fields.
- Explicit inference notes. Estimated dimensions are not measurements.

This is a parametric architectural model, not a stored triangle mesh or a raw PDF. Source adapters extract and review geometry offline. The browser converts the saved polygons and dimensions into meshes when X-ray is enabled, shares geometry between repeated layouts, and disposes it when disabled. It never parses a PDF. The source files and reviewed extraction manifests remain the reproducibility evidence.

The common schemas and validation live in `frontend/js/building-floor-plans.js`; `three-floor-plans.js` only creates and manages Three.js objects. Pionir's PDF interpretation is confined to its authoring scripts. Another supplier needs an adapter to the same schema, not another renderer.

## Read paths

`GET /proposals/:id`, `POST /proposals/batch` and parcel-scoped proposal reads join models onto building features as `properties.floorPlans` and `properties.floorModel`. A proposal footprint must exactly match its registered footprint before attachment. Models are derived read data, stripped when a proposal is saved, so publishing a copied or cached proposal cannot duplicate or overwrite the registry.

`POST /buildings/near` attaches matching native models as `floorPlans` and `floorModel`. Altered or demolished buildings do not receive the original interior. Stable source identity, rather than proximity, owns the attachment.

`GET /buildings/floor-model?city=<city>&source=<source>&buildingId=<id>` reads one native model; proposal reads also supply `ownerId=<public-proposal-id>`. Absence returns `{ "model": null }` with HTTP 200. Database failures remain errors rather than falsely claiming no evidence exists.

## Ingestion and deployment

The backend deployment applies `backend/db/building-floor-model.sql` before reloading the API. The table belongs to `geo_user`. This app owns the authored registry; shared raw cadastre and building surveys remain in cadastre-data.

```sh
# Review first; the default is a rolled-back transaction.
PGHOST=localhost node --env-file=backend/.env backend/scripts/import-building-floor-plans.mjs \
  --archive path/to/proposal.geojson --init-schema

# Save only that project's validated models. Repeating this is a no-op.
PGHOST=localhost node --env-file=backend/.env backend/scripts/import-building-floor-plans.mjs \
  --archive path/to/proposal.geojson --apply
```

For a native building, use `--models path/to/models.json` with an envelope `{"schema":"consensus-builder.building-floor-model-registry.v1","models":[...]}`. Each entry contains `city`, `source`, `buildingId`, `footprint` (WGS84 Polygon/MultiPolygon) and `floorPlans` (the common model). Proposal models must use `--archive`, which verifies their current stored identity and footprint.

Production imports use the production environment, `--target production`, and `--confirm-production` when applying. Each project is one transaction: models are validated, versioned and read back before any old inline copies are removed. Changed models retain older versions; equal semantic JSON is a no-op despite PostgreSQL key ordering. Missing source pages never delete a saved model. The source-search inventory records gaps separately.

The current authored Pionir corpus covers 67 floors across nine owners and four sites. Missing floors and proxy intervals remain explicit and are never cloned. Shared below-ground models are attached once under their explicit owner: Savica under F3 and Lovinčićeva under C1. Savica raster traces are reviewed source evidence, not survey geometry; ramps retain flat plan footprints because no vertical profile is known; Lovinčićeva labels do not imply modeled stair runs. Native identities remain source-specific (`sourceFeatureId`, `dguBuildingId`, or `sourceLayerId`).
