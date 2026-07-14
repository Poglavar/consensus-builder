# Tables used by this repo

Synced from prod with `sync-tables` (single prod DB "geodata" on `do`).
Mark big tables `(schema-only)` if you don't need their data locally.

## Building tables renamed by source (2026-07-14)

Building tables were renamed so each has exactly one source: `dgu_*` = DGU/OSS cadastre,
`gdi_*` = GDI photogrammetry, `overture_*` = Overture Maps.
Migration: `cadastre-data/db/migrations/rename_building_tables_by_source.sql`.

> 🚨 **DEPLOY BLOCKER — the rename is NOT on prod yet (checked 2026-07-14).** This repo's code now
> names the NEW tables directly (`dgu_building`, `gdi_building_footprint`, `gdi_building_3d`,
> `gdi_building`, `dgu_gdi_building_match`). On prod those names DO NOT EXIST — the old names are
> still the real tables and there are no compat views pointing the other way. **Apply
> `cadastre-data/db/migrations/rename_building_tables_by_source.sql` to prod BEFORE deploying this
> backend, or every building query 500s.**
>
> The local dev DB (`zagreb`, the one `backend/.env` points at) HAS been migrated — including a
> dedupe of `gdi_building_footprint`, whose rows were each stored twice (715,366 rows / 357,683
> distinct object_id, both copies byte-identical), which had to go before `PRIMARY KEY (object_id)`
> could be added.

| old name | new name |
| --- | --- |
| `public.building` | `public.dgu_building` |
| `public.parcel_building` | `public.dgu_building_parcel` |
| `public.building_footprint` | `public.gdi_building_footprint` |
| `public.building_3d` | `public.gdi_building_3d` |
| `public.building_3d_match` | `public.dgu_gdi_building_match` |
| `zagreb.zagreb_building_overture` | `public.overture_building_footprint` |

**Backwards-compat VIEWS exist under all the OLD names.** This repo no longer uses them: every query
here now names the NEW tables directly, so the shims can be dropped without touching this code.

**Heads-up for this repo:** `height_m` / `eave_height_m` / `eave_low_confidence` MOVED off the match
table onto the new `public.gdi_building` attribute hub (they are per-GDI-object properties and were
duplicated up to 164x per object). `backend/buildings/zagreb-3d.js` now reads them from
`gdi_building` via `dgu_gdi_building_match`, not off the match table. `public.gdi_building` is
therefore required — sync it, or heights go missing.

## The buildings we work with are the GDI objects (2026-07-14)

Zagreb has TWO surveys of the same city and they disagree — the same bbox yields 112 GDI objects vs
66 DGU cadastre buildings.

- `gdi_building_footprint` (**object_id**) is the **working set**. `GET /buildings?bbox=` serves it,
  cut/tunnel/demolish detection scans it, and every demolition record is keyed by its `object_id`.
  It is 1:1 with `gdi_building_3d` (same object_id, mean IoU 0.997 — the footprint and mesh products
  of the same feature), which is what the 3D view and the walk sim render. So a record NAMES its
  mesh and every consumer matches it exactly, by id.
- `dgu_building` (**zgrada_id**) is the **cadastre reference layer** — `GET /buildings?bbox=&source=dgu`.
  It is drawn, and nothing else: nothing is ever cut, tunnelled or demolished against it.

Before this, detection scanned the cadastre while the 3D view rendered GDI meshes — we cut one
dataset and rendered another — and ~110 lines of footprint-overlap matching, a graze bar and a
`dgu_gdi_building_match` resolver existed purely to guess which mesh a cadastre record meant. All of
that is deleted. `dgu_gdi_building_match` stays in the schema (it still relates the two surveys, and
`zagreb-3d.js` uses it for heights) but is no longer part of the carve.

- ads.ad
- ads.ad_parcel
- public.area_monitor
- public.cadastral_municipality
- public.dgu_building
- public.dgu_gdi_building_match
- public.dgu_road_usage
- public.ens_plan
- public.gdi_building
- public.gdi_building_3d (schema-only)
- public.gdi_building_footprint
- stats.numbeo_city
- public.overture_feature
- public.parcel
- public.parcel_ba
- public.parcel_bg (schema-only)
- public.parcel_ens
- public.parcel_info
- public.parcel_lj
- public.parcel_lj_owner
- public.parcel_nyc_unit
- public.parcel_ownership
- public.planned_land_use
- public.planned_road
- consensus.proposal
- public.road_parcel_classification
- public.street
- consensus.urban_rule
- consensus.urban_rule_text
- consensus.urban_rule_variable
