-- DDL for the proposal table
-- This table stores proposal definitions and shared lifecycle state.

CREATE TABLE IF NOT EXISTS proposal (
    id SERIAL PRIMARY KEY,
    proposal_id VARCHAR(255) UNIQUE NOT NULL, -- Unique identifier (can be onchain ID or local ID)
    city VARCHAR(100) DEFAULT 'city', -- City identifier for multi-city support
    
    -- Basic proposal information
    name VARCHAR(500),
    title VARCHAR(500),
    description TEXT,
    author VARCHAR(255),
    type VARCHAR(50) NOT NULL, -- 'parcel', 'road', 'building', 'structure'
    -- Marketplace/on-chain phase. Browser map visibility is intentionally not server state.
    lifecycle_status VARCHAR(50) NOT NULL DEFAULT 'Active'
        CHECK (lifecycle_status IN ('Active', 'Executed', 'Cancelled', 'Expired', 'draft')),
    
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
    CONSTRAINT proposal_proposal_id_key UNIQUE (proposal_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_proposal_city ON proposal(city);
CREATE INDEX IF NOT EXISTS idx_proposal_type ON proposal(type);
CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_status ON proposal(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_proposal_author ON proposal(author);
CREATE INDEX IF NOT EXISTS idx_proposal_created_at ON proposal(created_at);
CREATE INDEX IF NOT EXISTS idx_proposal_expires_at ON proposal(expires_at);
CREATE INDEX IF NOT EXISTS idx_proposal_ancestor_parcel_ids ON proposal USING GIN(ancestor_parcel_ids);
CREATE INDEX IF NOT EXISTS idx_proposal_descendant_parcel_ids ON proposal USING GIN(descendant_parcel_ids);
CREATE INDEX IF NOT EXISTS idx_proposal_parent_proposal_ids ON proposal USING GIN(parent_proposal_ids);
CREATE INDEX IF NOT EXISTS idx_proposal_child_proposal_ids ON proposal USING GIN(child_proposal_ids);
CREATE INDEX IF NOT EXISTS idx_proposal_proposal_data ON proposal USING GIN(proposal_data);

-- Comments for documentation
COMMENT ON TABLE proposal IS 'Stores proposal definitions and shared lifecycle state';
COMMENT ON COLUMN proposal.proposal_id IS 'Unique identifier for the proposal (can be onchain ID or local ID)';
COMMENT ON COLUMN proposal.ancestor_parcel_ids IS 'Array of parcel IDs that are ancestors (parent parcels before proposal)';
COMMENT ON COLUMN proposal.descendant_parcel_ids IS 'Array of parcel IDs that are descendants (child parcels created by proposal)';
COMMENT ON COLUMN proposal.parent_features IS 'Deep copy of original GeoJSON features (parcels, etc.) before they were changed';
COMMENT ON COLUMN proposal.child_features IS 'GeoJSON features of the new/modified objects created by this proposal';
COMMENT ON COLUMN proposal.proposal_data IS 'Complete proposal definition used for reconstruction';
COMMENT ON COLUMN proposal.screenshot_url IS 'Static map screenshot URL used as the proposal thumbnail in lists and cards';

-- Migration for existing installs (table name is `proposal` on the live server):
-- ALTER TABLE proposal ADD COLUMN IF NOT EXISTS screenshot_url VARCHAR(2000);
--
-- Lifecycle cleanup — run backend/scripts/remove-server-applied.js in dry-run mode first, then with
-- --apply. Add --drop-applied only after every deployed API version has stopped reading the column.
