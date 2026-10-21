<!-- Design of record for the plan / design / agreement rework: what a design, an agreement and a plan are, what replaces named plans and decision kinds, and the open questions still being settled. -->

# Plan, design, agreement

A rework of what sits above a single authored change. Started 2026-10-21 on branch
`plan-design-agreement` (off `colosseum-worlds-fair` at 3a62b4a7e, which includes the Schelling plan
layer). Design discussion only so far; nothing below is implemented. This is the living plan:
decisions are appended as they are made and the open list shrinks.

## Decisions (user, 2026-10-21)

### Two records and one informal word

| Term | What it is | Record? |
|---|---|---|
| **Design** | One authored change: a road, a park, a parcel layout, an urban rule, a building. Today's "proposal". Immutable once published; referenced by agreements, never owned by one. Carries its design type (road, lake, …) and nothing about who decides. | yes |
| **Agreement** | A set of designs plus a **decision rule** (who decides, how they are counted, whether it binds), with allocations and money optional. A vote is an agreement with no allocation; an authority adopting a plan is an agreement whose rule is "this authority decides". The unit that is signed, minted, ENS-named, bet on and executed. | yes |
| **Plan** | No record. The informal word for what is on the map (the applied composition) and for a share link of selected designs. | no |

- A loose bundle of designs with no decision rule is never a record: nothing can happen to it
  inside the app, so there is nothing to sign and nothing for a market to settle on.
- Markets, ENS names and mints attach to agreements only. A design on its own is shareable; nobody
  decides on it and it is not bettable until an agreement includes it.
- **Decision rule** replaces the publish-time **decision kind** of `proposal-kinds.md`: owner deal,
  owner vote and community vote become rules an agreement can have. Decision 7 there (every
  published record carries a kind) is reversed: a bare design carries none. "Kind" is left to mean
  the design type.
- Several agreements may cover the same designs at once. A counterproposal that changes only the
  terms is a **counter-agreement** over the same design records; one that changes geometry is a
  fork of the design. A design's hash is therefore pure geometry, site and rules; terms never move it.
- Exclusivity is enforced only at execution, on the input land: two open agreements over the same
  land are both allowed and form one market contest; only one can execute.

### Consent and execution move to the agreement (pitfall 2, user 2026-10-21)

- Only agreements have a lifecycle (Active, Executed, Cancelled, Expired, a deadline). Designs are
  content: draft, published, forked. No design-level consent, status or expiry.
- Execution is one event: every allocation moves at once, obligations settle from one escrow per
  agreement, parcel history gets one entry per affected parcel pointing at the agreement. Map
  application stays a local preview. Funding is per agreement.
- **What is minted:** the agreement, as one chain account committing to the agreement's content on
  **IPFS**, never a server URL and not Walrus (deprecated, possibly dead). Reading stays independent
  of our server, as `chain-proposal-loader.js` already is.
- **Who counts:** the approval engine counts off-chain from published signed decisions, anyone can
  re-run it, and the agreement's named lens attests "decision satisfied" on chain; the program
  checks that attestation plus escrow (option b). Chain order stays Solana first, EVM later.
- **Terms are a separate step for every design.** Drawing and publishing a design never asks for
  terms; "Create agreement" is its own dialog over chosen designs, usable immediately after drawing.
  Nothing is auto-coupled, not even a single road with cash.

To confirm (recommended): a design is its own IPFS object and its content hash is its CID; an
agreement is an object of links to design CIDs plus inputs, decision rule, allocations and money,
so its CID commits to everything transitively and a counter-agreement reuses the design objects.
That one scheme replaces the effect hash, the plan hash and the member hashes. Pinning goes
through the backend relay as a courier only: the browser computes the CIDs, the relay pins, the
browser verifies the pinned CID before minting; `POST /proposals/prepare` goes away, which settles
the pending "mint must not need the server" decision. No unanimity carve-out: every decision rule,
unanimity included, executes on the lens attestation, because the owner set is lens-backed anyway.
An agreement may be drafted over local unpublished designs; publishing or minting it pins them first.

### Carried over from the Codex design session of 2026-10-21 (notes commits 0a5d0c9b0, ac30810b3)

- Roads inside a readjustment are drawn as roads, ordinary road designs. The plots are their own
  design, a **parcel layout** (the standalone border redraw). The agreement pools the land across
  all covered designs, so drawing steps never decide who bears the cost of a street.
- Designs never depend on other designs, only on the ground being available.
- No temporal component: an agreement settles ownership, allocations, money and rules. What gets
  built when is out of scope.
- Urban rules stay spatially exclusive with one another; an urban rule may coexist with a parcel
  layout on the same ground (vocabulary.md, "Accepted direction: urban-rule overlap").
- The painted Schelling superblock is a natural agreement scope: one road-network design, one
  parcel-layout design per block, one agreement whose pool is every parcel the blocks touch.

### What this replaces

- Named plans as records (`plans.md`). Their machinery (member hashes, aggregate hash, site-only
  mint, ENS name, one market) is re-pointed at agreements, with the terms moved from the members
  onto the bundle. "Which plan gets built" becomes "which agreement executes".
- Decision kinds (`proposal-kinds.md`): moved onto the agreement as its decision rule.
- The land-readjustment record that bundles layout, allocations, cash and approval in one proposal
  (`land-readjustmend.md`): split into a parcel-layout design and an agreement. The approval engine
  of its §23 becomes the agreement's decision-rule engine.
- The Codex session's three-object model (plan, design or change, agreement): the loose plan is dropped.

No legacy support anywhere (user, 2026-10-21: the software is not in use yet). No compatibility
readers, no migrations, no parallel old/new paths; chain programs, contracts, hashes and prod
demo content may all change, and affected records are recreated.

## Open, in the order they are being worked through

1. Plan vs agreement. **Decided above.**
2. Consent and execution are per design today: effect hash at publish, signed owner decisions, lens
   verdicts, `ProposalNFT.acceptProposal`, the Solana consent route, the oracle lifecycle and
   parcel-history events are all keyed on one design. They must move to the agreement hash and one
   execution event.
3. Decision kinds. **Resolved with 1**: the decision rule lives on the agreement.
4. "Agreement" already names the per-input-parcel sub-deals of the courtyard flow
   (`reparcellization-agreements.js`) and the Approval tab's "Agreement rules". Fold or drop.
5. Pooled before/after is an agreement-level computation: contributions on the ground before any
   covered design, allocations on the fabric after all of them. Per-design numbers lose the road
   land from the pool and double count crossings.
6. "No dependencies" holds only because piece and plot ids are content hashes: members replay in
   authored order, and an agreement whose members cannot all apply in that order is refused.
7. Illustrative parcel estimates cannot bind at publish (`PARCEL-OPTIONAL.md` rule 3). An agreement
   over estimates is local exploration until estimates become a registered source, or it binds as
   open ground.
8. Naming of the individual object (design vs proposal), and which code, API and chain names keep
   `proposal`. A second opinion the Codex session requested was still pending when this was written.
9. Sequencing. Sketch: M1, local only, split land readjustment into a parcel-layout design plus an
   agreement that holds today's terms engine, roads drawn as roads inside it, Schelling plots as an
   automatic layout. M2, publish agreements with consent bound to the agreement hash. M3, mint
   agreements and settle markets on them. The one-road-plus-cash flow keeps working throughout as an
   agreement created in the same step as its design.
