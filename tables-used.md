# Tables used by this repo

Synced from production with `sync-tables` (one database, `geodata`, on `prod-de`). Mark big tables
`(schema-only)` to sync structure without data and `(local-only)` for tables not on production yet.
Every table is defined once, in `cadastre-data` (`api/ddl/`, `db/`) or in this repo's `backend/db/*.sql`.

Rules that shape the list:

- Building tables carry their source in the name: `dgu_*` is the DGU cadastre, `gdi_*` the GDI
  photogrammetry, `overture_*` Overture Maps. The GDI objects (`gdi_building_footprint`, keyed by
  `object_id`, 1:1 with `gdi_building_3d`) are the working set that is cut, tunnelled, demolished and
  rendered; `dgu_building` is a drawn reference layer only. `gdi_building` holds per-object heights.
- Generic-city 3D sources (`overture_building_footprint`, `osm_decor`) are ingested by `cadastre-data`
  and keyed by area, not city (`backend/buildings/overture-cities.js`).

- `gdi_building_footprint` (**object_id**) is the **working set**. `GET /buildings?bbox=` serves it,
- `dgu_building` (**zgrada_id**) is the **cadastre reference layer** — `GET /buildings?bbox=&source=dgu`.
- ads.ad
- ads.ad_parcel
- public.area_monitor
- public.cadastral_municipality
- public.parcel_build_envelope
- public.dgu_building
- public.dgu_gdi_building_match
- public.dgu_road_usage
- public.ens_plan
- public.gdi_building
- public.gdi_building_3d (schema-only)
- public.gdi_building_footprint
- stats.numbeo_city
- public.osm_decor
- public.edozvola_feature (local-only — not on prod yet; mirror with cadastre-data permits/fetch-edozvola.js)
- public.overture_address (local-only — not on prod yet; ingest with cadastre-data addresses/fetch-overture-addresses.js)
- public.overture_building_footprint
- public.parcel
- public.parcel_ba
- public.parcel_bg (schema-only)
- public.parcel_ens
- public.parcel_info
- public.parcel_lj
- public.parcel_lj_owner
- public.parcel_nyc_unit
- public.osm_road
- public.parcel_ownership
- public.planned_land_use
- public.road_widening_segment
- public.gup_street_line
- consensus.proposal
- consensus.design
- consensus.plan
- consensus.shared_plan_session (schema-only — private collaboration content and capability verifiers; backend/db/shared-plan-session-ddl.sql)
- consensus.agreement
- consensus.agreement_decision
- consensus.bet_event (schema-only)
- consensus.points_account (schema-only)
- consensus.points_market (schema-only)
- consensus.points_position (schema-only)
- consensus.points_transaction (schema-only)
- consensus.points_wallet_challenge (schema-only)
- consensus.building_floor_model
- public.road_parcel_classification
- public.street
- consensus.urban_rule
- consensus.urban_rule_text
- consensus.urban_rule_variable
- court.attestation

## Community code voting

- consensus.community_voting_ballot (schema-only)
- consensus.community_voting_event (schema-only)
- consensus.community_voting_throttle (schema-only)

Defined in `backend/db/community-voting-ddl.sql`; private ballots and limiter state are not copied from production.
