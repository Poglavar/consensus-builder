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
--   local:  PGHOST=localhost psql -U zagreb_user -d geodata -f backend/routes/transactions-ddl.sql
--   docker: docker exec -i consensus-builder-db-1 psql -U zagreb_user -d geodata < backend/routes/transactions-ddl.sql
--   server: ssh do "psql \"\$DATABASE_URL\" -f /root/code/consensus-builder/backend/routes/transactions-ddl.sql"
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

-- Every object in geodata is owned by geo_user (db/2026-08-08-unify-ownership-geo-user.sql); a table
-- left owned by the connecting role aborts a later `CREATE INDEX IF NOT EXISTS` run by anyone else.
-- Guarded so this file still applies on a database that has no geo_user role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.solana_transaction OWNER TO geo_user';
    END IF;
END
$$;
