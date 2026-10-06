-- Versioned, source-neutral architectural evidence attached to stable city building identities.
-- This is authored app data, separate from the raw building surveys maintained by cadastre-data.
SET LOCAL ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.building_floor_model (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city text NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
    source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
    owner_id text NOT NULL DEFAULT '',
    building_id text NOT NULL CHECK (length(building_id) BETWEEN 1 AND 255),
    version integer NOT NULL CHECK (version > 0),
    current boolean NOT NULL DEFAULT true,
    footprint jsonb NOT NULL CHECK (footprint->>'type' IN ('Polygon', 'MultiPolygon')),
    geom_hash text NOT NULL CHECK (length(geom_hash) = 64),
    model_hash text NOT NULL CHECK (length(model_hash) = 64),
    floor_plans jsonb NOT NULL CHECK (floor_plans->>'schema' = 'consensus-builder.building-floor-plans.v2'),
    date_missing timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((source = 'proposal' AND length(owner_id) BETWEEN 1 AND 255)
        OR (source <> 'proposal' AND owner_id = '')),
    UNIQUE (city, source, owner_id, building_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS building_floor_model_current_identity
    ON consensus.building_floor_model (city, source, owner_id, building_id) WHERE current;
