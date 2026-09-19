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
7. **Proposal funding** — one devnet Solana program and shared browser/agent codec for two distinct
   commitments: funded donations held until execution (and refundable on cancellation/expiry), plus
   revocable soft pledges that move USDC only when their owner fulfils them after execution.
   Deployed as [`1jES…6g`](https://explorer.solana.com/address/1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g?cluster=devnet),
   with live [soft-pledge](https://explorer.solana.com/tx/Fs4neKgYxY5QmV7FwovJg1Ay8X5mecVafZkW4N87NSfC9hGqs1sTm2gYX5ypjdyAvWPhCwF9vUfnquyBiNmdbGT?cluster=devnet)
   and [funded-donation](https://explorer.solana.com/tx/dFJn5idbgQy85NmJ3bpGTPW284nYGifec9TKy98pP4PHUsgY3WpqU5M5HnQ4UNxMTrdeDo5rp6ShdsLZ346fbH3?cluster=devnet)
   proof transactions.
8. **Complete funding lifecycles** — a guarded devnet script proves both outcomes with a separate
   supporter wallet. The cancelled path [refunds its donation](https://explorer.solana.com/tx/4ZzwYiHiM4kbt5zypFw1WRuji1rLkydwsfm3QWLKVLh8RSMiP4bX9axX3PCNYYvXgNyuDveA7Qa2cx69xuzdD9af?cluster=devnet)
   and [voids its pledge](https://explorer.solana.com/tx/4yPScLbBHM1KzxsrYYBvSXnA4ZPfx3DuDTEoJwMFmudRJQhP89tghvyfk6qpXVsc2aej3ZSbq5mNGGedB7ZwDvbX?cluster=devnet);
   the executed path [releases its donation](https://explorer.solana.com/tx/3s1v1sGhPbdN2JzydhNDhLTY1M6mW5uFntXRkGbmx2cyPHGPeVuks93HWZtjTQfPFbRhFj4FhQR6vWahNMvawLn5?cluster=devnet)
   and [fulfils its pledge](https://explorer.solana.com/tx/5NUeperNd6wu3ZizQW7ASWZtfa2nFKjevnGeVtqAeFWhFyfDbcUBKw5enRwKcTRAyZ1yHNpeEqWC8Vs2dyp94UgA?cluster=devnet).
   Run it with `cd blockchain/solana && node scripts/proposal-support-lifecycle.mjs --live`.
9. **One agent/action/activity model** — browser algorithms and the server LLM runner use the same
   controller/action/event contract. The Activity explorer combines live and simulated events,
   filters by source or actor type, and keeps AI/human provenance in expandable details instead of
   visually segregating actors throughout the product.

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
