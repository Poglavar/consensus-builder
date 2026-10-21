# Candlestick Point (San Francisco) inputs

Inputs for `backend/scripts/import-candlestick-courtyard.mjs`, which recreates the "Courtyard
Candlestick" concept as ordinary Freeform building proposals so it can stand next to the official plan.

## candlestick-point-boundary-wgs84.geojson

The project-area boundary: DataSF dataset `m288-24sn` ("Former SF Redevelopment Agency Project
Areas"), feature "Bayview Hunters Point Area B Zone 1", about 271 acres, reprojected to WGS84.
Licence: PDDL 1.0 (City and County of San Francisco). Both the courtyard concept and the official
FivePoint plan describe the same 271.6-acre development. This boundary is source context; each
Freeform proposal owns its own footprint site.

## The courtyard concept model (not in the repository, 37 MB)

Published by Courtyard Urbanist (Alicia Pederson) on 2026-10-05 under the concept page
https://candlestick-project.aliciapederson.chatgpt.site/ (Substack write-up:
https://urbancourtyard.substack.com/p/san-francisco-could-have-a-dense). Download
`downloads/Candlestick_FG3D_Editable_Design.zip` from that page and unzip it; the script reads the
`Candlestick_FG3D_Editable_Design.json` inside (schema `candlestick.design_model` 3.0.1, release
`CND-2026-10-05-FG3D-FINAL`, coordinates in EPSG:26910 metres). The script prints the file's SHA-256;
the published canonical hash is in the Substack appendix.

## fivepoint/ — the approved FivePoint plan, digitized

Inputs for `backend/scripts/import-candlestick-fivepoint.mjs`. The official 2024 Modified Project
Variant (FivePoint / CP Development Co. with OCII; final map approved 2026-06-16, groundbreaking
2026-09-09) is published only as PDF figures: FEIR Addendum 7 (Aug 2024) Figures 3–5 (land use,
2019 and 2024 maximum building heights) and the 2024 Design for Development block plans. These
GeoJSON layers (WGS84) were traced from the vector content of those figures and georeferenced by a
similarity fit of the drawn project boundary onto the DataSF boundary above (11 corner pairs, RMS
0.75 m, dense-boundary RMS 2.7 m; details in `georeferencing.json`, per-feature `confidence`):

- `blocks.geojson` — 63 development blocks with neighborhood, 2024 land use and maximum height.
- `height_zones.geojson` — 89 height-zone polygons (40–180 ft) with their block.
- `towers.geojson` — the 11 encouraged tower locations A–K with maximum heights (220–420 ft).
- `tower_allowable_zones.geojson`, `innovation_district.geojson`, `mid_block_breaks.geojson`,
  `land_use.geojson` — the remaining figure layers.
- `program.json` — the program numbers (7,218 homes, 2,472 affordable, 2.8 M sq ft office/R&D,
  304,500 sq ft retail, 220-room hotel, 105.7 acres of parks) with the page each came from.

Approximate by construction: a massing read off a height map, not the developer's drawings. The tower
points are the figures' symbols: an encouraged tower may stand anywhere in its allowable zone, and the
Innovation District parcel heights (A–N) were read from a raster figure (A5.3N). Affordable units and arts
space come from the OCII project overview, not Addendum 7.


## Import contract and recreation

Each disconnected footprint becomes one ordinary Freeform proposal (`goal` and `typologyType` are
`single`), retaining its holes, height and source identity. Source MultiPolygons are split without
selecting a largest piece. The Courtyard projection retains full WGS84 precision and removes
repeated consecutive source vertices. The FivePoint reconstruction retains all pieces around
mid-block passages and assigns overlapping tower bases to the taller volume, keeping the whole
built footprint without overlapping independent building parcels.

Both commands default to a dry run and write `{ plan, proposals }` to `--out`. The plan manifest
names its members as `authoredProposalIds`; publication resolves their database row IDs and uses
the ordinary immutable named-plan API. `--apply` prepares, publishes and reads back each building,
then publishes and verifies the plan's membership. An exact rerun skips existing records; changed
content at an existing ID fails and requires a new `--proposal-id` prefix/version.

For recreating an already-published aggregate, supply `--source-proposal-id <row-id>` to preserve
ordinary counterproposal lineage. Published source geometry and chain references remain intact.
Rebuilt records can then be edited, moved, reshaped and saved with the standard Freeform tool.
