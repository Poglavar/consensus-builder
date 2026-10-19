-- Proposal site and parcel binding (PARCEL-OPTIONAL.md, phase 1): adds proposal.site and
-- proposal.binding and relaxes "cadastre_parcel_ids is non-empty" to "non-empty OR a site".
-- Re-runnable, and only ALTERs: the unqualified name resolves through search_path to the existing
-- proposal table (public locally, consensus on the server) and can never create a shadow table,
-- which is why this file, unlike proposals-ddl.sql, is safe in deploy-backend.sh's DDL list.

ALTER TABLE proposal ADD COLUMN IF NOT EXISTS site geometry(MultiPolygon, 4326);
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS binding JSONB;

ALTER TABLE proposal DROP CONSTRAINT IF EXISTS proposal_cadastre_parcel_ids_nonempty;
ALTER TABLE proposal DROP CONSTRAINT IF EXISTS proposal_cadastre_parcel_ids_or_site;
ALTER TABLE proposal ADD CONSTRAINT proposal_cadastre_parcel_ids_or_site CHECK (
    CASE WHEN jsonb_typeof(cadastre_parcel_ids) = 'array'
        THEN jsonb_array_length(cadastre_parcel_ids) > 0 OR site IS NOT NULL
        ELSE FALSE
    END
) NOT VALID;
-- NOT VALID: enforced for every insert/update, not re-scanned over existing rows on each deploy.
-- Rows that passed the stricter non-empty CHECK it replaces pass this one by construction.
-- proposal_cadastre_declaration_matches_record is unchanged and stays.

CREATE INDEX IF NOT EXISTS idx_proposal_site ON proposal USING GIST (site);

COMMENT ON COLUMN proposal.site IS 'The ground the proposal occupies (MultiPolygon, EPSG:4326). See PARCEL-OPTIONAL.md.';
COMMENT ON COLUMN proposal.binding IS 'Server binding of the site at publish time (parcels, intrusion, coverage). cadastre_parcel_ids equals its bound parcels.';
