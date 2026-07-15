# Decomposing proposal-manager.js

`frontend/js/proposal-manager.js` is ~8,200 lines — one object literal (`const ProposalManager = {…}`)
with ~260 methods, including five 170–740-line `_apply<Type>Proposal` methods and their
`_unapply<Type>Confirmed` siblings that all repeat the same ~10-step skeleton (load assets → build
children → filter → add to map → hide parents → link ancestors → save children → set applied/lifecycle
→ update UI → refresh styles). It is too big to hold in a context window, so cross-cutting edits
(e.g. the status split) degrade into grep-and-patch across dozens of near-identical sites — which is
how "missed one site" bugs get in.

## Constraint
The apply/unapply methods are I/O-heavy (map, proposalStorage, DOM, turf), so they have **no
node-runnable test net** and browser (Playwright) tests are off by default. Every step must therefore
extract **pure** logic that *can* be unit-tested, or move code verbatim (verified by `node --check` +
the duplicate-globals guard + existing tests + a manual browser smoke-check via claude-in-chrome).

## Progress
`proposal-manager.js`: **8,210 → 5,085 lines** so far. New sibling modules:
`proposal-road-geometry.js` (718) and `proposals/apply/{route,road,buildings,structures,parcels,unapply}.js`.

## Staged plan
1. **[DONE] Pure apply-routing** → `proposals/apply/route.js` (`normalizeGoalKey`, `isBuildingGoal`,
   `classifyApplyRoute`). The dispatcher and `_normalizeGoalKey`/`_isBuildingProposal` delegate.
   Locked by `backend/test/apply-route.test.js`. UMD-wrapped (`window.__applyRoute`) so it declares no
   globals — a bare top-level `normalizeGoalKey` would shadow the existing one in `proposals/core.js`.
4. **[DONE] Move the per-type methods** into `proposals/apply/<type>.js` UMD mixins, each `Object.assign`ed
   onto `ProposalManager` (they use `this`, so binding is preserved). Also moved the road-polygon
   geometry cluster to `proposal-road-geometry.js`. Verified: byte-identical bodies, node method-presence,
   `frontend-duplicate-globals` guard, and in-browser (boot, all 10 methods `this`-bound, route/geometry
   globals intact).
2. **[TODO — low risk] Pure helper extraction**: the synthetic-id / owner / parcel-feature module-level
   helpers still in `proposal-manager.js` (and the child-feature filtering inside the apply modules) →
   their own tested modules. Deferred here only because several are exported for
   `proposal-manager-ids.test.js` and overlap `synthetic-parcel-identity.js`, so it needs a careful
   export/require re-wire — not a blind move.
3. **[TODO — risk-gated] Collapse the shared skeleton** into one `applyProposalPipeline(kind, hooks)`.
   This restructures the CONTROL FLOW of the core apply methods, which have no node-runnable test net
   (they need map/storage/DOM). Do NOT do this blind: first stand up a characterization harness (stub
   map/proposalStorage/DOM and assert observable effects) OR drive a real apply/unapply per type in the
   browser (needs proposals loaded — this profile's storage was empty). Until then the per-type files are
   the safe unit of edit; the duplication stays but is at least isolated and findable.

## Guardrails
- Never declare a bare top-level `function`/`const` that another file already declares — the
  `frontend-duplicate-globals.test.js` guard enforces this. Wrap new modules in a UMD/IIFE.
- node-required files must resolve status/route helpers via `typeof X === 'function' ? X : require(...)`
  (browser global or node require), never a bare global.
- After each step: `node --check`, `npx vitest run` green, and a claude-in-chrome smoke-check that the
  app boots and a proposal still applies/unapplies.
