-- Signed owner decisions relayed for published agreements (plan-design-agreement.md, M2 "Owner
-- decisions"): POST /agreements/:cid/decisions stores a decision only after the server re-verifies
-- the two lens facts and the owner's wallet signature over the agreement-decision/v1 statement, which
-- names the agreement's CID (agreements/decisions.js); readers verify them again, so this table is a
-- convenience, never an authority. Rows are append-only: a withdrawal is a new signed decision, and
-- each owner's current acceptance is the fold of its rows in signing order. The columns of
-- proposal_owner_decision, keyed by the agreement's CID; the CID commits to the terms, so no
-- separate terms hash is kept.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user, after agreement-ddl.sql; locally:
--   psql "$DATABASE_URL" -f backend/db/agreement-decision-ddl.sql   (DATABASE_URL from backend/.env)
-- Idempotent; safe to re-run.

SET ROLE geo_user;

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.agreement_decision (
    id            bigserial   PRIMARY KEY,
    agreement_cid text        NOT NULL REFERENCES consensus.agreement (cid),  -- the agreement the decision signs
    owner_id      text        NOT NULL,                  -- abstract party from the agreement's rights snapshot
    actor_id      text        NOT NULL,                  -- the wallet that signed
    decision      text        NOT NULL CHECK (decision IN ('approve', 'withdraw')),
    context_hash  text        NOT NULL,                  -- approval context (input parcels, rights, policy, lens)
    decided_at    timestamptz NOT NULL,                  -- the signed decidedAt, never the time of receipt
    signature     text        NOT NULL UNIQUE,           -- the wallet's decision signature: one row per signed decision
    receipt       jsonb       NOT NULL,                  -- the complete receipt, as signed and verified
    created_at    timestamptz NOT NULL DEFAULT now(),    -- when the relay received it
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agreement_decision_agreement
    ON consensus.agreement_decision (agreement_cid, decided_at, signature);

COMMENT ON TABLE consensus.agreement_decision IS 'Relayed, signature-verified owner decisions on published agreements, keyed by agreement CID (plan-design-agreement.md M2).';
