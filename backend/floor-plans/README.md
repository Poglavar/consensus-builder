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
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs daily --max-pages 10000 --max-minutes 180 --max-assets 100 --ai-budget-usd 5 --ai-chunk-size 1
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs status
```

Long runs should use the installed `run-job` helper or an equivalent persistent process runner. `daily` refreshes the registry, seeds every known non-social agency website, discovers projects and listings, resolves building identity, downloads matched listings' assets, screens drawings, and collects/submits a bounded vision batch. It saves metric vector geometry and then attempts registration of eligible complete floors. Every source and task is checkpointed. Session advisory locks prevent duplicate crawls, extractors, vision workers and daily runs. Limits, blocked requests and item failures remain explicit; failed fetches never erase archived evidence or prove a listing was removed.

The production PM2 definition schedules 06:00 UTC once daily, without immediate restarts after failures. A file in Git does not enable that schedule: follow [`deployment.md`](deployment.md), including the outcome monitor and verification of the actual PM2 process. The older laptop automation is separate; retire it when production takes over to avoid two independent paid processing queues.

The first configuration submits **one page per daily run**, with a $5 UTC-day ceiling, until a larger chunk is approved. This intentionally queues a backfill rather than charging for it all at once. Batch processing is asynchronous: a normal run collects the previous completed batch and submits at most one new chunk. A pending batch is not a failure; a batch still pending after 26 hours is reported. `interpret --no-ai` collects without new submissions. `daily --no-ai` still discovers, screens, queues and collects existing work, but does not submit paid requests.

## Data and review gates

- `agency` retains the registry record and verified website identity; `website_candidate` records unverified search leads separately. `site` includes additional directory-linked sites. A website is verified with its visible legal name and exact OIB, or an explicitly reviewed name/address match. Unresolved does not mean no website exists.
- `target` is the due queue. Home pages, public sitemaps, project/listing/pagination/contact links, labeled plans, PDFs, and unlabeled listing gallery images are discovered. New-build wording is retained; resale is included too. Zagreb URLs receive priority.
- `blob` stores immutable bytes by SHA-256; `observation` connects URLs, page evidence and runs. HTTP validators reduce page downloads. Assets are fetched fresh so a changed drawing at an unchanged URL is detected. Robots rules, DNS/private-address checks, bounded downloads and host serialization apply. Access blocks remain explicit gaps.
- `listing` stores source claims. `listingOwned` limits apartment associations to the matching property card or project-table row and excludes footer, agent and legal artifacts. Main Eurovilla plan buttons remain public download endpoints; access rules still apply. Reviewed source manifests can also supply ownership, but only when listing identity, archived source URL and exact source hash agree. Property coordinates only produce candidates within 100 m. Automatic identity requires an unambiguous reviewed listing/project binding, or an exact street and house number corroborated by source coordinates and a cadastral/survey match with >=90% overlap in both directions. Postcode-only strings and proximity alone never verify a building.
- `extraction` stores OCR/PDF text, normalized source linework and screening evidence. Generic drafts are **not architectural models**: they can include furniture, dimensions and annotations and have no metric scale or placement. PDFs are bounded at 30 pages, with truncation recorded. `model_revision` retains every draft or reviewed unit revision.
- Reviewed Avenue V unit models use `consensus-builder.floor-architecture.v1`. Import requires the exact source hash already archived at the declared URL. They are available for local 2D/3D review and are not published to `consensus.building_floor_model` while global placement is unresolved.
- `plan_task` identifies source hash + page + processor + building/fact context. A replaced source or changed association requires a new task. The vision reader receives only the public page image and published floor/unit/area facts. Building IDs, footprints and coordinates stay in the application. It distinguishes slabs, wall segments and openings, reads a printed metric dimension or scale bar, and retains uncertainty and room labels. OCR/Hough linework is never treated as semantic architecture.
- `processed_plan` stores immutable `processed-floor-plan.v1` records with `floor-architecture.v1` polygons, dimensions in metres, opening geometry, floor identity, height assumptions, and original pixel/source references. **No interior triangle mesh is stored.** The existing renderer extrudes the vector plan deterministically. Every unit can be reviewed locally without inventing its position within the building.
- Complete floors can enter `consensus.building_floor_model` only with a known level, printed scale/north, a current verified footprint, clean geometry checks and >=90% slab/footprint overlap in both directions. The source and listing are locked during publication. Different manual sources or registrations require review; missing floors are never cloned. Publishing saves and reads back a versioned registry record before reporting success. Wall/slab/opening heights and unknown floor elevations are explicitly estimated.

`ai_batch` reserves the token-count estimate plus 20% input headroom and the full output limit **before** submission. Completed costs are stored per page in `plan_task`, exposed in the review UI and appended to the shared LLM cost ledger. The cap uses completed cost for batches submitted that UTC day plus all unresolved reservations. An interrupted/ambiguous submission is marked `unknown`, retains its reservation and blocks further submissions until the provider batch ID is reconciled; it is never automatically resubmitted.

The generic HTML parser does not execute client-side application code. Sites whose listings or plans exist only behind JavaScript APIs need an evidence-backed adapter. It also cannot discover unpublished, sold-only, gated or deliberately inaccessible plans. Never treat the crawl as complete citywide floor coverage.

## Extraction runtime

`extract-floor-plan-draft.py` requires Python 3 with OpenCV, NumPy and Pillow, plus `tesseract`, `pdfinfo`, `pdftotext` and `pdftoppm` on PATH. `FLOOR_PLAN_PYTHON` selects the runtime; production uses an isolated pinned virtual environment. Screening is local. Semantic interpretation uses `ANTHROPIC_API_KEY` and `claude-sonnet-4-6` batch requests through the shared cost helper. PDF screening examines up to 30 pages; vision tasks cover the source's declared total pages, capped at 1,000, one separately rendered page per task. The daily chunk and spend limits bound actual processing.

```sh
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs extract --max-assets 500
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs match
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs verify-sites
# Stop the active crawl before rebuilding current associations after a parser correction.
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs reparse
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs resolve-bindings
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs enqueue-plans
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs interpret --budget-usd 0.20 --chunk-size 1
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs interpret --no-ai
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs publish
```

## Review and verification

`frontend/floor-plan-archive.html` separates **Buildings & floor plans** and **Agencies** into tabs. The building selector includes every current registered building floor model, Avenue V apartment models, and a searchable collection of all current archived source files. Plans can be selected directly or browsed with Previous/Next; each shows its original drawing, available 2D/3D reconstruction, room schedule and source conflicts. Registered models show a stack of the reconstructed floors; Avenue V shows its authored exterior mesh. Maps use registered or authored building footprints. The archive does not turn nearby building candidates or source-page links into verified building associations.

The read-only API provides `/floor-plan-archive/catalogue`, `/building/:id`, `/building/avenue-v/mesh`, `/source/:sha256`, and `/processed/:id` alongside the status, agency and asset routes. Interpreted plans are grouped by building identity, with geometry, source hashes, review notes and actual processing cost. Changed source/ownership associations are excluded from the current catalogue. Catalogue responses contain compact metadata; geometry loads when a building or source is selected. Three.js renders only on interaction or resize and disposes previews when switching buildings. Missing geometry and unresolved locations remain explicit.

`?backend=...` selects the API; `building=registered-1&plan=B1-floor-0` selects a registered plan, `building=archive&plan=<sha256>` selects a source, and `tab=agencies` opens the agency review. English, Croatian, Spanish and Serbian labels are supported through `lang`. The production API route is registered in `backend/index.js`; `scripts/floor-plan-review-server.mjs --port PORT` is a local read-only preview server.

```sh
cd backend
npx vitest run test/floor-plan-*.test.js test/building-floor-plans.test.js test/three-floor-plans.test.js
python3 test/test_floor_plan_draft.py
```

The `reparse` command checkpoints each listing and is idempotent. It preserves raw bytes, observations and model revisions, marks former catalog/card false positives as `not-a-listing`, and withdraws unsupported building links while retaining their previous evidence.

Archive data and authoring manifests are idempotent. Re-importing unchanged Avenue V unit models must return `changed: false`. Browser inspection covers source image loading, real 3D geometry, unit switching, the unknown-floor conflict and a 390 px viewport.
