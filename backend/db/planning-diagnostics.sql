-- Planning funnel and diagnostics store (applied by deploy-backend.sh). Collection still needs
-- UGT_DIAGNOSTICS_INGEST=true on the API; rows are bounded to 10,000 and seven days.
CREATE TABLE IF NOT EXISTS consensus.planning_diagnostic (
    id uuid PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 2048)
);
ALTER TABLE consensus.planning_diagnostic ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE consensus.planning_diagnostic ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS planning_diagnostic_received ON consensus.planning_diagnostic (received_at);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.planning_diagnostic OWNER TO geo_user';
    END IF;
END $$;
-- Ingestion and private reporting prune under an advisory transaction lock; for an enabled service
-- the operator must also schedule this deletion (including when ingestion is idle or disabled).
-- DELETE FROM consensus.planning_diagnostic WHERE received_at < now() - interval '7 days';
