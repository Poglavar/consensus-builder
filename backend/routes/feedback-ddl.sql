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
-- Additive delivery state, including for a feedback inbox created before Telegram was enabled.
ALTER TABLE consensus.feedback ADD COLUMN IF NOT EXISTS telegram_notified_at timestamptz;
ALTER TABLE consensus.feedback ADD COLUMN IF NOT EXISTS telegram_attempted_at timestamptz;
ALTER TABLE consensus.feedback ADD COLUMN IF NOT EXISTS telegram_attempts integer NOT NULL DEFAULT 0 CHECK (telegram_attempts >= 0);
CREATE INDEX IF NOT EXISTS feedback_telegram_pending_idx ON consensus.feedback (created_at)
    WHERE telegram_notified_at IS NULL;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        ALTER TABLE consensus.feedback OWNER TO geo_user;
    END IF;
END $$;
