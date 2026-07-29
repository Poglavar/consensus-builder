-- Versioned lane-topology solutions and their recognition jobs.
-- Raw OSM remains immutable evidence; every deterministic/model/manual result is a new solution.

CREATE TABLE IF NOT EXISTS public.lane_topology_solution (
    id BIGSERIAL PRIMARY KEY,
    parent_id BIGINT REFERENCES public.lane_topology_solution(id),
    city VARCHAR(64) NOT NULL DEFAULT 'zagreb',
    area_key VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'canonical', 'rejected', 'stale')),
    source_kind VARCHAR(32) NOT NULL
        CHECK (source_kind IN ('deterministic', 'codex', 'claude', 'adjudicated', 'manual')),
    provider VARCHAR(32),
    model VARCHAR(128),
    prompt_version VARCHAR(32),
    graph_schema_version INTEGER NOT NULL,
    osm_snapshot_at TIMESTAMPTZ,
    coverage geometry(Polygon, 4326) NOT NULL,
    selected_bbox NUMERIC[] NOT NULL,
    graph JSONB NOT NULL,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lane_topology_solution_coverage_gix
    ON public.lane_topology_solution USING gist (coverage);
CREATE INDEX IF NOT EXISTS lane_topology_solution_area_idx
    ON public.lane_topology_solution (city, area_key, created_at DESC);
CREATE INDEX IF NOT EXISTS lane_topology_solution_status_idx
    ON public.lane_topology_solution (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lane_topology_problem (
    id BIGSERIAL PRIMARY KEY,
    solution_id BIGINT NOT NULL REFERENCES public.lane_topology_solution(id) ON DELETE CASCADE,
    problem_key TEXT NOT NULL,
    problem_type VARCHAR(80) NOT NULL,
    severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
    point geometry(Point, 4326),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (solution_id, problem_key)
);

CREATE INDEX IF NOT EXISTS lane_topology_problem_point_gix
    ON public.lane_topology_problem USING gist (point);
CREATE INDEX IF NOT EXISTS lane_topology_problem_solution_idx
    ON public.lane_topology_problem (solution_id, severity, status);

CREATE TABLE IF NOT EXISTS public.lane_topology_job (
    id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(32) NOT NULL CHECK (provider IN ('codex', 'claude')),
    status VARCHAR(24) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    city VARCHAR(64) NOT NULL DEFAULT 'zagreb',
    area_key VARCHAR(64) NOT NULL,
    selected_bbox NUMERIC[] NOT NULL,
    base_solution_id BIGINT REFERENCES public.lane_topology_solution(id),
    result_solution_id BIGINT REFERENCES public.lane_topology_solution(id),
    model VARCHAR(128),
    prompt_version VARCHAR(32),
    input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    output_tail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lane_topology_job_created_idx
    ON public.lane_topology_job (created_at DESC);
CREATE INDEX IF NOT EXISTS lane_topology_job_status_idx
    ON public.lane_topology_job (status, created_at DESC);
