Unless overriden here, follow instructions from ../AGENTS.md (the workspace-wide file one level up)


## Topology migration (2026-10-15)

Observed junction recognition and traffic simulation have moved out of this repository:

- Recognition, extractors/processors, network assembly and the topology workbench: private `zagreb-promet-topologija`, local sibling [../zagreb-promet-topologija](../zagreb-promet-topologija/README.md).
- Simulator UI and simulation logic: private `zagreb-promet-simulacija`, local sibling [../zagreb-promet-simulacija](../zagreb-promet-simulacija/README.md).
- Public endpoints: the shared `zagreb-api` service, implemented in `cadastre-data/api`.
- Shared table definitions: `cadastre-data/api/ddl/roads/002_lane_topology.sql` and `003_traffic_simulator_source.sql`; data stays in the existing shared geodata database.

Continue recognition and topology work in the new topology repository, following its own `AGENTS.md` and README. Do not resume topology jobs or maintain those implementations here. The topology copies in this worktree are retained to preserve historical and concurrent uncommitted work; there is no automatic synchronization. Compare any later local changes before porting them, and preserve local environment files and evidence.

Generic proposal/corridor editing still belongs to Consensus Builder. When merging generic work from this branch, exclude the retired recognition routes, topology scripts, workbench, domain tests and duplicate DDL. The simulator cleanup is already on `main` in commit `670a98d5`.
