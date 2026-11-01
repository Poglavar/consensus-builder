-- Private hosted chat state and a spend ledger retained independently of conversation deletion.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.chat_conversation (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{24}$'),
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    client_ip text NOT NULL,
    language text NOT NULL,
    city text NOT NULL,
    plan_ref text,
    plan_cid text,
    plan_history jsonb NOT NULL DEFAULT '[]',
    messages jsonb NOT NULL DEFAULT '[]',
    notes jsonb NOT NULL DEFAULT '[]',
    turns integer NOT NULL DEFAULT 0,
    spent_usd numeric(12,6) NOT NULL DEFAULT 0,
    turn_in_progress_since timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_conversation_expiry_idx ON consensus.chat_conversation(expires_at);
CREATE TABLE IF NOT EXISTS consensus.chat_turn (
    id bigserial PRIMARY KEY,
    conversation_id text REFERENCES consensus.chat_conversation(id) ON DELETE SET NULL,
    n integer NOT NULL,
    turn_key uuid NOT NULL,
    client_ip text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL DEFAULT 0,
    cache_read_tokens integer NOT NULL DEFAULT 0,
    cache_write_tokens integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    steps jsonb NOT NULL DEFAULT '[]',
    est_usd numeric(12,6) NOT NULL CHECK (est_usd >= 0),
    cost_usd numeric(12,6) CHECK (cost_usd >= 0),
    status text NOT NULL DEFAULT 'running',
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (conversation_id, turn_key)
);
CREATE INDEX IF NOT EXISTS chat_turn_created_idx ON consensus.chat_turn(created_at);
COMMENT ON TABLE consensus.chat_turn IS 'UTC daily spend reservations and settled cost. Deleting chat content cannot reset the spend cap.';
