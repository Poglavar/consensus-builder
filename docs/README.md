<!-- Navigation between current product guides, developer setup and specialist references. -->
# Documentation

[Project overview](../readme.md) · [Live app](https://urbangametheory.xyz/) · [Local development](development.md)

## Use the app

- [Start here and watch the twelve walkthroughs](https://urbangametheory.xyz/how-to-use.html#videos).
- [Buildings and building rules](https://urbangametheory.xyz/how-to-use-buildings.html).
- [Parks, squares and lakes](https://urbangametheory.xyz/how-to-use-park-square.html).
- [Land readjustment and owner allocations](https://urbangametheory.xyz/how-to-use-reparcellization.html).
- [Roads, rail and stations](https://urbangametheory.xyz/how-to-use-road.html).
- [Views, comparisons and counterproposals](https://urbangametheory.xyz/how-to-use-views.html).
- [Croatian guides](https://urbangametheory.xyz/kako-koristiti.html) and [roadmap](https://urbangametheory.xyz/roadmap.html).

The videos recorded on 26 October 2026 include English narration, captions and transcripts. Each is embedded beside the relevant written procedure. Local application, publication, a shared composition, named-plan membership, owner acceptance and execution evidence are distinct states. An execution status or source event does not prove payment, legal registration or physical construction; see the [domain vocabulary](vocabulary.md) for the current boundaries.

## Develop and integrate

- [Local development](development.md) and [test scope](development.md#verify-a-change).
- [API and agent quickstart](https://api.urbangametheory.xyz/docs/agents).
- [Agent runtime](../backend/agents/README.md).
- [Restatements of existing situations and plans](../restatements/README.md).

The protocol build is maintained on `colosseum-worlds-fair`. Its [architecture](https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/docs/architecture.md), [protocol contracts](https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/docs/protocol.md), [reproducible build](https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/docs/hackathon-build.md) and [Solana programs](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair/blockchain/solana) describe that branch. They do not imply that every integration is enabled on every branch or location.

## Documents by subject

Each document describes a current contract, an open plan or research. Verification evidence belongs in commit messages and tests, not here.

**Domain model and records**

- [Vocabulary](vocabulary.md): the glossary of current definitions; read it before changing a record or behavior.
- [Plan, design and agreement](plan-design-agreement.md): the record contract, with [proposal history](rethink-proposals.md) and [open ground](PARCEL-OPTIONAL.md) behind it.
- [Projections](projections.md) and [protocol](protocol.md): metric geometry anywhere on the globe; identifiers, schemas and trust model.
- [Lens model](lens-model.md), [community consultations](community-consultations.md), [ownership adapters](ownership-adapters.md).
- [Land readjustment](land-readjustmend.md), [unsurveyed ground](unsurveyed-ground.md), [impact resolver](impact-resolver.md).
- [Location first](location-first.md), [saved workspace](saved-workspace.md), [portable plan files](portable-plan-files.md), [IPFS storage](ipfs-storage.md).

**Editing and the map**

- [Design language](design-language.md): components, tokens, messages and element names. [Click stack](click-stack.md), [dividers](dividers.md), [language expansion](language-expansion.md).
- Roads and rail: [road editor](road-editor.md), [corridor elevation](corridor-elevation.md) and its [levels plan](corridor-levels-plan.md), [road in a parcel](road-in-parcel.md), [schelling plans](schelling-parcels.md).
- Buildings: [urban rules and massing](urban-rule-massing.md), [freeform buildings](freeform-building.md), [floor plans](floor-plans.md), [building floor models](building-floor-models.md), [planning rule audit](planning-rule-audit.md).
- [Agreement editor](agreement-editor.md), [build-out timeline](buildout-timeline.md) (open plan).

**Sources and cities**

- [Source adapters](source-adapters.md), [frontend source configuration](frontend-source-configuration.md), [Atlas public sources](atlas-public-sources.md), [economic sources](economic-sources.md), [world parcels](world-parcels.md).
- [GUP scenario integration](gup-scenario-integration.md), [zoning standards research](zoning-standards-research.md), [planning usage and diagnostics](planning-usage-and-diagnostics.md).

**3D views**

- Model view: [ground](3d-ground.md), [life](3d-life.md), [Overture scenery](overture-buildings.md), [Zagreb buildings performance](BUILDINGS-3D-PERFORMANCE.md), [OSM 3D world](osm-3d-world.md).
- Photo view: [Google 3D Tiles](realistic-3d.md), [terrain fitting](3d-terrain-fitting.md), [seams review](photoreal-seams-review.md), [elevation realism](elevation-realism.md).

**Markets and chain**

- [LMSR market](lmsr-market.md), [betting on agreements](betting-lmsr-points.md), [betting instrumentation](betting-instrumentation.md), [San Francisco demos](sf-agreement-bets.md) and their [publication record](sf-demo-validation-2026-10-26.md), [prediction market research](prediction-market-integration.md).
- [Agreement recreation, 2026-10-26](agreement-recreation-2026-10-26.md) stays until its deadlines pass.
- [ENS](feature-ens-readme.md) and [Canton/DAML](feature-daml-readme.md): dated integration notes; verify the configuration before a chain operation.

**Agents and MCP**

- [MCP design of record](mcp.md), [workflow](mcp-workflow.md), [editing contract](mcp-editing.md), [agent working plan](agent-working-plan.md) (open plan), [directory listings](mcp-directory-submissions.md).

**Hackathon and plans**

- [Scope manifest](HACKATHON.md), [architecture](architecture.md), [build and verification](hackathon-build.md).
- [Streamline plan](streamline.md), [backlog](BACKLOG.md), [dependency security](dependency-security.md).
