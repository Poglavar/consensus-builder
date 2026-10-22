-- Publication freezes authored content. Updates may change presentation and recorded outcomes,
-- but a changed design is a new proposal.
-- Resolve existing tables through search_path (public locally, consensus on some installs).
-- No backfill, hash restamping, legacy bypass or second write contract.

CREATE OR REPLACE FUNCTION enforce_proposal_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    mutable_columns text[] := ARRAY[
        'name', 'title', 'description', 'screenshot_url', 'screenshot_before_url', 'screenshot_pair_url',
        'epoch_year', 'lifecycle_status', 'accepted_parcel_ids', 'owner_acceptances',
        'onchain_data', 'updated_at', 'proposal_data'
    ];
    mutable_record_keys text[] := ARRAY[
        -- Response identity mirrors are filled immediately after INSERT; the real IDs are protected columns.
        'id', 'proposalId', 'proposal_id',
        'name', 'title', 'description', 'screenshotUrl', 'screenshotBeforeUrl', 'screenshotPairUrl',
        'screenshotDataUrl', 'epochYear', 'lifecycleStatus',
        'acceptedParcelIds', 'ownerAcceptances', 'onchain', 'onchainData', 'updatedAt'
    ];
BEGIN
    IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns)
        OR (NEW.proposal_data - mutable_record_keys) IS DISTINCT FROM (OLD.proposal_data - mutable_record_keys)
    THEN
        RAISE EXCEPTION 'Published proposal content is immutable; publish a fork with a new authored ID.'
            USING ERRCODE = '23514', CONSTRAINT = 'proposal_published_content_immutable';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proposal_publication_immutable ON proposal;
CREATE TRIGGER proposal_publication_immutable BEFORE UPDATE ON proposal
    FOR EACH ROW EXECUTE FUNCTION enforce_proposal_publication();
