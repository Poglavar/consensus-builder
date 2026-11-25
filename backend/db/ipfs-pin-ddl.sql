-- Content pinned on IPFS (docs/ipfs-storage.md): one row per CID, written once the pinning provider
-- confirmed it holds exactly those bytes. Publishing writes only to the index; a design, plan or
-- agreement is pinned before a mint that references it (agreements/pin-content.js), and a CID that has
-- a row is never pinned again nor unpinned, so a design shared by several agreements is stored and
-- recorded once. Pins a sponsor makes with their own provider key are not recorded here.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user; locally:
--   psql "$DATABASE_URL" -f backend/db/ipfs-pin-ddl.sql   (DATABASE_URL from backend/.env)
-- Idempotent; safe to re-run.

SET ROLE geo_user;

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.ipfs_pin (
    cid         text        PRIMARY KEY,           -- CIDv1 UnixFS sha2-256 base32, as the provider confirmed it
    kind        text        NOT NULL CHECK (kind IN ('design', 'plan', 'agreement')),
    pinned_at   timestamptz NOT NULL,              -- the provider's pin time when it reports one
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
