# Floor-plan production runtime

Deploy through the repository's normal Git release workflow. The default is a
manual run with no recurring schedule. The job files alone do not register one.
**The user explicitly withheld approval to schedule this job on 2026-10-08. Do
not run `--enable` without their subsequent explicit approval.**

Production setup on that date installed the schema/runtime, seeded agency sites
and configured the approved provider credential. The deployed preflight passed.
A bounded manual run with `--no-ai` fetched eight pages, persisted source hashes
and reported partial coverage with one robots exclusion and no implementation
errors. No provider batches were submitted by that production smoke. PM2 still
had no floor-plan daily job registered. Verify the current host rather than
assuming that audit still describes it.

On October 11 the user approved production archive cleanup and requested that
development and collection continue locally. The production Opereta downloader
was stopped at 17:12 UTC and remains stopped. Temporary maintenance applied
the additive source-policy DDL and removed 1,958,102,084 bytes of ineligible raw
evidence, leaving 1,524,350,976 retained bytes. Readback confirmed no excluded
observations, unchanged processed-model and cost totals, and a repeated final
cleanup with zero changes. Application code was not deployed, no new paid calls
were made, and the recurring job remains disabled. The 500-photo experiment
predates this policy and remains historical evidence.

## Prepare the deployed checkout

From `~/code/consensus-builder`, after the floor-plan change is committed,
pushed and deployed:

```sh
bash backend/scripts/install-floor-plan-job.sh --prepare
node backend/scripts/floor-plan-archive.mjs init
node backend/scripts/floor-plan-archive.mjs import --registry data/floor-plan-agencies/registry.json --websites data/floor-plan-agencies/verified-websites.json
node backend/scripts/floor-plan-archive.mjs sites --file data/floor-plan-agencies/candidate-websites.json
node backend/scripts/floor-plan-archive.mjs websites --file data/floor-plan-agencies/website-discovery.json
```

`init` is additive and idempotent. The existing `consensus.building_floor_model`
migration must also be installed. Keep credentials in the existing protected
`backend/.env`, including `ANTHROPIC_API_KEY`; never put keys in Git, CLI arguments
or logs. The sibling `~/code/agents/lib/llm-cost` helpers must be present and
their shared ledger writable. The archive CLI loads `.env` relative to itself.

For a future authorized rollout, first install the new additive DDL with
`init`, then run the read-only `source-policy` audit and review its
accepted/excluded counts. Run `source-policy --apply` once before resuming any
crawler or downloader; it writes permanent minimal exclusion records for
addressless listings and aliases and removes their old raw HTML, images and
OCR. Shared or reviewed blobs are protected. Confirm cleanup and current
source eligibility before collection. The October 11 maintenance completed
this cleanup on production; a future application rollout still needs these
checks against the then-current data. Architecture studios enter the existing `floor_plan.site`
queue through the implemented `architecture-sites --file FILE` command and
the agent-maintained `backend/floor-plans/architecture-studios.json`. The
verified HKA/MPGI-backed roster contains 18 studio sites and is a partial seed,
not a complete studio register. The national MPGI lists authorize particular
spatial-planning work; 49 unverified Zagreb leads are kept separately from seeds.
Applying this source policy also resets older verified listing-to-building
associations whose evidence lacks `locationPolicy=explicit-address-v1` and
clears their canonical links. Rerun exact resolution from current source
evidence before processing those listings. Application deployment and any
production collection restart remain future work. The persistent local restart
imports the 18 sites and 3,061 verified permanent exclusions, fetches studio
sources followed by Opereta without AI, then cleans the remaining old local
archive. Its progress and readback reports live under
`backend/logs/floor-plan-local-restart-20261011/`.

The prepare command creates `backend/.venv-floor-plans`, installs pinned Python
packages and checks OpenCV, NumPy, Pillow, `pdfinfo`, `pdftoppm`, `pdftotext` and
Tesseract. Install missing system commands through the host's normal package
management. With no arguments or `--help`, the installer only prints usage.

## Verify; enable only after explicit scheduling approval

```sh
FLOOR_PLAN_PYTHON=backend/.venv-floor-plans/bin/python node backend/scripts/floor-plan-archive.mjs check --production
bash backend/scripts/install-floor-plan-job.sh --enable
pm2 describe consensus-builder-floor-plan-daily
```

Preflight checks the actual tables and key columns, seeded websites/home targets,
Python runtime, key presence and shared model pricing. It does not make a paid
call or prove provider authentication. `--enable` runs preflight again with the
dedicated Python interpreter,
starts the initial bounded run immediately and saves the PM2 configuration.

The schedule is **06:00 UTC daily** on the UTC production PM2 host; verify the
daemon's time zone as part of enabling it. `autorestart:false` prevents a failed
job from turning into a rapid retry loop. Retire the previous laptop floor-plan
automation once the production run and monitor are verified.

Default limits are 10,000 agency-page/asset fetches, 180 minutes, 100 source
extractions, one item in one selected AI stage per invocation and a $5 UTC-day
ceiling. The local policy requires the advertised property or architecture
project's own exact street and house number before retaining its HTML or fetching
images/documents. A studio or agency contact address cannot qualify. Addressless
listings are permanently excluded across known aliases, with only a minimal
tombstone retained. `daily` recognizes building locations before extraction, and
`buildings` is the default submission stage. `--ai-stage images`
and `--ai-stage plans` are explicit alternatives; `--ai-stage none` submits no
stage. All stages still collect prior work. Downloads and image screening need
an address-qualified owner but do not need a resolved building. OCR/line extraction,
plan queueing and paid interpretation require an independently supported city and
exact source address resolved to a current verified canonical listing match or a
current source-cited `building_task` candidate with canonical mapping, matching
the current listing HTML hash and non-low confidence. Raw spatial candidates,
pins, registry office cities and proximity alone do not qualify. This gate
applies to explicit source hashes and old queued tasks;
if location evidence is lost before a paid response is applied, retain its
response and cost for review without producing geometry. Explicit
`--ai-budget-usd none` removes the ceiling, while the 1–20 item chunk limit still
applies. Discovery receives
40% of the page and time allowance, listing-owned downloads up to 35% of time,
and screening up to 20%, leaving room to collect and save models. The complete HGK
registry is a separate small fetch; it cannot update the registry from a partial
snapshot. A running HTTP operation and final database checkpoints may extend a
phase by its bounded timeout. Large backfills remain queued. Increase the chunk
only after inspecting sample geometry and actual costs.

## Outcome monitoring

The matching `Agency Floor Plans` entry must be deployed in
`alerts-server-telegram/bot-list.json` before enabling the schedule. The reviewed
entry is also in [`monitor-entry.json`](monitor-entry.json). It is currently
`active:false` while scheduling approval is withheld. Activate the monitor only
when the job is explicitly approved and enabled. It checks four hours
after the scheduled start and judges the latest scheduled run, not yesterday's
artifact. Do not invoke notification delivery merely to test registration.

The CLI writes `backend/logs/floor-plan-run-stats.json` atomically after querying
the stored source associations and vector artifacts. It contains the run verdict,
distinct hosts contacted, decoded response bytes, deduplicated archive growth,
all three AI stages' costs and counters, current vector-plan/publication counts,
pending tasks and unknown paid submissions. Zero new plans and
ordinary provider-batch waiting are valid. Partial coverage, blocked sources,
processing failures, unknown batches and stale runs remain visible as failures.

For a production smoke check, read the final `floor_plan.pipeline_run`, at least
one observed source hash and any generated `processed_plan` back from PostgreSQL.
Fetch its `/floor-plan-archive/processed/:id` and archived image through the API,
and compare source/2D/3D in the review page. A published floor additionally needs
its current registry version and footprint checked. A successful process exit
alone does not establish any of these outcomes.

## Resume and stop

`interpret --collect-only` or `recognize-buildings --collect-only` collects the
selected stage's existing batch without submitting more. `daily --no-ai` collects
all three stages. Every paid response and its cost are checkpointed before domain
validation. Already checkpointed responses replay without another ledger entry;
the ledger append and database checkpoint are not one atomic transaction. A source,
consumed fact, listing URL or processor change creates a new
plan task; building tasks also include their candidate map. Historical responses
and costs remain in the archive. Source-only plans remain available for local
review after the location gate passes, without requiring a verified canonical
association; publication requires a current
verified listing association, independent geometric registration and a current
footprint.

An `unknown` submission blocks new submissions in all three stages and retains the
reserved budget. Reconcile the provider batch ID and request IDs with its `stage`
and corresponding `plan_task` or `building_task` before changing the batch to
`submitted`; never reset those tasks to queued blindly. An ordinary pending
batch blocks new submissions only in its own stage.
Provider-rejected requests and invalid geometry retain their raw response and
error for diagnosis. Corrected processors create new tasks rather than silently
overwriting the original evidence.

Use `pm2 delete consensus-builder-floor-plan-daily` and `pm2 save` to remove the
scheduled job. The archived sources, tasks and models stay intact. Coordinate
the monitor entry when deliberately stopping the job so absence is not mistaken
for an unnoticed failure.
