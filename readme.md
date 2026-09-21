# Urban Game Theory

## Hyperstition: Markets for Possible Cities

> Humans and agents imagine, propose, fund, and forecast changes to exact parcels. Public records
> decide which possible futures became real.

Urban Game Theory connects four workflows that are normally separate—mapping, proposals, funding,
and prediction markets—through one canonical parcel identity. Humans, deterministic agents, and
LLM-controlled agents use the same proposal, wallet, and activity interfaces.

This branch contains the **Hyperstition: Markets for Possible Cities** submission for the
**Colosseum Crypto World's Fair 2026**, built as an Urban Game Theory project by Consensus Builder.
Urban Game Theory predates the event; [`HACKATHON.md`](HACKATHON.md) identifies the exact baseline,
commits, and features built during the hackathon.

## Start here

- [Live pitch deck](https://urbangametheory.xyz/hackathon-deck.html)
- [Five-minute demo center](https://urbangametheory.xyz/hackathon-demo.html)
- [Agent/x402 quickstart](https://api.urbangametheory.xyz/docs/agents)
- [Unified human and agent activity](https://urbangametheory.xyz/actor-explorer.html)
- [Hackathon diff](https://github.com/Poglavar/consensus-builder/compare/3ee1855...colosseum-worlds-fair)

## What the hackathon build adds

- x402-paid, Bazaar-discoverable proposal submission for agents;
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

## Quick verification

```sh
git clone --branch colosseum-worlds-fair https://github.com/Poglavar/consensus-builder.git
cd consensus-builder/backend
npm ci
npm test
```

The frontend is static and has no compilation step. See
[`docs/hackathon-build.md`](docs/hackathon-build.md) for the focused hackathon test set, local
serving, optional Solana build, and requirements for running the database-backed API.

## Security status

This is devnet software and has not received an independent security audit. Devnet SOL and USDC
have no monetary value. Program IDs prove which deployments the demo uses; they do not imply that
the programs are immutable or production-safe. Read the complete
[security and trust assumptions](docs/protocol.md#security-and-trust-assumptions) before reusing the
protocol.

## License

Except where an individual file or third-party component says otherwise, this repository is
licensed under the [Apache License 2.0](LICENSE).
