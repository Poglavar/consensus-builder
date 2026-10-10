-- Prepared publication artifacts (projections.md §3). POST /proposals/prepare materialises a proposal
-- from its authored inputs, binds it and stores the result here, immutable and content-addressed
-- (the id is the digest's prefix, so preparing the same thing twice is one row). Metadata upload,
-- minting and POST /proposals all reference that exact artifact, and publication stores the artifact
-- itself — so what was minted is what is published. A published record names its artifact in
-- proposal_data.preparation; rows here are never updated.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user; locally:
--   PGHOST=127.0.0.1 psql -U zagreb_user -d geodata -c 'SET ROLE geo_user' -f backend/db/proposal-prepared-ddl.sql
-- Idempotent; safe to re-run.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.proposal_prepared (
    id          text        PRIMARY KEY,                -- 'prep_' + the digest's first 32 hex chars
    digest      text        NOT NULL,                   -- sha256 hex of the canonical (key-sorted) artifact JSON
    artifact    jsonb       NOT NULL,                   -- inputs digest, site + hash, binding, declaration, corridor land + provenance, cadastre revision
    city        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposal_prepared_created_at ON consensus.proposal_prepared (created_at DESC);

COMMENT ON TABLE consensus.proposal_prepared IS 'Immutable, content-addressed prepared publication artifacts (projections.md §3).';
