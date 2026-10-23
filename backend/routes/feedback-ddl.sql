-- Private user feedback. No public read endpoint; maintainers use scripts/feedback-inbox.mjs.
CREATE SCHEMA IF NOT EXISTS consensus;
CREATE TABLE IF NOT EXISTS consensus.feedback (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('bug', 'feedback')),
    message text NOT NULL CHECK (length(message) BETWEEN 1 AND 8000),
    page_url text,
    source text NOT NULL CHECK (source IN ('web', 'mcp', 'api')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON consensus.feedback (created_at DESC);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        ALTER TABLE consensus.feedback OWNER TO geo_user;
    END IF;
END $$;
