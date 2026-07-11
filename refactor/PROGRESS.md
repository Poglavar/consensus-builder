# proposals.js refactor — progress ledger

Durable state for the long-running, behavior-preserving split of `frontend/js/proposals.js`
(26,376 lines / ~340k tokens) into cohesive classic-script modules. This file is the source of
truth that survives context resets — every step is logged here and committed.

Branch: `proposals-refactor` (worktree: `consensus-builder-proposals-refactor/`), forked from
`main` @ `2ff1bbd`.

---

## The safety net (the gate)

Hermetic Playwright suite (~40 specs), all backend calls mocked via `e2e/helpers/mocks`.
Runs against THIS worktree's static frontend, isolated from the Docker app on :8080.

```
./refactor/run-e2e.sh            # full suite (the gate)
./refactor/run-e2e.sh <spec>     # targeted
```

### Baseline = a FAILURE SET, not counts (some specs are flaky under parallel load)

Total ≈ 177 specs. Pass/skip counts drift run-to-run because a few map-click specs are timing-flaky
(they pass under parallel load, fail in isolation, and vice-versa). So the robust regression check is
**set-based**: *the set of specs failing on my version must be a subset of specs that also fail on
unmodified `main`*. Counts are advisory only.

**`allowed_red`** — specs proven to fail on unmodified main @ 2ff1bbd (run identically). Grow this
set only after adjudicating a new failure against main (see method). Tolerated, never "fixed" here:
- `blockchain-sync.spec.ts:10` — EVM contract sync, `totalSynced 0 vs 1`. Deterministic, pre-existing.
- `blockchain-sync.spec.ts:240` — Solana proposal import. Deterministic, pre-existing.
- `city-switching.spec.ts:5` — `city-config.js:3` defaults `new_york`; stale test. Unrelated.
- `parcel-info-panel.spec.ts:149` — parcel-ID-after-click. Flaky map-click; fails on main too (isolation-proven).
- `parcel-info-panel.spec.ts:244` — government-ownership. Same.

Runner uses `BASE_URL=http://localhost:8090` (not `127.0.0.1`, which breaks the `data-source` spec).
Compare against unmodified main by serving `/Users/simun/Code/consensus-builder/frontend` on :8091.

### THE INVARIANT — assert after every extraction step
1. `node --check frontend/js/proposals/*.js frontend/js/proposals.js` — all parse.
2. **Carve name-conservation OK** (the carve tool aborts otherwise).
3. **Runtime global surface**: `node refactor/verify-globals.mjs` → no baseline global lost (108 at load).
4. e2e: `./refactor/run-e2e.sh`; compute `failures − allowed_red`. If empty → green.
   If non-empty → **adjudicate each new failure against main on :8091, isolated**. Fails on main too →
   add to `allowed_red`. Passes on main → REAL REGRESSION → stop and fix before proceeding.
5. No `onclick`/`onchange` handler in `index.html` references a now-missing global.

---

## Method
Strangler extraction. Keep the **classic-script global-scope model** (NO ES modules — that is the
trap; see ARCHITECTURE.md). Move one cohesive cluster at a time into a new file, re-point
`index.html`'s script loader, run the gate, commit if green. Never proceed on red.

---

## Analysis facts (from AST pass — see refactor/analyze.js, refactor/map.json)
- 446 top-level functions, 75 top-level vars, 0 classes.
- **124** distinct `window.*` globals exported (the public contract).
- **27** load-order-sensitive top-level statements (mostly `if` guards + a few init calls).
- **20** shared mutable `let` read by ≥2 functions, across multiple concerns → must live in one
  shared `state.js` loaded first.
- 6 monster functions = ~6,550 LOC (25%): `createProposal` 1425, `showProposalInfo` 1373,
  `handleSharedPlanRoute` 1150, `showUploadProposalModal` 962, `showProposalDialog` 838,
  `openConstrainedCorridorModal` 800. Moved whole in pass 1; internal decomposition is pass 2.

---

## Modules extracted (Phase 2)
| # | module | symbols | proposals.js after | gate |
|---|--------|---------|--------------------|------|
| 1 | `state.js` (91 L) | 42 mutable bindings | 26,330 | green |
| 2 | `lifecycle.js` (326 L) | 16 expiry/decay/offer-value fns | 26,023 | green |
| 3 | `parcel-id.js` (314 L) | 15 identity + record-cache fns | 25,727 | green |

`allowed_red` handler-grep baseline (same on main): `algorithmicRoads`, `detectRoadsUsingAI`,
`showMonitorListModal` are real but pre-existing (lazy/conditional road-AI + monitor handlers);
`function`/`if`/`toggle` are regex artifacts. Handler gate = parity with main, not absolute.

## Log
- **2026-06-26** — Phase 0+1 done (safety net, AST map, architecture). Phase 2 done: extracted all
  22 modules + slimmed proposals.js to bootstrap.js (1,320 L), gate-green per step, committed per
  step/batch. Phase 3 done: final full regression green; **definitive main comparison proves every
  failing spec fails identically on unmodified main (zero regressions)**. See REPORT.md.
  **COMPLETE.** proposals.js 26,376 → bootstrap.js 1,320 + 22 cohesive modules. Pass-2 items in REPORT.md.
