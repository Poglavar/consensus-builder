# Private Stanovanje.plus archive processing

The archive collector retains building metadata and every advertised drawing. Reconstruction
handles each floor drawing separately, reusing the original ten trial checkpoints when their
SVG hashes agree. The live index inspected on 2026-10-20 contained 195 building entries,
125 entries with floor drawings, 365 floor drawings and 1,124 drawings of all types.
An advertised link can still contain an embedded upstream 404 page; that is a coverage gap.

All source files, model requests, responses, usage and review artifacts stay under the ignored
run directory. No command below writes the public publication database or deploys a site.
The previously recorded permission outreach is still unresolved.

From the repository root, install the local geometry dependencies and collect:

```sh
uv venv backend/.venv-stanovanje
uv pip install --python backend/.venv-stanovanje/bin/python shapely lxml
run-job start stanovanje-collect backend/.venv-stanovanje/bin/python \
  backend/scripts/stanovanje-plus-archive.py collect
```

The default run root is `backend/logs/stanovanje-plus-archive-20261020`; `--root` selects another.
The original ten-building run remains untouched. The collector uses two download workers,
checks crawl rules, caps each response at 64 MB, checkpoints each building and skips saved sources.
Rerun collection to retry missing sources without fetching retained drawings again.

Process the collected sources, including while collection advances:

```sh
run-job start stanovanje-process node backend/scripts/stanovanje-plus-archive-run.mjs \
  --root=backend/logs/stanovanje-plus-archive-20261020 --run --concurrency=6
```

Each subscription reading or refinement pass is capped at 30 drawing identities. The shared
CLI runner selects the model and records subscription tokens and API-equivalent usage separately
from metered spend. Every response is saved before geometry is applied. Existing attempts never
silently repeat: inspect a failed or interrupted attempt explicitly. A processor lock prevents
two orchestrators from selecting the same queue. After an interrupted process, verify its owner
and managed job are gone before removing its lock and resuming.

`processing-summary.json` reports current geometry and stage errors. A partial final run exits
with code 2; format validity alone does not establish usability. Source-only roof drawings
remain viewable without fabricated walls. Geometric refinements retain measured wall solids;
ambiguous components and unsupported voids remain explicit review failures.
An uncaught processor failure records `status: failed` and its error before releasing the lock.
Add `--local-only` to replay saved responses into geometry and refresh the private catalogue
without making any new model calls; that pass records `status: checkpointed`.
The floor candidate tries 0.01 then 0.1 source-unit precision to close CAD rounding gaps,
bounded to 3 cm theoretical displacement at the retained scale. Measured walls are unchanged;
distinct source regions are never joined. Precision and displacement are recorded for review.

An inspected workspace-routing failure with no saved response can be retried explicitly using
`stanovanje-plus-worker.mjs --root=<archive> --stage=reading --retry-codes=<drawing-code>`.
This archives the failed request/attempt, checks the unchanged source hash, assigns a new attempt
number and restricts the pass to those same drawing identities. It does not add a new cohort.

The processor refreshes `publication-bundle.json` after each pass. It uses the existing shared
publication projection and catalogue consumer. Source PNG hashes identify full-source rasters;
the bundle also records their original SVG hashes and URLs. Whole-floor variants do not create
apartments or imply numbered storeys. Unknown geography remains null. Source attribution is
retained. Public incorporation remains separate from preparing this private bundle.

Open the private source overlay, 2D/3D model and building-outline viewer:

```sh
run-job start --interactive stanovanje-review node backend/scripts/stanovanje-plus-review.mjs \
  --root=backend/logs/stanovanje-plus-archive-20261020 --serve --port=8613
```

Use `http://localhost:8613/?building=<drawing-code>`. Reload to read the latest processing
checkpoint. All responses use `Cache-Control: no-store`; the server binds to loopback and
exposes only explicit source/model/review routes. Review status is bound to the exact model hash.

The main UI elements are **Building and drawing**, **Original source**, **Processed model**,
**Whole building**, and **Quality review**. Existing `.panel`, `.toolbar`, `.columns` and
`.model-view` categories and theme variables live in `review.css`.
