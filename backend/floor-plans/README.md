# Agency floor-plan archive

This pipeline keeps public agency evidence separate from published building architecture. It runs against the existing `geodata` database and creates the `floor_plan` schema as `geo_user`.

The official HGK **broker companies** (`posrednici`) registry is fetched in full, with page counts, stable totals and unique IDs checked before updating the city list. The City of Zagreb filter uses its 68 official settlements, with postal disambiguation for Strmec. The checked snapshot contains 470 city agencies; two ambiguous Strmec records remain in the snapshot's `scope_review`. Registry inclusion is the recorded fact; the API does not provide a separate active-license flag. This is registered-seat coverage, not every agency selling property in the city.

## Run locally

Commands below run from the repository root. The CLI loads `backend/.env`; `PGHOST=localhost` selects the existing laptop PostgreSQL instance. It does not create another database.

```sh
npm install --prefix backend
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs init
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs import --registry data/floor-plan-agencies/registry.json --websites data/floor-plan-agencies/verified-websites.json
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs sites --file data/floor-plan-agencies/candidate-websites.json
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs websites --file data/floor-plan-agencies/website-discovery.json
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs daily --max-pages 10000 --max-minutes 180 --max-assets 2000
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs status
```

Long runs should use the installed `run-job` helper or an equivalent persistent process runner. `daily` refreshes the registry, crawls due URLs, extracts pending source files, and proposes building candidates. Every source is checkpointed. Session advisory locks prevent duplicate crawls, extractors and daily runs. Limits, blocked requests and item failures return status `partial` and exit code 2; failed fetches never erase archived evidence or prove a listing was removed.

The active **Daily agency floor-plan refresh** Codex automation runs at 06:00 in the app's local schedule. It checks this worktree and actual output rows, avoids duplicate backfills, and reports meaningful changes or new failures. This is a local task, not a deployed server cron. The production Telegram bot monitor has no access to this laptop database; its outcome check needs a deployed or synchronized output before server deployment.

## Data and review gates

- `agency` retains the registry record and verified website identity; `website_candidate` records unverified search leads separately. `site` includes additional directory-linked sites. A website is verified with its visible legal name and exact OIB, or an explicitly reviewed name/address match. Unresolved does not mean no website exists.
- `target` is the due queue. Home pages, public sitemaps, project/listing/pagination/contact links, labeled plans, PDFs, and unlabeled listing gallery images are discovered. New-build wording is retained; resale is included too. Zagreb URLs receive priority.
- `blob` stores immutable bytes by SHA-256; `observation` connects URLs, page evidence and runs. HTTP validators reduce page downloads. Assets are fetched fresh so a changed drawing at an unchanged URL is detected. Robots rules, DNS/private-address checks, bounded downloads and host serialization apply. Access blocks remain explicit gaps.
- `listing` stores source claims. Asset discovery spans the page, while `listingOwned` limits apartment associations to the matching property card or project-table row. Main Eurovilla plan buttons are retained as public download endpoints; access rules still apply. Property coordinates only produce candidates within 100 m, never a verified building assignment. Agency footer coordinates are excluded. Explicit reviewed project/unit evidence can link a unit to an authored building identity.
- `extraction` stores OCR/PDF text, normalized source linework and screening evidence. Generic drafts are **not architectural models**: they can include furniture, dimensions and annotations and have no metric scale or placement. PDFs are bounded at 30 pages, with truncation recorded. `model_revision` retains every draft or reviewed unit revision.
- Reviewed Avenue V unit models use `consensus-builder.floor-architecture.v1`. Import requires the exact source hash already archived at the declared URL. They are available for local 2D/3D review and are not published to `consensus.building_floor_model` while global placement is unresolved.

The generic HTML parser does not execute client-side application code. Sites whose listings or plans exist only behind JavaScript APIs need an evidence-backed adapter. It also cannot discover unpublished, sold-only, gated or deliberately inaccessible plans. Never treat the crawl as complete citywide floor coverage.

## Extraction runtime

`extract-floor-plan-draft.py` requires Python 3 with OpenCV, NumPy and Pillow, plus `tesseract`, `pdfinfo`, `pdftotext` and `pdftoppm` on PATH. `FLOOR_PLAN_PYTHON` selects a configured Python runtime. The local verified runtime uses OpenCV 5.0.0, NumPy 2.5.2 and Pillow 12.1.1. No paid model APIs are used.

```sh
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs extract --max-assets 500
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs match
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs verify-sites
# Stop the active crawl before rebuilding current associations after a parser correction.
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs reparse
```

## Review and verification

`frontend/floor-plan-archive.html` separates **Buildings & floor plans** and **Agencies** into tabs. The building selector includes every current registered building floor model, Avenue V apartment models, and a searchable collection of all current archived source files. Plans can be selected directly or browsed with Previous/Next; each shows its original drawing, available 2D/3D reconstruction, room schedule and source conflicts. Registered models show a stack of the reconstructed floors; Avenue V shows its authored exterior mesh. Maps use registered or authored building footprints. The archive does not turn nearby building candidates or source-page links into verified building associations.

The read-only API provides `/floor-plan-archive/catalogue`, `/building/:id`, `/building/avenue-v/mesh`, and `/source/:sha256` alongside the status, agency and asset routes. Catalogue responses contain compact metadata; geometry loads when a building or source is selected. Three.js renders only on interaction or resize and disposes previews when switching buildings. Original registered PDFs load from their public source URLs; agency source files load from the local archive. Missing geometry and unresolved locations remain explicit.

`?backend=...` selects the API; `building=registered-1&plan=B1-floor-0` selects a registered plan, `building=archive&plan=<sha256>` selects a source, and `tab=agencies` opens the agency review. English, Croatian, Spanish and Serbian labels are supported through `lang`. The production API route is registered in `backend/index.js`; `scripts/floor-plan-review-server.mjs --port PORT` is a local read-only preview server.

```sh
cd backend
npx vitest run test/floor-plan-*.test.js test/building-floor-plans.test.js test/three-floor-plans.test.js
python3 test/test_floor_plan_draft.py
```

The `reparse` command checkpoints each listing and is idempotent. It preserves raw bytes, observations and model revisions, marks former catalog/card false positives as `not-a-listing`, and withdraws unsupported building links while retaining their previous evidence.

Archive data and authoring manifests are idempotent. Re-importing unchanged Avenue V unit models must return `changed: false`. Browser inspection covers source image loading, real 3D geometry, unit switching, the unknown-floor conflict and a 390 px viewport.
