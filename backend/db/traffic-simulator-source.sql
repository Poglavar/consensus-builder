-- Regional copies of saved junction evidence for the dedicated read-only simulator.
-- Original solution IDs, graphs and source creation times are preserved on import.
CREATE SCHEMA traffic_simulator AUTHORIZATION geo_user;

CREATE TABLE traffic_simulator.lane_topology_solution (
    id bigint PRIMARY KEY,
    parent_id bigint,
    city text NOT NULL,
    source_kind text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    graph jsonb NOT NULL,
    stats jsonb,
    coverage geometry(Geometry, 4326)
);

CREATE TABLE traffic_simulator.lane_topology_decision (
    decision_key text PRIMARY KEY,
    node_key text NOT NULL,
    city text NOT NULL,
    assignment jsonb NOT NULL,
    point geometry(Point, 4326),
    superseded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE traffic_simulator.lane_topology_problem (
    solution_id bigint NOT NULL,
    problem_key text NOT NULL,
    severity text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
