-- Before/after thumbnails (dividers.md, M3): beside the thumbnail a proposal has had, the same
-- ground without the proposal and the two side by side for link previews. Re-runnable and only
-- ALTERs, like proposal-site-ddl.sql: the unqualified name resolves through search_path to the
-- existing proposal table (public locally, consensus on the server), so this file is safe in
-- deploy-backend.sh's DDL list. Rows are filled by the thumbnail queue at publish and by
-- scripts/backfill-proposal-thumbnails.mjs --before for older rows.

ALTER TABLE proposal ADD COLUMN IF NOT EXISTS screenshot_before_url VARCHAR(2000);
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS screenshot_pair_url VARCHAR(2000);

COMMENT ON COLUMN proposal.screenshot_before_url IS 'Thumbnail of the same ground without the proposal: the before half of a before/after view (dividers.md)';
COMMENT ON COLUMN proposal.screenshot_pair_url IS 'Before and after thumbnails side by side, the bet link preview image';
