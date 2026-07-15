-- DDL for proposals table
-- This table stores all proposal data needed to recreate proposals on the map

CREATE TABLE IF NOT EXISTS proposals (
    id SERIAL PRIMARY KEY,
    proposal_id VARCHAR(255) UNIQUE NOT NULL, -- Unique identifier (can be onchain ID or local ID)
    city VARCHAR(100) DEFAULT 'city', -- City identifier for multi-city support
    
    -- Basic proposal information
    name VARCHAR(500),
    title VARCHAR(500),
    description TEXT,
    author VARCHAR(255),
    type VARCHAR(50) NOT NULL, -- 'parcel', 'road', 'building', 'structure'
    -- Two INDEPENDENT status axes (the old overloaded `status` column is GONE):
    --   lifecycle_status: marketplace/on-chain phase — 'Active', 'Executed', 'Cancelled', 'Expired', 'draft'
    --   applied:          whether the geometry is stamped on the map and cutting the buildings under it
    lifecycle_status VARCHAR(50) NOT NULL DEFAULT 'Active',
    applied BOOLEAN NOT NULL DEFAULT true, -- spatial proposals are applied-by-default on create
    
    -- Financial information
    offer NUMERIC(20, 8),
    offer_currency VARCHAR(10) DEFAULT 'USD',
    budget NUMERIC(20, 8),
    budget_currency VARCHAR(10) DEFAULT 'USD',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Decay and deposit settings
    decay_enabled BOOLEAN DEFAULT FALSE,
    decay_percent INTEGER, -- Percentage of offer that decays (1-100)
    decay_duration_ms BIGINT, -- Duration over which decay happens (in milliseconds)
    deposit_enabled BOOLEAN DEFAULT FALSE,
    deposit_percent INTEGER, -- Percentage of offer deposited (10-200)
    
    -- Conditional proposal settings
    is_conditional BOOLEAN DEFAULT FALSE,
    disbursement_mode VARCHAR(50) DEFAULT 'partial', -- 'conditional' or 'partial'
    
    -- Parcel relationships
    ancestor_parcel_ids JSONB, -- Array of parcel IDs that are ancestors (parent parcels)
    descendant_parcel_ids JSONB, -- Array of parcel IDs that are descendants (child parcels created by proposal)
    accepted_parcel_ids JSONB, -- Array of parcel IDs that have accepted the proposal
    owner_acceptances JSONB, -- Object mapping owner addresses to acceptance status
    
    -- Proposal-specific data (stored as JSONB for flexibility)
    -- For road proposals: definition (points, width), parentFeatures, childFeatures, metadata
    -- For building proposals: buildingGeometry, parameters, parentParcelIds
    -- For structure proposals: kind, geometry, parentParcelIds, blockName
    -- For reparcellization: polygons with ownerKey, displayName, color, percent
    road_proposal JSONB,
    building_proposal JSONB,
    structure_proposal JSONB,
    reparcellization JSONB,
    
    -- Feature collections (GeoJSON)
    parent_features JSONB, -- Deep copy of original GeoJSON features before changes
    child_features JSONB, -- GeoJSON features of new/modified objects created by proposal
    
    -- Dependency tracking
    parent_proposal_ids JSONB, -- Array of parent proposal IDs
    child_proposal_ids JSONB, -- Array of child proposal IDs
    
    -- Additional metadata
    lens JSONB, -- Array of lens entries
    bounds JSONB, -- Bounds for reliable positioning [minX, minY, maxX, maxY]
    onchain_data JSONB, -- Blockchain-related data (NFT info, contract addresses, etc.)
    screenshot_url VARCHAR(2000), -- Static map screenshot URL used as the proposal thumbnail
    
    -- Full proposal data as JSONB (for complete reconstruction)
    -- This stores the entire proposal object as it exists in the frontend
    proposal_data JSONB NOT NULL,
    
    -- Indexes for common queries
    CONSTRAINT proposals_proposal_id_key UNIQUE (proposal_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_proposals_city ON proposals(city);
CREATE INDEX IF NOT EXISTS idx_proposals_type ON proposals(type);
CREATE INDEX IF NOT EXISTS idx_proposals_lifecycle_status ON proposals(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_proposals_applied ON proposals(applied);
CREATE INDEX IF NOT EXISTS idx_proposals_author ON proposals(author);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_expires_at ON proposals(expires_at);
CREATE INDEX IF NOT EXISTS idx_proposals_ancestor_parcel_ids ON proposals USING GIN(ancestor_parcel_ids);
CREATE INDEX IF NOT EXISTS idx_proposals_descendant_parcel_ids ON proposals USING GIN(descendant_parcel_ids);
CREATE INDEX IF NOT EXISTS idx_proposals_parent_proposal_ids ON proposals USING GIN(parent_proposal_ids);
CREATE INDEX IF NOT EXISTS idx_proposals_child_proposal_ids ON proposals USING GIN(child_proposal_ids);
CREATE INDEX IF NOT EXISTS idx_proposals_proposal_data ON proposals USING GIN(proposal_data);

-- Comments for documentation
COMMENT ON TABLE proposals IS 'Stores all proposal data needed to recreate proposals on the map';
COMMENT ON COLUMN proposals.proposal_id IS 'Unique identifier for the proposal (can be onchain ID or local ID)';
COMMENT ON COLUMN proposals.ancestor_parcel_ids IS 'Array of parcel IDs that are ancestors (parent parcels before proposal)';
COMMENT ON COLUMN proposals.descendant_parcel_ids IS 'Array of parcel IDs that are descendants (child parcels created by proposal)';
COMMENT ON COLUMN proposals.parent_features IS 'Deep copy of original GeoJSON features (parcels, etc.) before they were changed';
COMMENT ON COLUMN proposals.child_features IS 'GeoJSON features of the new/modified objects created by this proposal';
COMMENT ON COLUMN proposals.proposal_data IS 'Complete proposal object as stored in frontend - used for full reconstruction';
COMMENT ON COLUMN proposals.screenshot_url IS 'Static map screenshot URL used as the proposal thumbnail in lists and cards';

-- Migration for existing installs (table name is `proposal` on the live server):
-- ALTER TABLE proposal ADD COLUMN IF NOT EXISTS screenshot_url VARCHAR(2000);
--
-- Status split — run backend/scripts/split-status-applied.js --apply, which:
--   ADDs applied + lifecycle_status, backfills them, strips the legacy nested `status` from JSONB,
--   then DROPs the old overloaded `status` column and its index. No dual-write, no transition.

