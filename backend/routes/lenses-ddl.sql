-- Attester directory for the lens model (lens-model.md): known lens members and their coverage,
-- refreshed by the land-event job from attestations seen on chain. Informational; no program reads it.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.lens_member (
    key           text PRIMARY KEY,           -- base58 SAS authority public key
    kind          text,                       -- what the member attests: owner-consent | court | permit | imagery | osm | lifecycle
    name          text,
    description   text,
    metadata_uri  text,
    service_url   text,                       -- where the member takes attestation requests; null when it has none
    coverage      jsonb NOT NULL DEFAULT '{"ownership":0,"parcels":0,"executed":0}'::jsonb,
    first_seen_at timestamptz,                -- on-chain time of the first attestation seen, never fetch time
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Added after the table first shipped; the DDL runs on every deploy, so it must be idempotent.
ALTER TABLE consensus.lens_member ADD COLUMN IF NOT EXISTS service_url text;
-- Self-registration (POST /lenses/members): the member's SAS credential name and its own signed time.
ALTER TABLE consensus.lens_member ADD COLUMN IF NOT EXISTS credential_name text;
ALTER TABLE consensus.lens_member ADD COLUMN IF NOT EXISTS registered_at timestamptz;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.lens_member OWNER TO geo_user';
    END IF;
END $$;
