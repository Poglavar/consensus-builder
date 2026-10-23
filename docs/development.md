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

## Public guides and videos

English `frontend/how-to-use*.html` and Croatian `frontend/kako-koristiti*.html` share `frontend/css/howto.css`. Keep the language pairs, navigation anchors and procedures aligned. The hub links to each relevant walkthrough. Keep domain wording aligned with the [code-grounded vocabulary](../vocabulary.md): distinguish source parcels, formed ground and authored plots; local application from named-plan membership; and observed evidence from legal or physical completion. State units, currencies and valuation bases wherever a money amount appears.

The deployed guide sources and [current packaged media](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair/frontend/videos/howto/2026-10-19) are maintained on the protocol branch. That media directory contains MP4, poster, WebVTT/SRT captions, transcript and a manifest. Players load on demand, expose fullscreen controls and include a readable transcript. Raw captures and browser state remain outside the public frontend. Videos are demonstrations of a recorded UI version; re-record them when that workflow materially changes.

## Deployment

Use the intended branch’s `frontend/deploy-frontend.sh` after committing and pushing the reviewed changes. The protocol branch supports a `BRANCH` override; inspect the entrypoint before running it. A normal frontend deploy builds and mirrors a complete release. A documentation-only publication must include its CSS and media before swapping HTML, and the committed files must also reach the production branch so a later release preserves them.

Verify the served HTML, captions, media content types and byte-range playback after publication. A successful upload alone does not establish that the CDN serves the new files.


## Verified local preview links

Before sharing a preview, check the listening checkout, the browser's `getBackendBase()` and a
real parcel/building data response. A static page loading successfully is not an API readiness
check. Local pages normally target port 3000; when no local API is running, supply the supported
`backend` query override explicitly (for example, the production API for read-only source data).
Production read access does not establish write access: the production origin guard rejects uploads
from localhost. For model uploads and authoring, use this checkout’s local development API and verify
a real upload returns a retrievable model URL, plus complete building stock for land-take review.
A link without a city retains the browser's saved city. Do not change cities just to conceal a
source failure, and do not describe a mocked browser check as proof of live source availability.
