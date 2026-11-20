-- Drops consensus.building_floor_model, the floor-model registry the shared published floor-plan documents
-- (cadastre-data buildings.floor_plan) replace. Not applied by deploy-backend.sh: run it by hand, once.
--
-- Run it only once the release is deployed in which proposal buildings read the publication (attachProposalFloorModels,
-- backend/buildings/floor-models.js) and deploy-backend.sh no longer applies the table's DDL, and once the proposal
-- bindings are published where that release reads (zagreb-novogradnje backend/scripts/bind-proposal-floor-plans.mjs).
--
-- The guard refuses while any current registry row has a layout whose source URL no published plan carries
-- with that row's proposal reference ({ city, source, ownerId, buildingId, footprintSha256: geom_hash }, as
-- zagreb-novogradnje backend/scripts/bind-proposal-floor-plans.mjs writes it) and a registration (without
-- one the plan cannot be drawn). A second run, after the drop, changes nothing.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
--        -f backend/db/migrations/2026-11-20-drop-building-floor-model.sql
SET LOCAL ROLE geo_user;
DO $$
DECLARE
    missing text;
BEGIN
    IF to_regclass('consensus.building_floor_model') IS NULL THEN
        RAISE NOTICE 'consensus.building_floor_model is already dropped.';
        RETURN;
    END IF;
    SELECT string_agg(format('%s/%s %s', m.owner_id, m.building_id, coalesce(l->>'id', '?')), ', '
               ORDER BY m.owner_id, m.building_id, l->>'id')
      INTO missing
      FROM consensus.building_floor_model m
     CROSS JOIN LATERAL jsonb_array_elements(m.floor_plans->'layouts') l
     WHERE m.current
       AND NOT EXISTS (
           SELECT 1 FROM buildings.floor_plan p
            WHERE p.document#>>'{source,url}' = l#>>'{source,url}'
              AND p.document->'buildingRefs' @> jsonb_build_array(jsonb_build_object('city', m.city, 'source', m.source,
                  'ownerId', m.owner_id, 'buildingId', m.building_id, 'footprintSha256', m.geom_hash))
              AND coalesce(p.document->'registration', 'null'::jsonb) <> 'null'::jsonb);
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Not dropped: layouts no published plan carries for their proposal building: %', missing;
    END IF;
    DROP TABLE consensus.building_floor_model;
    RAISE NOTICE 'consensus.building_floor_model dropped.';
END $$;
