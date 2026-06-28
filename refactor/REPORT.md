# proposals.js refactor — final report

## Outcome
The 26,376-line `frontend/js/proposals.js` god-file (~340k tokens, 446 top-level functions,
124 `window.*` globals) was split into **22 cohesive classic-script modules** under
`frontend/js/proposals/`, plus a 1,320-line `bootstrap.js` (init/wiring only). **Behavior-preserving;
zero regressions.**

```
26,376-line proposals.js  →  proposals/bootstrap.js (1,320, init side-effects only)
                          +  22 modules (state, data, storage, server-sync, parcel-id, geometry,
                             chain, execution, layer-render, urban-rules, roads, reparcel, list-ui,
                             lifecycle, details-panel, create, dialog-create/upload/share,
                             sharing-routes, core)
```

## Why it worked where prior attempts didn't
`proposals.js` is a **classic global-scope script** (0 import/export). Top-level `function`/`var`
auto-attach to `window`; top-level `let` forms a *shared global lexical binding across all classic
scripts*; 97 inline HTML handlers call globals by bare name. So splitting into ordered classic-script
files needs **zero call-site rewrites** — provided you keep classic scripts and preserve load order.
The likely prior failure mode (ES-module conversion) silently breaks all of that. We kept classic
scripts, put shared mutable state in `state.js` (loaded first) and the 27 load-order-sensitive init
side-effects in `bootstrap.js` (loaded last); every other module is pure declarations (order-independent).

## Method (per module)
1. `carve.js` (AST) moves exact byte ranges + leading comments by symbol name; **aborts unless
   extracted ∪ remaining == original** (no symbol lost or duplicated).
2. Wire the module into the `index.html` loader before `bootstrap.js`.
3. Gate: `node --check` · runtime global-surface verifier (108 baseline globals must stay present
   at load) · full Playwright e2e (`--retries=2`) · handler-grep parity with main.
4. Commit each green step (revertable history).

## Evidence of zero regressions
- **Runtime global surface**: 108/108 baseline globals present at load after every step.
- **e2e**: failure set was a subset of `allowed_red` at every step.
- **Definitive main comparison**: every failing spec on this branch fails **identically on unmodified
  `main`** (proven in isolation, `--workers=1`):
  - `blockchain-sync:10`, `blockchain-sync:240` — chain-sync layer, `totalSynced 0 vs 1`. Deterministic, pre-existing.
  - `city-switching:5` — `city-config.js:3` defaults `new_york`; stale test. Unrelated.
  - `parcel-info-panel:149`, `:244` — flaky map-click; 8 passed/2 failed identically on main and branch.
- No production logic was edited — only relocation, the loader list, and file headers.

## Known issues / residual risk (all pre-existing or cosmetic — for pass 2)
- **Pre-existing test failures** above are unrelated to this refactor (they fail on main too).
- **Sharing duplication preserved**: 8 base64/compress/decode helpers exist in BOTH `sharing-routes.js`
  and the pre-existing `sharing.js` (this exactly mirrors the prior `proposals.js`/`sharing.js`
  duplication; `sharing.js` loads last and wins). Dedup is a safe pass-2 cleanup.
- **Cosmetic**: `carve` left blank-line gaps and a few orphaned comments in `bootstrap.js`; harmless.
- **Files >2k LOC**: `data.js` (singletons), `dialog-create.js`, `sharing-routes.js` — each cohesive,
  dominated by one large function/object that is a pass-2 decomposition target.

## Recommended pass 2 (separate effort)
1. Decompose the monster functions now isolated in their modules: `createProposal` (1425),
   `showProposalInfo` (1373), `handleSharedPlanRoute` (1150), `showUploadProposalModal` (962),
   `showProposalDialog` (838), `openConstrainedCorridorModal` (800).
2. Dedup `sharing-routes.js` ↔ `sharing.js`; consider merging into one `sharing.js`.
3. Add unit tests for the now-isolated pure helpers (hashing, normalization, geometry, lifecycle).
4. Split `data.js` into `config.js` + `storage-api.js` + `selection.js`; tidy blank lines/orphan comments.
5. This is the unlock for T48 (AI-agentize/x402): modules are now small enough to load and edit individually.

## How to re-verify
```
cd consensus-builder-proposals-refactor
./refactor/run-e2e.sh                 # full suite vs allowed_red
node refactor/verify-globals.mjs      # global surface vs baseline
# main comparison: serve /Users/simun/Code/consensus-builder/frontend on :8091, run with BASE_URL
```
