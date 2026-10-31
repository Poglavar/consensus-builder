-- Private collaboration state; never part of the public design/plan publication index.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.shared_plan_session (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{24}$'),
    state jsonb NOT NULL CHECK (
        state ?& ARRAY['id', 'schema', 'controller', 'version', 'ownerTokenHash', 'inviteTokenHash', 'artifact', 'updatedAt', 'expiresAt']
        AND state->>'id' = id AND state->>'schema' = 'ugt-shared-plan-session/v1'
        AND state->>'controller' IN ('owner', 'agent')
        AND (state->>'version')::integer >= 0
        AND jsonb_typeof(state->'expiresAt') = 'number'
        AND (state->>'expiresAt')::double precision > (state->>'updatedAt')::double precision
        AND state->>'ownerTokenHash' ~ '^[a-f0-9]{64}$'
        AND state->>'inviteTokenHash' ~ '^[a-f0-9]{64}$'
        AND NOT state ? 'ownerToken' AND NOT state ? 'inviteToken'
    ),
    storage_bytes integer NOT NULL CHECK (storage_bytes > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE consensus.shared_plan_session IS 'Private accepted plan artifact, control/version, hashed capabilities, change receipt and one undo snapshot. Not publication.';
