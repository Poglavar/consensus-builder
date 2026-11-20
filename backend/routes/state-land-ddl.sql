-- Snapshots read by the state land observer (oracle/state-land-observer.js): each complete read of a
-- cadastre's free state plots or land applications in one district, without geometry. A land event
-- `state_land_status` names the snapshot it was seen in by `source_hash`, so the evidence behind a
-- status change stays checkable after the cadastre, which publishes only the current state, has
-- moved on. Idempotent; applied by deploy-backend.sh as geo_user.

CREATE SCHEMA IF NOT EXISTS consensus;

-- snapshot_hash: sha256 of the canonical JSON of `records` (sorted by id). records: one entry per
-- record, { id, statusCode, createdAt, updatedAt, geometryHash }, with the cadastre's own times.
-- fetched_at is when the snapshot was first read; updated_at moves each time the same snapshot is
-- read again.
CREATE TABLE IF NOT EXISTS consensus.state_land_snapshot (
    snapshot_hash text PRIMARY KEY,
    provider      text        NOT NULL,     -- 'kazakhstan-pkk'
    view_name     text        NOT NULL CHECK (view_name IN ('free', 'applications')),
    district_id   integer     NOT NULL,
    source_url    text        NOT NULL,
    record_count  integer     NOT NULL,
    records       jsonb       NOT NULL,
    fetched_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS state_land_snapshot_view_idx
    ON consensus.state_land_snapshot (provider, district_id, view_name, fetched_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.state_land_snapshot OWNER TO geo_user';
    END IF;
END $$;
