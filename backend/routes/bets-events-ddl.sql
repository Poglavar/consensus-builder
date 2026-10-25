-- Anonymous browser betting funnel events; separate from chain-backed activity and simulation records.
CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.bet_event (
    id                  uuid PRIMARY KEY,
    visitor_id          uuid NOT NULL,
    session_id          uuid NOT NULL,
    actor_mode          text NOT NULL CHECK (actor_mode IN ('visitor', 'simulated')),
    simulation_run      text,
    occurred_at         timestamptz NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now(),
    name                text NOT NULL CHECK (name IN (
        'entry', 'discovery', 'market_open', 'comparison_view', 'agreement_open', 'quote',
        'action_start', 'action_status', 'action_end', 'position_view', 'share', 'return', 'close'
    )),
    city                text,
    agreement_account   text,
    agreement_cid       text,
    action              text CHECK (action IS NULL OR action IN ('create', 'buy', 'sell', 'resolve', 'claim', 'stake')),
    side                text CHECK (side IS NULL OR side IN ('yes', 'no')),
    result              text CHECK (result IS NULL OR result IN (
        'started', 'preparing', 'awaiting_signature', 'submitted', 'confirmed', 'succeeded',
        'failed', 'cancelled', 'unknown'
    )),
    asset               text CHECK (asset IS NULL OR asset IN ('points', 'devnet-usdc')),
    entry_point         text,
    error_code          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((actor_mode = 'simulated' AND simulation_run IS NOT NULL) OR (actor_mode = 'visitor' AND simulation_run IS NULL))
);

CREATE INDEX IF NOT EXISTS bet_event_received_idx ON consensus.bet_event (received_at DESC);
CREATE INDEX IF NOT EXISTS bet_event_mode_received_idx ON consensus.bet_event (actor_mode, received_at DESC);
CREATE INDEX IF NOT EXISTS bet_event_visitor_session_idx ON consensus.bet_event (actor_mode, received_at, visitor_id, session_id);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.bet_event OWNER TO geo_user';
    END IF;
END $$;
