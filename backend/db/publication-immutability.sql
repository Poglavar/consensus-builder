-- Publication freezes authored content. Updates may change presentation and recorded outcomes,
-- but a changed design is a new proposal, and changed plan membership is a new named plan.
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

CREATE OR REPLACE FUNCTION enforce_named_plan_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    member jsonb;
    member_id text;
    member_count integer;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY['onchain_data', 'updated_at'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['onchain_data', 'updated_at'])
        THEN
            RAISE EXCEPTION 'Named plans are immutable; create a new plan with supersedes.'
                USING ERRCODE = '23514', CONSTRAINT = 'named_plan_identity_immutable';
        END IF;
        IF OLD.onchain_data IS NOT NULL AND NEW.onchain_data IS DISTINCT FROM OLD.onchain_data THEN
            RAISE EXCEPTION 'A named plan chain reference can only be attached once.'
                USING ERRCODE = '23514', CONSTRAINT = 'named_plan_chain_reference_immutable';
        END IF;
    END IF;

    IF jsonb_typeof(NEW.proposal_ids) IS DISTINCT FROM 'array'
        OR jsonb_typeof(NEW.member_hashes) IS DISTINCT FROM 'object'
        OR NEW.plan_hash IS NULL OR NEW.plan_hash !~ '^[0-9a-f]{64}$'
    THEN
        RAISE EXCEPTION 'A named plan requires complete SHA-256 commitments; recreate invalid experimental plans.'
            USING ERRCODE = '23514', CONSTRAINT = 'named_plan_complete_commitment';
    END IF;
    member_count := jsonb_array_length(NEW.proposal_ids);
    IF member_count = 0
        OR member_count <> (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.proposal_ids))
        OR member_count <> (SELECT count(*) FROM jsonb_object_keys(NEW.member_hashes))
    THEN
        RAISE EXCEPTION 'A named plan requires one hash per unique proposal row ID.'
            USING ERRCODE = '23514', CONSTRAINT = 'named_plan_complete_commitment';
    END IF;
    FOR member IN SELECT value FROM jsonb_array_elements(NEW.proposal_ids) LOOP
        member_id := member #>> '{}';
        IF jsonb_typeof(member) <> 'string' OR member_id !~ '^[0-9]+$'
            OR jsonb_typeof(NEW.member_hashes->member_id) IS DISTINCT FROM 'string'
            OR (NEW.member_hashes->>member_id) !~ '^[0-9a-f]{64}$'
        THEN
            RAISE EXCEPTION 'A named plan requires a SHA-256 hash for every proposal row ID.'
                USING ERRCODE = '23514', CONSTRAINT = 'named_plan_complete_commitment';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS named_plan_publication_immutable ON ens_plan;
CREATE TRIGGER named_plan_publication_immutable BEFORE INSERT OR UPDATE ON ens_plan
    FOR EACH ROW EXECUTE FUNCTION enforce_named_plan_publication();
