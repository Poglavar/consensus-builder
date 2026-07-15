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

## Staged plan (each step ships independently, suite stays green)
1. **[DONE] Pure apply-routing** → `proposals/apply/route.js` (`normalizeGoalKey`, `isBuildingGoal`,
   `classifyApplyRoute`). The dispatcher and `_normalizeGoalKey`/`_isBuildingProposal` now delegate.
   Locked by `backend/test/apply-route.test.js`. UMD-wrapped (`window.__applyRoute`) so it declares no
   globals — a bare top-level `normalizeGoalKey` would shadow the existing one in `proposals/core.js`.
2. **Pure geometry/decision helpers** still inline in the `_apply*` methods (child-feature filtering,
   the uncut-remainder guard already at `_shouldSkipUncutRemainder`, parent/child id resolution) →
   `proposals/apply/*.js`, each unit-tested. Shrinks the giant methods without touching their I/O.
3. **The shared 10-step skeleton** → one `applyProposalPipeline(kind, hooks)` where each type supplies
   only its init/geometry/link differences. Collapses ~1,500 duplicated lines and makes "touch every
   apply path" a one-line change. Do this only once steps 1–2 have carved out enough pure surface that
   the per-type residue is small.
4. **Move the per-type methods** into `proposals/apply/<type>.js` modules mixed into `ProposalManager`
   via `Object.assign` (they use `this`, so binding is preserved). The global `ProposalManager` facade
   and load order stay intact.

## Guardrails
- Never declare a bare top-level `function`/`const` that another file already declares — the
  `frontend-duplicate-globals.test.js` guard enforces this. Wrap new modules in a UMD/IIFE.
- node-required files must resolve status/route helpers via `typeof X === 'function' ? X : require(...)`
  (browser global or node require), never a bare global.
- After each step: `node --check`, `npx vitest run` green, and a claude-in-chrome smoke-check that the
  app boots and a proposal still applies/unapplies.
