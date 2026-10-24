-- Named map compositions are immutable plan/v1 objects; their designs remain independently published.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.plan (
    cid text PRIMARY KEY,
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
