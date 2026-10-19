<!-- Inventory of model stages and their source, review, and billing contracts. -->
# LLM tasks in this repo

The agency floor-plan archive has three LLM stages. All use the shared
`agents/lib/llm-cost/llm.mjs` batch layer and `backend/floor-plans/batch-worker.js`.
The shared `defaults.json` selects the model and reasoning effort; image classification
uses its `cheap` tier, and no call site pins a model. Each request uses a strict structured-output schema. Small schemas preserve nullable fields in the provider grammar; larger schemas use the shared layer’s documented conversion limits. Batch results
are priced at the model that answered, written to the shared cost ledger, and
checkpointed on their task before domain validation. There is no online fallback
in these stages.

The exact-address policy is implemented locally but has not been deployed to
production. The production Opereta downloader stopped at 17:12 UTC on October
11; no production archive cleanup or new paid calls followed, and no recurring
schedule was enabled. The 500-photo experiment predates this gate and remains
historical evidence only. Before any image/document fetch or source retention,
the advertised agency property or architecture-studio project must itself state
a street and house number; studio/agency contact addresses do not count. Missing
addresses enter a permanent minimal exclusion ledger across known aliases, with
raw HTML, images and OCR removed subject to reviewed/shared-source protection.
Verified canonical listing-to-building evidence must include
`locationPolicy=explicit-address-v1`. Applying `source-policy` resets older
verified associations without that marker and clears their canonical links;
rerun exact resolution from current source evidence before processing affected
listings. The architecture-studio seed is partial and does not represent a
complete HKA register.

| Stage | Source sent to the model | Stored result and limit | Invocation |
|---|---|---|---|
| Ad-building recognition (`buildings`, `ad-building-recognition-v3-explicit-address`) | Archived public listing HTML text and structured claims, bounded known links, and at most 40 building candidates shown by opaque `C` IDs | A source-quoted address/project reading, one candidate ID or abstention, and issues in `building_task`. Every non-null address or project claim needs an exact contiguous quote from the source. A candidate is selectable only when the advertised property has a quoted exact street and house number matching the candidate; its city must match the source locality. The model sees no canonical building ID and performs no photographic recognition. Local validation rejects unsupported quotes and references. A candidate does not verify or write `listing.match_status`; a current, source-cited candidate with canonical mapping, matching current listing HTML hash and non-low confidence can authorize source processing. | `enqueue-buildings [--limit N] [--listing-url URL]`; `recognize-buildings [--budget-usd N\|none] [--chunk-size 1..20] [--collect-only]`; `daily` (default submission stage) or `daily --ai-stage buildings` |
| Listing-image classification (`images`, `listing-image-kind-v1`) | One retained raster image owned by an address-qualified listing/project, keyed by its source hash | A small structured reading in `image_task` identifies a floor plan, uncertain image, photo or render. Output is capped at 512 tokens. Current explicitly labelled floor plans can be accepted locally without a paid call. Confirmed non-plans may have their bytes discarded after source, ownership and shared-use checks; URL and SHA-256 tombstones remain. A changed hash is eligible again. Download and image screening require an exact-address owner but not yet a resolved building. | `enqueue-images [--limit N] [--site HOST]`; `classify-images [--budget-usd N\|none] [--chunk-size 1..20] [--collect-only]`; `image-status [--limit N]`; `daily --ai-stage images` |
| Floor-plan interpretation (`plans`, `floor-plan-vision-v11`) | One archived public drawing page, locally measured wall/gap/scale candidates and labelled crops, plus the listing's floor, unit ID and area facts | Source-only metric vector plan or an explicit non-plan/needs-review result in `plan_task` and `processed_plan`. The model selects candidate geometry IDs; local checks validate scale, topology and raster support. It cannot supply building identity, wall coordinates, a verified registration or publication approval. Queueing, OCR/line extraction and paid interpretation require a current verified canonical listing-to-building match or a current source-cited `building_task` candidate with canonical mapping, matching current HTML hash and non-low confidence. Raw spatial candidates and pins alone do not qualify. The gate is rechecked for queued tasks and before applying a paid response; if location evidence is lost, the paid response and cost remain available for review but produce no geometry. | `enqueue-plans [--limit N] [--source-hash SHA256]`; `interpret [--budget-usd N\|none] [--chunk-size 1..20] [--collect-only]`; `daily --ai-stage plans` |
| Crawl, source ownership, extraction/screening, exact reviewed bindings, spatial candidates, geometric registration and publication | No LLM | Deterministic source and review gates. Building location is required before extraction or plan work as described above. Existing source-only geometry remains immutable and reviewable; publication still requires a current verified association, footprint and independent registration evidence. | Existing archive pipeline and `publish` |

`daily` recognizes buildings before asset crawling and extraction, and selects
`buildings` for new submission by default. `images` and `plans` are explicit
alternatives. `daily --ai-stage none`
or `daily --no-ai` submits no stage; all three still collect prior work. Each
invocation submits at most one chunk in the selected stage. The optional
`--ai-budget-usd none` or stage command's `--budget-usd none` removes the spend
ceiling, while the 1–20 item chunk limit remains. All three stages share the daily
spend calculation. An ordinary pending batch stops a new submission only in its
own stage; an `unknown` submission blocks all three until reconciled. No recurring
schedule is enabled by the repository or by these commands.

Validate a small batch and its recorded cost before requesting approval for a large paid run.
The classification cache survives discarded image bytes; a new explicit plan label clears a
prior negative URL decision, while uncertainty keeps the bytes available for review.

Only documents and images owned by an exact-address-qualified listing/project can be downloaded. Before OCR/line extraction or plan queueing, the listing must additionally have an independently supported city and exact address resolved to either a current verified canonical building match or a current source-cited `building_task` candidate with canonical mapping, matching current listing HTML hash and non-low confidence. The agency/studio's registered office city, raw spatial candidates and pins are insufficient. This applies to explicit `--source-hash` requests and previously queued tasks. Untriaged raster images also wait for a current floor-plan or uncertain classification, or a current listing-owned floor-plan label. Plan preparation keeps drawings with no supported wall or metric-scale candidates in local review without token counting or a paid provider call. Both disconnected alternating bars and connected bars with regular ticks can supply measured scale candidates; the model must still read printed endpoint labels. Room dimensions without a supported scale candidate remain a detector limitation.

Source-only plan models keep `building:null` and can be grouped under their
listing for review after the location gate above passes. A later verified building match supplies a current label and
footprint at read time without changing model bytes or hash. An LLM suggestion
never promotes an association to verified. If location evidence becomes stale
before a paid response is applied, retain its response and cost for review and
do not produce geometry. The publication gate rechecks source
currency, listing ownership, verified identity, independent scale/orientation,
clean raster support and the live footprint. Stale or ambiguous evidence remains
visible as a task result or review issue rather than an invented building.

The batch and reader contracts are covered by fast offline tests with fake
provider clients in `backend/test/floor-plan-image-worker.test.js`, `floor-plan-batch-worker.test.js`,
`floor-plan-building-worker.test.js`, `floor-plan-processing.test.js`, and
`floor-plan-building-reading.test.js`. Those tests make no paid calls.
