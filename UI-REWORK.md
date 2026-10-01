# Map-driven UI rework (branch `new-ui`)

Goal: remove the left sidebar and make the map the whole interface — a search box, a few floating
buttons, contextual menus on what you click, a selection tray, a command palette — without losing a
single capability the sidebar offered. First visit opens on a rotating globe coloured by parcel-data
coverage.

## Principles

1. **Rehouse, don't rewrite.** Sidebar controls are wired by element id with inline handlers calling
   globals. Controls move into floating sheets keeping their ids, inline handlers and
   `data-section` wrappers, so every existing consumer (see inventory) keeps working and the per-city
   `sidebar.disabledSections` config still hides the same sections.
2. **One command registry.** `js/ui/commands.js` (UMD, no DOM) names every capability: id, label key,
   icon, group, `when(ctx)` and `run(ctx)` calling the existing globals, plus the surfaces it appears
   on (layers, tools, proposals, settings, game, parcel menu, selection tray, palette). A headless test
   fails if any capability has no surface, and if any control id the inventory lists is missing from
   index.html. The Cmd-K palette renders the whole registry.
3. **The sidebar is deleted, not hidden.** No fallback path. Code that read `#sidebar.collapsed` or
   called `toggleSidebar()` is changed to the no-sidebar reality (the map is always unobstructed on
   the left).
4. **Mobile first.** Every sheet is a bottom sheet under 768px; popovers become bottom-sheet peeks.
   300–400px widths must work.
5. **i18n** en/hr/es/sr for every new string. **Reduced motion** honoured (globe spin, fly-in).
6. **Logic in pure modules** (search ranking, coverage tier lookup, command availability, globe
   projection math), tested headlessly in `backend/test/frontend-*.test.js`.

## Layout

| Place | What |
|---|---|
| top-left | **Search box** (omnibox) with the **city chip** (current city; click → world view) |
| top-right | existing **user bubble** (`#username-display`), **Layers** button, **Settings** button |
| left edge, under search | existing **mode strip** (2D/3D/photo/AI/walk, cadastre view) |
| bottom-left | nothing but the scale bar (the Game pill was removed: the simulation is a section of the Activity sheet) |
| bottom-centre | **Selection tray** (only while parcels are selected) |
| bottom-right | **Proposals** (count badge), **Tools**, **Activity** buttons (Activity carries the **running dot** while the simulation runs) |
| at click point | **Parcel menu** (popover; mobile: bottom-sheet peek) |
| anywhere | **Command palette** (Ctrl/Cmd-K, also a button in Settings) |

### Where every sidebar section goes

| Sidebar section | New home |
|---|---|
| City select, detect city | city chip → world view; "Use my location" in the search box; the city list is a search result group |
| Data source, base map, wipe local data | Settings sheet |
| Game | Activity sheet → Simulation section (all ids kept) |
| Proposals: list, plan stats, grain score, minted, share plan, clear | Proposals button opens the proposals sheet (list button first) |
| Parcels: locate | Search box (parcel-id results); the old input ids remain inside the Layers sheet's parcels section for existing code |
| Parcels: layer toggles, ownership highlight, parcels-in-view, coverage, refresh, clear | Layers sheet → Parcels |
| Blocks: toggles | Layers sheet → Blocks; block actions (count, from selected, list, clear) → Tools sheet → Blocks |
| Stations | Tools sheet → Stations (also in the parcel build palette already) |
| Buildings | Layers sheet → Buildings |
| Roads: line toggles, government plan | Layers sheet → Roads; detection/analysis actions and legend → Tools sheet → Roads |
| Area monitor | Tools sheet → Area monitor |
| Measurement | Tools sheet → Measure |
| Information, debug mode, badges, intro | Settings sheet |
| Status bar + log | a compact status line inside the Activity button's sheet; `#floating-status` becomes the always-visible toast |

### Parcel interaction

- **Click a parcel** → parcel menu at the click point: parcel id and one-line facts, then actions:
  *Propose here* (opens the parcel panel on its build palette), *Select more* (enters multi-select),
  *Details* (parcel panel info tab), *History*, *Tools* (parcel panel tools tab), *Offer my land*
  (only when the build palette offers it), *View in 3D*. Everything the existing click chain does
  (drill to proposals on top, share-plan pick, browse mode, blocks highlight) is preserved; only the
  final "open the parcel panel" becomes "open the parcel menu".
- **Select more** → multi-select (`multiParcelSelection`); each click toggles; Shift+click still
  works; the **selection tray** shows count, total area and actions: *Propose* (panel build palette
  for the selection), *Detect block*, *Clear*, *Done*.
- Block, road, proposal clicks open their existing panels unchanged.

### Search box

One input, grouped results, keyboard navigable:
- **Cities**: configured cities first, then the world-parcels registry cities (with coverage tier).
- **Parcels**: anything that looks like a cadastral id → existing `CadastralParcelRepository.ensureIds`
  + `selectParcel` path (the old Locate box).
- **Proposals**: `GET /proposals/summary?q=` (server-side), click → `selectAndHighlightProposal`.
- **Places**: address geocoding (Photon, debounced, ≥3 chars) → pan the map there.
- **Commands**: the command registry (same as the palette).

## World view and globe

- **When**: first visit (no stored city, no `?city=`, no shared route), or the city chip. Shared
  links and returning visitors go straight to their city.
- **Globe**: three.js (already loaded lazily via `whenThreeReady`), an equirectangular texture painted
  on a canvas from `countries.geojson` coloured by coverage tier, graticule, atmosphere glow, city
  dots. Idle auto-rotate (off under reduced motion), drag/fling, wheel/pinch zoom. Search box on top.
- **Coverage tiers** (from `world-parcels/registry.json`, compiled to a compact
  `frontend/data/world-coverage.json` by a script):
  1. **live** — a configured city (or its area): open it.
  2. **source verified** — open parcel data exists but isn't loaded: warn, offer *Explore anyway* and
     *Ask for this city*.
  3. **nothing found** — searched, no open data: warn, *Explore anyway*.
  4. **not researched** — warn, *Explore anyway*.
- **Click** anywhere → lat/lon → nearest configured city within reach, else registry city/country
  tier → popup.
- **Fly-in**: camera dives to the point; because a city switch reloads the page, the last frame's
  target is stored in sessionStorage and the boot shows that frame and fades it out over the loaded
  map, so it reads as one motion.
- **Explore anyway** opens a generic *explore* city (`?city=explore&at=lat,lon,zoom`): basemap and
  whatever layers need no cadastre; parcel sections disabled; a banner says there is no parcel data
  here yet. Proposals there need a no-cadastre anchor (open product decision; out of scope).
- **Ask for this city**: `POST /cities/requests` stores a request count per place (demand signal).

## Build order

1. Command registry + surfaces + coverage test; floating shell (sheets, buttons, game pill); rehouse
   every sidebar section; delete the sidebar and fix its dependents.
2. Search box + city chip.
3. Parcel menu + selection tray.
4. Command palette.
5. World view: coverage data, globe, fly-in handoff, explore city, city requests.
6. Cleanup: dead CSS, docs, final i18n and mobile pass.

Status per step is recorded at the end of this file.

## Status

(filled in as steps complete)

### Phase 1 (registry, shell, rehoused sidebar, sidebar deleted) — built, browser-checked

**Built**
- `frontend/js/ui/commands.js` — the command registry (UMD, no DOM at load; `window.UiCommands`).
  74 commands; helpers `listCommands`, `commandsFor(surface, ctx)`, `findCommand`,
  `searchCommands(query, ctx, t)` (accent-insensitive, ranked exact > prefix > word start >
  substring > id), `runCommand`, `createBrowserContext(window)`, and `REHOUSED_CONTROL_IDS`.
  Every command is on the `palette` surface plus its sheet's. Toggles/buttons with an id run by
  clicking the rehoused control; inputs (locate, base map, data source, city, turn interval) run by
  `MapShell.revealControl` (open the sheet, focus the control); id-less buttons call the global.
- `frontend/js/ui/map-shell.js` + `frontend/css/map-shell.css` — buttons, Game pill and sheets.
  `MapShell`: `initializeMapShell`, `openSheet/closeSheet/closeSheets/toggleSheet/isOpen`,
  `revealControl(id)`, `revealSection(name)`, `setSectionBusy(name, busy, msg)` (replaces
  `setSidebarDisabled`, locks only the named section), `setLockedFor3D(bool)` (replaces
  disable/enableSidebarFor3D), pure `placePopover` (tested). Popover on desktop anchored to its
  button (below a top button, above a bottom one), bottom sheet (≤80vh) under 768px; one open at a
  time; Esc / close button restore focus to the button; outside pointerdown closes; aria-expanded /
  aria-controls on every trigger. The Proposals badge mirrors `#showProposalsButton`'s
  `data-i18n-params` count via a MutationObserver.
- `js/sidebar-management.js` renamed to `js/map-controls.js` (control behaviour only;
  `initializeSidebar` → `initializeMapControls`, which now also gates every section by its layer
  checkbox at boot since sheets are always "expanded"). Boot: `MapShell.initializeMapShell();
  initializeMapControls();`. `css/sidebar.css` deleted: shell/control rules → `map-shell.css`,
  confirm dialogs → `modals.css`, 2D/3D button + `#three-container` → `map.css`, touch targets →
  `layout.css`.
- Hooks for later phases: `#map-search-slot` (top-left) and `#selection-tray-slot` (bottom-centre),
  empty and `display:none` while empty.

**Where every sidebar section lives now** (all ids, inline handlers and
`.accordion-section[data-section]` wrappers kept; accordion headers became plain `h3` headings;
`.accordion-content` became `.sheet-section-body`)
- Layers sheet: Parcels (locate row, layer toggles, ownership highlight, in-view count, coverage /
  refresh / clear), Parcel Blocks toggles, Buildings, Roads layer toggles + government plan toggle.
- Tools sheet: Measurement, Parcel Blocks actions + block list + counted, Stations, Roads
  (detection, Apply government plan, progress, Analyze, analysis toggle, legend), Area monitor.
- Proposals sheet: the sheet itself is `data-section="proposals"`; list button first.
- Game pill: date · turn · play/pause (`#game-datetime`, `#game-turns`, `#game-play-pause-btn`);
  its toggle opens the game sheet (`data-section="game"`): `#gameCheckbox`, interval, progress,
  New game, log, agents.
- Activity sheet: Open activity explorer / Show agents, then the status bar (`#status`,
  `#status-log-expanded`, Copy all / Open log). `#floating-status` is now the always-visible
  one-line toast, centred one row above the bottom buttons.
- Settings sheet: brand + AI badge, debug badges (`.settings-badge-bar`), the city row
  (`#city-select` + custom dropdown, `#detect-city-button` — phase 2 replaces these with the city
  chip and the search box), Data (data source, base map — label now translated, wipe), Information
  (contact, about, intro, start here, debug mode).

**Layout decisions**
- Mode strip moved from bottom-left to the left edge under the search slot: slots are now `top`
  offsets (64…304px); `map-mode-stack.test.js` asserts `top`. `--map-mode-stack-left` is a fixed
  10px. Scale bar sits above the Game pill and toast row.
- Desktop: while a right-dock panel is visible, the right-hand buttons and the user bubble step left
  of it. 3D: Layers/Settings move to the bottom-right (the 3D settings panel owns top-right). Photo
  view lifts the bottom row above the Google credits. Phones: bottom-right buttons are a column so
  the Game pill keeps the bottom row at 320px; labels hidden; turn label hidden.
- 3D keeps Buildings and Proposals sections (and every sheet button) usable; everything else in the
  sheets and the Game pill is disabled until exit, as the sidebar was.
- `syncProposalsIndicator` (only reset an accordion header's opacity) deleted with its callers;
  `openProposalFromList`'s `collapseSidebar` option renamed `closeSheets`.
- City config: a disabled section now hides every wrapper with that `data-section` (Blocks and
  Roads appear in two sheets); `parcelBlocks` maps to `data-section="blocks"`.

**Deferred**: search box, city chip, parcel menu, selection tray, palette (phases 2–4); the
palette button in Settings. Proposals badge shows the local + cached server count; the server half
refreshes when the proposals sheet opens (unchanged IntersectionObserver).

**Pre-existing bug fixed on the way**: `activityExplorerState` was referenced in `game.js` but
never declared (since 361cf41c), so every way into the activity explorer threw a ReferenceError.

**Verified in a headed browser (1400×900 and 375×740, `?reduceMotion=1`, Zagreb)**: no console
errors at boot; all six sheets open/close (button toggle, Esc restores focus, outside click), one
at a time, anchored correctly; parcels toggle removes/re-adds the parcel layer; GDI buildings
toggle loads the layer; Measure activates; proposals list opens and closes the sheet; badge
showed 412 after the server count; play/pause flips `gameState.isRunning` and the icon; activity
explorer and Show agents open; base map switch loads MapTiler tiles; enabling game mode un-greys
the game controls; 3D entry closes sheets, locks/unlocks controls, floating UI clear of the 3D
panel; parcel click → shell steps left of the parcel panel; 375px: no overlaps among strip, pill,
buttons, bubble, toast; bottom sheets full width. **Not verified**: photo (Google tiles) view
layout, the area-monitor route opening the Tools sheet, detect-existing-roads busy lock, a city
with disabled sections (e.g. Belgrade), Playwright suites (not run).

### Phase 5a (globe) — built, not yet integrated

Built standalone; nothing in the app loads it yet. Preview: serve `frontend/` with a no-cache server
and open `/world-preview.html` (logs every callback; `?lang=hr`, `?reduceMotion=1` work).

- Data: `node scripts/build-world-coverage.mjs --run` → `frontend/data/world-coverage.json` (~180 KB,
  deterministic; the tier mapping is documented in the script header). **Re-run it whenever
  `world-parcels/registry.json` or a city's `defaultCenter` in `city-config.js` changes** —
  `backend/test/world-coverage-build.test.js` fails until the committed file matches.
- Modules (`frontend/js/world/`): `globe-math.js` and `world-coverage.js` (pure, UMD), `globe.js`
  (`window.WorldView`), `handoff.js` (`window.WorldHandoff`); styles in `frontend/css/world.css`.
  Public API is documented in each file's header comment.
- Backend: `POST /cities/requests {placeKey, name, country, lat, lon}` (30/h per IP) and
  `GET /cities/requests?limit=` (`backend/routes/city-requests.js`); table `consensus.city_request`
  from `routes/city-requests-ddl.sql`, applied by `deploy-backend.sh`. **Prod DDL runs on the next
  backend deploy — deploy the backend before a frontend that posts to it.**

Integration steps:

1. `index.html` `<head>`, with the other CSS: `<link rel="stylesheet" href="css/world.css">`.
2. `index.html`, as early in `<body>` as the cache-bust loader allows (so the frame covers the map
   before its first paint), add `js/world/handoff.js`. It consumes a fresh handoff record by itself
   and fades it once `window.whenAppBooted()` resolved and the base tile layers finished loading;
   when map-core.js (which defines `whenAppBooted`) has not loaded yet it listens for the
   `appBooted` event instead, so loading it before map-core is fine.
3. With the app scripts (anywhere after `i18n.js`; `globe.js` needs the import-map
   `window.whenThreeReady`, which is defined inline in index.html — it only calls it on `open()`):
   `js/world/globe-math.js`, `js/world/world-coverage.js`, `js/world/globe.js`.
4. Open it (first visit — no stored city, no `?city=`, no shared route — or from the city chip):

   ```js
   WorldView.open({
       closable: !isFirstVisit,
       initialView: { lat: 30, lon: 15 },            // optional
       onOpenCity(cityId, point) {
           WorldView.flyTo(point, { onDone(state) {
               WorldHandoff.store({ dataUrl: WorldView.captureHandoffFrame(), cityId,
                   center: [state.lat, state.lon], zoom: Math.round(state.leafletZoom) });
               navigateToCity(cityId);   // for a countrywide-live point (e.g. Osijek) pass point too
           } });
       },
       onExplore(point) {
           WorldView.flyTo(point, { onDone(state) {
               WorldHandoff.store({ dataUrl: WorldView.captureHandoffFrame(), cityId: 'explore',
                   center: [state.lat, state.lon], zoom: Math.round(state.leafletZoom) });
               location.href = `?city=explore&at=${state.lat.toFixed(5)},${state.lon.toFixed(5)},12`;
           } });
       },
       onRequestCity(place) {           // returned promise drives the button's thank-you / error line
           return fetch(`${getBackendBase()}/cities/requests`, { method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ placeKey: place.placeKey, name: place.name || place.country,
                   country: place.country, lat: place.lat, lon: place.lon }) })
               .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });
       },
       onClose() { /* back to the current city */ }
   });
   ```

   Notes: `flyTo` ends at 120 km altitude inside a sky haze (the texture is 110m Natural Earth, too
   coarse to show a city), so the handoff frame is a soft haze that dissolves and scales into the
   map. `state.leafletZoom` (≈10 at 120 km) is the geometric equivalent; the city's own default zoom
   is probably the better target. Tier `live` for a point anywhere in Croatia carries the nearest
   Croatian `cityId` (parcels are countrywide). `WorldView.close()` frees the WebGL context; call it
   if the user leaves without navigating. The overlay is `z-index: 20000`, handoff frame `25000`.

### Phase 2 + 4 (search box, city chip, command palette) — built, browser-checked

**Built**
- `frontend/js/ui/search-model.js` (pure, UMD, `window.SearchModel`): `classifyQuery` (city /
  parcel / proposal / address / command; a leading `>` = commands only), `looksLikeParcelId`,
  `parcelIdCandidates` (a bare `1813/6` → the ids loaded on the map ending in `-1813/6`;
  `335550-1813/6` → `HR-…`; NYC/Colorado/Ljubljana/Belgrade prefixes; Croatian bare number with
  no loaded match → "add the cadastral municipality"), `rankCities`, `resolveProposalCityId`,
  `rankProposals` (current city first), `parsePhoton` (deduped), `placeZoom`,
  `classifyPlaceLocation` (here / other-city / world; same-cadastre cities and countrywide-live
  countries count as here), `pushRecent`, `orderGroups` (groups ranked by their best match),
  `selectableItems`, `moveSelection`, `keyAction`.
- `frontend/js/ui/map-search.js` (`window.MapSearch`: `initialize`, `focus`, `showCities`, `close`)
  + `frontend/css/map-search.css`, mounted in `#map-search-slot`. City chip (current city short
  name) → `MapShell.openWorldView?.({})`, else the city list. Groups: Recent searches (localStorage
  `cb_map_search_recent`, max 8, empty query), Cities (Use my location, configured cities, world
  registry places via `WorldCoverage.load()` lazily on first focus), Parcels (`locateParcelById`,
  errors inline under the item), Proposals (`GET {getBackendBase()}/proposals/summary?q=&limit=8`,
  250 ms debounce, aborted when superseded), Places (Photon, ≥3 chars, 350 ms debounce, aborted,
  biased to the map centre, attribution line), Commands (`UiCommands.rankCommands`, available only,
  top 5), and a "Commands… ⌘K/Ctrl K" row. ↑↓ Enter Esc; `/` focuses the box outside text fields.
  A chosen place pans (zoom 18 house/street … 6 country) and drops a circle marker, cleared by the
  next search or Esc. A proposal opens like the browse list does (local copy, else the same
  download confirm + `importServerProposal`, then `openProposalFromList(…, { closeSheets: true })`);
  one in another city goes through the shared-link path (`/proposals/<id>` pushed, then
  `promptCityMismatchForProposal`). Hidden in model/photo view (it moves the 2D map).
- `frontend/js/ui/command-palette.js` (`window.CommandPalette`: `initialize`, `open(query)`,
  `close`, `isOpen`; pure `groupPaletteItems`, `registryGroupOrder`) +
  `frontend/css/command-palette.css`. Ctrl/Cmd-K toggles it, except while typing in another text
  field (the search box hands its `>query` over). Every palette command, grouped in registry order
  (best-matching group first when filtering); unavailable ones greyed with the reason
  (`commandPalette.reason.*`: disabledIn3D / busy / hiddenForCity / disabled) — the registry gives a
  reason only for control-backed commands, via the new `ctx.controlUnavailableReason(id)`.
  Bottom sheet under 768px. Settings sheet: `#command-palette-button` (command
  `settings.commandPalette`, Settings surface only).
- Registry: `UiCommands.rankCommands(query, ctx, t)` → `[{ entry, label, rank, available, reason }]`
  (`searchCommands` is now its available subset). `parcels.locate` → `MapSearch.focus()`,
  `settings.city` → `MapSearch.showCities()`, `settings.detectCity` →
  `CityConfigManager.detectNearestCity()` (all three palette-only now).

**Removed (dead after the search box)**: `#city-select` + its custom dropdown, `#detect-city-button`,
the Locate row (`#locateParcelInput/Button/Error`) and their CSS; `populateCitySelect`,
`buildCityDropdown`, `handleCitySelectChange`, `setupDetectCityButton` (its body is now
`CityConfigManager.detectNearestCity()`); the Locate DOM wiring (its core is
`window.locateParcelById(value)` → `{ ok, parcelId }` / `{ ok: false, reason, message }`);
i18n `sidebar.city.label`, `sidebar.parcels.locateParcelPlaceholder`, `sidebar.parcels.locateButton`.
Refactors to share instead of duplicate: `importServerProposal(serverId)` (list-ui.js, used by the
list row click and the search box); `CityConfigManager.getCityCenter`; `switchCity(id, { clearRoute })`
/ `navigateToCity(id, { clearRoute })` drop a `/proposals|/plans|/parcel/<id>` path so "go to this
city" from the search box does not carry the link being viewed into the next city (found in the
browser: switching Šibenik → Split re-opened the Šibenik proposal and prompted again).

**Hook for the globe integrator**: implement `MapShell.openWorldView(opts)`. The search box calls
it (and closes itself first) with `{}` from the city chip, `{ focus: place }` for a world-registry
place (a `WorldCoverage` Place: `{ kind, tier, name, country, cc, note, lat, lon, placeKey }`), and
`{ focus: { lat, lon, name } }` for a geocoded place outside every configured city. Until it exists
the chip opens the city list, a world place shows its tier text inline, and a far geocoded place
just pans the 2D map. `js/world/world-coverage.js` is already in the script list (before
map-search.js); add only `globe-math.js`, `globe.js`, `handoff.js` and `world.css`.

**Tests**: `frontend-map-search.test.js` (classification, parcel candidates, ranking, grouping,
place location, recent, keyboard, index.html wiring, every key in en/hr/es/sr),
`parcel-locate.test.js`, `frontend-command-palette.test.js`; `frontend-ui-commands.test.js` and
`i18n-locale-coverage.test.js` (dynamic prefixes `commandPalette.groups.`, `.reason.`, `world.tier.`)
updated. Full suite: 420 files / 5802 tests pass, 2 skipped.

**Verified in a headed browser (1400×900, 375×740, 320×640; Zagreb, `?reduceMotion=1`)**:
"Ilica 1" → Photon places, Enter moved the map to Ilica at z18 with the marker; "1323/2" →
`HR-335240-1323/2` (from the loaded ids), Enter selected it and turned parcel ids on;
`HR-335240-999999` → "Parcel not found" inline; `99999/9` → the add-the-municipality hint; "park"
→ commands + 8 proposals from the local DB + places; a Zagreb proposal → download confirm → opened
collapsed, map moved; a Šibenik proposal → city prompt with `/proposals/1312`, "Open in Šibenik"
reloaded there and ran the shared route (that record then fails to apply — "A park must take
whole parcels…" — a data problem, not the search); "Split" + Enter → reloaded into Split; chip →
city list → Zagreb; "Korzo Rijeka" → panned to Rijeka with parcels (countrywide); "Prešernov trg" →
"Open in Ljubljana"; "Paris" → registry place with tier; Use my location → the confirm (cancelled);
Cmd-K opened the palette, "meas" filtered to Measure + greyed Clear Measurements, Enter ran Measure;
Cmd-K in a plain text input did nothing, from the search box it opened; Settings → Command palette
opened it and closed the sheet; Esc closes. Phone: compact chip + magnifier, focus expands to the
top edge with a full-height result sheet, back arrow collapses; palette is a bottom sheet. No
console errors. **Not verified**: geolocation success path (prompt only), Photon outage/error line,
the 3D-hidden search box, other languages' layout.

**Known/deferred**: at 320px the user bubble is squeezed to its avatar (it now reserves room for
the compact search box); "Open in <city>" switches city but cannot carry the place (no `?at=`
yet — the explore-city work adds it); proposal search is server-only (local unsynced drafts are
not searched); places in other countries' configured cities are offered by distance (60 km).

### Phase 3 (parcel menu, selection tray) — built, browser-checked

**Built**
- `frontend/js/ui/parcel-menu-model.js` (pure, UMD, `window.ParcelMenuModel`): `availableActions(facts)`
  / `isActionAvailable(action, facts)` (menu order: propose, selectMore, details, history, tools,
  offer, view3d, detectBlock), `buildPaletteAvailable(state)` — the one predicate for "the build
  palette (and its Ownership Offer) renders", now also used by `renderParcelProposalActions` —
  `parcelArea`, `ownershipFacts` (type/count only from loaded data; unknown count is null, not 1),
  `displayParcelId` (same id as the panel title), `placeMenuAtPoint` (right-below, flips, clamps).
- `frontend/js/ui/parcel-menu.js` + `frontend/css/parcel-menu.css` (`window.ParcelMenu`: `open`,
  `close`, `dismiss`, `isOpen`, `contextFacts`, `runAction`). Popover in `#map-container` at the
  click point; follows pan/zoom (hidden while the point is off-screen or mid-zoom); re-anchors to a
  visible point of the parcel when the drill stack has already framed a large parcel. Closes on a
  map background click, Esc / × (also deselects, like closing the panel), a right-dock panel or a
  sheet opening, 3D starting, or multi-select starting. ≤767px: bottom-sheet peek, actions as a
  4-column tile grid. `role="group"`, not `dialog` — `isAnyModalOpen()` treats any dialog as a
  blocking modal and would silence map shortcuts.
- `frontend/js/ui/selection-tray.js` + `frontend/css/selection-tray.css` (`window.SelectionTray`:
  pure `summarizeSelection`, `render`, `propose`). Rendered into `#selection-tray-slot` while
  multi-select is on — also with 0 parcels ("Click parcels to select them" + Done), so the mode is
  never on with no way out on screen. Count, turf-measured total area (null-safe; unknown = hidden,
  never 0), actions Propose · Detect block · Clear · Done. Re-renders on the existing
  `multi-parcel-selection-change` event (dispatched by `multiParcelSelection.updateUI`). Row: the
  bottom row when ≥1200px wide and no right-dock panel; otherwise one row up (centred on the map left
  of the dock); phones: between the Game pill row and the button column, icon-only. The status
  toast always sits one row above the tray.
- Commands (`commands.js`): `parcel.propose|selectMore|details|history|tools|offer|view3d|detectBlock`
  (surface `parcel-menu` + palette; `when` = the model on `ctx.parcel`), `selection.propose|clear|done`
  (surface `selection-tray` + palette; `when` on `ctx.selection`); `blocks.fromSelected` (already on
  the tray surface) is now unavailable on an empty active selection. `createBrowserContext(win,
  extra)` gained live `ctx.parcel` (the open menu's parcel, else a single selected parcel — so the
  palette offers parcel actions when one is selected) and `ctx.selection` ({active, count}).
  Strings: `parcelMenu.*`, `selectionTray.*` in en/hr/es/sr (plural forms for counts).

**Click chain** (`parcels/ui/parcel-selection.js` onParcelClick): unchanged up to the end. Then:
selection styling, `selectedParcelId`, `currentParcel`, `currentParcelCoordinates`, blocks highlight
as before; an applied non-road proposal on the parcel still selects that proposal (no menu, as the
panel was closed by `clearSingleParcelSelection` before); otherwise `ParcelMenu.open`. **Decision:**
when the parcel panel is already open, a click keeps moving the panel to the clicked parcel (the
inspector, as before) and opens no menu — the menu is for the closed-panel state. The legacy
split-geometry preview branch (`feature.properties.geometries`) still opens the panel directly.

**Menu actions**: Propose here / Details / Tools → `showParcelInfoPanel` + `switchParcelTab(null,
'proposals-tab'|'info-tab'|'tools-tab')`; History → Info tab + `ProposalParcelHistoryCard.mountAfter
(#info-content)` for the parcel's cadastre ids, first row opened (beside, not inside,
`#info-content`, which the owner fetch re-renders; `ParcelsUIParcelPanel.dropParcelHistoryCard` removes
it when the panel moves to another parcel, closes, or shows a multi-selection); Select more →
`multiParcelSelection.toggle({ preserveSelectedParcel: true })` (the Shift+click seed); Offer my land →
`startParcelBuildTool('offer')`; View in 3D → centre the map on the parcel, click `#mode-3d-toggle`
(no parcel focus exists in `enter3D`; the lazy shim loads the stack); Detect block →
`animateFloodfillFromSelected()`.

**multiParcelSelection** (`proposals/data.js`): `updateUI` no longer opens the parcel panel on every
toggle — it refreshes the panel only while it is open; the panel rendering moved to
`showSelectionInPanel()` (used by updateUI and the tray's Propose). Dead `updateCreateProposalButton`
(targeted the removed `#createProposalButton`) and its two callers removed. `#multiSelectCheckboxInfo`
kept: it still toggles multi-select from the panel and `syncMultiSelectCheckboxes` keeps it in step
with the tray. `drill-ui.js` treats `#parcel-menu` as a neighbour like the parcel panel, so the "At
this spot" stack lives as long as the menu.

**Tests**: `frontend-parcel-menu.test.js` (model availability incl. road parcel, no blocks, no 3D,
no history ids, multi-select, the Offer/palette predicate against the real `renderParcelProposalActions`;
facts null-safety; placement; command availability/run; characterization of onParcelClick's tail —
menu not panel + selection state, multi-select toggles without the menu, Shift+click, open panel
stays the inspector, applied proposal wins; verified red by re-opening the panel in the tail),
`frontend-selection-tray.test.js` (count/area null-safety). `parcel-build-block-suggestion.test.js`
now injects the model.

**Verified in a headed browser** (Zagreb, `?reduceMotion=1`; 1400×900, 1024×768 in Croatian,
375×740, 320×640): menu at the click point with id, area, owner type and count; flips up near the
bottom edge; Propose here → panel on the build palette (15 tools incl. Offer); Details, Tools,
History (card mounted, row open) land on the right tab; Esc closes and deselects; a map background
click and opening the Layers sheet close it; Select more → tray "1 parcel"; clicks add/remove
parcels with live count and area; tray Propose → "Multiparcel selection" panel on Proposals; Detect
block (menu and tray) → 285-parcel block after the wider-ground load; Clear → empty tray with Done;
Done → mode off, tray gone; Shift+click → tray with 2; Esc exits multi-select as before; road parcel
→ "Road" fact, no Detect block; View in 3D → 3D centred on the parcel; Offer → the guest
personalize gate the palette's Offer shows; with the panel open a click updates the panel; phone peek
and tray clear of the Game pill, buttons and toast; no page errors. **Not verified in the browser**:
a parcel under an applied proposal (fresh profile has no proposals; covered by the characterization
test); the history timeline itself (local `GET /parcels/:uid/history` answers 500 — the local DB
lacks a table it queries, error 42P01); Belgrade-style cities with blocks disabled.

### Phase 5b (globe integrated, explore city, ?at=) — built, browser-checked

**Built**
- `frontend/js/world/world-entry-model.js` (pure, UMD, `window.WorldEntryModel`; loads before
  city-config): `parseAt`/`formatAt` (`?at=lat,lon[,zoom]`, |lat| ≤ 85.05, |lon| ≤ 180, zoom clamped
  3–19, anything else ignored), `isSharedRoute` (proposals/plans/parcel/monitors paths, `?parcel`,
  `?proposalShare`, `?shared`, `?activity`, `?scene`, view-mode params), `bootDecision` (globe on a
  first visit = no stored city, no `?city=`, no shared route; `?world=1` forces it, closable when a
  city was chosen), `resolveLanding` (same city → in place; another city → reload; a click on a live
  city → that city's default view; a countrywide-live spot (inland Croatia) or a precise search
  result → that spot via `?at=` at ≥ zoom 17; explore → zoom 12 city / 10 area / the search zoom),
  `liveCityFor` (a Croatian spot opens in the loaded Croatian city — one countrywide cadastre — so the
  popup says "Open Split" from Split and lands in place), `utmProjectionFor`.
- `frontend/js/ui/world-entry.js` (`window.WorldEntry`: `open(opts)`, `ownsBoot()`,
  `explorePlaceName()`), loaded right after city-config: first-visit/`?world=1` boot (dark
  `body.world-view-pending` cover until the first globe frame; `?world` stripped), the landing
  (flyTo → `captureHandoffFrame` → `WorldHandoff.store` + `switchCity(id, { clearRoute, at })`, or in
  place: `WorldHandoff.play` + close + `map.setView`, pointer stored via
  `CityConfigManager.rememberCurrentCity()`), `POST /cities/requests`, the explore banner and chip
  name, the Settings button. `MapShell.openWorldView(opts)` delegates to it.
- City config: `explore` entry (`explore: true`; centre from `?at=`, else localStorage
  `cb_explore_at` — updated on every moveend — else a world overview; WGS84 data CRS + UTM metric CRS
  of the point; `parcels.source: 'none'`; disabled sections parcels, parcelBlocks, buildings, roads,
  areaMonitor, stations, proposals, game). Excluded from `getAvailableCities`, `findNearestCity`, the
  stored-city pointer (never written, never read) and `build-world-coverage.mjs`. PersistentStorage
  scope `explore` (explicit, so the legacy migration never reloads out of it). New manager API:
  `isExplore`, `wasCityChosenAtBoot`, `rememberCurrentCity`, `rememberExploreView`, `getCityConfig`,
  `hasParcelData`, `EXPLORE_CITY_ID`; `navigateToCity`/`switchCity` take `at` and always drop `at`
  and `world`. Buildings stay off: the backend resolves building providers by city id and falls back
  to Zagreb for an unknown one, so nothing generic works without code.
- No parcels without cadastre: `fetchParcelData`, the transport's `fetchBounds`/`fetchByIds`
  (parcels/fetch.js), the moveend controller and map-core's zoomend/initial fetch all short-circuit
  on `hasParcelData() === false`.
- `?at=` (map-core.js): the initial `setView` uses it (ignored on proposal deep links), then it is
  stripped with `history.replaceState`. The search box's "Open in <city>" passes the place as `at`
  (with its Photon zoom); a far place while exploring just pans; a world place passes `zoom` in focus.
- Explore UI: `body.explore-city` hides Layers, Proposals, the Game pill and the whole mode strip
  (model/photo/AI/walk build on parcels); Tools (Measure), Activity, Settings stay. Commands: a
  section hidden by the city config now hides its group's commands too, global-calling ones included
  (`UiCommands.GROUP_SECTIONS`, `ctx.isSectionHidden`; reason `hiddenForCity`) — this also tidies
  Belgrade-style cities.
- Command `world.open` ("World view", Settings `#world-view-button` + palette). The globe focuses its
  canvas on open (Escape did nothing when opened from the chip: the key handler lives on the root).
  Globe option `chooseCity(place)` picks which live city a popup opens.
- Site intro waits for `worldview:landed` while a first-visit globe owns the boot (shown after the
  reload into a city, or when the globe lands in place).
- `index.html`: `world.css`; `js/world/handoff.js` first in `<body>`; `world-entry-model.js` before
  and `ui/world-entry.js` after `city-config.js`; `globe-math.js`, `globe.js` after
  `world-coverage.js`. i18n: `city.labels.explore`, `mapShell.commands.worldView`, `world.explore.*`.
- Removed the harness `frontend/world-preview.html` + `js/world/world-preview.js`: `?world=1` in the
  real app replaces it, and a stray page would have shipped with the frontend.
- Local DB: `backend/routes/city-requests-ddl.sql` applied (as geo_user) to the local `geodata`.

**UI names**: *world view* / *globe* (overlay), *globe popup* (place card: Open <city> / Ask for this
city / Explore anyway), *World view button* (Settings), *explore city*, *explore banner* (top-centre:
text, Ask for this city, World view, ×), *explore chip* ("Explore · <place>").

**Tests**: `frontend-world-entry.test.js` (28: `?at=` parse/clamp/format, shared routes incl. a
cross-check against the app's `isProposalDeepLinkPath`, boot decision, landing matrix with the real
coverage data — Zagreb in place, Split reload, Osijek → HR city at zoom 17, precise search, explore
zooms, UTM; explore config completeness against the key paths ALL real cities share, sections,
not-a-city/storage scope/pointer, reload memory, `navigateToCity` at/world; fetch guard; site intro
deferral; wiring; section-hidden commands). Verified red by deleting `currency` from explore, the
fetch guard and the intro deferral. `city-parcel-membership.test.js` skips the `explore: true` entry.
Full suite: 421 files / 5834 passed, 2 skipped (1 file skipped).

**Verified in a headed browser** (fresh profiles, 1400×900, 375×740, 320×640): first visit → globe,
no ×, intro held; Zagreb label → Open Zagreb → reload into Zagreb, handoff frame shown 63 ms after the
reload and faded on map drawn, intro after; returning visit → no globe; chip → globe (Esc closes) →
Split → Split with 7073 parcels; from Split, Osijek → "Open Split" → in place at 45.55,18.69 z17,
6314 parcels; Tokyo → Explore anyway → `?city=explore`, chip "Explore · Tokyo", banner, status
"Exploring without parcel data", `cb_current_city` still split; pans/zooms 5–18, Tools/Activity/
Settings sheets, Measure (800 m line), palette (only Measure/Pinpoint/Activity/Settings/World view
available), search "Shibuya" → pans, no page errors; Ask for this city → row `geonames:1850147`
count 1 in `consensus.city_request`; explore → Osijek → reload to `?city=zagreb&at=…` (stripped) at
z17 with parcels; search "Prešernov trg" → Ljubljana at the square, z18; shared `/proposals/1342` on
a fresh profile → no globe; `?world=1&reduceMotion=1` → globe, closable, no spin, flyTo in 1 ms;
first visit picking New York (the booted default) → in place, no reload, pointer stored, intro after;
`?lang=hr` banner/chip/status in Croatian; banner × stays dismissed for the session.

**Open**: proposals in explore need a no-cadastre anchor (out of scope); photo view could work
anywhere but is hidden (it enters through the parcel-bound 3D stack); on a fresh profile a shared
proposal link stacks the city-switch prompt over the site intro (pre-existing); phone chip shows
"Explor…" (compact width); the first-visit globe boots the default city underneath (its parcels load
behind the cover).

### Phase 6 (cleanup, fresh-eyes review) — built, browser-checked

**Cleanup**
- **Data & maintenance** (Settings sheet; `data-section="data"`, title key `mapShell.maintenance.title`):
  data source and base map, then "Stored in this browser": Show loaded parcels cover, Refresh
  parcel data, Clear parcel / blocks / roads / proposals from local storage, Wipe ALL local data.
  They moved out of Layers → Parcels, Tools → Blocks / Roads and the Proposals sheet with their
  ids and handlers. Each dataset's upkeep sits in its own nested
  `.accordion-section.sheet-subsection[data-section=parcels|blocks|roads|proposals]`, so a city
  that hides the section hides its upkeep too (Belgrade: blocks/roads upkeep hidden; explore: all
  four, only Wipe remains), `isSectionHidden` still sees "every wrapper hidden", the 3D lock keeps
  the proposals clear usable as before, and `setSectionBusy('roads')` also locks the roads clear
  while detection runs. Commands `parcels.coverage|refresh|clearLocal`, `blocks.clear`,
  `roads.clear`, `proposals.clearLocal` are on the `settings` surface. The per-dataset clears stay
  `.btn-danger`, i.e. visible only in debug mode (as in the sidebar); Wipe is always visible.
  Test: `frontend-sheet-maintenance.test.js`.
- **One sheet style** (`css/map-shell.css`, "Controls inside the sheets"): every `.btn` in a sheet,
  whatever colour class it still carries, is a compact white row (36px desktop / 44px phones, 8px
  radius, icon + label, focus ring); one filled primary per sheet (`.sheet-action--primary`, the
  proposals list); destructive = red outline, not a red block; toggled tools (Measure, Pinpoint,
  a station being placed) dark; checkbox rows with hover and a greyed look when disabled (3D lock);
  `.sheet-field` label-over-select; `.sheet-note` for the read-outs; section separators only between
  top-level sections. The rooster card keeps its own look. Sheet buttons gained Font Awesome icons
  (keys moved onto a label `<span>` where the key was on the button; not on `#showProposalsButton`,
  whose key/params are written by list-ui.js and mirrored into the badge). Inline `style` removed
  from `#parcels-in-view`, `#parcels-counted`, the data selects.
- Label writers that flattened those buttons now keep the markup: `runWithButtonBusyState` restores
  `innerHTML` (and takes `{ key, fallback }` busy labels, translated), `detectExistingRoads` and
  `applyGovernmentRoadPlan` restore markup, the game log / agents writers write into the label span.
  `clearMeasurementsButton` shows with `display: ''` (was `inline-block`).
- **Explore chip on phones**: compass icon + the place ("Tokyo") instead of "Explor…"; desktop keeps
  "Explore · Tokyo". `body.explore-city` widens `--map-search-compact-width` to 150px.
- **Dead code/CSS**: `.game-status*` rules (game.css); unused `blockButtons` query left in
  `updateBlockButtonStates`. i18n keys made unreferenced by the rework removed from all four
  locales: `sidebar.data.title`, `sidebar.game.datetime`, `sidebar.game.turns`, `sidebar.header.toggle`
  (computed by diffing references at the base commit vs now, dynamic `prefix.${x}` keys counted as
  used). No CSS for removed elements remained (earlier phases had cleaned it).
- **i18n** (en/hr/es/sr): `mapShell.maintenance.*`; `common.busy.*` (Detecting/Loading/Forming/
  Selecting/Refreshing/Analyzing/Applying…); `sidebar.roads.detectingExisting`; the status toast's
  cadastral lines `status.messages.cadastral_ground_already_loaded|checking_cadastral_ground|
  loading_cadastral_ground|waiting_for_proposal_before_parcels`; `status.messages.debug_mode_enabled|
  disabled`; `city.switch.cancelled`. "Base map:" was already translated (Phase 1).
- **Docs**: readme.md "Map UI" section; how-to pages (en + hr, main and reparcellization) describe
  the parcel menu / Select more / selection tray / mode strip / Proposals button;
  `.github/copilot-instructions.md`, `gup-scenario-integration.md`, `TEST.md` no longer mention the
  sidebar. Screenshots in `frontend/images/howto/` that still show the sidebar: `hub-01-odabir.png`,
  `hub-02-dizajn.png`; the old chrome (☰ toggle, bottom-left mode buttons): `cesta-02-crtanje`,
  `cesta-04-prijedlog`, `park-01..03`, `prikazi-01-3d`, `prikazi-03-realisticno`,
  `reparcelacija-01-odabir` — regenerate with `CAPTURE_HOWTO=1` (not run).

**Bugs found in review and fixed**
- A live language switch left the search box (placeholder, chip title), the command palette, the
  explore banner, an open parcel menu and the Proposals button's aria-label in the old language:
  they listened only to `i18n:translationsLoaded`, which fires once at boot. All now also use
  `i18n.onChange` (the palette re-renders its list when open). Seen in the browser before/after.
- Escape leaked out of the globe: closing it also exited multi-select / closed the details panel,
  and `/`, Ctrl-K and the T/O/P/C hotkeys acted on the map behind it. The globe root now stops
  propagation of every key (it is `aria-modal`). Verified: Esc closes the globe, multi-select stays.
- One Escape closed both an open sheet and the proposal details panel: the details handler now
  ignores an Escape already handled (`defaultPrevented`). Verified in the browser.
- An Escape inside a dialog opened from a sheet (status log, version history) also closed the
  sheet: `MapShell.isBlockingDialogOpen(except)` (any visible `[aria-modal]`, styled confirm,
  `dialog[open]`, non-sheet `[role=dialog]`; not sheets, the parcel menu, docked panels or the
  cross-section editor) now gates the sheet's Escape, and `/` and Ctrl-K, which used to open the
  search/palette underneath a modal or the globe.
- The command palette (z 11000) sat under the proposals list / details / share-plan panels (12000)
  and the drill stack (11900): now 12500 (under the site intro 14500 and confirms 30000). Verified
  over an open details panel.
- Share-plan mode left the search box, the tray, `/` and Ctrl-K live (the sidebar was inert): the
  lockdown rule covers `.map-shell-slot`, and both shortcuts check `window.sharePlanMode`
  (verified by setting the mode by hand — no applied proposal was available to share).
- Opening a server proposal from the search box left focus in the input under the download
  confirm (a second Enter stacked a second confirm) and wrote the download outcome into a list the
  confirm click had closed: the box closes first; progress/failure go to the status line.
- Clicking a greyed palette row, a group title or the footer blurred the input and killed the
  palette's keyboard (and let hotkeys through): mousedown inside the dialog keeps the caret.
- The selection tray stayed live over the 3D canvas, running 2D flows underneath: hidden in
  model/photo view (the selection is kept and the tray returns on exit).
- The tray's count line could push it past its slot on phones (es/hr empty state): it ellipsizes,
  full text in its title.

**Verified in a headed browser** (fresh profile; 1400×900, 375×740, 320×640; `?reduceMotion=1`):
first visit → globe → Zagreb → Open Zagreb → reload, intro modal after, map with parcels; every
sheet (Layers, Tools, Proposals, Game, Activity, Settings incl. Data & maintenance); search: "park"
(commands, 8 proposals, places), "7502/1" → `HR-339164-7502/1` selected, "Ilica 1" → z18 Ilica,
">meas" → Measure; a Zagreb proposal from the search → confirm (focus left the box) → Download →
details panel; palette (Ctrl-K, "clear" grouped, unavailable greyed), palette over the details
panel; parcel menu at the click point → Propose here (panel on Proposals), Select more → tray with
2 parcels and area → Done; 3D enter (search hidden, Layers/Settings bottom-right, sheet controls
locked and greyed) and exit (0 locked left); photo button present in the strip; refresh parcel data
restores its icon + label; live switch to hr (search placeholder, chip, open parcel menu, badge,
sheets) and es (phone sheet, parcel menu peek, tray at 375 and 320); Belgrade (Serbian; blocks,
buildings, roads, area monitor hidden in Layers/Tools and the blocks/roads upkeep in Settings; menu
without Detect block); Ljubljana (buildings/roads/area monitor hidden; parcel menu incl. Detect
block); chip → globe → "Tokyo" → Explore anyway → explore city, phone chip "compass icon + Tokyo" at 375 and
320, Settings shows only Wipe; returning visit → no globe, stored city. No page errors or console
errors at any point. **Not verified**: Shift+click (Phase 3 did), the real share-plan panel (no
applied proposal; mode simulated), photo view itself (Google tiles), geolocation success.

**Judgment calls left open** (not changed)
- Sheets are `role="dialog"`, so `isAnyModalOpen()` treats an open sheet as a modal and silences the
  R/B/T… hotkeys and multi-select Esc while any sheet is open (the sidebar never did). The parcel
  menu avoids the role for that reason; the sheets could too (role `region`/`group`).
- The per-dataset local-storage clears stay debug-mode-only (`.btn-danger` is hidden otherwise), as
  in the sidebar; Wipe ALL is the only always-visible destructive action.
- Areas in the parcel menu and tray use `toLocaleString('hr-HR')` (32.132 m² in English) — the
  app-wide convention (38 call sites), not changed here.
- Enter with nothing highlighted runs the first item (search: "Use my location" on an empty query;
  palette: the first command).
- The parcel menu is clamped to the map container, not to the space left of a docked "At this spot"
  stack, so it can sit partly under it on desktop; on phones a tall stack can cover the menu peek.
- The search list stays open after Tab moves focus out.
- The grain-score view closes the sheets but leaves the rest of the shell interactive (the sidebar
  used to collapse).
- The explore chip/banner keep the first place's name while the visitor pans to another country.
- A search proposal whose city does not resolve opens in the current city (also in explore).
- The proposals list panel (12000) covers the top-right user bubble, Layers and Settings at
  ≤1400px; it is not a `.right-dock-panel`, so the buttons do not step left of it.
- The globe overlay does not make the app behind it inert (its controls stay in the accessibility
  tree).

**Remaining known issues**
- Playwright specs now target the map shell (updated, typechecked, NOT run): selectors for the
  sheets and search box; `sidebar.spec.ts` became `map-shell.spec.ts`; the fixtures seed a stored
  city (`seedCity`, default `new_york`, opt out with `test.use({ seedCity: null })`) so the
  first-visit globe never covers specs that start fresh.
- Pre-existing, not from the rework: ids read by code but absent from the markup (`blockifyButton`,
  `singleBuilding`, `showProposalsCheckbox`, `showBlocks`, `map-dimensions-text`,
  `total-spent-value`); `.share-plan-subtext` never shows (nothing sets `share-plan-disabled`);
  many status lines in road/government-plan code are English-only.
- `!important`: none added in this phase; the rework as a whole removed 27 and moved 6 phone
  touch-target ones from sidebar.css into layout.css.
- `ctx.parcel` (commands.js) recomputes the parcel facts (turf area, owners) per parcel command on
  every palette/search keystroke while a parcel is selected — cheap today, worth caching if slow.

Full suite: 422 files / 5841 tests passed, 2 skipped (1 file skipped).

### Simulation moved into the Activity sheet — built, browser-checked

The in-UI game is now a minor feature (background agents are watched in the activity explorer), so
the bottom-left **Game pill** and the separate **game sheet** are gone.

- **Simulation section** (`.accordion-section[data-section="game"]` with the
  `[data-section-title="game"]` title, "Simulation" / "Simulation (paused)") sits in the Activity
  sheet under the explorer buttons and above the status line: a small play/pause icon button
  (`#game-play-pause-btn`, `aria-pressed`, `.is-running`) and muted `#game-datetime · Turn
  #game-turns`; then a native `<details>` "Simulation settings" holding `#gameCheckbox`, the interval
  slider, the next-turn progress and New Game. The settings body is the gated `.sheet-section-body`
  (greyed while game mode is off); the play row and the summary stay live (Play turns game mode on).
- **Duplicates removed**: `#show-game-log-btn` / `#show-agents-btn` are gone; game.js writes the
  count into `#activity-explorer-button` ("Open activity explorer (N)") and the label into
  `#activity-agents-button`.
- **Running dot**: `#activity-running-dot` on the Activity button, shown only while
  `gameState.isRunning` (`js/ui/simulation-indicator.js`, pure `indicatorFor` + `sync`, called from
  `updateGameUI`); labelled "Simulation running"; no pulse under `prefers-reduced-motion`.
- Commands: the `game` surface is gone; the game commands and the explorer/actors commands
  (`activity.explorer`, `activity.agents`, formerly `game.log`/`game.agents`) are on a new `activity`
  surface and the palette. The explorer commands are group `activity`, so the explore city (which
  hides `game`) keeps them and drops only the simulation. `MapShell.revealControl` opens a folded
  `<details>` around the control. `setLockedFor3D` scopes to `.map-sheet` only.
- i18n: `mapShell.simulation.{title,titlePaused,settings,running,turn}`,
  `mapShell.activityExplorerCount`, palette group `game` → "Simulation"; removed `mapShell.game.*`,
  `sidebar.game.{title,titlePaused,showGameLog,showGameLogCount}`.

**Verified in a headed browser** (1400×900 and 375×740, Zagreb, `?reduceMotion=1`): bottom-left
holds only the scale bar; Activity sheet shows the compact row; play → icon pause, turns advanced
(2 → 3 → 6), dot on the Activity button with the sheet closed; pause → dot gone; settings disclosure
opens; game mode off greys only the settings and titles the section "(paused)"; explorer
("Open activity explorer (55)", 159 events) and Actors open; reduced-motion emulation → dot without
animation; hr labels; explore city (Tokyo) has no simulation section and its palette keeps only the
explorer/actors/status-log commands; 3D lock disables and restores the section; share-plan mode
locks the sheet; no page errors. **Not run**: Playwright (map-shell.spec.ts updated: the Game row
dropped from the sheet table, a new simulation/running-dot test).

Full suite: 428 files (1 skipped) / 5874 tests passed, 2 skipped.

## UI element names

Canonical names for follow-up discussion.

| Name | What / where |
|---|---|
| **search box** (omnibox) | top-left input; result groups Recent searches, Cities, Parcels, Proposals, Places, Commands |
| **city chip** | left end of the search box; current city; opens the world view |
| **explore chip** | the city chip in the explore city ("Explore · Tokyo"; phones: compass + place) |
| **user bubble** | top-right `#username-display` (Guest / wallet, language) |
| **Layers button** / **Layers sheet** | top-right; Parcels, Parcel Blocks, Buildings, Roads toggles |
| **Settings button** / **Settings sheet** | top-right; brand, debug badges, World view, Command palette, Data & maintenance, Information |
| **Data & maintenance** | Settings section: data source, base map, "Stored in this browser" upkeep, Wipe ALL |
| **mode strip** | left edge under the search box: cadastre view, 2D, 3D, photo, AI, walk |
| **Proposals button** / **Proposals sheet** | bottom-right with the count badge; list, plan stats, rooster, minted, share plan |
| **Tools button** / **Tools sheet** | bottom-right; Measurement, Parcel Blocks actions, Stations, Roads, Area Monitor |
| **Activity button** / **Activity sheet** | bottom-right; activity explorer, actors, Simulation section, status line + log |
| **running dot** | small pulsing green dot on the Activity button's corner while the simulation runs ("Simulation running"); no pulse under reduced motion |
| **Simulation section** | Activity sheet, under the explorer buttons: play/pause icon button, date · Turn N; **Simulation settings** disclosure (Enable game mode, interval, next-turn progress, New Game) |
| **status toast** | `#floating-status`, one line above the bottom row |
| **parcel menu** | popover at a parcel click (phones: bottom-sheet peek): Propose here, Select more, Details, History, Tools, Offer my land, View in 3D, Detect block |
| **selection tray** | bottom-centre while multi-select is on: count, area, Propose, Detect block, Clear, Done |
| **command palette** | Ctrl/Cmd-K, or Settings → Command palette |
| **world view** / **globe** | full-screen globe coloured by parcel-data coverage; **globe popup** (Open <city> / Ask for this city / Explore anyway) |
| **explore city** / **explore banner** | `?city=explore`: map without parcels; banner top-centre (Ask for this city, World view, ×) |
| **handoff frame** | the globe's last frame fading over the map after a city reload |
| **"At this spot" stack** | the drill panel (right dock) listing what lies under a click |
| **parcel panel** | right-dock `#parcel-info-panel` (Info / Proposals = build palette / Tools tabs) |
