-- DDL for the ai_scene table.
-- One row per shared AI photorealistic render: the hosted image plus everything needed to drop a
-- link-follower back into the same 3D world and camera view (which proposals were applied, the
-- orbit-camera pose, city/lang, and the model/prompt used). Keyed by a short URL-safe slug.

CREATE TABLE IF NOT EXISTS ai_scene (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(32) NOT NULL UNIQUE,        -- short URL id, e.g. /proposals/662?scene=<slug>
    image_url VARCHAR(2000) NOT NULL,        -- hosted PNG (uploads/images/...), used in-app and as og:image
    focus_proposal_id VARCHAR(255),          -- the proposal the render is "about" (drives the /proposals/:id path)
    proposal_ids JSONB NOT NULL DEFAULT '[]'::jsonb, -- all proposals to apply to reconstruct the world
    view JSONB,                              -- orbit camera: { targetLat, targetLng, headingDeg, pitchRad, range }
    city VARCHAR(100),
    lang VARCHAR(10),
    model VARCHAR(100),                      -- which image model produced it
    prompt TEXT,                             -- the caption used, for provenance
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_scene_slug_idx ON ai_scene (slug);
CREATE INDEX IF NOT EXISTS ai_scene_focus_idx ON ai_scene (focus_proposal_id);

-- One row per paid render, so the lifetime spend cap survives restarts and deploys (an in-memory
-- counter would reset to zero every time the process restarted, making the cap unenforceable).
-- Not every render is shared, so this cannot be derived from ai_scene.
CREATE TABLE IF NOT EXISTS ai_scene_spend (
    id SERIAL PRIMARY KEY,
    model VARCHAR(100),
    cost_usd NUMERIC(12, 6) NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_scene_spend_created_idx ON ai_scene_spend (created_at);
