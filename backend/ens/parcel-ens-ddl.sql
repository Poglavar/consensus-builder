-- DDL for parcel_ens: maps an ENS label (slug) to its parcel.
-- Backs the CCIP-Read wildcard gateway for <slug>.parcels.urbangametheory.eth.
-- slug -> parcel_id is the authoritative direction (slugs aren't cleanly
-- reversible — e.g. Zagreb's `/` collapses to `-`), so we store the mapping.

CREATE TABLE IF NOT EXISTS parcel_ens (
    slug        TEXT PRIMARY KEY,         -- ENSIP-15-safe label, e.g. us-ny-6201001005440048
    parcel_id   TEXT NOT NULL,            -- canonical parcelId, e.g. US-NY-6201001005440048
    city_code   VARCHAR(8) NOT NULL,      -- zg|ny|co|lj|bg|ba (from the id prefix)

    -- Optional enrichment, populated later; the gateway emits geo/avatar only
    -- when present. Added now (nullable) to avoid a future migration.
    lat         DOUBLE PRECISION,         -- parcel centroid latitude (WGS84)
    lon         DOUBLE PRECISION,         -- parcel centroid longitude (WGS84)
    area_m2     DOUBLE PRECISION,         -- parcel area in square metres
    token_id    NUMERIC,                  -- ParcelNFT tokenId = uint256(keccak256(parcelId))
    image_url   TEXT,                     -- parcel image (avatar record)

    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS parcel_ens_parcel_id_idx ON parcel_ens (parcel_id);
CREATE INDEX IF NOT EXISTS parcel_ens_city_code_idx ON parcel_ens (city_code);
