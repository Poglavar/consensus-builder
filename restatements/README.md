<!-- Source-backed restatements of existing situations and published plans using Consensus Builder. Keep evidence and reproducible conversion work together. -->

# Restatements

`restatements/` holds existing situations and published plans restated using Consensus Builder’s proposal and plan tools. A restatement expresses source material in our system so it can be inspected in 2D and 3D, compared with alternatives, and used as a reference for further work.

Each entry identifies whether it represents an observed built situation, a historical state, or a published plan, including its date, source evidence and uncertainty. Using the proposal data model does not make a restatement a new development proposal or establish that a published plan was built.

Each restatement should keep, where available:

- a README describing scope, dates, sources, provenance and known uncertainty;
- source and normalized GeoJSON;
- reproducible extraction, conversion, import or upload scripts;
- stable proposal identifiers or a link to the corresponding records in the system.

Standalone plans live directly below this directory, such as [`upu-borovje/`](upu-borovje/). Collections organized around one developer or research series may have an intermediate folder, such as [`pionir-paron/`](pionir-paron/). The [`nova-naselja/`](nova-naselja/) collection restates whole recently planned neighbourhoods, including their buildings and the public-space/circulation framework where the source data supports it.

The stored GeoJSON schemas and proposal identifiers retain their existing names. Source-derived geometry, dates and provenance stay attached to each restatement.
