-- DDL for ens_plan: globally-unique named plans (a named, mutable set of
-- proposal ids) resolvable as <slug>.proposals.urbangametheory.eth.
-- slug is the ENS label; proposal_ids is the ordered list the name points at.
-- Mutation is gated by an edit token (sha256 stored), so the creator can update
-- the plan later without a wallet.

CREATE TABLE IF NOT EXISTS ens_plan (
    slug             TEXT PRIMARY KEY,        -- ENS-safe label, globally unique
    proposal_ids     JSONB NOT NULL,          -- ["1","2","3"] ordered proposal ids
    title            TEXT,
    city             VARCHAR(32),
    edit_token_hash  TEXT NOT NULL,           -- sha256(editToken) for mutation auth
    creator_ip       INET,
    creator_fingerprint VARCHAR(64),
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
