<!-- Source-backed restatements of existing situations and published plans using Consensus Builder. Keep evidence and reproducible conversion work together. -->

# Restatements

`restatements/` holds existing situations and published plans restated using Consensus Builder’s designs and agreements. A restatement expresses source material in our system so it can be inspected in 2D and 3D, compared with alternatives, and used as a reference for further work.

Each entry identifies whether it represents an observed built situation, a historical state, or a published plan, including its date, source evidence and uncertainty. Using the design data model does not make a restatement a new development proposal or establish that a published plan was built.

Each restatement should keep, where available:

- a README describing scope, dates, sources, provenance and known uncertainty;
- source and normalized GeoJSON;
- reproducible extraction, conversion and publishing scripts;
- the committed ground file of each plan's agreement (`--capture`, below).

Standalone plans live directly below this directory, such as [`upu-borovje/`](upu-borovje/). Collections organized around one developer or research series may have an intermediate folder, such as [`pionir-paron/`](pionir-paron/). The [`nova-naselja/`](nova-naselja/) collection restates whole recently planned neighbourhoods, including their buildings and the public-space/circulation framework where the source data supports it. The Candlestick Point imports (San Francisco) keep their inputs in [`backend/scripts/data/candlestick/`](../backend/scripts/data/candlestick/README.md).

## Designs and agreements

A restated plan is published as its designs plus one agreement over them (plan-design-agreement.md): every design is a content-addressed `design/v1` object, and the agreement is a community vote with no lens, money, allocations or deadline, titled after the plan. Identifiers are design CIDs and agreement CIDs; there are no named plans or proposal ids. The same content always gives the same CIDs, so rerunning a publish publishes nothing new, and a corrected design is simply a new CID. Each design's `authoredAt` is a fixed source date (the plan's date, or the archive's own date), never the time of publishing.

Every publishing script runs through [`backend/scripts/lib/restatement-publish.mjs`](../backend/scripts/lib/restatement-publish.mjs) and shares its steps:

```sh
node <script> --dry-run                                                   # design objects and CIDs; no network
node <script> --designs --api <api> [--origin <app>] --apply              # pin and index the designs
node <script> --capture --app <app> --api <api>                           # the land the app derives → ground file
node <script> --agreement --api <api> [--origin <app>] [--app <app>] --apply   # pin and index the agreement
```

- A parcel layout is pinned with `--designs` and its binding asked; the index takes it only with its agreement.
- `--capture` drives the running app with agent-browser: it applies the plan's designs exactly as an agreement link does and writes the input parcels and output pieces the app derives to the plan's committed ground file. A piece's hash commits to its exact geometry, so the agreement's outputs must be the app's own.
- `--agreement` refuses a ground file captured over other designs than the current ones (recapture), and inputs that are not exactly the parcels the designs bind on the server.
- `--apply` gates every write; `--origin` is required with it when the API is not on localhost. Progress is checkpointed per design in `~/.config/ugt/restatements/<api host>/<plan key>.json`, and pins wait out the courier's rate limit (30 pins per 15 minutes).

To recreate all demo content on an API, run the four steps for each of:

1. `restatements/upu-borovje/build-and-upload.mjs` (UPU Borovje – zona jug);
2. `restatements/upu-borovje/build-urban-blocks.mjs` (Borovje – urbani blokovi; shares the streets, layouts and parks of 1);
3. `backend/scripts/import-candlestick-fivepoint.mjs` and `backend/scripts/import-candlestick-courtyard.mjs --source <model>`;
4. `backend/scripts/publish-restatement-archives.mjs` (the twelve Pionir/Paron projects and the three Nova naselja neighbourhoods).

The stored GeoJSON archive schemas keep their existing names. Source-derived geometry, dates and provenance stay attached to each restatement.
