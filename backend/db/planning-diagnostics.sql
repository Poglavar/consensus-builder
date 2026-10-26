-- Opt-in only: deliberately NOT added to deployment DDL. Review retention/disclosure first.
-- Run with the existing backend database role; no new accounts or credentials.
CREATE TABLE IF NOT EXISTS consensus.planning_diagnostic (
    id uuid PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 2048)
);
CREATE INDEX IF NOT EXISTS planning_diagnostic_received ON consensus.planning_diagnostic (received_at);
-- Ingestion and private reporting prune under an advisory transaction lock; for an enabled service
-- the operator must also schedule this deletion (including when ingestion is idle or disabled).
-- DELETE FROM consensus.planning_diagnostic WHERE received_at < now() - interval '7 days';
