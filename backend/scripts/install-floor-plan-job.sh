#!/usr/bin/env bash
# Prepare the isolated floor-plan OCR runtime or explicitly enable its bounded PM2 job.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd -- "$BACKEND_DIR/.." && pwd)"
VENV_DIR="$BACKEND_DIR/.venv-floor-plans"
ECOSYSTEM_FILE="$BACKEND_DIR/floor-plans/ecosystem.config.cjs"
JOB_NAME="consensus-builder-floor-plan-daily"
ENABLE=false

usage() {
  cat <<'EOF'
Usage: install-floor-plan-job.sh [--prepare | --enable] | --help

No arguments and --help only print this usage. --prepare installs and checks the
dedicated Python environment without enabling the job. --enable repeats that runtime
check, runs the CLI production preflight, then starts the bounded job immediately and
registers its daily 06:00 UTC PM2 schedule. Review and approve the first pilot run before
using --enable.
EOF
}

if [[ $# -eq 0 || ( $# -eq 1 && "$1" == "--help" ) ]]; then
  usage
  exit 0
fi
if [[ $# -ne 1 || ( "$1" != "--enable" && "$1" != "--prepare" ) ]]; then
  usage >&2
  exit 2
fi
if [[ "$1" == "--enable" ]]; then ENABLE=true; fi

cd "$REPO_DIR"
[[ -f "$BACKEND_DIR/package.json" ]] || { echo "Missing backend/package.json" >&2; exit 1; }
[[ -f "$BACKEND_DIR/node_modules/pg/package.json" ]] || { echo "Backend Node dependencies are missing; install them through the approved project deploy path first." >&2; exit 1; }
[[ -f "$BACKEND_DIR/.env" ]] || { echo "Missing backend/.env" >&2; exit 1; }
[[ -f "$ECOSYSTEM_FILE" ]] || { echo "Missing PM2 ecosystem file: $ECOSYSTEM_FILE" >&2; exit 1; }

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check -r "$BACKEND_DIR/floor-plans/requirements.txt"
"$VENV_DIR/bin/python" "$SCRIPT_DIR/floor-plan-runtime-check.py"

if [[ "$ENABLE" != true ]]; then
  echo "Runtime is ready. PM2 job remains disabled."
  exit 0
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 is unavailable; refusing to enable the scheduled job." >&2
  exit 1
fi
cd "$BACKEND_DIR"
export FLOOR_PLAN_PYTHON="$VENV_DIR/bin/python"
if ! node scripts/floor-plan-archive.mjs check --production; then
  echo "Floor-plan production preflight failed; refusing to enable." >&2
  exit 1
fi

# PM2 starts the command immediately on registration, then uses cron_restart daily.
pm2 startOrRestart "$ECOSYSTEM_FILE" --only "$JOB_NAME" --update-env
pm2 save
echo "Enabled $JOB_NAME. It is scheduled daily at 06:00 UTC."
