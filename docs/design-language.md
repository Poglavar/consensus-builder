# Design language

One page of decisions so every surface, old or new, reads as one product. The map shell
(`css/map-shell.css`, `parcel-menu.css`, `selection-tray.css`, `map-search.css`) is the reference
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

Every non-map page carries the same header: logo, "Back to the map", language. No page is a dead end.

## Vocabulary

| Concept | Use | Do not use |
|---|---|---|
| The thing a user makes | **proposal**; **draft** until it is applied; **plan** only for the user's set of applied proposals | design, object, record, replacement, project, scenario |
| Land | **parcel** (a cadastral unit); **plot** only for the new parcels a design cuts; **site** only for a drawn outline | lot, land, ground, slice, piece, geography |
| Reshaping parcels | **Land readjustment** | reparcellization, subdivide, readjust, repartition |
| The official plan | **official road plan** (with a GUP source tag) | government plan, city plan, GUP alone |
| Datasets | plain name + source tag: "Official cadastre (DGU)", "3D buildings (GDI)", "Map buildings (OSM)" | the acronym alone |
| Consent | **Accept** = an owner's binding yes; **Vote** = non-binding support; **Support** = money, as **Pledge** or **Donate** | say yes, consent, boost, back, bid, attest (reserve for lens attestations) |
| Lifecycle | **Draft → Applied → Published → Minted → Executed**, modifiers **Expired / Withdrawn** | in-memory, unsaved, local, on server, active, inactive |
| Lifecycle verbs | **Apply / Unapply** (the map), **Publish** (the server), **Mint** (the chain), **Execute** | un-apply, remove from map, upload, save to server |
| Views | **2D · 3D · Photo**; **Walk** and **AI render** are tools | model view, realistic, photoreal, abstract 3D |
| Uploaded geometry | **building model** | model (alone) |
| The in-app game | **Simulation** (turns, agents); **Activity** is the log of everything | game, run, batch |
| People | **owner, author, agent, member**; identity = **profile name** | actor (only as the umbrella in the activity log), user, citizen, username, nickname |
| Dismissing | **Cancel** abandons, **Close** keeps, **Done** commits | OK, Dismiss, Back (as dismiss), Keep editing, Leave as is |
| Destroying | **Unapply** (map), **Delete** (a record), **Discard** (a draft), **Reset** (local data) | clear, wipe, erase, remove, rescind |

## Copy rules

- Sentence case everywhere, including buttons, tabs, headings and badges. Title Case is a bug.
- US spelling (analyze, center, neighbor, color), matching the majority of the existing strings.
- No trailing colons on labels; the layout separates label and value.
- One ellipsis character "…", never "...". Dashes: " – " (en dash) for ranges, no em-dash asides.
- Numbers, areas, money and dates go through one formatter keyed to the UI language
  (`js/format.js`): "3,522 m²" in English, "3.522 m²" in Croatian; money as amount then code
  ("431,000 USDT"); dates as `Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })`.
- Plurals through i18n plural keys, never "1 buildings".
- Nothing for developers in the UI: no ids, hostnames, "console", "local storage", "in-memory",
  "server ID". Ids sit behind a copy icon; developer messages are gated by debug mode.
- Every user-facing string is an i18n key. The status bar is translated like everything else.

## Visual rules

- **Tokens only.** New CSS takes every colour, font size, radius, shadow, spacing and z-index from
  `tokens.css` (`--cb-*`). A literal in new CSS fails `design-tokens.test.js`. The per-file literal
  counts in that test may only go down.
- **Buttons** have four roles, and a surface has one primary: `btn` (secondary, outlined) ·
  `btn-primary` (filled) · `btn-quiet` (text only) · `btn-danger` (outlined red). `btn-success` is
  the filled affirmative for Accept / Apply to map. No gold, teal or gradient buttons.
- **Dialogs** use `cb-dialog-overlay > cb-dialog > cb-dialog__header / __body / __footer` with one
  `close-circle-btn` in the header. Sheets use `map-sheet`; right-dock panels use
  `right-dock-panel`. No new overlay families.
- **Form controls** inherit the base rules in `primitives.css`; no per-component input styling.
- **Breakpoint:** phones are `max-width: 767.98px`, desktop `min-width: 768px`. No other edge.
- **Stacking:** `--cb-z-*` ladder only. No 13001, no 100001, no `!important` z-index.
- **Icons:** Font Awesome only; no emoji in labels or chrome, no raster icons.
- **Motion:** every animation sits under `prefers-reduced-motion: no-preference`.
- Nothing moves when a panel opens: panels overlay the map, they do not push the controls.

## Phone layout

- The bottom row is a labelled bar (Proposals · Tools · Activity) across the width; its height is
  `--map-shell-bar-height`, and `--map-shell-bottom-clearance` grows with it, so the tray, the toast
  and the scale bar sit above the bar and the dock sheets end above it (the bar stays reachable).
- Sheets (parcel, proposal, road, block) run edge to edge above the bar; the proposals list is a
  70dvh modal sheet with its own close.

## Deferred (known, not yet done)

- An editable proposal title on the card (the auto-name is "Type · parcel N" for now).
- The lifecycle badge names inside the older panels (parcel panel, block panel, road panel).
- The remaining untranslated status strings in road-detection.js (needs a file-level helper).
- Trailing colons on labels (layout-dependent; remove per surface as each is migrated).
- A shared header component on the static pages (they share tokens, titles and a back link today).

## Migration order

1. Names and this page. 2. Tokens, primitives, the three verified bugs, lints. 3. The spine flow:
parcel menu → parcel panel → editors → proposal card → proposals list; one formatter. 4. Sheet
contents. 5. Satellite pages under one header. 6. Mobile.
