-- Persistent, source-timestamped land-event observations used by oracle recipes. The first event
-- type is proposal_lifecycle, derived from immutable terminal Solana proposal state. Lens model v2
-- adds proposal_acceptance (one per AcceptanceRecord, many per proposal) and proposal_verdict (one
-- per VerdictSettled). event_id is deterministic per fact and is the idempotency key for all of them.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.land_event (
    event_id             text PRIMARY KEY,
    event_type           text NOT NULL,
    subject_type         text NOT NULL,
    subject_id           text NOT NULL,
    outcome              text NOT NULL,
    source_url           text NOT NULL,
    source_hash          text NOT NULL,
    source_observed_at   timestamptz NOT NULL,
    attester             text NOT NULL,
    transaction_signature text NOT NULL,
    evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One terminal outcome per proposal for lifecycle events. It used to be a table-wide
-- UNIQUE (event_type, subject_id, outcome), which rejects the second acceptance of a proposal
-- (same type, subject and outcome 'accepted'); it now covers proposal_lifecycle only. Dropping the
-- constraint removes no rows. Apply this file before the job writes proposal_acceptance events.
ALTER TABLE consensus.land_event DROP CONSTRAINT IF EXISTS land_event_event_type_subject_id_outcome_key;
CREATE UNIQUE INDEX IF NOT EXISTS land_event_lifecycle_outcome_uidx
    ON consensus.land_event (event_type, subject_id, outcome)
    WHERE event_type = 'proposal_lifecycle';

CREATE INDEX IF NOT EXISTS land_event_subject_idx
    ON consensus.land_event (subject_id, source_observed_at DESC);
CREATE INDEX IF NOT EXISTS land_event_type_recency_idx
    ON consensus.land_event (event_type, source_observed_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.land_event OWNER TO geo_user';
    END IF;
END $$;
