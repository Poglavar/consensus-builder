-- DDL for ens_plan: globally-unique named plans (a named set of proposal ids)
-- resolvable as <slug>.proposals.urbangametheory.eth.
-- slug is the ENS label; proposal_ids is the ordered list the name points at.
-- Named plans are IMMUTABLE (plans.md, 2026-10-10): no update route, a revision is
-- a new plan that records `supersedes`. edit_token_hash is kept for rows created
-- before that and is no longer issued. Run as geo_user (the table's owner).

CREATE TABLE IF NOT EXISTS ens_plan (
    slug             TEXT PRIMARY KEY,        -- ENS-safe label, globally unique
    proposal_ids     JSONB NOT NULL,          -- ["1","2","3"] ordered proposal ids
    title            TEXT,
    city             VARCHAR(32),
    edit_token_hash  TEXT,                    -- legacy: sha256(editToken) of pre-immutable plans
    creator_ip       INET,
    creator_fingerprint VARCHAR(64),
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Immutable plans (plans.md). Idempotent.
ALTER TABLE ens_plan ALTER COLUMN edit_token_hash DROP NOT NULL;
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS author        TEXT;
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS place         TEXT;          -- contest name, e.g. "Borovje"
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS member_hashes JSONB;         -- {"<proposal id>": sha256 of what it builds}
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS plan_hash     TEXT;          -- sha256 over ordered [id, member hash]
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS supersedes    TEXT REFERENCES ens_plan(slug);
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS site          geometry(MultiPolygon, 4326);  -- union of member sites
ALTER TABLE ens_plan ADD COLUMN IF NOT EXISTS onchain_data  JSONB;         -- set once by scripts/mint-plan.mjs
CREATE INDEX IF NOT EXISTS ens_plan_supersedes_idx ON ens_plan (supersedes);
CREATE INDEX IF NOT EXISTS ens_plan_city_idx ON ens_plan (city);
