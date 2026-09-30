-- Tables of the reference lens member (backend/lens/, lens-model.md): the devnet stand-in owner
-- registry its devnet-registry identity adapter reads, and the attestations it has issued.
-- Idempotent; applied by deploy-backend.sh as geo_user.

CREATE SCHEMA IF NOT EXISTS consensus;

-- Devnet stand-in for the land registry: which wallet the member recognises as an owner of a
-- parcel. One row per owner; a co-owned parcel has several rows sharing owner_count.
-- established_at is when the ownership was established at the source. It is nullable so an import
-- that does not know it stays honest; the member refuses to attest such a row rather than invent a time.
-- note is operator free text and must never hold a name or an OIB.
CREATE TABLE IF NOT EXISTS consensus.lens_devnet_owner (
    parcel_uid     text        NOT NULL,
    owner_wallet   text        NOT NULL,     -- base58 public key
    owner_count    smallint    NOT NULL CHECK (owner_count BETWEEN 1 AND 255),
    established_at timestamptz,
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (parcel_uid, owner_wallet)
);

-- Attestations this member has issued. issued_at is the chain time of the issuing transaction
-- (NULL when the RPC did not report a block time), never the insert time.
CREATE TABLE IF NOT EXISTS consensus.lens_attestation (
    address            text PRIMARY KEY,         -- SAS attestation PDA
    kind               text        NOT NULL CHECK (kind IN ('ownership', 'verdict')),
    credential         text        NOT NULL,
    schema             text        NOT NULL,
    authority          text        NOT NULL,
    parcel_uid         text,
    proposal_account   text,
    owner              text,
    payload            jsonb       NOT NULL,     -- decoded schema fields
    account_hash       text        NOT NULL,     -- sha256 hex over the whole attestation account bytes
    expiry             bigint      NOT NULL,     -- SAS expiry, Unix seconds
    transaction_signature text,
    payment            jsonb,                    -- x402 settlement receipt, when the request was paid
    issued_at          timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lens_attestation_parcel_idx ON consensus.lens_attestation (parcel_uid) WHERE parcel_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS lens_attestation_proposal_idx ON consensus.lens_attestation (proposal_account) WHERE proposal_account IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.lens_devnet_owner OWNER TO geo_user';
        EXECUTE 'ALTER TABLE consensus.lens_attestation OWNER TO geo_user';
    END IF;
END $$;
