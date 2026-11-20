-- Published standalone property-offer/v1 records.  These are intentionally not consensus.agreement:
-- an offer has no plan/design membership or readjustment outputs.
SET ROLE geo_user;
CREATE SCHEMA IF NOT EXISTS consensus;
CREATE TABLE IF NOT EXISTS consensus.property_offer (
    cid text PRIMARY KEY,
    city text NOT NULL,
    title text,
    direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
    proposer text NOT NULL,
    buyer text,
    seller text,
    lens text NOT NULL,
    parcel_refs jsonb NOT NULL,
    parcel_keys text[] NOT NULL,
    price_lamports numeric(20,0) NOT NULL CHECK (price_lamports > 0),
    expires_at timestamptz NOT NULL,
    content jsonb NOT NULL,
    onchain jsonb,
    acceptance jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((direction = 'buy' AND buyer = proposer AND seller IS NULL) OR (direction = 'sell' AND seller = proposer AND buyer IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_property_offer_city_created_at ON consensus.property_offer (city, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_offer_parcel_keys ON consensus.property_offer USING GIN (parcel_keys);
CREATE INDEX IF NOT EXISTS idx_property_offer_expires_at ON consensus.property_offer (expires_at);
CREATE TABLE IF NOT EXISTS consensus.property_offer_acceptance (
    offer_cid text NOT NULL REFERENCES consensus.property_offer(cid),
    id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'),
    candidate jsonb NOT NULL,
    consents jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (offer_cid,id)
);

-- Lens-scoped, immutable transfer evidence.  It is deliberately not an owner registry:
-- resolving evidence into an owner set is a lens policy outside this table.
CREATE TABLE IF NOT EXISTS consensus.property_offer_transfer (
    lens text NOT NULL,
    network text NOT NULL,
    offer_cid text NOT NULL REFERENCES consensus.property_offer(cid),
    parcel_keys text[] NOT NULL CHECK (cardinality(parcel_keys) > 0),
    proof jsonb NOT NULL,
    decision text NOT NULL,
    terminal text CHECK (terminal IN ('settled', 'void')),
    observed_at bigint CHECK (observed_at IS NULL OR observed_at >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (lens, network, offer_cid),
    CHECK ((terminal IS NULL AND observed_at IS NULL) OR (terminal IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_property_offer_transfer_parcel_keys
    ON consensus.property_offer_transfer USING GIN (parcel_keys);
