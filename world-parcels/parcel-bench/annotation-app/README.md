# Groundwork: mobile image annotation

A standalone, private review app for visible physical/use divisions. No frontend build or npm
install: the server uses Node 22+ built-ins, and the browser uses ES modules, IndexedDB and a service
worker. This does not change the map app or the frozen ParcelBench experiments.

## Phone workflow

1. Open the HTTPS site, enter the access key, then use **Connection and saved reviews → Download
   for trip**. Wait for **14 images ready offline**. Add the page to the phone's Home Screen.
2. For an unmarked image, tap two interior points. Existing suggested pairs already have A and B.
   Pinch to zoom, drag to pan, or use the zoom/fit controls. **Move A & B** replaces the two points.
3. Choose **Separate**, **Same area**, or **Unclear**. The answer saves on the phone before moving
   to the next unanswered pair. Previous and the image/pair selector revisit answers.
4. **Trace edge** optionally records a polyline by tapping vertices; Undo and Clear trace correct
   it. Dragging/pinching while tracing moves the image without adding a vertex. Finish editing and
   choose an answer to include the trace. Point edits, unfinished traces, and notes also survive reload.
5. **Add another pair here** creates another observation in this image. There is no requirement to
   complete an image's whole boundary network.
6. Sync runs while the app is open, on reconnect/resume, or with **Sync now**. Keep it open until
   **All reviews synced**. No background-sync promise is made when the app is closed. Conflicting
   reviews require an explicit choice; neither is silently discarded. Server history retains corrections.
7. **Export backup** downloads the phone's current review records and unfinished drafts. Browser
   storage can be evicted or cleared: synchronize and keep backups. A downloaded pack must be reopened
   online if its storage is evicted. Switching between browser and Home Screen may use distinct storage.

The **image viewer**, **pair selector**, **decision buttons**, **editing toolbar**, and **pack menu**
are the UI names for follow-up work. Shared visual categories are actions, panels, badges, notices,
disclosures and fields. Their theme and presentation are in `public/styles.css`; JavaScript supplies
only image-dependent SVG geometry. This standalone tool currently has English strings in
`public/strings.mjs`, independent of the multilingual map application.

## Prepare an immutable pack

From this directory:

```sh
node prepare.mjs
```

This creates ignored `../output/annotation-bundle-v1/`: 5 Mozambique/Nepal target crops and 9 Croatian
development crops, 41 starting pairs, and the exact image hashes, metric extents, CRS and source
credits. The target crops start with empty anchors; the 36 Croatian suggestions retain only anchor
positions. Their agent-written answers and explanations are omitted. The filename, hash, sample ID,
coordinate system and geometry form one immutable batch. Preparing into an existing bundle refuses
to overwrite it. New packs use a new destination, review data directory and browser scope; do not
replace a batch underneath reviews or add compatibility readers to experimental records.

Coordinates are **image-edge pixels**, origin top left, x right/y down; anchors and trace vertices
must be strictly inside the image. Metric coordinates use each sample's `bbox` and `crs`, not a global
Croatian CRS. One source can contribute several crops; 14 images are not 14 independent settlements.
No model predictions, cadastral overlays or inferred ownership appear in the review interface.

## Run locally

Set the following environment variables (use absolute bundle/data paths):

```sh
export ANNOTATION_BUNDLE="$PWD/../output/annotation-bundle-v1"
export ANNOTATION_DATA="$PWD/../output/annotation-reviews-v1"
export ANNOTATION_BASE_PATH=/review/
export ANNOTATION_ORIGIN=http://localhost:8787
export ANNOTATION_PORT=8787
node --env-file=/path/to/ignored/annotation.env server.mjs
```

The ignored env file contains `ANNOTATION_TOKEN`, a randomly generated access key of at least 32
bytes. Never place it in a URL or a tracked file. Open `http://localhost:8787/review/` and enter it.
The app binds only to loopback. Offline functionality requires HTTPS or localhost; a phone's plain
HTTP LAN address is insufficient. Node 22+ is required for the env-file launch and modern APIs.

## Hosted service (prepared, not deployed by this change)

`ecosystem.config.cjs` proposes one isolated PM2 process on `prod-de`, loopback port 8791, served at
`https://zagreb.lol/plot-review/`. Confirm the port and existing nginx routes before installation.
Keep the immutable imagery pack and mutable reviews under separate `/srv/groundwork/` directories,
outside the code checkout and static docroots. `/srv/groundwork/secret.env` contains only the access
key, mode 0600; the versioned PM2 file owns the public config. Use one process, never a cluster.

The nginx location must preserve the `/plot-review/` prefix when proxying to `http://localhost:8791`:

```nginx
location = /plot-review { return 308 /plot-review/; }
location ^~ /plot-review/ {
    client_max_body_size 128k;
    proxy_pass http://localhost:8791;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Run `nginx -t` before reload. Start/restart via the ecosystem file with `--update-env`, then verify
the actual process settings and `GET /plot-review/api/health`. Check unauthenticated API/image
requests are refused and authenticated writes work at the public origin. The pinned origin accepts
no cross-origin writes; HTTPS cookies are HttpOnly, Secure and SameSite Strict. Rotating the access
key invalidates existing cookies. Imagery is cached only in the authenticated browser's private
cache; review APIs are no-store. Shell assets contain no private labels or images.

`reviews.json` is the server source of truth for synced reviews, including a revision journal.
Writes are serialized, fsynced and atomically renamed before success is returned. Back this file up
outside the release directory. A lock prevents two processes opening the same data directory. After
an abrupt kill, check the PID in `reviews.lock`; remove a stale lock only after establishing no
server owns the directory. Normal shutdown releases it. Code updates do not modify stored records.
Bump the shell cache version in `public/sw.js` when publishing changed offline assets. Verify the
updated app online, then download/check the offline pack again.

## Export a human review dataset

Use **Export backup**, or save the authenticated `api/reviews` JSON response for the full server
snapshot and revision history. Convert either using:

```sh
node export_reviews.mjs --input phone-backup.json \
  --bundle ../output/annotation-bundle-v1 \
  --output ../output/human-visible-divisions-v1.json
```

The exporter verifies batch content and every image hash, rejects duplicate IDs, invalid coordinates
and unresolved conflicts, and preserves per-observation revision and sync provenance. Pending
phone reviews remain marked `pending-sync-backup`. Unfinished drafts are backup material and are
not admitted as judgments. `separate` and `same_surface` enter `samples[].probes`; `unclear` enters
`uncertain_reviews`. Trace vertices and notes remain evidence, not exhaustive boundary ground truth.
`starting_task_status` describes only the offered pairs, not the completeness of the image's labels.

The new `human-visible-divisions-v1` format deliberately does not impersonate the frozen
`visible-division-v1` agent drafts or invent confidence values. Evaluation roles stay `unassigned`.
The exporter creates a human annotation artifact; it does not train a model, overwrite the old
scorer's inputs, or automatically promote reviewed crops to a holdout set. Choose/freeze geographic
roles and add an explicit consumer before model evaluation or training.

## Focused checks

From the repository root:

```sh
node --test world-parcels/parcel-bench/annotation-app/test/model.test.mjs \
  world-parcels/parcel-bench/annotation-app/test/server.test.mjs \
  world-parcels/parcel-bench/annotation-app/test/export.test.mjs
node --test world-parcels/parcel-bench/annotation-app/test/mobile.test.mjs
```

The second command is three targeted **headless Playwright browser checks**, run through Node's
test runner. It uses the existing `e2e/node_modules/@playwright/test`, prepared imagery, temporary
review stores and loopback port 8789. It covers offline download/reload/sync, partial drafts, native
touch pinch, 320px layout and explicit cross-device conflicts. Test answers never enter the real
review store. No full repository suite is required to run these checks. A headed visual inspection
is separate; the implementation was inspected at 390px width in a dedicated background Chrome.

Validation record, 2026-10-19 (all runs targeted; none stopped):

| Check | Result |
|---|---|
| Worker headless server unit checks, 1 file / 5 tests | Loopback binding initially blocked by sandbox; permitted rerun passed, then the hardening rerun passed. |
| Worker headless export unit checks, 1 file / 4 tests | Passed. |
| Headless model unit + mobile browser checks, 2 files / 8 tests | 5 model tests passed; all 3 browser checks blocked before launch by loopback sandbox restriction. |
| Permitted headless mobile browser rerun, 1 file / 3 tests | Passed. |
| Headless model + export unit checks, 2 files / 9 tests | 7 passed, 2 failed because export expectations still used the retired complete/partial status names; assertions updated to the explicit starting-task coverage contract. |
| Final headless export/server unit + mobile browser checks, 3 files / 12 tests | All passed: 9 unit tests and 3 browser checks. The unchanged 5 model tests had already passed. |
| Headed visual inspection, dedicated Chrome at 390px | Empty-anchor and suggested-pair screens inspected; no browser errors; browser closed afterward. |

Physical iPhone/Safari testing has not been performed. Backend and export boilerplate were delegated
to a `gpt-6-luna` worker; integration, state behavior, UI, review and Git were handled by the primary agent.
