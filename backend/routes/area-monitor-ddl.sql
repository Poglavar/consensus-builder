-- DDL for area_monitor table
-- Stores user-defined monitoring areas with polygon geometry and tracked parcels
-- Used to track acquisition progress for infrastructure projects

CREATE TABLE IF NOT EXISTS area_monitor (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    polygon JSONB NOT NULL,              -- GeoJSON Polygon geometry
    parcel_ids JSONB NOT NULL,           -- ["HR-335-1234", "HR-335-1235", ...]
    parcel_count INTEGER NOT NULL,

    -- Phase 4 fields (nullable, added now to avoid migration)
    eojn_url TEXT,
    skyscrapercity_url TEXT,

    -- Abuse prevention
    creator_ip INET,
    creator_fingerprint VARCHAR(64),     -- SHA-256 of browser characteristics

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_area_monitor_parcel_ids ON area_monitor USING GIN(parcel_ids);
CREATE INDEX IF NOT EXISTS idx_area_monitor_created_at ON area_monitor(created_at);
CREATE INDEX IF NOT EXISTS idx_area_monitor_creator_ip ON area_monitor(creator_ip);

-- Comments for documentation
COMMENT ON TABLE area_monitor IS 'User-defined monitoring areas for tracking parcel acquisition progress';
COMMENT ON COLUMN area_monitor.polygon IS 'GeoJSON Polygon geometry defining the monitored area';
COMMENT ON COLUMN area_monitor.parcel_ids IS 'Array of parcel IDs (HR-<maticni_broj_ko>-<broj_cestice> format) within the area';
COMMENT ON COLUMN area_monitor.parcel_count IS 'Cached count of parcel_ids array length';
COMMENT ON COLUMN area_monitor.eojn_url IS 'Link to public procurement notice on EOJN (elektronički oglasnik javne nabave)';
COMMENT ON COLUMN area_monitor.skyscrapercity_url IS 'Link to SkyscraperCity forum thread discussing this project';
COMMENT ON COLUMN area_monitor.creator_fingerprint IS 'SHA-256 hash of browser characteristics for abuse prevention';
