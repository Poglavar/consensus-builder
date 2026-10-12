<!-- Inventory of every transient / status / notice message mechanism in the frontend, and the plan to fold them into three families with one typography. Gathered 2026-10-12 from a read of the code; line numbers are from that day and will drift. -->
# Ephemerals: one voice for transient messages

The map talks to the reader through at least 23 separate mechanisms. On a phone three of them are
visible at once in an ordinary 3D session: a blue pill at the top ("Applied 22 proposals."), a white
pill above the dock ("Checking cadastral ground…") and a black pill with a spinner under it
("Loading buildings…"). Each has its own font size, padding, width rule, z-index and lifetime, most
of them literal colours. This file lists them all and proposes three families with one look.

## Inventory

Positions: `dock` = `--map-shell-dock-height`; `clearance` = `--map-shell-bottom-clearance`
(dock + 8 px on wide screens, dock + 44 px on phones; css/map-shell.css).

| # | Mechanism | Where it lives | Position · z | Look | Width / wrapping | Lifetime · stacking · a11y |
|---|---|---|---|---|---|---|
| A | Blue toast | `#ephemeral-message-container` `.ephemeral-message` (utilities.css ~2049, phone block duplicated in game.css ~968) · `showEphemeralMessage(msg, duration)` ui-helpers.js ~408 · 68 calls in 25 files | top 20 px centred (over the top controls on a phone) · z 14000 literal | blue `rgba(29,113,184,.95)` / white, 14 px (13 on phones), radius 20 | desktop: `nowrap`, no max-width, max-height 50 px, overflow hidden, so a long message is one row that runs off screen; phone: wraps, clipped at 80 px | timer 2–12 s (default 5); stacks one element per call, no cap, no dedupe; not click-through; no aria-live; the third "type" argument that 22+ callers pass (`'error'`, `'success'`…) is ignored, every message is blue; every call also mirrors into B |
| B | White status line | `#floating-status` / `#floating-status-text` (index.html ~321, utilities.css ~633) · `updateStatus(msg, {transient})` ui-helpers.js ~18 · 377 calls in 67 files, 144 with untranslated literals | bottom = clearance, centred (+48 px with the selection tray) · z 990 | white .82 / grey, 12 px, radius 12 | max-width min(480 px, viewport − button columns); `nowrap` + ellipsis; transient progress lines wrap | never auto-dismisses: replaced by the next call, hidden when empty; click-through; no aria |
| C | Status bar + log | `.status-bar` `#status` in the Activity sheet (utilities.css ~362), log modal; `beginStatusActivity` spinner ui-helpers.js ~289 | in a sheet | grey, 14 px | clamped to 2 lines | log of 2000 entries; the "busy" spinner lives only here, invisible while the sheet is closed |
| D | 3D "Loading buildings…" | `.three-mode-buildings-loader` (map.css ~320; phone ~886) · three-mode.js ~6760 | top-left 12 px; ≤480 px: bottom = dock + 12 px centred, i.e. directly UNDER B · z 11 inside the z 900 container | black .72 / white, 13 px 600, radius 999 | no rule | while the near fetch or glTF models are pending; click-through; no aria |
| E | 3D "Rendering…" overlay | `#three-rendering-overlay`, inline styles three-mode.js ~6724 | fixed, screen centre · z 999999 | black .66 / white, 16 px 600 | none | on 3D entry; click-through |
| F | Photo status | `.photoreal-status` (photoreal-mode.css ~24) · local `setStatus` | top = top clearance, centred · z 1001 | dark .86 / white, tokens for font | min(420 px, 100 % − 112 px), wraps | until cleared; role=status aria-live polite |
| G | Photo tile loader | `.photoreal-tile-loader` (photoreal-mode.css ~45) · `updateLoader` | top = top clearance, left 64 px · z 6 | dark .78 / white, 11 px, radius 999 | none | per frame "Streaming 3D tiles… N %"; click-through |
| H | Photo cover | `.photoreal-cover*` (photoreal-mode.css ~86) | full container · z 4 | sky blue, 42 px spinner, 14 px | 80 % | until first seat; its fallback text differs from G's for the same key |
| I | 3D view-angle hint | `.three-view-hint` (photoreal-mode.css ~117) · three-mode.js ~7156 | bottom 24 px (64 px with Google credits), centred · z 6 | dark .86 / white, 13 px 500, radius 999 | 80 %, wraps | after 10 s, for 6 s, once per mode; role=status |
| J | 3D isolation banner | `.three-mode-isolation-banner` (map.css ~546) | top 12 px centred · z 10 | white .96 / dark, 12 px 600, radius 999 | `nowrap` | state; × button |
| K | Copy feedback | `.copy-feedback-toast` (utilities.css ~2101) · `showCopyFeedback` ui-helpers.js ~458 · 6 calls | fixed bottom 34 px centred (inside the dock) · z 100001 literal | dark .9 / white, 11 px 600, radius 999 | none | 1.1 s; replaces; role=status aria-live polite |
| L | Area-monitor toast | inline `cssText` area-monitor/ui.js ~643 · `AreaMonitorUI.showToast` · 8 calls, 2 untranslated | fixed bottom 24 px centred (inside the dock) · z 20000 | `#333` / white, 13 px, radius 8 | none | 3.5 s; stacks with overlap; no aria |
| M | Source-failure cards | `#source-status-stack` `.source-status` (parcel-sources.css ~22) · `ParcelSourceSettings.reportFailure` parcel-source-settings.js ~241 · callers map-core.js ~402 (buildings), parcels/fetch.js ~640 (parcels), ground-fallback.js ~626 | fixed right 1 rem, bottom 4.5 rem · `--cb-z-notice` | tokens | min(30 rem, 100 vw − 2 rem), wraps; no phone rule, two cards cover half a phone screen | persistent until dismissed; one card per kind, stacked (parcels + buildings = two near-identical cards, the "two messages" case); role=status; the same failure text also goes to B |
| N | Multi-tab banner | `.cb-multitab-banner` (base.css ~69) · multi-tab-guard.js ~26 | fixed top, full width · z 100000 literal | yellow / brown, 0.9 rem | wraps | until dismissed; role=alert; pushes A down |
| O | Explore banner | `.explore-banner` (world.css ~862) · ui/world-entry.js ~319 | under the search, centred · z 1000 | cream .97 / brown, 13 px, radius 12 | min(560 px, 100 vw − 32 px), wraps | until dismissed; role=status |
| P | Corridor "Applying…" | `.corridor-apply-indicator` (corridor-editor.css ~656) · road-drawing.js ~491 · 3 calls | top 14 px centred in the Leaflet container · z 1200 | dark .82 / white, 13 px 600, radius 999 | none | ref-counted, fades in after 150 ms; click-through |
| Q | Pinpoint readout | `.pinpoint-readout` (utilities.css ~2851) · pinpoint-tool.js ~29 | fixed, bottom = `--map-shell-bottom` + 96 px · z 1200 | navy .85 / white, 13 px mono, radius 6 | `nowrap` | live; aria-live polite; on a phone it sits under B |
| R | Proposal load overlay | `.proposal-load-*` (modals.css ~231; `.proposal-load-status` declared twice) · proposals/core.js ~930 · 12 calls | fixed scrim, 360 px card · z 12050 | white card, literals | fixed grid | modal; role=status |
| S | Waiting overlay | `.proposal-waiting-overlay` (modals.css ~3438) · dialog-share.js ~9 · 7 calls | fixed scrim · z 12050 | white card | — | modal |
| T | Sheet section busy | `.sheet-section-busy` (map-shell.css ~466) · `MapShell.setSectionBusy` · 2 calls | in a sheet | light blue, 13 px | wraps | state; role=status |
| U | Agent-bubble error | inline `cssText` agent-bubbles.js ~479 · 1 call, hardcoded English via innerHTML | fixed top-right · z 10001 | red / white, 14 px | 350 px | 5 s; stacks |
| V | Simulation dot | `#activity-running-dot` (map-shell.css ~309) | Activity button corner | green pulse | — | state; role=img |
| W | Dialogs | `.cb-confirm-overlay` `.cb-alert-dialog` (modals.css ~6400) · `showStyledAlert/Confirm/Choice` city-config.js ~8797–8955 · ~108 alerts, 12 confirms, 5 choices; plus native `alert` ×11, `confirm` ×7, `prompt` ×3 still in use | fixed scrim · z 30000 literal, inline 50000 overrides in two callers | white, 15 px | min(420 px, 100 % − 40 px) | modal; role=alertdialog |

In-flow status lines inside panels (not floating, listed so nothing is missed): corridor editor
notice/hint, `.corridor-hint`, `.ai-scene-status`, bets dialog `setStatus`, `.reparcel-status`,
`#station-placement-status` (also written to B), `#urban-blocks-status`, `.map-search__status`,
`.activity-live-status`, `.canton-status`, site panel status/warning, command palette empty state
(errors go to B), `.three-mode-xray-note`, `.proposal-approval-status`, road-node edit tooltips.
Most use literal colours. They stay in-flow; only their typography should follow the families.

## What is wrong, in one list

- **The same message twice.** A mirrors every toast into B, so a confirmation appears at the top
  and the bottom at once; parcel-source failures go to both B and M; some callers log twice
  (site-drawing.js ~565, proposal-editor-shell.js ~1795 and ~1808).
- **Loading has seven looks:** B transient lines, C's spinner (only inside the Activity sheet), D,
  E, G/H, P, R/S. Photo view shows three of them at once plus a spinner on the mode button.
- **Six independent dark pills** (D, G, I, K, P, Q, plus E inline), each with its own size, while
  `.cb-toast` in primitives.css ~181, written as "one look for every transient message", is used by
  nothing.
- **Width:** A has no cap on desktop and does not wrap (one long row, clipped at 50 px high); K and
  L sit inside the dock at bottom 34 / 24 px; M has no phone rule; A sits over the top controls on a
  phone (top 20 px).
- **Type is ignored:** 22+ callers pass `'error'` / `'success'` to A and get blue.
- **Z-index literals** everywhere (14000, 20000, 100001, 999999) although `--cb-z-toast`,
  `--cb-z-notice`, `--cb-z-banner` exist in tokens.css.
- **Dead and native:** parcels/ui/minted-layer.js ~278 calls a `showToast` that does not exist
  ("Failed to load minted parcels" never shows); 21 native `alert`/`confirm`/`prompt` calls remain
  beside the styled dialogs.

## Proposal: three families, one typography

Colour and position may differ per family; font, padding, radius, wrapping and width rules are
shared through `.cb-toast` (tokens only).

| Family | What it says | Position | Look | Lifetime |
|---|---|---|---|---|
| **Notice** | an outcome: "Applied 22 proposals.", "Copied", "Area monitor created", an error | top centre, under the top row (`--map-shell-top-clearance`), never over the controls | neutral dark pill by default; `success` and `error` variants by colour only (the type argument becomes real) | auto-dismiss (caller passes a duration); a queue of one: a new notice replaces the old after a minimum display time, never a stack; `aria-live` polite (assertive for errors) |
| **Status** | what the app is doing now: "Checking cadastral ground…", "Loading buildings…", "Applying…", "Streaming tiles 40 %" | bottom centre in the row above the dock (where B is) | light pill with an optional spinner / progress slot | replaced, never stacked; gone when idle; click-through; `aria-live` polite |
| **Banner** | something persistent that needs an action: parcel or building source failed, another tab holds the lock, "no parcels here, draw a site" | top, full width on phones, a card at the top-right on desktop | surface card with buttons, tokens | until dismissed or resolved; concurrent failures merge into ONE banner with one line per source and the actions of each |

Shared rules: 13 px, `--cb-leading`, padding `--cb-space-2 --cb-space-4`, `--cb-radius-pill`,
`white-space: normal`, at most three lines (`-webkit-line-clamp`), `max-width: min(480px, 100vw −
2 × 16px)` on every width, so a long message wraps on desktop and spans the phone minus gutters.
z-indexes come from the tokens. The Activity log keeps receiving every notice and status line (the
rationale in ui-helpers.js stands: the log is what survives), but the floating status line shows
only the status family.

Mapping: A, K, L, U → Notice. B, D, E (text), G, H (text), P, T (stays in-flow but same type) →
Status, with the C spinner moving onto the status pill. M, N, O → Banner. I, J, Q keep their place
(hints and readouts) but take the shared typography. R/S stay modal (they block input on purpose)
and take the dialog typography; the native `alert`/`confirm`/`prompt` calls move to W.

## Rollout, smallest first

1. **Typography and width** (CSS only): A and B take `.cb-toast`; A gains a desktop cap and wraps,
   loses the duplicated phone block in game.css, moves under the top row on phones. Fixes the long
   row today without touching any caller.
2. **Notice family:** K, L and U call `showEphemeralMessage`; the type argument selects a variant;
   queue instead of stack; aria-live; stop mirroring into the floating status (keep the log); z
   from tokens; the dead `showToast` call fixed.
3. **Status family:** D, G, P and E's text write the floating status with a spinner slot; their own
   pills go; the Activity-sheet spinner moves to the status pill; B's 144 untranslated literals get
   keys over time (separate ratchet).
4. **Banner family:** one component for M, N, O with a phone rule; concurrent source failures merge
   into one card.
5. **Dialogs:** native `alert`/`confirm`/`prompt` → styled; the two inline z-index overrides go.

Decided 2026-10-12: notices at the top (the bottom is where the dock, the status line and the
panels already are); notices go neutral dark like the other pills, with green / amber / red for
`success` / `warning` / `error`; the blue is gone. One size for every floating message:
`--cb-text-md`. The status line fades out on its own eight seconds after its last word when nothing
is busy, and carries a spinner while anything is (`beginStatusActivity`).

## Log

- 2026-10-12: inventory gathered and verified at the source (the toast's ignored type argument,
  the unused `.cb-toast`, the 3D loader's phone rule placing it under the status line, the
  source-failure stack without a phone rule).
- 2026-10-12: steps 1–4 built. `.cb-toast` (css/primitives.css) is the one typography, with
  `--success/--warning/--error/--status` variants and a spinner slot; notices run on
  `js/ui/notice-queue.js` (one at a time, 1.2 s minimum before a replacement, repeats dropped;
  node-tested) through `showEphemeralMessage(message, duration, type)`, which logs to the Activity
  log but no longer takes the status line; the copy, area-monitor and agent-bubble toasts are
  notices (the agent-bubble text and the minted-layer failure got translation keys; the dead
  `showToast` call now shows). The status line (`#floating-status`) holds `is-busy` while any
  status activity is open and `is-idle` after a quiet spell; the 3D "Rendering…" overlay, the
  "Loading buildings…" badge, the photo tile loader and the corridor "Applying…" pill write it
  instead of drawing their own; a failed photo view is an error notice. Persistent banners (parcel
  and building source failures, the other-tab lock, the explore banner) mount into one card under
  the top row (`js/ui/banner-stack.js`, `.cb-banner-stack` / `.cb-banner`), which sets
  `--cb-banner-stack-height` so notices sit below it; the parcel failure no longer repeats on the
  status line. Step 5: the direct `alert` calls (AI scene, agents, epoch) and the two synchronous
  `confirm`s (game reset, leaving manual blockify) use the styled dialogs with the browser's as the
  last resort; the three `prompt`s stay (a copy fallback and the custom timeline year have no
  styled equivalent yet), as do the `confirm`/`alert` fallbacks that already sit behind a styled
  check. Verified in a headed Chrome at 1280 and 390 px (notices, status line in 3D, banner card
  with a notice below it) and by the browser specs that touch these elements.
