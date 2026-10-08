# Floor-plan production runtime

`install-floor-plan-job.sh` prepares the dedicated `backend/.venv-floor-plans`
environment on an existing deployed checkout. With no arguments or `--help`, it
only prints usage. `--prepare` installs the pinned Python packages without
registering the job. `--enable` repeats the runtime checks, runs the CLI's
`check --production` preflight, then starts the bounded PM2 job immediately and
saves the PM2 process list. Review and approve the first pilot before using
`--enable`.

The PM2 app runs once daily at 06:00 UTC with `autorestart: false`. It uses
`backend/.env` through the archive CLI's existing dotenv loader. The extractor
runtime is selected by `FLOOR_PLAN_PYTHON` and checked for OpenCV, NumPy, Pillow,
`pdfinfo`, `pdftoppm`, `pdftotext`, and Tesseract. The package pins are isolated
from the backend's Node environment.

The PM2 command declares the production page, time, and asset limits, AI
budget, chunk size, and run-stats path. The CLI's production preflight must
verify schema readiness, a reviewed bounded source seed, configured model
pricing, and required credentials without making paid calls. The first crawl
starts as soon as PM2 registers the job, then repeats daily at 06:00 UTC.

Monitoring should consume `backend/logs/floor-plan-run-stats.json`, using the
existing run-stats shape:

```json
{
  "version": 1,
  "job": "consensus-builder-floor-plan-daily",
  "runStatus": "completed",
  "verdict": "success",
  "startedAt": "<ISO-8601>",
  "endedAt": "<ISO-8601>",
  "dryRun": false,
  "counters": {
    "sourcesSeeded": 0,
    "pagesFetched": 0,
    "assetsProcessed": 0,
    "draftsForReview": 0,
    "notPlan": 0,
    "failed": 0,
    "pending": 0
  },
  "error": null
}
```

Use `runStatus`/`verdict` for the check outcome and source-specific counters for
throughput context. A zero draft count can be a valid run; do not use it alone as
a failure signal. A stale stats file or missing completed run should fail the
freshness check.
