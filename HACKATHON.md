<!-- This manifest defines the reviewable scope of the Colosseum World's Fair build. -->
# Colosseum World's Fair hackathon scope

Urban Game Theory is a long-running project. This branch isolates the work built for the
Colosseum World's Fair hackathon so it can be reviewed independently of the existing city,
parcel, ownership, proposal-rendering, and Lens foundations.

## Review boundary

- Pre-hackathon baseline: `3ee1855` (`Record the GUP scenario integration direction and inventory`)
- Hackathon branch: `colosseum-worlds-fair`
- First hackathon commit: `d29ca3e` (`Add proposal_market parimutuel program with client and localnet tests`)

GitHub comparison:

<https://github.com/Poglavar/consensus-builder/compare/3ee1855...colosseum-worlds-fair>

Local review commands:

```sh
git log --reverse --oneline 3ee1855..colosseum-worlds-fair
git diff --stat 3ee1855...colosseum-worlds-fair
git diff 3ee1855...colosseum-worlds-fair
```

## Built for the hackathon

1. **Agent proposal market** — a Solana parimutuel market program, client, IDL, and localnet tests.
2. **x402 pay-to-propose** — paid proposal submission with hosted-facilitator settlement,
   replay protection, database persistence, and exact-resource Bazaar discovery.
3. **Agent interface and demo runner** — machine-readable discovery, agent quickstart,
   deterministic paid submission, persona planning, batch selection, minting, and staking.
4. **Agent provenance in the product** — proposal records and UI identify agent-created proposals
   and link the relevant on-chain transactions.
5. **Transaction explorer** — store-backed incremental Solana transaction sync and proposal-aware
   decoding for the demo flow.
6. **Safe proposal review** — Details is read-only; Counterpropose/Fork creates a separately editable
   clone instead of mutating someone else's proposal.
7. **USDC pledge escrow** — a devnet Solana program plus browser and agent clients for pledging,
   execution-triggered release, cancellation/expiry refunds, exact on-chain totals, and retry-safe
   operation IDs.

## Pre-existing platform foundations

The underlying cadastral map and parcel fabric, proposal editor and 3D visualization, ownership
model, Lens trust concept, and the broader Urban Game Theory application predate the hackathon.
The hackathon work composes those foundations into an agent-discoverable, paid, attributable, and
fundable proposal workflow; it does not claim the whole application as new.

## Judge demo path

1. Discover the paid proposal capability through the x402/Bazaar metadata.
2. Run an agent proposal through payment, persistence, and its on-chain transaction link.
3. Open the resulting proposal in read-only Details and fork it with Counterpropose.
4. Pledge devnet USDC and inspect the escrow totals through the UI or agent endpoint.
5. Resolve the lifecycle by releasing an executed proposal or refunding a cancelled/expired one.
