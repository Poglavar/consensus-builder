-- Ledger tables for the server-side agent runner (design: agents-functionality-for-ugt.md §WS3/WS7).
-- agent_run: one row per persona per run (checkpoint + verdict); agent_cost: one row per model call
-- with its exact cost, so the daily spend cap and the per-item cost display read the same numbers.
--
-- Applied by hand like the other DDL files in this repo (there is no auto-apply):
--   local:   PGHOST=localhost psql -U zagreb_user -d geodata -f backend/db/agents-ddl.sql
--   server:  psql "$DATABASE_URL" -f backend/db/agents-ddl.sql
-- Idempotent; safe to re-run.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.agent_run (
    id            bigserial PRIMARY KEY,
    run_id        text        NOT NULL,          -- "<day>-<persona>", one per persona per UTC day
    persona       text        NOT NULL,
    day           date        NOT NULL,
    mode          text        NOT NULL,          -- 'dry-run' | 'live'
    status        text        NOT NULL,          -- 'running' | 'done' | 'failed'
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    stage         text,                          -- last completed stage, for resume: planned | chosen | posted | minted | staked
    summary       jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- counts, ids, errors — what the Telegram line is built from
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_started_at ON consensus.agent_run (started_at DESC);

CREATE TABLE IF NOT EXISTS consensus.agent_cost (
    id                     bigserial PRIMARY KEY,
    run_id                 text        NOT NULL,
    item                   text        NOT NULL,   -- candidate id / batch custom_id
    provider               text        NOT NULL,   -- 'anthropic'
    model                  text        NOT NULL,   -- resolved model id as billed
    batch_id               text,
    input_tokens           integer     NOT NULL DEFAULT 0,
    output_tokens          integer     NOT NULL DEFAULT 0,
    cache_read_tokens      integer     NOT NULL DEFAULT 0,
    cache_creation_tokens  integer     NOT NULL DEFAULT 0,
    usd                    numeric(12, 6) NOT NULL, -- never null: a metered call without a price is a bug
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_cost_created_at ON consensus.agent_cost (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_cost_run_id ON consensus.agent_cost (run_id);

-- Every object in geodata is owned by geo_user (see AGENTS.md); the apply path above does not
-- SET ROLE, so hand ownership over where the role exists.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.agent_run OWNER TO geo_user';
        EXECUTE 'ALTER TABLE consensus.agent_cost OWNER TO geo_user';
        EXECUTE 'ALTER SEQUENCE consensus.agent_run_id_seq OWNER TO geo_user';
        EXECUTE 'ALTER SEQUENCE consensus.agent_cost_id_seq OWNER TO geo_user';
    END IF;
END $$;
