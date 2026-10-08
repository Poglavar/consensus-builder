# Floor-plan production runtime

Deploy through the repository's normal Git release workflow. The job files alone
do not register a schedule. **The user explicitly withheld approval to schedule
this job on 2026-10-08. Do not run `--enable` without their subsequent explicit
approval.**

Production setup on that date installed the schema/runtime, seeded agency sites
and configured the approved provider credential. The deployed preflight passed.
A bounded manual run with `--no-ai` fetched eight pages, persisted source hashes
and reported partial coverage with one robots exclusion and no implementation
errors. No provider batches were submitted by that production smoke. PM2 still
had no floor-plan daily job registered. Verify the current host rather than
assuming that audit still describes it.

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
call. A valid key is established by the reviewed small pilot, not by presence
alone. `--enable` runs preflight again with the dedicated Python interpreter,
starts the initial bounded run immediately and saves the PM2 configuration.

The schedule is **06:00 UTC daily** on the UTC production PM2 host; verify the
daemon's time zone as part of enabling it. `autorestart:false` prevents a failed
job from turning into a rapid retry loop. Retire the previous laptop floor-plan
automation once the production run and monitor are verified.

Default limits are 10,000 agency-page/asset fetches, 180 minutes, 100 source
extractions, one AI page per chunk and a $5 UTC-day ceiling. Discovery receives
40% of the page and time allowance, matched downloads up to 35% of time, and
screening up to 20%, leaving room to collect and save models. The complete HGK
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
actual source/processing counters, current vector-plan/publication counts,
pending tasks, per-run cost and unknown paid submissions. Zero new plans and
ordinary provider-batch waiting are valid. Partial coverage, blocked sources,
processing failures, unknown batches and stale runs remain visible as failures.

For a production smoke check, read the final `floor_plan.pipeline_run`, at least
one observed source hash and any generated `processed_plan` back from PostgreSQL.
Fetch its `/floor-plan-archive/processed/:id` and archived image through the API,
and compare source/2D/3D in the review page. A published floor additionally needs
its current registry version and footprint checked. A successful process exit
alone does not establish any of these outcomes.

## Resume and stop

`interpret --no-ai` collects an existing batch without submitting more. Every
page result and its cost are checkpointed, so restarting does not charge for the
same completed task again. A source, context or processor change creates a new
task; historical responses and their costs remain in the archive.

An `unknown` submission blocks new submissions and retains the reserved budget.
Reconcile the provider batch ID and its request IDs with `plan_task` before
changing that batch to `submitted`; never reset those tasks to queued blindly.
Provider-rejected requests and invalid geometry retain their raw response and
error for diagnosis. Corrected processors create new tasks rather than silently
overwriting the original evidence.

Use `pm2 delete consensus-builder-floor-plan-daily` and `pm2 save` to remove the
scheduled job. The archived sources, tasks and models stay intact. Coordinate
the monitor entry when deliberately stopping the job so absence is not mistaken
for an unnoticed failure.
