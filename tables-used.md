# Tables used by this repo

Synced from prod with `sync-tables` (single prod DB "geodata" on `do`).
Mark big tables `(schema-only)` if you don't need their data locally.

## Building tables renamed by source (2026-07-14)

Building tables were renamed so each has exactly one source: `dgu_*` = DGU/OSS cadastre,
`gdi_*` = GDI photogrammetry, `overture_*` = Overture Maps.
Migration: `cadastre-data/db/migrations/rename_building_tables_by_source.sql`.

> ⚠️ **Not on prod yet (checked 2026-07-14).** The rename is applied to the LOCAL/dev `geodata` only;
> on prod the old table names are still the real tables. `sync-tables` pulls FROM prod, so it cannot
> fetch the new names until the migration is applied there.

| old name | new name |
| --- | --- |
| `public.building` | `public.dgu_building` |
| `public.parcel_building` | `public.dgu_building_parcel` |
| `public.building_footprint` | `public.gdi_building_footprint` |
| `public.building_3d` | `public.gdi_building_3d` |
| `public.building_3d_match` | `public.dgu_gdi_building_match` |
| `zagreb.zagreb_building_overture` | `public.overture_building_footprint` |

**Backwards-compat VIEWS exist under all the OLD names**, so this repo's queries still work
unchanged today. Those views are DEPRECATED and will be DROPPED once consumers migrate — that is why
both names still appear in code and docs. The list below uses the NEW names, which are the real
tables `sync-tables` pulls.

**Heads-up for this repo:** `height_m` / `eave_height_m` / `eave_low_confidence` MOVED off the match
table onto the new `public.gdi_building` attribute hub (they are per-GDI-object properties and were
duplicated up to 164x per object). `backend/buildings/zagreb-3d.js` reads heights through the match
table, which only still works because the compat view re-joins them. `public.gdi_building` is
therefore listed below — sync it, or heights go missing once the shims are dropped.

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
