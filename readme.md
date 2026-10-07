# Consensus Builder

## Hyperstition: Markets for Possible Cities

> Humans and agents imagine, propose, fund, and forecast changes to exact parcels. Public records
> decide which possible futures became real.

Consensus Builder, an Urban Game Theory project, connects four workflows that are normally separate—mapping, proposals, funding,
and prediction markets—through one canonical parcel identity. Humans, deterministic agents, and
LLM-controlled agents use the same proposal, wallet, and activity interfaces.

This branch contains the **Hyperstition: Markets for Possible Cities** submission for the
**Colosseum Crypto World's Fair 2026**, built as an Urban Game Theory project by Consensus Builder.
Urban Game Theory predates the event; [`HACKATHON.md`](HACKATHON.md) identifies the exact baseline,
commits, and features built during the hackathon.

## Start here

- [Live pitch deck](https://urbangametheory.xyz/deck.html)
- [Five-minute demo center](https://urbangametheory.xyz/hackathon-demo.html)
- [Executed YES case](https://urbangametheory.xyz/proposals/hackathon-executed-borovje-2026) — the counterpart of the cancelled canonical case, shown beside it in the demo center with every devnet transaction linked.
- [Lens model](lens-model.md) — soulbound parcels, a list of trusted attesters per proposal, attested execution; programs upgraded on devnet, with live member-service and human-owner verification still to complete.
- [Agent/x402 quickstart](https://api.urbangametheory.xyz/docs/agents)
- [Unified human and agent activity](https://urbangametheory.xyz/actor-explorer.html)
- [Follow @UrbanGameTheory on X](https://x.com/UrbanGameTheory)
- [Hackathon diff](https://github.com/Poglavar/consensus-builder/compare/3ee1855...colosseum-worlds-fair)

## What the hackathon build adds

- x402-paid, Bazaar-discoverable proposal submission for agents;
- an eleven-tool MCP surface that reuses the same proposal, funding, forecast, activity, and
  verified-fact adapters for deterministic or LLM controllers;
- Solana devnet programs for proposal prediction markets, donations, and soft pledges;
- one activity model for people, deterministic controllers, and LLM controllers;
- a deterministic land-event oracle with hashed resolution recipes and source-linked evidence;
- a privacy-preserving bridge to parcel-level Croatian court attestations;
- a recipe-bound external market verifier for those public SAS attestations; and
- read-only proposal review plus safe Counterpropose/Fork flows.

The deployed prediction market resolves from either ProposalNFT terminal state or a recipe-bound
external evidence account. On 2026-09-21 the external verifier completed its first funded devnet
lifecycle from a real Croatian court SAS attestation: both outcomes were staked, an unrelated wallet
resolved the market permissionlessly, and the winning position claimed the pool. The public proof is
recorded in [`HACKATHON.md`](HACKATHON.md#live-external-market-proof).

## Repository guide

| Path | Purpose |
|---|---|
| [`frontend/`](frontend/) | Parcel map, proposal UI, wallet flows, pitch, demo, and actor explorer |
| [`backend/`](backend/) | Public API, x402 gate, agent runtime, activity ledger, and land-event oracle |
| [`blockchain/solana/`](blockchain/solana/) | Anchor programs, generated IDLs, clients, and lifecycle scripts |
| [`docs/architecture.md`](docs/architecture.md) | Current system diagram and implemented versus next boundaries |
| [`docs/hackathon-build.md`](docs/hackathon-build.md) | Reproducible install, test, local-view, and demo instructions |
| [`docs/protocol.md`](docs/protocol.md) | Program IDs, schemas, recipe and adapter contracts, and trust assumptions |
| [`HACKATHON.md`](HACKATHON.md) | Reviewable hackathon scope and proof links |

## Map UI

The frontend has no sidebar; the map is the whole interface:

- **Search box** (top left) with the **city chip**: cities, parcel ids, proposals, addresses and
  commands in one input. The city chip opens the world view.
- **User bubble**, **Layers** and **Settings** (top right). Layers and Settings open floating sheets;
  Settings holds data source, base map and a *Data & maintenance* section (loaded-parcel cover,
  refresh parcel data, clear local parcel/block/road/proposal data, wipe all local data).
- **Mode strip** (left edge): 2D, 3D, photo, AI, walk and the cadastre view.
- **Game pill** (bottom left): date, turn and play/pause; expands to the game sheet.
- **Proposals** (with count badge), **Tools** and **Activity** buttons (bottom right).
- **Parcel menu** on click: *Propose here*, *Select more*, *Details*, *History*, *Tools*,
  *Offer my land*, *View in 3D*, *Detect block*. Multi-select shows a **selection tray**
  (*Propose*, *Detect block*, *Clear*, *Done*).
- **Command palette**: Ctrl/Cmd-K.
- **Urban blocks · OSM** in Layers: detects enclosed blocks from OSM road centrelines worldwide,
  including Explore mode without parcels. Roads load automatically without a line overlay; click
  a coloured block for area, outer perimeter, estimated walking time at 5 km/h, compactness and,
  when available, a live count of loaded parcels. Details use a side panel on desktop and a
  collapsible bottom sheet on phones; the whole selected block fits in the unobstructed map area.
  An adjustable target size (100 × 100 m by default) estimates how many smaller blocks its area
  represents, without designing a subdivision. Selecting a block updates the URL; **Copy block
  link** shares its outline ID, bounds and target size. Opening that link loads the whole road
  enclosure, selects the block and frames it above/beside the panel on any screen size.
  The view follows the map at neighbourhood scale;
  open or clipped blocks stay unshaded. This analysis is separate from parcel-based block tools.
- **World view**: on first visit a globe coloured by parcel-data coverage; pick a city, or
  *Explore anyway* to open a place without parcel data.

Code: `frontend/js/ui/` (`commands.js` capability registry, `map-shell.js`, `map-search.js`,
`search-model.js`, `command-palette.js`, `parcel-menu.js`, `parcel-menu-model.js`,
`selection-tray.js`, `world-entry.js`), `frontend/js/world/` (`globe.js`, `globe-math.js`,
`world-coverage.js`, `world-entry-model.js`, `handoff.js`) and `frontend/js/map-controls.js` (layer,
tool and game control behaviour formerly in the sidebar). Coverage data `frontend/data/world-coverage.json` is built by
`scripts/build-world-coverage.mjs`.

## Quick verification

```sh
git clone --branch colosseum-worlds-fair https://github.com/Poglavar/consensus-builder.git
cd consensus-builder/backend
npm ci
npm test
```

The frontend is static and has no compilation step. See
[`docs/hackathon-build.md`](docs/hackathon-build.md) for the focused hackathon test set, local
serving, optional Solana build, and requirements for running the database-backed API. Current
regression results and coverage boundaries are recorded in [`TEST.md`](TEST.md): 6,366 fast tests
passed (6 skipped), and the headed browser suite has 253 distinct collected cases across 64 specs.
The UI feature inventory indexes 99 command IDs; indexed coverage describes intended review scope,
while only passing headed runs verify those actions.

## Security status

This is devnet software and has not received an independent security audit. Devnet SOL and USDC
have no monetary value. Program IDs prove which deployments the demo uses; they do not imply that
the programs are immutable or production-safe. Read the complete
[security and trust assumptions](docs/protocol.md#security-and-trust-assumptions) before reusing the
protocol.

## License

Except where an individual file or third-party component says otherwise, this repository is
licensed under the [Apache License 2.0](LICENSE).
