# proposals.js — target architecture (for sign-off)

## The one constraint that dictates everything: it's a classic global-scope script

`proposals.js` has **0 `import`/`export`**. It's loaded as a classic `<script>` (via the loader
array in `index.html`, currently one entry `'js/proposals.js'`). In a classic script:

- top-level `function f(){}` and `var x` → become **`window.f` / `window.x`** automatically;
- top-level `let`/`const` → form a **shared global lexical binding visible to every other classic
  script** on the page (not a `window` property, but reachable by bare name);
- 97 inline `onclick`/`onchange` handlers in `index.html` call these globals by bare name.

**Therefore the split needs ZERO call-site rewrites.** If I move functions and the shared `let`s
into separate classic-script files and load them in the right order, every name still resolves
exactly as before. Converting to ES modules would break all of this silently (scope changes,
`window.*` disappears, load order becomes a module graph) — that is almost certainly what sank the
earlier attempts. **We keep classic scripts.**

## Keystone: `state.js` loaded first
The 20 shared mutable `let`s (e.g. `currentProposalTool`, `currentProposalDetailsContext`,
`proposalLayer`, the `proposalLoad*` overlay refs) are read across multiple concerns. They go into
one `frontend/js/proposals/state.js` loaded **before** all other proposal modules. Because of the
shared global lexical environment, every later module reads/writes them by bare name, unchanged.

## Keystone: `init.js` loaded last
The 27 top-level side-effecting statements (event wiring, registration calls, guards) move to
`frontend/js/proposals/init.js`, loaded **after** all definitions, preserving their run order.

## Proposed module layout — `frontend/js/proposals/` (replaces the single file)

Load order top→bottom. LOC approximate; pass-1 moves functions **whole** (no internal rewrites).

| # | file | concern | ~LOC |
|---|------|---------|------|
| 1 | `state.js` | all shared mutable bindings + shared consts (keystone, first) | ~150 |
| 2 | `storage.js` | `proposalStorage`, persistence, hashing, write-cache, migration | ~1300 |
| 3 | `server-sync.js` | fetch/upload/sync proposal summaries & ids ↔ backend | ~500 |
| 4 | `parcel-id.js` | parcel-id normalize, ancestors/descendants, parcel records | ~500 |
| 5 | `geometry.js` | geometry/feature/bounds/lake-zones/thumbnails | ~970 |
| 6 | `chain.js` | NFT/mint/walrus/wallet/erc20/balance + mint modals | ~1250 |
| 7 | `execution.js` | accept/execute/ownership-transfer/consent/reject/claim | ~1420 |
| 8 | `urban-rules.js` | urban-rule typology/contiguity/land-use | ~235 |
| 9 | `roads-tracks.js` | road/track/corridor serialise + helpers | ~165 |
| 10 | `reparcel.js` | reparcellization/blockify | ~130 |
| 11 | `layer-render.js` | leaflet layers, highlights, panes, groups, center/focus | ~1530 |
| 12 | `lifecycle.js` | expiry/decay/countdown + offer-value format/parse | ~370 |
| 13 | `list-ui.js` | proposal list panel, multi-parcel selection | ~560 |
| 14 | `details-panel.js` | `showProposalInfo` (1373) + details panel, boost/donate | ~1660 |
| 15 | `create.js` | `createProposal` (1425) + create helpers | ~1820 |
| 16 | `dialog-create.js` | `showProposalDialog` (838) + create-dialog facets UI | ~1400 |
| 17 | `dialog-upload.js` | `showUploadProposalModal` (962) + upload flow | ~1200 |
| 18 | `dialog-corridor.js` | `openConstrainedCorridorModal` (800) + corridor | ~900 |
| 19 | `dialog-misc.js` | list modal, payload inspector, mint/gate/share-plan modals | ~1500 |
| 20 | `sharing.js` | `handleSharedPlanRoute` (1150) + encode/decode/deeplink/routes | ~1680 |
| 21 | `init.js` | the 27 top-level side-effects + event wiring (keystone, last) | ~200 |

~21 files, each ≤~1.8k LOC (vs one 26k-LOC file). Boundaries may flex slightly during extraction;
the count/shape is what I want signed off, not every line.

## Risk register
| risk | mitigation |
|------|-----------|
| Shared `let` becomes unreachable after move | All shared mutable state in `state.js`, loaded first; verified by global-surface diff + e2e. |
| Load-order side effects reorder | All 27 top-level side-effects isolated in `init.js` (last); relative order preserved. |
| A moved function silently drops off `window` | After each step: diff the 124-name global surface; empty diff required. |
| `onclick` handler points at a moved-and-renamed global | No renames in pass 1 (pure move); grep handlers vs missing globals each step. |
| Chain-import paths under-tested (2 specs pre-red) | Rely on global-surface invariant + passing `proposal-chain-bridge`; do not touch chain logic semantics. |
| Two functions shared a closure var not caught | AST shared-state list is exhaustive for top-level bindings; `node --check` + e2e catch the rest. |

## Scope
- **Pass 1 (this effort):** behavior-preserving split into the modules above + load-order wiring.
  Gate = full e2e green at baseline after each step. This is what unlocks AI-agentability (T48).
- **Pass 2 (follow-on, separate):** decompose the 6 monster functions; add unit tests for pure
  helpers (hashing, normalization, geometry, lifecycle). Out of scope until pass 1 lands.
