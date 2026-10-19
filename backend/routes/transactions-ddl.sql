-- DDL for consensus.solana_transaction — the local mirror of every devnet transaction this system
-- has ever made. The explorer used to re-scan the chain on every page load, which the public devnet
-- RPC rate-limits within one request; now a sync writes here incrementally and the page reads here.
--
-- `raw` holds the exact getParsedTransactions item, unmodified, so the decoder can be improved and
-- re-run over the whole history without refetching anything. The table is the checkpoint: a sync
-- killed halfway only loses the signatures it had not fetched yet.
--
-- Applied the same way as the other routes/*-ddl.sql files in this repo — by hand with psql, there
-- is no auto-apply step (see feature-ens.md for the same pattern):
--
--   local:  psql "$DATABASE_URL" -f backend/routes/transactions-ddl.sql   (DATABASE_URL from backend/.env)
--   docker: docker exec -i consensus-builder-db-1 psql -U zagreb_user -d geodata < backend/routes/transactions-ddl.sql
--   server: apply this file from the server checkout after loading its PostgreSQL environment.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS consensus.solana_transaction (
    signature TEXT PRIMARY KEY,
    slot BIGINT,
    block_time BIGINT,                        -- unix seconds from the chain; NULL until a block is timestamped
    cluster TEXT NOT NULL DEFAULT 'devnet',
    raw JSONB NOT NULL,                       -- the untouched getParsedTransactions item
    touched_addresses TEXT[],                 -- every account key + token-balance owner, for ?address= in SQL
    first_seen_watched TEXT[],                -- which watched addresses' scans surfaced this signature
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- The explorer's only ordering: newest first, slot breaking ties inside a block time.
CREATE INDEX IF NOT EXISTS solana_transaction_recency_idx
    ON consensus.solana_transaction (block_time DESC, slot DESC);

-- ?address=<pubkey> becomes `$1 = ANY(touched_addresses)`, which needs GIN to avoid a seq scan.
CREATE INDEX IF NOT EXISTS solana_transaction_touched_idx
    ON consensus.solana_transaction USING GIN (touched_addresses);

-- Durable status for each scheduled or manual sync. A successful empty run still advances
-- completed_at; failed attempts remain visible without making the prior success look fresh.
CREATE TABLE IF NOT EXISTS consensus.transaction_sync_run (
    run_id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    scanned INTEGER NOT NULL DEFAULT 0,
    new_signatures INTEGER NOT NULL DEFAULT 0,
    fetched INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_stack TEXT,
    rpc_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE consensus.transaction_sync_run
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS transaction_sync_run_latest_idx
    ON consensus.transaction_sync_run (job_name, started_at DESC);

-- Every object in geodata is owned by geo_user (db/2026-08-08-unify-ownership-geo-user.sql); a table
-- left owned by the connecting role aborts a later `CREATE INDEX IF NOT EXISTS` run by anyone else.
-- Guarded so this file still applies on a database that has no geo_user role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.solana_transaction OWNER TO geo_user';
        EXECUTE 'ALTER TABLE consensus.transaction_sync_run OWNER TO geo_user';
    END IF;
END
$$;
