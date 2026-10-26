<!-- Practical entry point for local development and documentation/media maintenance. -->
# Local development

[Overview](../readme.md) · [Documentation index](README.md) · [Test scope](../TEST.md)

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

See [TEST.md](../TEST.md) for browser fixtures, database-backed checks and their limitations. An entire suite is a separate, potentially expensive run; choose it deliberately rather than treating it as a quick smoke check. Browser fixtures with mocked APIs do not verify production data or live wallet transactions.

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

## Public guides and videos

English `frontend/how-to-use*.html` and Croatian `frontend/kako-koristiti*.html` share `frontend/css/howto.css`. Keep the language pairs, navigation anchors and procedures aligned. The hub links to each relevant walkthrough. Keep domain wording aligned with the [code-grounded vocabulary](../vocabulary.md): distinguish source parcels, formed ground and authored plots; local application from named-plan membership; and observed evidence from legal or physical completion. State units, currencies and valuation bases wherever a money amount appears.

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
