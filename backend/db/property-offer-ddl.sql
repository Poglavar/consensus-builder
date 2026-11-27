-- Index of published property-offer/v2 records (one plot or one flat, SOL or USDC) and of people's
-- signed requests that lens members state they hold a plot or a flat. The chain is the source of
-- truth: `onchain` and `status` mirror the offer account the server read itself, and whether a
-- holding request was answered is read from chain by clients, never stored here. These are not
-- consensus.agreement: an offer has no plan/design membership or readjustment outputs.
-- A database still holding the v1 tables is migrated by scripts/migrate-property-offers-v2.mjs
-- before this file is applied (it creates nothing over a v1 table).
SET ROLE geo_user;
CREATE SCHEMA IF NOT EXISTS consensus;
CREATE TABLE IF NOT EXISTS consensus.property_offer (
    cid text PRIMARY KEY,
    city text NOT NULL,
    title text,
    direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
    proposer text NOT NULL,
    currency text NOT NULL CHECK (currency IN ('SOL', 'USDC')),
    price numeric(20,0) NOT NULL CHECK (price > 0),
    asset_kind text NOT NULL CHECK (asset_kind IN ('parcel', 'flat')),
    asset_hash char(64) NOT NULL CHECK (asset_hash ~ '^[0-9a-f]{64}$'),
    asset_key text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    expires_at timestamptz NOT NULL,
    content jsonb NOT NULL,
    onchain jsonb,
    -- 'unminted' until the server has read the offer's chain account; then the account's status.
    status text NOT NULL DEFAULT 'unminted' CHECK (status IN ('unminted', 'open', 'committed', 'settled', 'cancelled', 'expired')),
    -- The maker's lens, and the counterparty's lens once the chain account names it.
    lens_members text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_offer_city_created_at ON consensus.property_offer (city, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_offer_asset_hash ON consensus.property_offer (asset_hash);
CREATE INDEX IF NOT EXISTS idx_property_offer_lens_members ON consensus.property_offer USING GIN (lens_members);
CREATE INDEX IF NOT EXISTS idx_property_offer_status ON consensus.property_offer (status);
CREATE INDEX IF NOT EXISTS idx_property_offer_lat_lng ON consensus.property_offer (lat, lng);

-- A person asks lens members to state that it holds a plot or a flat (property-holding-request/v1).
-- message is the exact text the claimant signed (frontend/js/holding-request.js builds it) and
-- signature its base58 ed25519 signature; requested_at is the time the claimant put in that text.
CREATE TABLE IF NOT EXISTS consensus.holding_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    city text NOT NULL,
    asset jsonb NOT NULL,
    asset_hash char(64) NOT NULL CHECK (asset_hash ~ '^[0-9a-f]{64}$'),
    asset_key text NOT NULL,
    claimant text NOT NULL,
    lens_members text[] NOT NULL CHECK (cardinality(lens_members) > 0),
    note text,
    message text NOT NULL,
    signature text NOT NULL,
    requested_at timestamptz NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (asset_hash, claimant, message)
);
CREATE INDEX IF NOT EXISTS idx_holding_request_lens_members ON consensus.holding_request USING GIN (lens_members);
CREATE INDEX IF NOT EXISTS idx_holding_request_claimant ON consensus.holding_request (claimant);
CREATE INDEX IF NOT EXISTS idx_holding_request_city_created_at ON consensus.holding_request (city, created_at DESC);
