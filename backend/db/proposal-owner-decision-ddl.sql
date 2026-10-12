-- Signed owner decisions relayed for published proposals with an approval setup
-- (land-readjustmend.md §19). POST /proposals/:id/owner-decisions stores a decision only after the
-- server re-verifies the two lens facts and the owner's wallet signature; readers verify them again,
-- so this table is a convenience, never an authority. Rows are append-only: a withdrawal is a new
-- signed decision, and each owner's current acceptance is the fold of its rows in signing order.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user; locally:
--   PGHOST=127.0.0.1 psql -U zagreb_user -d geodata -c 'SET ROLE geo_user' -f backend/db/proposal-owner-decision-ddl.sql
-- Idempotent; safe to re-run.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.proposal_owner_decision (
    id           bigserial   PRIMARY KEY,
    proposal_id  text        NOT NULL,                  -- the published proposal_id the decision signs
    owner_id     text        NOT NULL,                  -- abstract owner from the proposal's rights snapshot
    actor_id     text        NOT NULL,                  -- the wallet that signed
    decision     text        NOT NULL CHECK (decision IN ('approve', 'withdraw')),
    effect_hash  text        NOT NULL,                  -- the terms the signer saw; readers count it only if still current
    context_hash text        NOT NULL,                  -- approval context (parcels, rights, policy, lens)
    decided_at   timestamptz NOT NULL,                  -- the signed acceptedAt, never the time of receipt
    signature    text        NOT NULL UNIQUE,           -- the wallet's decision signature: one row per signed decision
    receipt      jsonb       NOT NULL,                  -- the complete receipt, as signed and verified
    created_at   timestamptz NOT NULL DEFAULT now(),    -- when the relay received it
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposal_owner_decision_proposal
    ON consensus.proposal_owner_decision (proposal_id, decided_at, signature);

COMMENT ON TABLE consensus.proposal_owner_decision IS 'Relayed, signature-verified owner decisions for abstract proposal approval (land-readjustmend.md §19).';
