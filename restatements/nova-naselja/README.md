<!-- This collection documents whole recent Zagreb neighbourhoods restated as Consensus Builder designs, one agreement per neighbourhood, including buildings and sourced public-space/circulation geometry. -->

# New Zagreb neighbourhoods

This collection restates three large planned neighbourhoods as Consensus Builder designs, published with one agreement per neighbourhood. It deliberately distinguishes the adopted plan from the built state:

- the site, road-system polygons, parks and squares come from the City of Zagreb's detailed planned-land-use layer;
- built footprints come from current DGU building geometry, with heights from the best local DGU–GDI match;
- road centrelines and editable cross-sections come from the current local OSM snapshot, clipped to the plan's official `IS` traffic surfaces;
- Podbrežje's unbuilt residential blocks are separately labelled `plan-derived-envelope` and are never presented as permit footprints.

| Plan key | Source plan | Area | Buildings | Green spaces / squares | Road centrelines | State represented |
|---|---|---:|---:|---:|---:|---|
| [`nova-naselja/novi-jelkovec`](novi-jelkovec/) | DPU Sopnica–Jelkovec | 39.53 ha | 64 observed | 11 / 5 | 85, 7.36 km | built state inside an officially fully realized plan |
| [`nova-naselja/podbrezje`](podbrezje/) | UPU Podbrežje | 19.43 ha | 4 observed + 7 plan-derived | 1 / 0 | 23, 1.46 km | mixed built and planned state |
| [`nova-naselja/vrbani-iii`](vrbani-iii/) | UPU Vrbani III | 29.07 ha | 53 observed | 14 / 0 | 41, 3.41 km | built state inside a mostly realized plan |

Each project contains:

- `plan-land-use.geojson`, the full official land-use context;
- `proposal-buildings.geojson`, a losslessly round-trippable building archive;
- `proposal-roads.geojson`, a losslessly round-trippable road archive;
- one canonical archive for each park or square;
- `plan.json`, the manifest: the archives in plan order (roads, parks, squares, buildings) and the quantitative inventory;
- `ground.json` once captured: the land the app derives for the neighbourhood's agreement (see below).

Park and square polygons are ordinary designs. They resolve live parcel ground, form public-space parcels, scan buildings beneath them and receive the same procedural decoration treatment as user-authored parks and squares. A restatement therefore succeeds only where its roads, readjustment and public-space polygons compose into a valid parcel fabric; the archive does not have a presentation-only bypass.

The archives are reproducible from the local spatial database:

```sh
node backend/scripts/seed-neighbourhood-reconstructions.mjs --dry-run
node backend/scripts/seed-neighbourhood-reconstructions.mjs --export
```

The first command builds and validates every archive without writing a file; the second writes the archives and manifests. Neither writes a database row. The generator refuses a `DATABASE_URL` (from backend/.env) whose host is not local.

Canonical building archives use `consensus-builder.reconstruction.v1`, roads use `consensus-builder.corridor-reconstruction.v1`, and parks/squares use `consensus-builder.structure-reconstruction.v1`. Every export must survive an export/import/export identity check before it is written.

## Publishing designs and agreements

`backend/scripts/publish-restatement-archives.mjs` turns each archive into a `design/v1` object (the archive's own date is the design's `authoredAt`) and publishes each neighbourhood as its designs plus one agreement: a community vote with no lens, money, allocations or deadline, titled by the manifest. Identifiers are the design CIDs and the agreement CID the script prints; the archives' internal proposal ids are archive keys only.

```sh
cd backend
node scripts/publish-restatement-archives.mjs --dry-run --collection nova-naselja                     # design CIDs, no network
node scripts/publish-restatement-archives.mjs --designs --collection nova-naselja --api <api> [--origin <app>] --apply
node scripts/publish-restatement-archives.mjs --capture --collection nova-naselja --app <app> --api <api>   # → <project>/ground.json
node scripts/publish-restatement-archives.mjs --agreement --collection nova-naselja --api <api> [--origin <app>] --app <app> --apply
```

`--capture` opens the running app with agent-browser, applies the neighbourhood's designs as an agreement link does and writes the land the app derives (input parcels, output pieces) to `<project>/ground.json`; `--agreement` builds the agreement from it and refuses when the designs changed since (recapture). `--only nova-naselja/<project>` limits any step to one neighbourhood; progress is checkpointed in `~/.config/ugt/restatements/<api host>/`.
