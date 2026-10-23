# Design language

One page of decisions so every surface, old or new, reads as one product. The map shell
(`css/map-shell.css`, `map.css`, `map-search.css`) is the reference
dialect; everything else migrates to it. Tokens live in `frontend/css/tokens.css`, shared components
in `frontend/css/primitives.css`; both load first. Tests in `backend/test/` keep the rules from
drifting (`design-tokens.test.js`, `i18n-style.test.js`, `page-chrome.test.js`,
`css-conflicting-selectors.test.js`).

## Names

| Thing | Name | Where |
|---|---|---|
| The product | **Consensus Builder** | app, guides, every `<title>` ("Page · Consensus Builder"; the landing pages may put the product first) |
| The organisation | **Urban Game Theory** | one byline per page, the social handles, the API host |
| The hackathon campaign | **Hyperstition: Markets for Possible Cities** | only `deck.html` and `hackathon-demo.html` |
| The betting surface | **Bets**, tagline **Bet on cities** | the Bets sheet and every place the pools are sold to a person; "hyperstition" and "prediction market" stay campaign and API words |

Every non-map page carries the same header: logo, "Back to the map", language. No page is a dead end.

## Vocabulary

| Concept | Use | Do not use |
|---|---|---|
| The thing a user makes | **proposal**; **draft** until it is applied; **plan** only for the user's set of applied proposals | design, object, record, replacement, project, scenario |
| Land | **parcel** (a cadastral unit); **plot** only for the new parcels a design cuts; **site** only for a drawn outline | lot, land, ground, slice, piece, geography |
| Reshaping parcels | **Land readjustment** | reparcellization, subdivide, readjust, repartition |
| The official plan | **official road plan** (with a GUP source tag) | government plan, city plan, GUP alone |
| Datasets | plain name + source tag: "Official cadastre (DGU)", "3D buildings (GDI)", "Map buildings (OSM)" | the acronym alone |
| Consent | **Accept** records an owner decision; summaries distinguish unsigned local records from verified signed receipts. **Vote** = non-binding support; **Support** = money, as **Pledge** or **Donate** | imply verified signing authority or legal ownership from a local acceptance; attest (reserve for lens attestations) |
| Publication and lifecycle display | **Draft / Published / Minted** describe record publication; **Execution recorded** requires matching observed execution evidence, otherwise **Execution reported; verification unavailable** qualifies the `Executed` lifecycle claim. **Expired / Withdrawn / Status unknown** qualify lifecycle. | imply payment, title registration or physical construction from either execution badge |
| Map state | **Applied** means this browser has applied the proposal to its map model; **Apply / Unapply** changes that state independently of publication and execution. | treat Applied as a step toward verified execution or construction |
| Lifecycle verbs | **Apply / Unapply** (the map), **Publish** (the server), **Mint** (the chain), **Execute** | un-apply, remove from map, upload, save to server |
| Views | **2D (map) · 3D (models) · 3D (aerial imagery)**; **Walk** and **AI render** are tools | a globe icon for aerial imagery, realistic, photoreal, abstract 3D |
| Uploaded geometry | **building model** | model (alone) |
| The in-app game | **Simulation** (turns, agents); **Activity** is the log of everything | game, run, batch |
| People | **owner, author, agent, member**; identity = **profile name** | actor (only as the umbrella in the activity log), user, citizen, username, nickname |
| Dismissing | **Cancel** abandons, **Close** keeps, **Done** commits | OK, Dismiss, Back (as dismiss), Keep editing, Leave as is |
| Destroying | **Unapply** (map), **Delete** (a record), **Discard** (a draft), **Reset** (local data) | clear, wipe, erase, remove, rescind |
| Betting | **bet** (yes or no on a proposal), **pool** (the money on it), **chance** (the pool share), **pays** (the payout multiple), **settle** | stake, wager, odds, forecast, market (in copy), hyperstition |

## Copy rules

- Sentence case everywhere, including buttons, tabs, headings and badges. Title Case is a bug.
- US spelling (analyze, center, neighbor, color), matching the majority of the existing strings.
- No trailing colons on labels; the layout separates label and value.
- One ellipsis character "…", never "...". Dashes: " – " (en dash) for ranges, no em-dash asides.
- Numbers, areas, money and dates go through one formatter keyed to the viewer's locale, the UI
  language plus region (`js/format.js`): "3,522 m²" in English, "3.522 m²" in Croatian; money as
  amount then code ("431,000 USDT", "431,000 GBP"), always in the currency of the place it belongs
  to (`js/city-money.js`), never converted; dates as `Intl.DateTimeFormat(locale, { dateStyle:
  'medium', timeStyle: 'short' })`, so "3 Oct 2026" in en-GB and "Oct 3, 2026" in en-US.
- Plurals through i18n plural keys, never "1 buildings".
- Nothing for developers in the UI: no ids, hostnames, "console", "local storage", "in-memory",
  "server ID". Ids sit behind a copy icon; developer messages are gated by debug mode.
- Every user-facing string is an i18n key. The status bar is translated like everything else.

## Visual rules

- **Tokens only.** New CSS takes every colour, font size, radius, shadow, spacing and z-index from
  `tokens.css` (`--cb-*`). A literal in new CSS fails `design-tokens.test.js`. The per-file literal
  counts in that test may only go down.
- **Buttons** are one family, `.btn`, with five roles and a surface has one primary: `btn`
  (secondary, outlined) · `btn btn-primary` (filled) · `btn btn-success` (the filled affirmative:
  Accept, Apply to map) · `btn btn-quiet` (tertiary: no fill, the faint line as border; no button is borderless) · `btn btn-danger` (outlined red). Modifiers,
  orthogonal to the role: `btn-sm` (small), `btn-block` (full-width row), `btn-icon` (square,
  icon only, with an `aria-label`). The selected state of any toggle is `aria-pressed="true"`,
  never a class, and has one look (primary-soft fill, primary border). The close control is
  `close-circle-btn`. Map chrome keeps `map-shell-button` and the view strip's `map-mode-tile`;
  the parcel and ground menus keep `parcel-menu__action`. Nothing else may paint a button
  (`backend/test/ui-vocabulary.test.js`): a component class beside `btn` may position
  (width, grid, order), never colour. No gold, teal or gradient buttons; the only highlight is
  `cb-shimmer`, on at most one control per surface.
- **Links** are `cb-link`: primary colour, underlined, on an `<a>` or on a `<button class="cb-link">`
  when the click runs script (never `href="#"`). `cb-link--external` adds the one ↗ mark and goes
  with `target="_blank" rel="noopener"`; the mark is never typed into a string. `cb-link--quiet`
  takes the surrounding colour inside muted meta lines. A link that looks like a button is
  `<a class="btn …">`. Rows of record links use `cb-link-row`. Every satellite page carries the same
  "Back to the map" link in its header.
- **Dialogs** are built by `js/ui/dialogs.js` (`CbDialog.open`, `.confirm`, `.alert`, `.choice`,
  `.prompt`) on `cb-dialog-overlay > cb-dialog > cb-dialog__header / __body / __footer` with one
  `close-circle-btn` in the header; a message dialog has no header. Sizes `--sm / --md / --lg /
  --xl`; on a phone every dialog is a bottom sheet. Nothing calls the browser's `confirm`, `alert`
  or `prompt`. Dialogs, sheets, and floating panels use `--cb-glass-sheet` with backdrop blur in
  both themes, including phone layouts; `--cb-panel-blur` owns their shared blur. Headers and large embedded sections stay transparent so
  they do not cover the glass; inputs, buttons, and small cards keep their own surface roles.
  Sheets use `map-sheet`; right-dock panels use `right-dock-panel`; anchored menus
  use the parcel menu's chrome. No other overlay families; z-index only from the `--cb-z-*`
  ladder; the backdrop is `--cb-backdrop`.
- **Tabs** are `cb-tabs > cb-tab` with `role="tab"` and `aria-selected`; **segmented controls**
  (filters, modes, choices in a row) are `cb-segmented > cb-segmented__option` with `aria-pressed`
  (or a native radio inside the option); **switches** are `cb-switch`; **choice tiles** (an icon
  and a short label in a grid) are `cb-tiles > cb-tile`; **selectable rows** (a source, a wallet,
  a watched area) are `cb-option`; every status, count, environment and tag pill is `cb-badge`.
  "Selected" is always an attribute (`aria-pressed`, `aria-selected`, `aria-current`, `:checked`),
  never `.active`, `.selected` or `.is-active`.
- **Themes.** Every component reads `tokens.css`; `data-theme="dark"` on `<html>` switches the
  whole app (Settings → Appearance, `js/ui/theme.js`). A literal colour in a component is a theme
  bug. Inline `style=` on a control is never a look: data-driven values only (a lane colour, a
  measured width).
- **Role count.** Reuse the six badge tones (neutral, primary, success, warning, danger, info)
  plus the count variant; lifecycle hooks share those definitions. Feature styles own layout
  and semantic states, with colors taken directly from the shared roles. Do not add local
  palette aliases or a new visual component for an existing control. Parcel/proposal rows have
  one owner in `panels.css`; parcel-detail rows have one owner in `proposals.css`.
- **Form controls** inherit the base rules in `primitives.css`; no per-component input styling.
- **Breakpoint:** phones are `max-width: 767.98px`, desktop `min-width: 768px`. No other edge.
- **Stacking:** `--cb-z-*` ladder only. No 13001, no 100001, no `!important` z-index.
- **Icons:** Font Awesome only; no emoji in labels or chrome, no raster icons.
- **View buttons:** map, geometric-shape and aerial thumbnails sit behind the 2D/3D labels; the two
  3D buttons have distinct tooltips and accessible names. The selected border preserves the image.
- **Motion:** every animation sits under `prefers-reduced-motion: no-preference`.
- Nothing moves when a panel opens: panels overlay the map, they do not push the controls.
- A dialog opened from a sheet leaves the sheet open underneath (a press inside the dialog is not
  an outside click). After a wallet transaction the dialog becomes the receipt: what went in, what
  changed, read back from the chain, and a Done button. It never closes itself.
- Everything worth passing on has a link to exactly itself, and the link opens on that thing: a bet
  is `/bets/<agreement account>?city=…` (`js/bets/bets-link.js`), which opens the bet's own dialog
  and unfurls with the agreement's question, chance and pool. "Copy link" sits on the row, in the dialog
  and on the receipt; the copy feedback is the shared "Copied".
- A bet is a thing of its own, the way a market is on Polymarket or Kalshi: the Bets list is for
  finding one, the bet dialog (`js/bets/bets-dialog.js`) is where it is read, placed and collected.
  The dialog carries the chance, pool, payouts, deadline, rule, the wallet's bets, the links and the
  way back to its rivals; the stake form shows the live "to win" with the stake counted in the pool.
  A pool with bets on one side only reads "Only yes bets so far", never "100% chance".
- The list hides what nothing can be done with (agreements without a pool fold under a count), orders
  contests by money, and filters All · Open · Settled · Mine. On desktop it is wider than the
  control sheets and centred on its dock button.

## Messages

- Three families, one typography (`ephemerals.md`; `.cb-toast` in css/primitives.css): a
  **notice** announces an outcome, top centre under the top row, dark pill with `success` /
  `warning` / `error` colours, one at a time (`showEphemeralMessage(message, duration, type)`); the
  **status line** says what the app is doing now, above the dock, light pill with a spinner while
  anything is busy, fading out when idle (`updateStatus`, `beginStatusActivity`); a **banner** is a
  persistent notice with an action, a section of the one card under the top row
  (`js/ui/banner-stack.js`, `.cb-banner`). Every floating message is `--cb-text-md`, wraps to at
  most three lines and never exceeds 480px (560px for the banner card). Nothing else floats a
  message of its own.

## Phone layout

- The bottom dock is Proposals · Bets · Activity. On a phone it is a labelled bar across the width
  in every view, a veil the map shows through (`--cb-glass-veil`, blurred; its buttons are
  transparent at rest); on a wide map it is three pills centred on the bottom edge, the same chrome
  as the top-right cluster, so the map keeps its bottom edge. Its height is `--map-shell-bar-height`
  in both shapes; `--map-shell-bottom-clearance` keeps the tray and toast above it. The credits and
  the scale bar are set straight on the map with a text halo (`--cb-text-halo`) and no boxes: on a
  phone in the row right above the bar, on a wide map in the pills' own row, from the corners.
- Sheets open above the bottom dock, which stays reachable while a sheet is open. On phones they
  use the full available width and stop above the dock.

## Map shell structure

- Keep the bottom Proposals · Bets · Activity dock available in 2D, model view and aerial view.
  The top-right Layers, Settings and Profile controls are shared across those views.
- The left view strip chooses 2D map, 3D models or 3D aerial imagery. Measure is a 2D utility beside
  that strip, not a destination in the bottom dock.
- Layers presents the controls for the selected view: original cadastre in 2D, model appearance in
  3D models, and existing-city visibility in aerial imagery. Keep these view-specific controls in
  Layers rather than adding another global panel.
- Creation starts from map context: selecting a parcel or open ground exposes the actions that apply
  there. Do not add a global Create command or button.
- Activity opens to recent events with All, People and Agents filters. Watched areas belong in
  Activity. Keep Simulation in a folded, clearly labelled section there. Plan actions stay secondary
  inside Proposals rather than becoming another primary navigation destination.
- During 2D editing, the active editor temporarily replaces the bottom dock with its existing
  finish/apply and cancel controls. Reuse the editor's actions; do not add a second generic Done or
  duplicate finish/cancel commands. A 3D preview keeps the current draft so returning to 2D resumes
  the same edit.

## Status (2026-10-13, branch `ui-vocabulary`)

The vocabulary above is what the code uses, not only what it should use. `backend/test/ui-vocabulary.test.js`
(with `backend/test/helpers/ui-vocabulary.mjs`) ratchets ten lists that may only shrink: classes that paint a
button, full-screen layers, z-index literals, bare `a` colours, `href="#"`, `target="_blank"` without
`noopener`, typed ↗ marks, class-keyed selected looks, native confirm / alert / prompt calls, inline styles on
controls. After lowering one, rerun `node backend/test/helpers/ui-vocabulary.mjs --write`; after lowering
colour, z-index or `!important` literals, `node backend/test/helpers/design-audit.mjs --write`. The e2e
control contract follows a markup change through `node e2e/scripts/migrate-control-contract.mjs --write`.

What the lists still allow, on purpose: the globe's city labels and its own backdrop, the phone's expanded
search bar, Leaflet's zoom buttons (themed through Leaflet's selector), and the lane swatch's data-driven
inline colours.

## Deferred (known, not yet done)

- An editable proposal title on the card (the auto-name is "Type · parcel N" for now).
- The remaining untranslated status strings in road-detection.js (needs a file-level helper).
- Trailing colons on the road and track proposal dialog labels; "Say yes" in the lens flow (the vocabulary
  says Accept); the emoji goal icons in data.js and the emoji map decorations.
- Fixed-height boxes (`CbDialog.open({ fixedHeight: true })`) for the dialogs whose content loads or grows
  while open: done for the lens dialogs and the welcome dialog; still to do for the minted list, share,
  create proposal, bets, wallet, parcel compare, status log and the five editors.
- The campaign pages (deck, deck2, deck3, hackathon demo, pitch variants) keep their own dialect by decision.
- Application CSS has no literal palette outside `tokens.css`; campaign artwork keeps its
  independent palette by the decision above. `design-tokens.test.js` enforces this boundary.

## Migration order (done)

1. Names and this page. 2. Tokens, primitives, the three verified bugs, lints. 3. The spine flow:
parcel menu → parcel panel → editors → proposal card → proposals list; one formatter. 4. Sheet
contents. 5. Satellite pages under one header. 6. Mobile. 7. The control vocabulary everywhere
(buttons, links, dialogs, tabs, segments, switches, badges, selected state) with the ratchets that keep it.
