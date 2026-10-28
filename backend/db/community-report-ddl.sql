-- Append-only NGO report relay. A stored signature and DID snapshot do not prove live website
-- authorization: readers resolve the organiser's DID Web document on every read.
-- Applied after agreement-ddl.sql by deploy-backend.sh; safe to re-run.
SET ROLE geo_user;

CREATE TABLE IF NOT EXISTS consensus.community_report (
    cid           text        PRIMARY KEY,
    agreement_cid text        NOT NULL REFERENCES consensus.agreement (cid),
    posted_at     timestamptz NOT NULL,
    content       jsonb       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_report_agreement
    ON consensus.community_report (agreement_cid, posted_at, cid COLLATE "C");

COMMENT ON TABLE consensus.community_report IS 'Append-only signed NGO reports; DID snapshots are not current website authorization.';
