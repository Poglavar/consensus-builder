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

## Verify a change

Run the headless unit test files for the behavior you changed. For the public guide contracts:

```sh
cd backend
npx vitest run test/product-guides.test.js
```

See [TEST.md](../TEST.md) for browser fixtures, database-backed checks and their limitations. An entire suite is a separate, potentially expensive run; choose it deliberately rather than treating it as a quick smoke check. Browser fixtures with mocked APIs do not verify production data or live wallet transactions.

## Public guides and videos

English `frontend/how-to-use*.html` and Croatian `frontend/kako-koristiti*.html` share `frontend/css/howto.css`. Keep the language pairs, navigation anchors and procedures aligned. The hub links to each relevant walkthrough.

The deployed guide sources and [current packaged media](https://github.com/Poglavar/consensus-builder/tree/colosseum-worlds-fair/frontend/videos/howto/2026-10-19) are maintained on the protocol branch. That media directory contains MP4, poster, WebVTT/SRT captions, transcript and a manifest. Players load on demand, expose fullscreen controls and include a readable transcript. Raw captures and browser state remain outside the public frontend. Videos are demonstrations of a recorded UI version; re-record them when that workflow materially changes.

## Deployment

Use the intended branch’s `frontend/deploy-frontend.sh` after committing and pushing the reviewed changes. The protocol branch supports a `BRANCH` override; inspect the entrypoint before running it. A normal frontend deploy builds and mirrors a complete release. A documentation-only publication must include its CSS and media before swapping HTML, and the committed files must also reach the production branch so a later release preserves them.

Verify the served HTML, captions, media content types and byte-range playback after publication. A successful upload alone does not establish that the CDN serves the new files.
