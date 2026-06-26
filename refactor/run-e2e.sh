#!/usr/bin/env bash
# Reproducible e2e gate for the proposals.js refactor.
# Serves THIS worktree's frontend on a dedicated port (isolated from the Docker app on :8080)
# and runs the hermetic Playwright suite against it. Used as the green-gate after every step.
#
#   ./refactor/run-e2e.sh                 # full suite
#   ./refactor/run-e2e.sh proposals       # only proposal-related specs (grep)
#   ./refactor/run-e2e.sh <spec ...>      # specific spec files / playwright args
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8090
BASE="http://localhost:${PORT}"

# Ensure this worktree's frontend is being served on $PORT (idempotent).
if ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/index.html" 2>/dev/null; then
  echo "[run-e2e] starting static server for $ROOT/frontend on :$PORT"
  ( cd "$ROOT" && nohup python3 -m http.server "$PORT" --directory frontend --bind 127.0.0.1 >/tmp/cb-refactor-serve.log 2>&1 & )
  for i in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:${PORT}/index.html" && break; sleep 0.25; done
fi

# Sanity: confirm we are serving the refactor worktree's proposals (not the Docker app's).
served_head="$(curl -s "http://127.0.0.1:${PORT}/js/proposals.js" | head -c 60 || true)"
echo "[run-e2e] serving from: $ROOT/frontend  (proposals.js head: ${served_head:0:40}...)"

cd "$ROOT/e2e"
if [ "${1:-}" = "proposals" ]; then
  shift; exec env BASE_URL="$BASE" npx playwright test --grep-invert @nothing -g "" proposal "$@" --reporter=list
fi
exec env BASE_URL="$BASE" npx playwright test "$@" --reporter=list
