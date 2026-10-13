# Agency floor-plan archive

This pipeline keeps public agency evidence separate from published building architecture. It runs against the existing `geodata` database and creates the `floor_plan` schema as `geo_user`.

## Novogradnje catalogue and current collection policy

The public destination is **https://zagreb.lol/novogradnje/**. The dedicated read-only
server (`backend/scripts/novogradnje-server.mjs`) serves project and apartment pages,
server-rendered metadata/JSON-LD, a sitemap, source plans and a compact search API.
Project URLs carry a stable site-key ID; apartment IDs derive from posting identity
and unit number. Renamed project slugs redirect to their current canonical URL.
The old archive HTML route redirects through a resolver that preserves known site
and plan selections. The operations/review API remains separate.

New-build claims are the default filter and receive crawl priority. Older buildings
remain searchable, with an explicitly sourced construction year when available.
A completion forecast is labeled separately; absent or conflicting years remain
unknown. Advertised apartment area and physical net plan area remain separate.
Translated aliases of one posting contribute evidence without multiplying its
apartments or source links. Commercial-only projects are omitted from this catalogue.

The source roster reconciles every known agency domain and the 20 evidenced studio
seeds. Unverified architecture leads remain leads. Discovery still spans the broad
source set, while **asset fetching now requires a located/probable site or a verified
building match and current listing ownership**. This concentrates download and
interpretation work on objects that can actually appear on the map. The deeper
processing gates and shared paid-call budget still apply.

Completed HTML/XML sources are reduced to URL/hash-bound evidence packets after
parsing. Every alias and historical observation must be supported before shared
bytes are discarded. Location, agency verification and text readers use those
packets; unchanged 304/200 revisits reuse them without restoring source files or
creating processing tasks. A server without HTTP validators still has to transfer
its response for a hash comparison. Unfinished assets and retained plans/PDFs stay
available. An envelope image is discarded only after both classification and sheet
reading finish, with its structured result preserved and no plan consumer waiting.

`floor-plan-retention.mjs` audits by default; `--apply` commits evidence and tombstones
before deleting files. The final `daily` stage drains committed batches within its
deadline and reports unfinished cleanup as partial. A repeated apply
resumes interrupted file pruning. Compacted raw HTML cannot be reparsed as HTML;
that command reports skipped compacted sources rather than treating them as empty.
Models, revisions, processing results and cost records are retained.
For a large existing archive, use `--apply --until-complete --limit 250` after
reviewing a sample audit. Each batch commits and verifies its evidence before file
removal, reports cumulative reclaimed bytes, and is skipped on restart. Exact
URL/hash evidence already saved by the crawler is reused rather than parsed again.

Only supported placements appear inside the transparent building view. Ambiguous
fits stay separate, and envelopes show known/estimated outlines and storeys; this
is not proof of a reconstructed facade or complete apartment inventory. Continued
coverage work is source discovery, resolving location ambiguity, then processing
the matched plan/render queue and reviewing geometry. **Scheduling remains disabled.**

The official HGK **broker companies** (`posrednici`) registry is fetched in full, with page counts, stable totals and unique IDs checked before updating the city list. The City of Zagreb filter uses its 68 official settlements, with postal disambiguation for Strmec. The checked snapshot contains 470 city agencies; two ambiguous Strmec records remain in the snapshot's `scope_review`. Registry inclusion is the recorded fact; the API does not provide a separate active-license flag. This is registered-seat coverage, not every agency selling property in the city.

## Source files and database metadata

Raw downloads live in the gitignored `data/floor-plan-downloads/` directory: `html/`, `images/`, `pdf/` and `other/` for registry and sitemap snapshots. Each file uses its SHA-256 hash as its name, with a two-character shard directory. `FLOOR_PLAN_ARCHIVE_DIR` can select another archive location. Writes are atomic and verified against size and hash before their metadata is saved.

PostgreSQL retains URLs, hashes, relative file paths, media types, byte counts, availability/discard flags, fetch/processing dates and run identifiers, plus structured claims, processing results, models and costs. It contains no raw download byte column after migration. All parsers, processing workers and source-serving routes read the same files and reject missing or corrupt retained evidence. Discarding evidence updates metadata first and deletes its file only after the database transaction commits; `prune-files` retries an interrupted deletion.

Back up this ignored directory alongside PostgreSQL. A database backup alone preserves references and processing history, but cannot restore original evidence. Existing archives need the verified, two-phase `migrate-storage` workflow in [`deployment.md`](deployment.md) before their raw database copy is removed.

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

Long runs should use the installed `run-job` helper or an equivalent persistent process runner. A posting is kept when it carries any location signal for the advertised object: an explicit street and house number, a street named in its title, address field or prose (not a "near X" mention), a map pin, a cited permit KLASA or a parcel number. Pages with none receive a minimal permanent exclusion record across known URL aliases; they do not enter image screening or plan extraction. Site location (below) then decides where the object is before floor geometry is processed. By default, `daily` submits one site-adjudication chunk; `--ai-stage images`, `--ai-stage plans`, `--ai-stage sheets` and the explicit `--ai-stage buildings` reader are alternatives, while `--ai-stage none` collects without submitting. Explicit source hashes and old queued tasks pass the same gates. If evidence is lost before a paid response is applied, retain its response and cost for review without producing geometry. The run then attempts registration of eligible complete floors. Every source and task is checkpointed, and advisory locks prevent duplicate runs. Limits, blocked requests and item failures remain explicit; failed fetches never prove a listing was removed.

No recurring schedule is enabled by this code or by running the CLI. A PM2 definition is available for a future explicitly approved 06:00 UTC schedule; follow [`deployment.md`](deployment.md) before enabling it. A scheduled host and a laptop automation must not independently submit the same paid work.

The HKA/MPGI-backed architecture-studio roster in `backend/floor-plans/architecture-studios.json` contains 20 verified websites and portfolio seeds. Import it locally with `architecture-sites --file backend/floor-plans/architecture-studios.json`; the command validates every row before adding it to the existing `floor_plan.site` queue with `source_kind=architecture`. Studio projects use the same exact-address and building-location gates as agency listings. The two official MPGI spatial-planning approval PDFs supplied 59 Zagreb company/address pairs; 47 unresolved or excluded leads remain separately in `architecture-studio-leads.json` and are not crawl seeds. These approval lists cover spatial-planning work, not every architecture practice, so the combined roster remains partial.

On October 11 the user approved production archive cleanup while keeping development and collection local. The production Opereta downloader remains stopped. One-off maintenance applied the additive policy DDL and removed **1,958,102,084 bytes** of ineligible raw evidence; final retained content was **1,524,350,976 bytes**. Readback found no excluded-source observations, unchanged processed-model and cost totals, and a repeated final cleanup was a no-op. Production application code was not deployed and the recurring schedule remains disabled. The earlier 500-photo experiment is historical evidence from before this policy.

The persistent local restart `fp-local-restart-20261011` imported all 18 studios and verified 3,061 permanent exclusions copied from production. The requested-site cleanup plus exclusion import removed 132,586,030 bytes locally while preserving all three processed plans and their costs. The fetch-only run started at 18:49 UTC for the 18 studio hosts followed by Opereta. Its atomic phase, per-host progress, trace and results are under the ignored `backend/logs/floor-plan-local-restart-20261011/` directory. Remaining old local agency evidence is audited and cleaned after this collection pass. A running job is not proof that every site has finished; inspect `summary.json` and each site's result for coverage and access gaps. This restart submits no AI work.

The October 12 local storage migration exported and hash-verified all **10,281 retained files / 10,171,333,501 bytes**, then removed the database byte column after reloading the local API readers. The blob relation shrank from 2,536,808,448 to 3,653,632 bytes; all three processed plans, reviewed models/revisions and recorded costs were unchanged. Original images were read back through every existing local API with matching hashes after the column was gone. Collection continues under `fp-local-file-crawl-resume-20261012`, starting from the interrupted Sangrad pass, then GIN, Unifika and Opereta, followed by the earlier time-capped 3LHD backlog. Production storage was subsequently migrated under the authorization recorded below.

The authorized October 12 production follow-up verified **2,932 retained files / 1,524,350,976 bytes** in the ignored repository archive, reloaded the existing API on release `35ae15d1`, then removed its raw byte column and compacted the blob relation from 1,714,896,896 to approximately 3,342,336 bytes. Full-row fingerprints across 17 archive metadata/processing tables and recorded costs were unchanged. All seven retained images matched their hashes through both the origin and public API after finalization. A private, inspected 292,055,654-byte recovery dump and verification reports remain in the production checkout under `backend/logs/floor-plan-production-storage-20261012/`. Production collection remains stopped and unscheduled; local collection continues.

Verified canonical listing-to-building evidence must carry `locationPolicy=explicit-address-v1`. Applying `source-policy` resets older verified associations that lack this marker and clears their canonical link; rerun exact resolution from current source evidence before processing those listings.

The default submits **one item in one selected AI stage per daily invocation**, with a $5 UTC-day ceiling; the selected stage defaults to `sites`. This queues a backfill instead of charging for it at once. `--chunk-size` or `--ai-chunk-size` allows 1–20 items in that one chunk. An explicit `--budget-usd none` or `--ai-budget-usd none` removes the spend ceiling but preserves the chunk limit. Batch processing is asynchronous: a run collects completed batches and may submit at most one new chunk in the selected stage. A pending batch is not a failure; a batch still pending after 26 hours is reported. `classify-images --collect-only`, `interpret --collect-only`, `recognize-buildings --collect-only`, and `daily --no-ai` collect without new submissions. All readers share cost accounting and budget reservations; an unknown submission blocks new work in every stage until reconciled.

Daily download totals include registry, discovery and asset requests. Host counts use requested hostnames with `www.` folded together and count each host once across phases. Bytes are decoded response bodies, including unsuccessful responses that returned a body; they are not network transfer bytes. Archive growth is reported separately after content-hash deduplication. Nested sitemaps alternate with listing-page sweeps across hosts. Eurovilla's generated search sitemaps and pages discovered from those maps are filtered or deferred with explicit counts; other listing and project sitemaps remain eligible.

To finish fetching one agency site before moving to the next, use the separate site runner:

```sh
PGHOST=localhost node backend/scripts/floor-plan-site-crawl.mjs --site opereta.hr --run-dir backend/logs/opereta-2026-10-11
```

Run it under a persistent process runner. It drains that site's due discovery queue, then address-qualified listing-owned images and documents, in chunks of at most 500 requests. External CDN assets need both current listing ownership and the exact-address gate. `--asset-mode plans` limits downloads to labelled plans and documents. This command only fetches sources and does not submit AI work. The lower-level `crawl` command supports `--site HOST`, `--discovery-only`, `--assets-only`, and `--plan-assets-only` for bounded diagnostics.

Use `--interleave-assets` to alternate the site's remaining pages and assets. It also migrates an unfinished two-stage run to a recorded mixed stage after recovering its in-flight counters. This lets image downloads proceed once the main catalogue has been read while older pages and language variants remain in the queue.

Use `--revisit-known` with a **new run directory** for a repeat pass over a processed site. It makes known, eligible discovery pages due once and prioritizes them before new pages. Resuming that directory does not reset them again. HTTP 304 responses reuse retained evidence without a body; identical HTTP 200 bodies skip parsing, discovery and source/extraction writes. Servers without validators must still transfer a body to establish whether it changed. Per-run `notModified` and `identicalBodies` counters expose the distinction. Source hashes and consumed facts preserve classification and plan-task identities, and sheet context is reused across URL aliases of the same source. A completed run directory remains a completed checkpoint; use another directory for the next visit.

On October 13, the user approved a local repeat pass and explicitly kept scheduling disabled. The initial persistent `fp-local-repeat-20261013` job covered the existing 18-studio roster, Eurovilla and Opereta; it was fetch-only, with a 5,000-request / 30-minute cap per host. An Urbanistica check and second pass each reused all 14 known pages without changing source bytes or creating processing tasks. The server returned HTTP 200 without validators, so HTML was transferred but not archived or processed again. Reports are under the ignored `backend/logs/floor-plan-repeat-20261014/` directory.

The October 14 local source cleanup removed **10,499 raw files / 10,075,824,256 bytes**,
leaving **424 retained files / 108,277,154 bytes** in the content-addressed archive.
The separate reconstruction bundle was preserved. Every compacted observation had
valid URL/hash evidence, no file deletions remained pending, all retained files
were present, and original model-source plans passed SHA-256 verification.
Full-row fingerprints for extractions, revisions, processed plans, tasks, batches
and all 68 site models were unchanged, as were recorded costs. A fresh Urbanistica
pass after deletion reused all 14 identical HTTP 200 responses (519,741 decoded
body bytes) with zero archive growth, new processing work or additional model cost.
The ignored `backend/logs/novogradnje-20261014/repeat-proof.json` records the checks.

The one-off `fp-local-repeat-20261014-resume` then resumed from the 3LHD checkpoint.
Its 144-host queue combines all 140 previously processed hosts with the current
20-studio roster and agency seeds. Each host retains its 5,000-request / 30-minute
cap, followed by independently committed cleanup batches with a 15-minute cleanup
cap. Unfinished cleanup and source failures remain explicit partial results.
This pass submits no AI work and creates no recurring schedule; inspect its live
summary and per-host results before making a coverage claim.

`daily` now locates sites, queues/collects site adjudication, queues/collects sheet context and assembles site models. Only the selected reader can submit a new chunk; all readers collect their own outstanding batches. Plan and sheet readers, and building and site readers, cannot consume each other's batches despite sharing storage-stage names. Failed or deferred site-model builds make the overall run partial. SIGINT/SIGTERM checkpoint interrupted work; status responses also check the worker's advisory lock so a saved `running` row cannot masquerade as a live process after a crash. Scheduling and the outcome monitor remain disabled.

The run directory retains atomic progress and result snapshots plus a per-fetch trace with decoded body bytes. Reuse the same directory, site and asset mode to resume; already committed sources are skipped by the database queue. Request and active-time limits apply across resumes (`--max-pages 50000`, `--max-minutes 360` by default). Three consecutive HTTP 403/429 responses stop the run for inspection. Exhausting the queue with failures remains a partial result. Without `--revisit-known`, a site run uses the existing due queue and does not force previously successful pages or the root sitemap due again.

## Site location (heuristic)

User decision 2026-10-12: match postings to places the way a person would, with stretchable heuristics and an LLM for close calls, not strict rules. New builds usually have no surveyed building, may replace an old one, sit on empty ground or span merged parcels, so the target is a **site** (parcels, plus the permitted footprint when there is one), not a surveyed building.

- `site-signals.js` reads the posting's own text: explicit address, street names (inflection-aware, capitalized, in street context; a title is a location slot; "u blizini/kod/pokraj X" marks a nearby street only), map pin, KLASA, parcel numbers, unit count, storey formula, new-build wording.
- `site-candidates.js` gathers candidate sites from official address points (`public.overture_address`), eDozvola permit footprints and site polygons (`public.edozvola_feature`, mirrored by cadastre-data `permits/fetch-edozvola.js`) near the pin, on the named streets or by KLASA, and the parcels under them; overlapping evidence merges into one site. The city's own recent permit records (`public.permit`, about one year) add units, floor area, height and investor by KLASA; the public WFS leaves those fields empty. Only Zagreb's sources are loaded, so a posting placed in another town gets no Zagreb street candidates.
- `site-scoring.js` adds weights per agreeing clue (KLASA, parcel, exact/variant address point, permit street and number, stated vs passing street, district = permit's cadastral municipality in the title, pin distance, recent building permit for a new-build ad, residential use, unit count) and subtracts for road/utility works. Status: `located`, `probable`, `ambiguous` (close call), `unresolved`. Weights are heuristics to tune against reviewed outcomes.
- `locate-sites` stores the ranked candidates with their reasons in `listing.location` and the signals in `listing.facts`; `located` and `probable` count as located for plan processing.
- `enqueue-sites` / `adjudicate-sites` (`ad-site-location-v1`, batch API, shared default model) show the posting text and up to six summarized candidates to the model, which picks one or none with quotes; its pick adds weight (high 0.35, medium 0.2, low 0.05) instead of overriding the heuristics, and a posting that is not about a building (an exhibition) stays unresolved. First chunk 2026-10-12: 5 postings, $0.102784.

### Envelope and placement (steps 2a/2b)

- **Footprint:** the polygons of ONE permit case — the latest building permit or amendment, then start of works, use permit, location permit — never a union across cases (a location permit's separate annex once fused into Avenue V's slab). Else the surveyed building, else the parcels.
- **Storeys (`envelope.js`):** storey formulas from sheets, permits and ads ("Po+Pr+3+Uk", "prizemlje, dva kata i uvučeni kat"); the highest posted floor is a lower bound; an existing building's surveyed height fills in. Heights come from printed elevations (a line through floor/elevation pairs: Avenue V reads 3.3 m storeys over a 5.2 m commercial ground floor), else 3.0/3.2 m estimates; implausible values are kept as conflicts.
- **Plan reading without a scale bar:** `floor-plan-vision-v12` / `floor-plan-reading.v4` take `scale=null` plus printed `dimensionHints`. Metres per pixel come from, in order: printed scale bar, printed dimensions on measured strokes, typical 0.90 m doors, listing area against the slab; with none, the plan is kept at a provisional 0.02 m/px marked `scaleBasis: unknown`. Only the first two are measurements. A drawing is read once per page and stated facts, not once per URL variant.
- **Sheet context (`sheet-context-v1`, `enqueue-sheets` / `read-sheets`):** one vision reading per posted sheet or envelope image: orientation (north arrow, or street names along the page edges), the key-plan inset (unit centre within the floor, block count), storeys visible in elevations/renders, printed elevation marks. First run 2026-10-12: 4 Avenue V sheets, $0.073236.
- **Fit (`plan-placement.js`):** rotation candidates from dominant wall directions; measured scales may move ±3% (penalised), estimated ones ±24%, unknown ones are fitted as a full floor when the outline broadly matches (overlap ≥0.6). Units may project 1.8 m (balconies). Priors are soft: a north arrow or street-derived bearing adds weight; the key plan's unit position both scores candidates and proposes mid-facade positions. Result: `placed`, `ambiguous` (alternatives kept) or `unplaced`.
- **Site models (`site-models`, table `floor_plan.site_model`):** one stored, idempotently rebuilt `site-model.v1` per located site. Read-only API: `/floor-plan-archive/sites` and `/floor-plan-archive/site?key=…`; the review page's **Sites** tab (`?tab=sites&site=…`) shows the envelope in 3D, footprint and fits on the map, the evidence and each fit's clues. Nothing here publishes to the map registry.

## Data and review gates

- `agency` retains the registry record and verified website identity; `website_candidate` records unverified search leads separately. `site` includes additional directory-linked sites. A website is verified with its visible legal name and exact OIB, or an explicitly reviewed name/address match. Unresolved does not mean no website exists.
- `target` is the due queue. Home pages, public sitemaps and project/listing/pagination/contact links are discovered. Image and document targets are admitted only after their owner supplies its own exact street and house number; nongallery images can qualify when ownership is explicit. New-build wording is retained; resale is included too. Zagreb URLs receive priority.
- `blob` stores file metadata by SHA-256; `observation` connects URLs, page evidence and runs. HTTP validators reduce both page and asset downloads. Existing assets are conditionally rechecked every 30 days, so a changed drawing at an unchanged URL is detected without transferring unchanged bytes when its server supports validators. An ordinary page edit does not make the entire gallery due again; a new asset URL or newly explicit plan label does. Missing or discarded cache files are requested unconditionally. Confirmed non-plan images can have their bytes discarded after classification, while URL and hash tombstones retain evidence and prevent refetching the same discarded bytes. A changed hash is processed afresh; a current explicit plan label or other protected plan source prevents deletion. Robots rules, DNS/private-address checks, bounded downloads and host serialization apply. Access blocks remain explicit gaps.
- `listing` stores source claims. Only a street and house number explicitly stated for the advertised property or architecture project qualify; a studio/agency contact address, postcode, locality alone or nearby landmark does not. `listingOwned` limits assets to the matching property/project and excludes footer, agent, contact, related-property and legal artifacts. Main Eurovilla plan buttons remain public download endpoints only for an address-qualified owner; access rules still apply. Reviewed source manifests can also supply ownership, but only when listing identity, archived source URL and exact source hash agree. Excluded sources leave a minimal permanent identity/URL/hash/reason ledger entry; old raw HTML, images and OCR are removed unless shared or reviewed evidence protects them. Building identity needs an independently supported city and exact source address, with an unambiguous reviewed binding, a cadastral/survey match with >=90% overlap in both directions, or an official house-number point: the exact street and number must name exactly one point in the source's settlement in cadastre-data's `public.overture_address` (DGU's register for Croatia, imported by `addresses/fetch-overture-addresses.js`), and that point must lie inside exactly one surveyed 3D footprint. Courtyard numbers such as `Ilica 10/1` are distinct points. Postcode-only strings and proximity alone never verify a building.
- `image_task` records one classification per source hash. Downloads require a current address-qualified owner and a located/probable site or verified building match. Screening preserves its current ownership and source checks. Explicitly labelled current plans can be accepted locally. Other eligible raster images receive a small structured reading that distinguishes plans, uncertain images, photos and renders. Confirmed non-plans may be discarded only after source and ownership checks; uncertain or shared/protected sources stay for review. An untriaged image does not enter extraction.
- `extraction` stores OCR/PDF text, normalized source linework and screening evidence. OCR/line extraction requires current location evidence as defined under `building_task`; this applies to all assets, explicit source hashes and old queued tasks. Raster images also require a current floor-plan/uncertain classification or an explicit listing-owned floor-plan label. Generic drafts are **not architectural models**: they can include furniture, dimensions and annotations and have no metric scale or placement. PDFs are bounded at 30 pages, with truncation recorded. `model_revision` retains every draft or reviewed unit revision.
- Reviewed Avenue V unit models use `consensus-builder.floor-architecture.v1`. Import requires the exact source hash already archived at the declared URL. They are available for local 2D/3D review and are not published to `consensus.building_floor_model` while global placement is unresolved.
- `plan_task` identifies archived source hash + page + listing URL + the floor, unit and area facts actually sent to the reader. Queueing and interpretation require current location evidence as defined under `building_task`. The vision reader receives public page images and measured source candidates; building IDs, footprints and coordinates are absent. OpenCV proposes source strokes, possible gaps and printed scale bars; the reader selects their IDs and identifies wall, opening and railing semantics. Geometry and scale candidates have separate labelled source crops. Slab vertices reference measured anchors. The AI cannot invent wall coordinates. Original evidence, selections, application-validated structured response and per-page cost are retained. One source owned by two listings can create separate tasks; changed source bytes or consumed facts create a new task. If location evidence is lost before applying a paid response, retain its result and cost for review and produce no geometry.
- `building_task` identifies an archived listing source and bounded, opaque building candidates. The `ad-building-recognition-v3-explicit-address` text reader sees listing HTML text and structured claims plus candidate addresses, names, distances and evidence, but no canonical database identifiers or photographic recognition. For every non-null address or project claim it must quote exact contiguous source words; a candidate is selectable only when the advertised property has a quoted exact street and house number matching the candidate. Candidate city is checked against source locality. It may abstain; the application validates quotes and IDs, retains the answering model and per-item cost, and stores the result as `candidate`, `unresolved` or `not_listing`. Only a current source-cited candidate with canonical mapping, matching current listing HTML hash and non-low confidence satisfies the source-processing gate. It never changes `listing.match_status` or creates a verified binding. Raw spatial candidates and pins alone are not sufficient location evidence.
- `processed_plan` stores immutable `processed-floor-plan.v1` records with `floor-architecture.v1` polygons, dimensions in metres, opening geometry, floor identity, height assumptions, and original pixel/source references. New readings have `building:null` and nullable canonical identity columns. **No interior triangle mesh is stored.** The renderer extrudes the vector plan deterministically. Source-only geometry can be reviewed locally after the location gate passes, without a verified canonical association. A later verified listing match supplies an optional current label and footprint at read time without rewriting the stored model or its hash; stale source or listing ownership hides the current reading. Historical building-bound rows remain tied to their original identity.
- Complete floors can enter `consensus.building_floor_model` only with a known level, independently verified printed scale/north, a current verified footprint, clean topology checks, independent wall support in the original clean raster and >=90% slab/footprint overlap in both directions. The raster check requires >=80% length-weighted support and >=65% for every wall at least 24 pixels long. Insufficient or inconclusive evidence remains in review. The source and listing are locked during publication. Different manual sources or registrations require review; missing floors are never cloned. Publishing saves and reads back a versioned registry record before reporting success. Wall/slab/opening heights and unknown floor elevations are explicitly estimated.

Map placement additionally requires `source.registrationEvidence` with schema `floor-plan-registration-evidence.v1`, the exact `sourceSha256` and `page`, and separately verified `scale` and `orientation` entries. Each needs `status:'verified'` and a nonempty `basis`; scale candidate ID, endpoints, metric length and quote, and the north vector must exactly match the processed source. The AI response cannot populate this object. Source-only geometry remains available for local review. Publication waits for a current verified listing-to-building association and footprint as well as independent registration; a square footprint cannot prove a scale or orientation reading.

`ai_batch` records its `images`, `plans` or `buildings` stage and reserves the token-count estimate plus 20% input headroom and the full output limit **before** submission. Image classification uses the shared `cheap` tier and caps output at 1,024 tokens per item (512 truncated a dense axonometric). Classifier v2 (`listing-image-kind-v2`) also marks **envelope evidence**: exterior photos/renders, sections, elevations, site plans and massing diagrams are kept as `image_kind='envelope'` for envelope reconstruction. Classification alone cannot discard them. Completed photo/render sources become eligible for the separate retention stage only after their sheet reading is saved and no plan consumer needs the bytes; other envelope evidence remains protected. Completed costs are stored in the corresponding task table and appended to the shared LLM cost ledger. The shared cap counts completed cost for batches submitted that UTC day plus all unresolved reservations. A pending batch in one stage does not stop another stage; an interrupted/ambiguous submission is marked `unknown`, retains its reservation and blocks all three until the provider batch ID is reconciled. A paid response is checkpointed before domain validation so replay does not charge or ledger it again.

Confirm a small batch's results and costs before requesting approval for a large paid run. A new explicit floor-plan label clears a previous negative URL decision; ordinary listing edits do not. Byte disposal removes the source file while retaining its metadata. Removing a legacy PostgreSQL byte column requires an explicit migration finalization; `--reclaim-space` also compacts that table.

The batch-worker API can prepare one explicitly approved image chunk of up to 500 items with `allowLargeImageBatch:true`; other stages remain capped at 20. Pass a `taskIds` allowlist for a site-specific submission. The ordinary `classify-images` CLI is global and rejects `--site` rather than silently ignoring it. Negative URLs are not periodically fetched just to discover a replacement image: a new URL or an explicit plan label reopens processing, and an explicit refetch can discover changed bytes at a reused URL.

Serialized requests have a 200,000,000-byte batch ceiling checked before token counting. Image conversion can reach that ceiling before the item limit; deferred items remain queued. Collect and review the submitted portion before continuing only the unresolved IDs from the approved manifest, subtracting all prior item costs from its original spending cap. The partial `(current_sha256, url)` asset index supports image reuse and current-source checks without repeatedly scanning the asset queue.

The generic HTML parser does not execute client-side application code. Sites whose listings or plans exist only behind JavaScript APIs need an evidence-backed adapter. It also cannot discover unpublished, sold-only, gated or deliberately inaccessible plans. Never treat the crawl as complete citywide floor coverage.

The current automatic geometry detector covers dark orthogonal walls and printed metric scale bars (alternating segments or connected baselines with regular ticks). A drawing with no supported wall or scale candidates stays in local review before any paid request. Faint, curved or diagonal structures, drawings without a measurable scale bar, and uncertain opening semantics require review. A successful format check or coincident raster stroke alone does not establish architectural accuracy. Such omissions must remain visible; they are not filled with guessed geometry.

The October 8 single-unit pilot produced a stored, source-linked 2D/3D review draft with the correct approximately 10 m drawing scale. Door/window and balcony-edge classifications still contained errors. A known opening whose geometry cannot be represented is omitted with its candidate ID and reason recorded; the raw response remains intact and the whole draft stays `needs_review`. Unknown source references, conflicting selections, invalid scale/slabs and invalid remaining geometry still reject the plan. This pilot establishes the collection/storage/preview flow, not unattended architectural accuracy. It predates the building-location requirement above and is historical evidence, not current eligibility guidance.

## October 11, 2026 pilot

The separate Opereta image-kind pilot classified 12 manually inspected images for $0.0013848: eight clear photos were discarded, three floor plans retained, and one room-area schedule retained as uncertain. Readback confirmed eight negative-cache entries, 710,879 discarded bytes and 451,731 retained bytes. These results validate this small sample and the storage/cache flow; they do not establish a population accuracy rate. This and the October 11 runs below predate the location-first policy; these are historical pilot facts, not current eligibility guidance.

The approved 500-image follow-up used 254 Claude Haiku API checks for $0.031551 and retained 246 source-labelled files locally. The payload ceiling split the paid requests into portions of 139 ($0.01725475) and 115 ($0.01429625), with the same original item allowlist and total spending cap. The stored decisions discarded 235 photos and 18 renders, retained one map as uncertain, and left no queued, submitted or failed tasks in that manifest. Database readback confirmed 47,275,450 discarded bytes and 253 matching negative-cache records; all 247 retained sources still had their bytes. A 20-image visual sample matched the retention decisions, including keeping a source-labelled room-area table. This is a limited retention check, not a population accuracy estimate.

That 500-image run predated the exact-address gate and is retained here as historical experiment evidence only. It is not a valid population of currently eligible sources.

Three listing readings produced two Avenue V project suggestions and one abstention for an ad with only a street name. No verified building associations were changed. The first three-item chunk cost $0.045674; two responses failed validation because the shared provider schema had converted nullable fields to optional strings. After preserving native nullability for small schemas, a two-item retry cost $0.027550 and both readings passed. Total building-recognition cost was $0.073224, including the failed attempts.

Two unverified-listing drawings were prepared separately. One had no supported scale candidate and stayed in local review at zero provider cost. The other yielded a source-only 9.39 × 7.05 m draft using its printed 5 m scale bar for $0.053654. Its missing corner, omitted glazed edge and opening conflict remain explicit review issues. The stored draft was read back and inspected beside its source in both 2D and 3D. Total paid recognition was $0.126878; all submitted batches were collected.

The one-off production daily run (`5227b510-50dc-470d-84da-9a3f317ba220`) ran from 11:55:36 to 12:13:56 UTC using the previously deployed pipeline with AI disabled. It attempted 1,094 fetches across 178 hosts, with 903 successful responses across 125 hosts. Decoded bodies totalled **537,069,375 bytes**: registry 298,188; home pages 55,567,426; sitemaps 420,199,168; other pages 61,004,593. Deduplicated archive growth was 887 blobs / 534,907,926 bytes. Counts include the registry host. Access failures and the discovery time cap made the run partial; it found 12 listings and fetched no plan assets because that deployed version still required verified building matches. The run exposed 65,075 due pages from 19 generated search maps, motivating the local queue filter. No recurring schedule was enabled. These measurements predate the queue, stage-decoupling and location-first changes above.

## Extraction runtime

`extract-floor-plan-draft.py` requires Python 3 with OpenCV, NumPy and Pillow, plus `tesseract`, `pdfinfo`, `pdftotext` and `pdftoppm` on PATH. `FLOOR_PLAN_PYTHON` selects the runtime; production uses an isolated pinned virtual environment. Screening and candidate extraction are local. All three LLM stages use batch requests through `floor-plans/batch-worker.js` and the shared `agents/lib/llm-cost/llm.mjs`, which chooses the model and effort from `defaults.json`, sends strict structured-output schemas, and prices and ledgers results at the model that answered. There is no per-repo model setting. The structured responses are validated locally before storage. PDF screening examines up to 30 pages; vision tasks cover the source's declared total pages, capped at 1,000, one separately rendered page per task. The daily chunk and spend limits bound actual processing. The stages and their LLM inventory are listed in [`docs/llm-tasks.md`](../../docs/llm-tasks.md).

```sh
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs match
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs verify-sites
# Stop the active crawl before rebuilding current associations after a parser correction.
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs reparse
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs resolve-bindings
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs enqueue-buildings --limit 100
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs recognition-status --limit 20
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs recognize-buildings --budget-usd 5 --chunk-size 1
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs enqueue-images --limit 1000
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs classify-images --budget-usd 5 --chunk-size 1
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs image-status --limit 20
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs extract --max-assets 500
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs enqueue-plans --limit 1000
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs interpret --budget-usd 5 --chunk-size 1
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs interpret --collect-only
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs publish
```

## Review and verification

`frontend/floor-plan-archive.html` separates **Buildings & floor plans** and **Agencies** into tabs. The building selector includes every current registered building floor model, Avenue V apartment models, and a searchable collection of all current archived source files. Plans can be selected directly or browsed with Previous/Next; each shows its original drawing, available 2D/3D reconstruction, room schedule and source conflicts. Registered models show a stack of the reconstructed floors; Avenue V shows its authored exterior mesh. Maps use registered or authored building footprints. The archive does not turn nearby building candidates or source-page links into verified building associations.

The read-only API provides `/floor-plan-archive/catalogue`, `/building/:id`, `/building/avenue-v/mesh`, `/source/:sha256`, and `/processed/:id` alongside the status, agency and asset routes. Interpreted plans with no verified building are grouped under a stable listing-derived review ID; a later verified association groups them under that building without rereading geometry. Plans retain source hashes, review notes and actual processing cost. Changed source/ownership associations are excluded from the current catalogue. Catalogue responses contain compact metadata; geometry loads when a building or source is selected. Three.js renders only on interaction or resize and disposes previews when switching buildings. Missing geometry and unresolved locations remain explicit.

On a localhost page `?backend=http://localhost:PORT` selects the API (default `http://localhost:3000`); every other host uses the production API; `building=registered-1&plan=B1-floor-0` selects a registered plan, `building=archive&plan=<sha256>` selects a source, and `tab=agencies` opens the agency review. English, Croatian, Spanish and Serbian labels are supported through `lang`. The production API route is registered in `backend/index.js`; `scripts/floor-plan-review-server.mjs --port PORT` is a local read-only preview server.

```sh
cd backend
npx vitest run test/floor-plan-*.test.js test/building-floor-plans.test.js test/three-floor-plans.test.js
python3 test/test_floor_plan_draft.py
```

The location eligibility joins also have an opt-in PostgreSQL check: from `backend`, run `FLOOR_PLAN_LOCATION_DB_TEST=1 npx vitest run test/floor-plan-location-sql.test.js`. It connects only to the local `geodata` database and uses temporary tables inside a rolled-back transaction; it makes no provider calls or changes to application data.

The `reparse` command checkpoints each eligible listing and is idempotent. It preserves retained raw bytes, observations and model revisions, marks former catalog/card false positives as `not-a-listing`, and withdraws unsupported building links while retaining their previous evidence. Excluded sources follow the separate minimal-ledger cleanup policy above.

Archive data and authoring manifests are idempotent. Re-importing unchanged Avenue V unit models must return `changed: false`. Browser inspection covers source image loading, real 3D geometry, unit switching, the unknown-floor conflict and a 390 px viewport.
