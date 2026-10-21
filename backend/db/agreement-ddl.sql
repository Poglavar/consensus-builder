-- Published agreements (plan-design-agreement.md, M2 "Courier and index"): the server's index of the
-- agreement/v1 objects browsers publish under their own CIDs. `content` is the object exactly as
-- addressed (its canonical bytes hash to `cid`); design_cids, input_parcel_ids, parcel_source_id and
-- deadline are copied out of it for lookups when it is indexed (POST /agreements, routes/agreements.js),
-- after its inputs were checked against its designs' server bindings. Status is computed, never
-- stored: expired once the deadline has passed, else active (executed and cancelled come from the
-- chain in M3, which also fills `onchain`). The screenshot columns are filled once by the thumbnail queue.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user; locally:
--   psql "$DATABASE_URL" -f backend/db/agreement-ddl.sql   (DATABASE_URL from backend/.env)
-- Idempotent; safe to re-run.

SET ROLE geo_user;

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.agreement (
    cid                   text        PRIMARY KEY,           -- CIDv1 raw sha2-256 base32 (bafkrei…) of the canonical content
    city                  text,                              -- the city of its first design (consensus.design.city)
    title                 text,
    author                text,
    design_cids           text[]      NOT NULL,              -- content.designs[].cid, in authored order
    input_parcel_ids      text[]      NOT NULL,              -- content.inputs.parcels[].parcelId, sorted
    parcel_source_id      text,                              -- the source those ids are in (content.inputs.parcels[].parcelSourceId); null: the city's default
    deadline              timestamptz,                       -- content.deadline; after it the agreement is expired
    content               jsonb       NOT NULL,              -- the agreement/v1 object as addressed
    onchain               jsonb,                             -- M3: the chain account the agreement is minted as
    screenshot_url        text,                              -- thumbnail (after): every design over the input land
    screenshot_before_url text,                              -- the same frame with the input land only
    screenshot_pair_url   text,                              -- before and after side by side, for link previews
    created_at            timestamptz NOT NULL DEFAULT now(),  -- when the index received it
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agreement_has_designs CHECK (cardinality(design_cids) > 0)
);

CREATE INDEX IF NOT EXISTS idx_agreement_city_created_at ON consensus.agreement (city, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_created_at ON consensus.agreement (created_at DESC);
-- "Which agreements include this design / settle this parcel?" (GET /agreements?design= / ?parcel=)
CREATE INDEX IF NOT EXISTS idx_agreement_design_cids ON consensus.agreement USING GIN (design_cids);
CREATE INDEX IF NOT EXISTS idx_agreement_input_parcel_ids ON consensus.agreement USING GIN (input_parcel_ids);

COMMENT ON TABLE consensus.agreement IS 'Index of published agreement/v1 objects by CID: designs, input land and deadline for lookups (plan-design-agreement.md M2).';
