<!-- This collection documents whole recent Zagreb neighbourhoods reconstructed as named Consensus Builder plans, including buildings and sourced public-space/circulation geometry. -->

# New Zagreb neighbourhoods

This collection reconstructs three large planned neighbourhoods as named collections of Consensus Builder proposals. It deliberately distinguishes the adopted plan from the built state:

- the site, road-system polygons, parks and squares come from the City of Zagreb's detailed planned-land-use layer;
- built footprints come from current DGU building geometry, with heights from the best local DGU–GDI match;
- road centrelines and editable cross-sections come from the current local OSM snapshot, clipped to the plan's official `IS` traffic surfaces;
- Podbrežje's unbuilt residential blocks are separately labelled `plan-derived-envelope` and are never presented as permit footprints.

| Named plan | Source plan | Area | Buildings | Green spaces / squares | Road centrelines | State represented |
|---|---|---:|---:|---:|---:|---|
| [`novi-jelkovec`](novi-jelkovec/) | DPU Sopnica–Jelkovec | 39.53 ha | 64 observed | 11 / 5 | 85, 7.36 km | built state inside an officially fully realized plan |
| [`podbrezje`](podbrezje/) | UPU Podbrežje | 19.43 ha | 4 observed + 7 plan-derived | 1 / 0 | 23, 1.46 km | mixed built and planned state |
| [`vrbani-iii`](vrbani-iii/) | UPU Vrbani III | 29.07 ha | 53 observed | 14 / 0 | 41, 3.41 km | built state inside a mostly realized plan |

Each project contains:

- `plan-land-use.geojson`, the full official land-use context;
- `proposal-buildings.geojson`, a losslessly round-trippable building proposal archive;
- `proposal-roads.geojson`, a losslessly round-trippable road proposal archive;
- one canonical proposal archive for each park or square;
- `plan.json`, the named-plan manifest and quantitative inventory.

Park and square proposals use `structureProposal.referenceOnly = true`. This is intentional: an adopted-plan polygon must be visible in a historical reconstruction without pretending that the app is newly repartitioning or acquiring today's cadastral/condominium land. Reference overlays also do not mark buildings beneath them for demolition and do not receive the app's procedural ponds, paths, trees, fountains or stalls unless a source archive explicitly supplies them. Ordinary user-authored parks and squares retain the normal whole-parcel formation and decoration semantics.

The reconstruction is reproducible from the local spatial database:

```sh
PGHOST=localhost node backend/scripts/seed-neighbourhood-reconstructions.mjs --dry-run --export
PGHOST=localhost node backend/scripts/seed-neighbourhood-reconstructions.mjs --apply --export
```

The first command validates and exports without changing proposal rows. The second upserts the proposals and the three `ens_plan` records into a local database. The generator refuses a non-local `PGHOST`.

Canonical building archives use `consensus-builder.reconstruction.v1`, roads use `consensus-builder.corridor-reconstruction.v1`, and parks/squares use `consensus-builder.structure-reconstruction.v1`. Every export must survive an export/import/export identity check before it is written.
