# Impact resolver — how a road (or any footprint) change deals with what it hits

When a road is drawn, moved, or removed, it changes parcels and can run into existing buildings and
other proposals. The **impact resolver** walks everything the change affects and applies the right
action to each. This doc records the decisions so far.

## Mutability: what we may and may not rewrite

`isProposalImmutable(p) = isProposalMinted(p) || !!p.serverProposalId` (frontend/js/proposals/chain.js).

- **Immutable** = minted on-chain **or** uploaded to the server. The server upload is a
  publication/commitment act — it stands in for the blockchain for people who don't mint, and once
  uploaded the record is shared and referenced, so we can **never** resync or rewrite its geometry.
- **Local-only** = never uploaded. Ours to change.

## DECISION (2026-07-15): proposals are only ever set aside / tunnelled / destroyed — never cut or split

A road (or a park/square/lake/building footprint) that intersects a proposal does **one** of:

1. **Unapply (set aside)** — the proposal is removed from the map but kept in its parcels' list,
   fully recoverable. This is the default and what the code does today (`setAsideObstacleProposal` in
   corridor-tunnel.js).
2. **Tunnel under** — the road goes underground through the proposal's footprint; the proposal stays.
3. **Destroy** — for a real building; for a proposal this is the same as unapply.

We do **NOT** cut a proposal's geometry in place, reshape it, or split it into two proposals. This
holds for **all** proposal kinds (building, park, square, lake, road, reparcellization) and both
mutability classes.

### Why (rationale)

- **Non-contiguous proposals are a firm no-go.** They'd complicate parcels, gain calc, rendering, and
  referencing for no benefit. So the only contiguity-preserving way to keep a *bisected* proposal
  would be to **split it into two** proposals.
- **Splitting is deferred (maybe indefinitely).** A park/square/lake splits into two naturally, but a
  **bisected building has no natural two-piece meaning** — two arbitrary half-structures rarely make
  sense. Until that's resolved we don't split anything, to avoid a half-baked, type-specific mess.
- **Immutable proposals can't be split or cut anyway** — their published geometry is frozen; unapply
  is the only honest option.
- Treating every occupying proposal uniformly (set aside / tunnel / destroy) keeps one simple, correct
  path instead of a matrix of type × mutability × topology special cases.

### Pros of this decision

- One uniform, easy-to-reason path; no non-contiguous proposals; no awkward half-buildings ever.
- Immutable (minted/server) proposals are never rewritten — correctness by construction.
- Nothing is lost: a set-aside proposal stays in the parcel list and can be re-applied.

### Cons (accepted for now)

- **Heavy-handed:** a road merely nicking the corner of a large local proposal sets the *whole* thing
  aside rather than trimming it — the user must re-create/adjust afterwards.
- Less "natural flow" than cut-in-place would feel for local proposals.
- A future cut/split feature is extra work layered on later, not a small tweak.

## Parcels (multiple, not one)

A road change reshapes **many** parcels at once. The flow: enumerate every affected parcel → find its
descendants (applied proposals over it) → dedupe to the set of affected proposals → set each aside.
Parcels themselves reshape with the road; a proposal that stays valid keeps its geometry on the
reshaped parcel (a building doesn't grow because its lot did) — only invalidation (parcel gone, or a
road now crossing it) forces a set-aside.

## Preflight disclosure is part of resolution

Impact resolution is two-phase: **calculate and disclose first, mutate second**. A cutting/tunnelling
dialog must deduplicate every proposal-owned obstacle, list each proposal by display name, and state
the outcome of every choice. Cutting or demolishing sets those proposals aside (unapplied but retained
in the proposal list); tunnelling preserves them. The same preflight must list local road proposals
that merge-on-connect will absorb and explicitly say that their separate proposal records will be
removed. No impact path may hide either outcome behind an internal `skipConfirm` mutation after
showing a buildings-only count.

The current corridor implementation enforces this contract in `collectObstacleProposalImpacts` and
`buildBuildingObstaclePrompt` before `resolveBuildingObstacles` executes the chosen action.

## Deferred (Phase 2, not built)

Cut-in-place for a **local, contiguous (notch)** case, and split-into-two for a **bisect** — both
gated on `!isProposalImmutable` and on settling the building-bisect question. The cut/reshape option
stays disabled until then.
