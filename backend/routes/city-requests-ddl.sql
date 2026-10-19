-- "Ask for this city" demand signal from the world view (frontend/js/world/globe.js): one row per
-- place, counting how often visitors asked for its parcels to be added. Written by
-- routes/city-requests.js; the request times are our own events, so the server clock is the source.

CREATE SCHEMA IF NOT EXISTS consensus;

CREATE TABLE IF NOT EXISTS consensus.city_request (
    place_key          text PRIMARY KEY,          -- registry city id, 'country:<ISO2>' or 'point:<lat>,<lon>'
    name               text NOT NULL,
    country            text,
    lat                double precision NOT NULL,
    lon                double precision NOT NULL,
    request_count      integer NOT NULL DEFAULT 0,
    first_requested_at timestamptz NOT NULL DEFAULT now(),
    last_requested_at  timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS city_request_count_idx ON consensus.city_request (request_count DESC, last_requested_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_user') THEN
        EXECUTE 'ALTER TABLE consensus.city_request OWNER TO geo_user';
    END IF;
END $$;
