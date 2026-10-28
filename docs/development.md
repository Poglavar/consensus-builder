<!-- Practical entry point for local development and documentation/media maintenance. -->
# Local development

[Overview](../readme.md) · [Documentation index](README.md) · [Test scope](TEST.md)

## Choose the code you need

Use `main` for its maintained application line. The [colosseum-worlds-fair branch](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair) contains the protocol, prediction-market and agent build. Check your branch before reproducing a live UI issue; public guides describe the deployed app.

## Run the map and API

Install Node.js, npm and the `serve` CLI used by `dev.sh`. Install the backend dependencies:

```sh
cd backend
npm ci
```

Configure the ignored `backend/.env` for the existing PostgreSQL/PostGIS installation and required datasets. Use one `DATABASE_URL` connection URL pointing at the shared `geodata` database and the appropriate application role. Keep credentials out of source control. Optional imagery, chain and AI integrations require their own configuration.

From the repository root:

```sh
./dev.sh
```

The launcher starts this checkout’s frontend and API on available local ports and prints the URL. Stop it with Ctrl-C. The map is plain HTML, CSS and JavaScript; its data-dependent flows still require a working API and datasets.

## Languages and translation loading

`frontend/i18n/<language>.json` is the only source of translated UI copy, including feature,
feedback, privacy, report and language-switcher strings. Keep language names and locale metadata
in `LOCALE_CHOICES` in `frontend/js/i18n.js`; the first locale for a language is its default.
The map picker and satellite-page selects use this registry. Mark a satellite select with
`data-i18n-locale-select="locale"` (regional preferences) or `"language"` (one option per language).

`i18n-loader.js` loads English as a fallback and the selected language at startup. A switch loads
only that language. `i18n.loadLanguage(language)` shares in-flight and successful requests; failures
are reported and may be retried. All requests use one build token per page. Features must use this
loader rather than fetch or register their own dictionaries. Wait for `i18n.translationsReady`
before initial rendering; generated content should also listen for `i18n:translationsLoaded`.
That event follows dictionary registration and DOM translation, including on a language switch.
Locale-picker buttons use `BusyControl.track` while the dictionary loads.

To add a language, add its locale metadata and dictionary, and extend `PlanRecord`’s saved-view
language set. The parity test checks that the supported UI and saved-plan languages agree. Then run
the targeted headless unit checks below. Keep interpolation names identical (`{name}` and
`{{name}}` are both supported).
Plural entries use CLDR categories (`zero`, `one`, `two`, `few`, `many`, `other`) under the key;
`count` selects the form through `Intl.PluralRules`. The selected dictionary is exhausted before
English is considered, and English fallback uses English plural rules. Arabic uses `ar-EG` with
right-to-left reading; French defaults to `fr-FR` and Portuguese to `pt-PT`. Registry metadata supplies document direction and resets it on a language switch. Native
names remain visible in every locale picker. Arabic quantities define all six CLDR forms. Map
geometry and technical addresses keep left-to-right direction; interface copy follows the locale.
For additional right-to-left languages, declare `direction: 'rtl'` and verify both desktop and phone
layouts, including a switch back to a left-to-right language.

```sh
cd backend
npx vitest run --maxWorkers=1 test/i18n-loader.test.js test/i18n-infrastructure.test.js test/i18n-locale.test.js test/i18n-locale-coverage.test.js test/building-count-plurals.test.js
```

These checks cover lazy requests, deduplication, retries, stale completions, dictionary shape,
duplicate keys, placeholders, coverage, plural forms and accidental inline multilingual tables.
Locale preferences add no new MCP operation. A saved plan can carry any supported UI language;
`PlanRecord` validates that language and supplies the MCP saved-view input schema and discovered
plan JSON Schema. `plan-record-schema.test.js` verifies registry parity and drafts plans in the new
languages through the real in-process MCP transport. Release the API and MCP service with this
shared-validator change before publishing the frontend, so saved plans in the new languages are
accepted throughout the write path. No database migration is needed.

## Private feedback inbox and Telegram

The web form at `/feedback.html` and MCP `ugt_submit_feedback` store reports in the same private
`consensus.feedback` inbox. Read it with the backend's database environment:

```sh
cd backend
node --env-file=.env scripts/feedback-inbox.mjs --list --limit 20
node --env-file=.env scripts/feedback-inbox.mjs --id RECEIPT_UUID
```

The API sends notifications through the existing `TELEGRAM_ACTIVITY_BOT_TOKEN`,
`TELEGRAM_ACTIVITY_CHAT_ID` and `TELEGRAM_ACTIVITY_THREAD_ID` configuration. Set these secrets in
the backend's ignored environment on the API host. Reports include their receipt, source, text
excerpt and optional page URL; link previews are disabled. Full text remains in the private inbox.
There is no public inbox endpoint.

Apply `backend/routes/feedback-ddl.sql` before starting the updated API; `deploy-backend.sh` includes
this step. The API owns delivery, with no extra cron job: it checks pending reports at startup,
after submissions and every minute, processing up to five per check. A failed attempt becomes
eligible again after five minutes. Missing Telegram configuration leaves reports pending.
`telegram_notified_at`, `telegram_attempted_at` and `telegram_attempts` in the inbox CLI show delivery
state. Identical submission retries do not resend a confirmed notification. Telegram and the
database do not share a transaction: a lost Telegram receipt or crash before saving success can
cause another delivery. The receipt ID identifies such duplicates. Test-mode API processes never
send notifications.

## Verify a change

Run the headless unit test files for the behavior you changed. For the public guide contracts:

```sh
cd backend
npx vitest run test/product-guides.test.js
```

See [TEST.md](TEST.md) for browser fixtures, database-backed checks and their limitations. An entire suite is a separate, potentially expensive run; choose it deliberately rather than treating it as a quick smoke check. Browser fixtures with mocked APIs do not verify production data or live wallet transactions.

### MCP parity check

Every change to human editing includes this check, even when no MCP code change is needed:

- Identify the authored records and operations changed by the site editor. Confirm that an agent
  can inspect the relevant state and make the equivalent edits using existing granular tools.
- Reuse shared generators and validators. If existing primitives cannot express the operation,
  expose it through MCP and update the affected input/output schemas, discovery and editing docs
  in the same change. Preserve coupled fields, revision identity and confirmation requirements.
- Verify the affected MCP path with a targeted headless check or an existing relevant test, and
  report the evidence. If no MCP change is required, state which shared code or existing operation
  provides parity. A successful browser edit alone does not establish MCP parity.
- When releasing, include the MCP service deployment/restart if its code or imported shared modules
  changed, then verify discovery and the affected operation against that release. Update directory
  copy and packaged plugin instructions when their claims change; the endpoint normally stays the
  same. Release authorization remains separate from this checklist.

See [MCP editing](mcp-editing.md) for supported primitives and authored-field boundaries.

### Space models and GeoJSON corridor import: MCP parity (2026-10-28)

Parks, squares and lakes can carry an uploaded GLB (`/structureProposal/modelUrl`, `modelName`,
`rotation`, `source: 'upload'`), and roads/tracks import GeoJSON centrelines. MCP parity:
`ugt_import_model` gained `kind` (`building`, `park`, `square`, `lake`); a space is drafted by
`ugt_draft_space`'s builder from the model's placed projected footprint, and the model fields are
set on its structure. `ugt_import_design` now declares the `kind`/`spaceKind`, `description`,
`author`, `authoredAt` and `toleranceM` fields its implementation already read, so GeoJSON polygons
can become a park, square or lake; GeoJSON LineString/MultiLineString centrelines go through the
site's own `parseGeoJson` and the OSM import's `recordsFromImport`, so site and MCP road imports are
identical by construction (properties such as `name`, `width`, `highway`, `lanes` and `railway` are
OSM way tags). `ugt_inspect_design` and `ugt_edit_design` read and patch the model
fields without an allow-list change. Output contract, discovery features and
[MCP editing](mcp-editing.md) were updated. Verified by headless unit tests
`backend/test/mcp-assets.test.js` (park model import, inspect and patch; space and corridor GeoJSON
import, byte-compared with the site's GeoJSON road records; strict schema kinds), with `mcp-discovery`, `mcp-server` and `mcp-agent-boundary` tests passing.

### Furniture models and lamps: MCP parity (2026-10-28)

Parks and squares can assign one uploaded GLB per furniture kind
(`/structureProposal/decorationDesign/models/<kind>` = `{url, name}`) and carry `lamps`
(`[{coordinate, bearing}]`). MCP parity: `ugt_import_model` gained `kind: 'furniture'`, which checks
the asset with the site's `FurnitureModels.validateModelSummary` (triangles from the shared
visible-triangle walk, texture sizes from embedded PNG/JPEG headers, decoded bytes), uploads it
through `/models` and returns only the asset; codes are `furniture-triangles`, `furniture-texture`,
`furniture-bytes` and `furniture-empty`. `ugt_edit_design` (and `ugt_edit_plan` edits, which share
`editedDesign`) normalize `models`, `lamps` and `stalls` (`{coordinate, bearing, color?}`, on parks
and squares) with `FurnitureModels.normalizeModels`, `normalizeLamps` and `normalizeStalls` and refuse a kind the structure does not offer (`furniture-kind-not-allowed`).
`ugt_draft_space` takes no furniture input, so furniture is authored by patch. Input/output schemas,
discovery (`imports.furnitureKinds`/`furnitureLimits`, `public-spaces.furnitureKinds`) and
[MCP editing](mcp-editing.md) were updated. Verified by headless unit tests
`backend/test/mcp-assets.test.js` (upload, limits, upload-then-patch of a drafted park) and
`backend/test/mcp-edit.test.js` (normalization and refused kinds), each confirmed red with its
check removed, with `mcp-discovery` and `mcp-agent-boundary` passing.

### Tree height steps and pavement trees: MCP parity (2026-10-28)

The park and square editors' tree card (Shorter / Taller in 1 m steps within the kind's range, New
look) and the square editor's Pavement tree tool write the same tree record an agent patches:
`heightM`, and on squares `pit` (`grille`, `grass` or `soil`). No MCP tool was added:
`ugt_edit_design` patches `/structureProposal/decorationDesign/trees/<i>/heightM` and `/pit`; the
shared `intentEditing` validation refuses an unknown pit and an out-of-range height (`invalid-tree`),
and a pit on green ground: parks and green building surroundings (paved surroundings open the square
editor, so they take pavement trees like squares; switching the treatment in the site clears the
surroundings design). Verified by headless unit tests
`backend/test/mcp-edit.test.js` (height, pit, refused pit and park pit; each check confirmed red with
it removed), `backend/test/park-planting.test.js` and `backend/test/frontend-structure-edit-history.test.js`.

## Lists and authoring boundaries

The **Lists panel** contains **Designs**, **Plans**, and **Agreements** tabs. One **Source and filters**
section preserves the browser/published scope, search, publication filter, and ordering across tabs.
The shared body supplies the inset for every tab. Plan-file import and imported-plan controls live
in Plans. The file format remains a plan, even with a single member; this presentation change
adds no authored fields or MCP editing operations. Record icons and subtle tints follow their type,
while action buttons retain accessible names and shared busy controls.
Search operates on loaded rows; published plans and agreements expose Load more. Designs retain
an explicit 1,000-row limit. Rows open their details in the click stack, which highlights their
geometry without applying a plan. Sharing uses each record's existing publication flow.

**Create plan** in Designs starts **Plan selection**: check designs, then Continue to the
**Plan composer** with those exact members selected. Saving opens the exact saved plan in the
current view's expanded Plan click-stack section. The composer chooses a name, member revisions
and saved view and writes only local storage. **Add to plan** opens a new composition or a reviewed
revision. A plan row offers **Create agreement** with that exact plan as its subject. Draft agreements
are reviewed and proposed in agreement details before their public link can be shared.

**Plan stats** and **Urban rooster** belong to each saved plan row. For Plan stats, `PlanAnalysis`
resolves exact members, obtains their source bindings and source parcels, and calls
`AgreementHeadless.materialize` with private fabric, ownership and storage ports; it does not read
or change the displayed composition, unapplied members count, unrelated applied designs do not.
Plan stats stays unapplied on purpose (user ruling 2026-10-28): plans that cannot stand on the map
together must still be comparable. A member this device holds a copy of is replayed on that copy's
own `cadastreParcelIds`, as applying it would; only members held nowhere here use the server
binding, which for an unpublished design can name fewer parcels than its pieces stand on.
**Compare plans** (Lists → Plans) adds checkboxes; **Compare** measures each chosen plan that way at
the default assumptions (`comparePlanStats` in `plan-stats.js`) and shows one table whose **Swap
rows and columns** turns between plans as columns and plans as rows. A plan that cannot be measured
keeps its place with the reason. The figures are Plan stats' own (`summaryTexts`), including
**Plan area**: every parcel the plan stands on, once, plus its open ground.
`proposals/present-state.js` (user decisions 2026-10-28) adds the ground: **Public land** is road
parcels, OpenStreetMap parks and squares (our server's Overpass chain via
`GET /osm-public-spaces` first, public Overpass from the browser when it cannot answer; user
decision 2026-10-28) and design pieces that are corridors, parks, squares or lakes; **Private land** is the rest
of the parcels. Each plan counts the existing buildings its designs do not clear (`/buildings/under`
over its parcels, demolition ground from `__demolitionPrefetch.collectDemolitionRegions` plus its
corridor pieces) beside its new ones, as **of which existing that remain** and **of which new**.
The first column, **Present state**, measures what stands today on the land chosen in **Present
state over the land of** (all compared plans, one of them, or another saved plan). Plan stats
shows the same land and building figures once they are read, after its other figures.
The rooster scores the plan as it stands on the map (user ruling 2026-10-28): every member must be
applied, and `GrainScoreRules.appliedPlanGround` reads the members' pieces and ground from the
live fabric and the cadastral repository, with no binding and no headless replay. An unapplied
member is refused with the "apply every design" message. The rooster retains its colored portrait.
The old map-wide statistics button and `?planStats=1` applied-composition follower are removed.
No authored contract changes or new MCP editing operations are needed; MCP ground inspection uses
`AgreementHeadless.derive` over the same formation handlers. Targeted tests check the shared host,
exact-member/source resolution and unchanged map state while inspecting an unapplied plan member.

Record removal belongs only to Lists. **Remove from browser** confirms and removes the local copy;
published links remain available. Removing a plan deletes its library entry, not its members or any
agreement's embedded plan reference. Membership inspection can still follow that reference.
The stored-plan list deliberately excludes plans inferred only from an agreement. The Share plan
dialog publishes or copies one saved revision and never edits membership.

`PlanComposition` carries canonical member content alongside the immutable `plan/v1` content so
later local design edits cannot change a saved plan. `PlanWorkspace` resolves and publishes those
exact revisions. The public plan format and publication policy are unchanged. Presentation uses
shared `CbDialog`, `BusyControl`, `btn` and `cb-actions` categories; `css/plan-dialog.css` and `css/lists.css` supply
layout and reads the shared theme roles from `css/primitives.css`.

MCP parity uses existing `ugt_draft_plan`, `ugt_inspect_plan`, `ugt_edit_plan` and `ugt_publish_plan`
operations, with the same `PlanRecord` validator and immutable member content. Adding a design is
an `ugt_edit_plan` add operation against the inspected CID; it returns a new private revision.
No new MCP editing tool or schema is needed: list removal changes browser storage only, not a
published record or authored membership. Lists adds no new authored fields. Targeted
`mcp-named-plans.test.js`, `plan-composition.test.js` and `plan-workspace.test.js` cover independent
creation, membership edits, old-revision isolation and exact dependency publication.

### Lists verification (2026-10-27)

- Six targeted headless unit files: 102/103 initially passed; the locale failure was an explicit-key
  requirement. Its 22 checks passed after correction. The Lists file gained a fourth check for command
  registration and browser-only deletion; all four passed. The plan-workspace file gained a fifth
  check for retaining confirmed publication on an existing local snapshot. Named-plan MCP operations
  passed in the initial targeted run.
- Five targeted headless Playwright scenarios: the three existing plan-sharing scenarios passed.
  Lists desktop initially used a stale selector; mobile hit a startup timeout. The two-scenario rerun
  passed desktop; mobile then attempted the intentionally clipped desktop close control. Using keyboard
  dismissal, its one-scenario rerun passed. Both viewport flows cover creation, inspection and removal.
- Two additional headless UI files: 49/55 checks passed. The new Agreements command was registered
  after this check. Remaining failures concern existing track-icon assumptions, the economic-settings
  command, and agreement-editor style baselines. The global control inventory also has unrelated drift;
  the Lists factory, changed tab controls and retired list controls have current contract entries.
- Manual headed browser: desktop and 390px mobile, translated controls, no horizontal overflow,
  real published plan and parcel reads, and a published plan opened in the click stack and saved locally.


### List polish and plan analysis verification (2026-10-27)

- Headless Playwright, `lists.spec.ts` (two viewport scenarios): the first spacing run had one
  startup timeout and one pass; the next passed both after fixing hidden-tab CSS precedence.
- Headless unit tests, three stats/render/wiring files: 35 passed. Three analysis/formation files:
  15 passed and two large fixtures exceeded the default five-second deadline. Rerunning the affected
  `mcp-ground.test.js` with a 60-second deadline passed all 10 tests.
- Headless Playwright, Lists, Plan stats and rooster interaction (five scenarios): initially three
  passed; mobile used a hidden close control and composition used a retired selector. The rerun
  passed four; the extended plan-isolation scenario exhausted its 30-second setup/test budget.
  The final run of Plan stats and design-list layout passed all three scenarios. Across these final
  runs, seven distinct scenarios pass, including unchanged map state while an unapplied saved
  building is measured beside an unrelated applied park. No run was stopped; no full suite ran.
- Headless unit tests, six targeted files: 85/88 passed. The three existing command-registry failures
  concern the custom track icon and unregistered economic-settings control. After removing obsolete
  timer scaffolding, the Plan stats rendering file passed all 14 checks again.
- Static control inventory still reports unrelated drift in other screens. The retired map-wide
  buttons were removed from the command/coverage contracts, and plan-row and import actions were
  registered. Other browser specs referencing the moved actions now use the shared plan-row helper;
  those whole specs were not rerun.
- Manual headed browser: desktop and 390px mobile; real plan binding and source parcel reads;
  named statistics and completed rooster score; unchanged designs, live parcels and ownership.
  The dedicated verification browser was closed. Source syntax and whitespace checks passed.

## Parcel layout handle presentation

On screens with a fine pointer and hover, parcel-layout nodes, midpoint insertion handles and
the rotation handle appear on hover or while dragging. Their hit areas stay active; boundary
segments retain their hover highlight. Screens without hover keep visible handles. This is a CSS-only
presentation change: authored geometry, editing gestures and validation are unchanged, so the
existing MCP `ugt_edit_design` geometry operations provide parity without a tool or schema change.

### Retest fixes (2026-10-28)

From the proposal creation and editing retest of `5b608d071`:
- **Refusals keep their reason.** An editor that will not open throws an `editor-refused` error
  (`parcel-layout.js` `refuseOpen`); the design shell shows its message, and only an editor that
  gives no reason gets "This design editor is unavailable." A layout over ground a Park holds now
  names the Park.
- **1,000-plot imports finish.** `carveLayout` differences only the plots whose box meets the carved
  piece, and a GeoJSON import checks the tiling once for the whole file instead of after every
  polygon. Headless: 1,000 grid plots carve in about 1.2 s instead of 6 s, and the import no longer
  multiplies a 0.1 s check by 1,000.
- **Drawing a site goes through map shapes.** While the site tool draws, `site-tool.css` turns off
  pointer events on every interactive map shape outside the tool's own pane, so a selected block's
  polygon no longer swallows its corners.
- **Block info takes the dock** from a standalone design details panel, as it does from the parcel
  panel; a panel the click stack hosts stays.
- **An untouched station editor closes without asking** (`stationDiffers` in
  `transit-stations.js`).

MCP parity: no change. These are editor presentation and performance fixes; the authored records
and their validation are unchanged.

## Public guides and videos

English `frontend/how-to-use*.html` and Croatian `frontend/kako-koristiti*.html` share `frontend/css/howto.css`. Keep the language pairs, navigation anchors and procedures aligned. The hub links to each relevant walkthrough. Keep domain wording aligned with the [code-grounded vocabulary](vocabulary.md): distinguish source parcels, formed ground and authored plots; local application from named-plan membership; and observed evidence from legal or physical completion. State units, currencies and valuation bases wherever a money amount appears.

The deployed guide sources and [current packaged media](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair/frontend/videos/howto/2026-10-19) are maintained on the protocol branch. That media directory contains MP4, poster, WebVTT/SRT captions, transcript and a manifest. Players load on demand, expose fullscreen controls and include a readable transcript. Raw captures and browser state remain outside the public frontend. Videos are demonstrations of a recorded UI version; re-record them when that workflow materially changes.

## Deployment

Use the intended branch’s `frontend/deploy-frontend.sh` after committing and pushing the reviewed changes. The protocol branch supports a `BRANCH` override; inspect the entrypoint before running it. A normal frontend deploy builds and mirrors a complete release. A documentation-only publication must include its CSS and media before swapping HTML, and the committed files must also reach the production branch so a later release preserves them.

Verify the served HTML, captions, media content types and byte-range playback after publication. A successful upload alone does not establish that the CDN serves the new files.


## Verified local preview links

Every localhost preview link shared with the user must explicitly include `backend`, `city` and
the intended location (`at`, plus camera/selection when relevant). This applies even when a local
API is running. Local pages normally target port 3000 and can retain `cb_dev_backend_base` and a
city in browser storage; a link must work independently of those saved settings.

Before sharing a preview, check the listening checkout, the browser's `getBackendBase()` and a
real parcel/building data response. A static page loading successfully or a backend health check
is not a source-data readiness check. Use a verified local API for local backend changes; the
production API can supply read-only source data. Copy the complete tested URL into the final
answer and check that its backend parameter survived: do not manually shorten the URL afterward.
Production read access does not establish write access: the production origin guard rejects uploads
from localhost. For model uploads and authoring, use this checkout’s local development API and verify
a real upload returns a retrievable model URL, plus complete building stock for land-take review.
A link without a city retains the browser's saved city. Do not change cities just to conceal a
source failure, and do not describe a mocked browser check as proof of live source availability.

### Bare-ground menu presentation (2026-10-27)

The first action reads **Draw a parcel**; its existing drawing operation is unchanged. It spans
both columns above three equal-width pairs of transport actions. Bare-ground copy reads
“Unsurveyed ground or a gap between parcels.” in all seven locales. This is copy/layout only:
MCP authoring primitives and schemas are unchanged, so no MCP editing change is required.
Verification: 11 headless unit checks in `frontend-ground-menu.test.js` and one targeted headless
Playwright scenario in `world-and-ground.spec.ts` passed, including both 1280px and 390px button
geometry and drawing/cancellation. Manual headed inspection used a bare-ground fixture at desktop
and mobile widths; the dedicated browser was closed. No full suite ran.

### Refreshing and closing the editor (2026-10-27)

There is no blanket native leave-page warning for unpublished designs. Publication is separate
from saving: designs persist automatically in the browser workspace, editor drafts persist as
edited, and saved plans and agreements remain in that workspace. Existing draft-flush and cleanup
handlers still run on exit. Unfinished SiteTool drawings and unsubmitted plan/agreement forms are
transient; removing the publication-based guard does not add autosave to those forms.
This changes navigation presentation only; authored editing and MCP primitives are unchanged.
Verification: two targeted headless Playwright scenarios in `proposal-shell-controls.spec.ts`
passed, covering draft autosave and an unpublished design plus edited draft surviving refresh,
closing with unload handlers enabled, and reopening without a leave-page prompt. No full suite ran.

### Station placement and building inspection

The transport palette groups station creation into Road station and Track station. The latter
chooses Ground level, Elevated station or Underground before starting the existing map placement
tool; Cancel and Escape create nothing. Existing station geometry editors do not change levels.
MCP parity uses `ugt_draft_station` with the same canonical `stationType` values (`bus`, `tram`,
`elevated`, `underground`) and shared footprint/attachment validation. No new authored fields or
MCP operations are introduced. The station-tool schema descriptions and discovery metadata explain
the Road/Track grouping and canonical level mapping. `mcp-constructors.test.js` verifies the existing
creation path and `mcp-discovery.test.js` verifies that mapping.

Observed-building inspection has one UI owner: the Built section of the click stack. Public
inspection and restored selections enter that section in either map view. The planning inspector
is shared rendered content, kept hidden when an observed-building record is not hosted.
These read-only presentation changes do not change MCP source-data inspection.
