-- Published designs (plan-design-agreement.md, M2 "Courier and index"): the server's index of the
-- design/v1 objects browsers publish under their own CIDs. `content` is the object exactly as
-- addressed (its canonical bytes hash to `cid`); city, site, bounds and binding are what the server
-- derived from it when it was indexed (POST /designs, routes/designs.js); the screenshot columns are
-- filled once by the thumbnail queue. The index is a convenience, never the identity: a changed
-- design is a new CID, and rows are never rewritten except to fill a missing thumbnail.
--
-- Applied by deploy-backend.sh (DDL_FILES) as geo_user; locally:
--   psql "$DATABASE_URL" -f backend/db/design-ddl.sql   (DATABASE_URL from backend/.env)
-- Idempotent; safe to re-run.

SET ROLE geo_user;

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.design (
    cid                   text        PRIMARY KEY,           -- CIDv1 raw sha2-256 base32 (bafkrei…) of the canonical content
    city                  text,                              -- where the site lies (proposals/publication-city.js), not the city the author named
    goal                  text        NOT NULL,              -- the design type, content.goal
    title                 text,
    author                text,
    site                  geometry(MultiPolygon, 4326),      -- the ground the binding was computed on: the authored site, else the footprint
    bounds                jsonb,                             -- { west, south, east, north } of the site
    binding               jsonb       NOT NULL,              -- the parcels the site takes, as checkProposalBinding derives them (proposals/binding.js)
    content               jsonb       NOT NULL,              -- the design/v1 object as addressed
    origin_cid            text,                              -- the design this one was forked from, content.origin.cid
    screenshot_url        text,                              -- thumbnail (after)
    screenshot_before_url text,                              -- the same frame without the design
    screenshot_pair_url   text,                              -- before and after side by side, for link previews
    created_at            timestamptz NOT NULL DEFAULT now(),  -- when the index received it
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_design_city_created_at ON consensus.design (city, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_created_at ON consensus.design (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_site ON consensus.design USING GIST (site);

COMMENT ON TABLE consensus.design IS 'Index of published design/v1 objects by CID, with the city and parcel binding the server derived (plan-design-agreement.md M2).';
