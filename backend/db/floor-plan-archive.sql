-- Agency source archive and review queue, separate from published architectural models.
SET ROLE geo_user;
CREATE SCHEMA IF NOT EXISTS floor_plan;
CREATE TABLE IF NOT EXISTS floor_plan.agency (
 registry_id bigint PRIMARY KEY, legal_name text NOT NULL, registered_address text NOT NULL, oib text,
 registry_record jsonb NOT NULL, registry_source text NOT NULL, registry_observed_at timestamptz NOT NULL,
 website text, website_status text NOT NULL DEFAULT 'unresolved', website_evidence jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.site (
 url text PRIMARY KEY, agency_id bigint REFERENCES floor_plan.agency, name text,
 discovery_url text NOT NULL, evidence jsonb NOT NULL,
 verification_status text NOT NULL DEFAULT 'candidate',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.run (
 id uuid PRIMARY KEY, status text NOT NULL CHECK(status IN ('running','complete','partial','failed','interrupted')),
 counters jsonb NOT NULL DEFAULT '{}', errors jsonb NOT NULL DEFAULT '[]', finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.blob (
 sha256 text PRIMARY KEY CHECK(length(sha256)=64), media_type text NOT NULL, byte_count integer NOT NULL,
 storage_path text, bytes_available boolean NOT NULL DEFAULT false, stored_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.target (
 url text PRIMARY KEY CHECK(length(url)<=2000), agency_id bigint REFERENCES floor_plan.agency,
 kind text NOT NULL CHECK(kind IN ('home','sitemap','page','asset')), priority integer NOT NULL DEFAULT 0, discovered_from text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ok','error','blocked','gone')),
 http_status integer, failure text, etag text, last_modified text, current_sha256 text REFERENCES floor_plan.blob,
 last_fetched_at timestamptz, next_check_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS floor_plan_target_due ON floor_plan.target(next_check_at,priority DESC);
CREATE INDEX IF NOT EXISTS floor_plan_target_current_asset
 ON floor_plan.target(current_sha256,url) WHERE kind='asset' AND current_sha256 IS NOT NULL;
CREATE TABLE IF NOT EXISTS floor_plan.observation (
 url text NOT NULL REFERENCES floor_plan.target, sha256 text NOT NULL REFERENCES floor_plan.blob,
 evidence jsonb NOT NULL, run_id uuid REFERENCES floor_plan.run, observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(url,sha256)
);
CREATE TABLE IF NOT EXISTS floor_plan.listing (
 url text PRIMARY KEY REFERENCES floor_plan.target, agency_id bigint REFERENCES floor_plan.agency, source_id text,
 facts jsonb NOT NULL, asset_urls jsonb NOT NULL DEFAULT '[]', building_id text, building_source text, building_evidence jsonb,
 match_status text NOT NULL DEFAULT 'unresolved' CHECK(match_status IN ('unresolved','candidate','verified')),
 last_observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.extraction (
 sha256 text PRIMARY KEY REFERENCES floor_plan.blob,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','not_plan','needs_review','reviewed','published','error')),
 model jsonb, evidence jsonb NOT NULL DEFAULT '{}', error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.model_revision (
 source_sha256 text NOT NULL REFERENCES floor_plan.blob,
 model_sha256 text NOT NULL CHECK(length(model_sha256)=64),
 model jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_sha256,model_sha256)
);
RESET ROLE;

-- Keep source identity and foreign-key provenance when confirmed non-plan image bytes are discarded.
SET ROLE geo_user;
ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS bytes_available boolean NOT NULL DEFAULT false;
ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS stored_at timestamptz;
ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS discarded_at timestamptz;
ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS discard_reason text;
ALTER TABLE floor_plan.target ADD COLUMN IF NOT EXISTS image_kind text
 CHECK(image_kind IN ('floor_plan','photo','render','uncertain'));
ALTER TABLE floor_plan.target ADD COLUMN IF NOT EXISTS image_classified_sha256 text;
CREATE INDEX IF NOT EXISTS floor_plan_target_image_classification
 ON floor_plan.target(image_kind,image_classified_sha256) WHERE kind='asset';
RESET ROLE;

-- Bindings carry independently established building identity; AI never chooses database IDs.
SET ROLE geo_user;
ALTER TABLE floor_plan.listing ADD COLUMN IF NOT EXISTS building_city text;
ALTER TABLE floor_plan.listing ADD COLUMN IF NOT EXISTS building_owner_id text NOT NULL DEFAULT '';
ALTER TABLE floor_plan.listing ADD COLUMN IF NOT EXISTS match_checked_at timestamptz;
ALTER TABLE floor_plan.extraction ADD COLUMN IF NOT EXISTS vision_checked_at timestamptz;
CREATE TABLE IF NOT EXISTS floor_plan.building_binding (
 id text PRIMARY KEY CHECK(length(id)=64), city text NOT NULL, source text NOT NULL,
 owner_id text NOT NULL DEFAULT '', building_id text NOT NULL, name text NOT NULL,
 match_kind text NOT NULL CHECK(match_kind IN ('listing','project','address')),
 match_value text NOT NULL, footprint jsonb, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS floor_plan_binding_match ON floor_plan.building_binding(match_kind,match_value);
CREATE TABLE IF NOT EXISTS floor_plan.ai_batch (
 id uuid PRIMARY KEY, provider_id text UNIQUE, model text NOT NULL,
 status text NOT NULL CHECK(status IN ('submitting','submitted','complete','error','unknown')),
 reserved_usd numeric NOT NULL CHECK(reserved_usd>=0), error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS floor_plan.plan_task (
 id text PRIMARY KEY CHECK(length(id)=64), source_sha256 text NOT NULL REFERENCES floor_plan.blob,
 source_url text NOT NULL, page integer NOT NULL CHECK(page>0),
 listing_url text NOT NULL REFERENCES floor_plan.listing, context jsonb NOT NULL,
 processor text NOT NULL, batch_id uuid REFERENCES floor_plan.ai_batch,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitted','complete','needs_review','not_plan','error')),
 result jsonb NOT NULL DEFAULT '{}', usage jsonb, cost_usd numeric CHECK(cost_usd>=0), error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS floor_plan_task_queue ON floor_plan.plan_task(status,created_at);
CREATE TABLE IF NOT EXISTS floor_plan.processed_plan (
 id text PRIMARY KEY CHECK(length(id)=64), task_id text NOT NULL REFERENCES floor_plan.plan_task,
 region_id text NOT NULL, city text NOT NULL, source text NOT NULL, owner_id text NOT NULL DEFAULT '',
 building_id text NOT NULL, source_sha256 text NOT NULL REFERENCES floor_plan.blob,
 model jsonb NOT NULL, model_hash text NOT NULL CHECK(length(model_hash)=64),
 status text NOT NULL CHECK(status IN ('ready','needs_review','published')),
 published_version integer, publication jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,region_id),
 CHECK((status='published' AND published_version IS NOT NULL AND published_version>0) OR (status<>'published' AND published_version IS NULL))
);
CREATE INDEX IF NOT EXISTS floor_plan_processed_building ON floor_plan.processed_plan(city,source,owner_id,building_id);
CREATE INDEX IF NOT EXISTS floor_plan_listing_assets ON floor_plan.listing USING gin(asset_urls);
RESET ROLE;
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS floor_plan.pipeline_run (
 id uuid PRIMARY KEY, status text NOT NULL CHECK(status IN ('running','complete','partial','failed','interrupted')),
 result jsonb NOT NULL DEFAULT '{}', finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
RESET ROLE;

SET ROLE geo_user;
ALTER TABLE floor_plan.agency ADD COLUMN IF NOT EXISTS in_scope boolean NOT NULL DEFAULT true;
RESET ROLE;
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS floor_plan.website_candidate (
 agency_id bigint NOT NULL REFERENCES floor_plan.agency,
 url text NOT NULL,
 source_url text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(agency_id,url)
);
RESET ROLE;

-- Geometry recognition and ad identity recognition are independent, versioned queues.
SET ROLE geo_user;
ALTER TABLE floor_plan.ai_batch ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'plans'
 CHECK(stage IN ('plans','buildings'));
ALTER TABLE floor_plan.processed_plan ALTER COLUMN city DROP NOT NULL;
ALTER TABLE floor_plan.processed_plan ALTER COLUMN source DROP NOT NULL;
ALTER TABLE floor_plan.processed_plan ALTER COLUMN building_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS floor_plan.building_task (
 id text PRIMARY KEY CHECK(length(id)=64), source_sha256 text NOT NULL REFERENCES floor_plan.blob,
 listing_url text NOT NULL REFERENCES floor_plan.listing, processor text NOT NULL,
 context jsonb NOT NULL, candidate_map jsonb NOT NULL DEFAULT '[]',
 batch_id uuid REFERENCES floor_plan.ai_batch,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitted','candidate','unresolved','not_listing','error')),
 result jsonb NOT NULL DEFAULT '{}', usage jsonb, cost_usd numeric CHECK(cost_usd>=0), error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS floor_plan_building_task_queue ON floor_plan.building_task(status,created_at);
CREATE INDEX IF NOT EXISTS floor_plan_building_task_listing ON floor_plan.building_task(listing_url,created_at DESC);
CREATE INDEX IF NOT EXISTS floor_plan_building_task_batch ON floor_plan.building_task(batch_id);
CREATE INDEX IF NOT EXISTS floor_plan_task_batch ON floor_plan.plan_task(batch_id);
RESET ROLE;

-- Image triage is independent of geometry extraction and caches a decision per source hash.
SET ROLE geo_user;
ALTER TABLE floor_plan.ai_batch DROP CONSTRAINT IF EXISTS ai_batch_stage_check;
ALTER TABLE floor_plan.ai_batch ADD CONSTRAINT ai_batch_stage_check CHECK(stage IN ('images','plans','buildings'));
CREATE TABLE IF NOT EXISTS floor_plan.image_task (
 id text PRIMARY KEY CHECK(length(id)=64), source_sha256 text NOT NULL REFERENCES floor_plan.blob,
 source_url text NOT NULL, processor text NOT NULL, batch_id uuid REFERENCES floor_plan.ai_batch,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitted','complete','needs_review','error')),
 result jsonb NOT NULL DEFAULT '{}', usage jsonb, cost_usd numeric CHECK(cost_usd>=0), error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS floor_plan_image_task_source ON floor_plan.image_task(source_sha256,processor);
CREATE INDEX IF NOT EXISTS floor_plan_image_task_queue ON floor_plan.image_task(status,created_at);
CREATE INDEX IF NOT EXISTS floor_plan_image_task_batch ON floor_plan.image_task(batch_id);
RESET ROLE;

-- Permanent, content-free decisions prevent excluded URL aliases from being crawled again.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS floor_plan.exclusion (
 identity text PRIMARY KEY, url text NOT NULL, source_sha256 text, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS floor_plan_exclusion_url ON floor_plan.exclusion(url);
ALTER TABLE floor_plan.target ADD COLUMN IF NOT EXISTS source_identity text;
ALTER TABLE floor_plan.target ADD COLUMN IF NOT EXISTS exclusion_reason text;
ALTER TABLE floor_plan.target ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'agency'
 CHECK(source_kind IN ('agency','architecture'));
CREATE INDEX IF NOT EXISTS floor_plan_target_source_identity ON floor_plan.target(source_identity);
RESET ROLE;
