-- Published camera flights retain immutable route, view and interior snapshots independently of designs.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.camera_flight (
    cid text PRIMARY KEY,
    content jsonb NOT NULL CHECK (content->>'schema' = 'camera-flight/v2'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
