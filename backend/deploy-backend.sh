#!/usr/bin/env bash
# Deploy the consensus-builder backend to the `do` server: the server syncs the
# selected branch (main by default), reinstalls deps, and reloads the PM2 process, then
# a public smoke test confirms the API is healthy. (Migrated from the old
# rsync-based flow to Git sync; the repo is cloned at $DEPLOY_DIR on the server.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${SSH_HOST:-do}"
DEPLOY_DIR="${DEPLOY_DIR:-/root/code/consensus-builder/backend}"
PM2_APP="${PM2_APP:-consensus-builder-api}"
BRANCH="${BRANCH:-main}"
DEPLOY_SMOKE_RETRIES="${DEPLOY_SMOKE_RETRIES:-5}"
DEPLOY_SMOKE_RETRY_DELAY_SECONDS="${DEPLOY_SMOKE_RETRY_DELAY_SECONDS:-5}"

# Guard: a git-pull deploy only ships committed-and-pushed work. Scoped to the
# backend dir so unrelated uncommitted frontend work doesn't block API deploys.
if ! git -C "$SCRIPT_DIR" diff --quiet -- "$SCRIPT_DIR" \
   || ! git -C "$SCRIPT_DIR" diff --cached --quiet -- "$SCRIPT_DIR"; then
    echo "⚠️  Uncommitted backend changes — commit and push before deploying." >&2
    exit 1
fi

# Guard: the server deploys origin/$BRANCH, so the local HEAD must BE origin/$BRANCH. Otherwise the
# deploy silently ships something other than what was tested here (unpushed commits are left
# behind; a stale checkout ships someone else's newer push).
git -C "$SCRIPT_DIR" fetch --quiet origin "${BRANCH}"
LOCAL_HEAD="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$SCRIPT_DIR" rev-parse "origin/${BRANCH}")"
if [[ "${LOCAL_HEAD}" != "${REMOTE_HEAD}" ]]; then
    if git -C "$SCRIPT_DIR" merge-base --is-ancestor "${LOCAL_HEAD}" "${REMOTE_HEAD}"; then
        echo "❌ Local HEAD ${LOCAL_HEAD:0:9} is behind origin/${BRANCH} (${REMOTE_HEAD:0:9}) — pull first, so you deploy what you tested." >&2
    else
        echo "❌ Local HEAD ${LOCAL_HEAD:0:9} is not on origin/${BRANCH} (${REMOTE_HEAD:0:9}) — push it (or set BRANCH=<the branch you are on>)." >&2
    fi
    exit 1
fi

echo "Deploying ${PM2_APP} to ${SSH_HOST} (${DEPLOY_DIR}) at ${LOCAL_HEAD:0:9}..."
ssh "${SSH_HOST}" \
  "DEPLOY_DIR='${DEPLOY_DIR}' PM2_APP='${PM2_APP}' BRANCH='${BRANCH}' EXPECTED_SHA='${LOCAL_HEAD}' \
   DEPLOY_SMOKE_RETRIES='${DEPLOY_SMOKE_RETRIES}' \
   DEPLOY_SMOKE_RETRY_DELAY_SECONDS='${DEPLOY_SMOKE_RETRY_DELAY_SECONDS}' bash -s" << 'EOF'
set -euo pipefail

cd "${DEPLOY_DIR}"

echo "Syncing to origin/${BRANCH}..."
git fetch --prune origin
git reset --hard "origin/${BRANCH}"
git checkout -B "${BRANCH}" "origin/${BRANCH}"

SERVER_HEAD="$(git rev-parse HEAD)"
echo "Server HEAD: ${SERVER_HEAD}"
echo "Local HEAD:  ${EXPECTED_SHA}"
if [[ "${SERVER_HEAD}" != "${EXPECTED_SHA}" ]]; then
    echo "❌ Server HEAD does not match local HEAD (a push landed between the local check and the sync?) — aborting before install/restart." >&2
    exit 1
fi

echo "Installing dependencies (npm ci)..."
npm ci

# Apply schema DDL BEFORE the reload, so new code never runs against an old schema. psql -1 runs
# every file in ONE transaction with ON_ERROR_STOP: any error rolls all of it back and, via set -e,
# aborts the deploy with the old process still serving. SET ROLE geo_user because DDL needs
# ownership and every geodata object is owned by geo_user (same rule as cadastre-data's
# api/scripts/apply_ddl.js). Connection comes from the PG* variables in this dir's .env.
#
# Explicit list, NOT a glob: every file here was checked to be idempotent and to resolve to the
# schema the live table is in. Deliberately excluded:
#   routes/proposals-ddl.sql, routes/ai-scene-ddl.sql — unqualified CREATE TABLE for tables that
#     live in `consensus`; the connection's search_path starts with `public`, so running them would
#     CREATE an empty public.proposal / public.ai_scene that shadows the real table for every query.
#     Schema-qualify them (consensus.) before adding them here.
#   buildings/building-3d-precompute.sql — a long batched backfill (CALL), not a schema step.
DDL_FILES=(
    routes/area-monitor-ddl.sql
    routes/land-events-ddl.sql
    routes/parcels-ddl.sql
    routes/transactions-ddl.sql
    db/agents-ddl.sql
    ens/ens-plan-ddl.sql
    ens/parcel-ens-ddl.sql
)
echo "Applying DDL (${#DDL_FILES[@]} files, one transaction, as geo_user)..."
PSQL_ARGS=(-X -q -v ON_ERROR_STOP=1 --single-transaction -c 'SET ROLE geo_user')
for f in "${DDL_FILES[@]}"; do
    [[ -f "$f" ]] || { echo "❌ DDL file missing: $f" >&2; exit 1; }
    PSQL_ARGS+=(-f "$f")
done
(
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    psql "${PSQL_ARGS[@]}"
)
echo "DDL applied."

echo "Reloading PM2 process without dropping connections..."
mkdir -p logs
export RELEASE_SHA="$(git rev-parse HEAD)"
# Reload FROM THE ECOSYSTEM FILE, not by process name. `pm2 reload <name>` reuses the config PM2
# saved when the app was first started, so a change to `env:` in ecosystem.config.cjs is silently
# ignored — the deploy reports success and the process keeps the old environment. (That is exactly
# how PUBLIC_API_BASE_URL stayed unset after being added: deploy "succeeded", env unchanged.)
# Passing the file makes PM2 re-read it, and --update-env applies the result.
# PM2 cannot change an already-registered process from fork to cluster mode via
# reload alone. Do that migration once; every later deploy takes the rolling
# reload path. This deliberately causes one brief restart during the migration
# instead of silently remaining in fork mode forever.
CURRENT_EXEC_MODE="$(pm2 jlist | node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const name = process.argv[1];
  const app = JSON.parse(input).find(item => item.name === name);
  process.stdout.write(app?.pm2_env?.exec_mode || "missing");
});
' "${PM2_APP}")"

if [[ "${CURRENT_EXEC_MODE}" == "fork_mode" ]]; then
    echo "Migrating ${PM2_APP} from fork mode to cluster mode (one-time restart)..."
    pm2 delete "${PM2_APP}"
    pm2 start ecosystem.config.cjs --only "${PM2_APP}" --update-env
else
    # Idempotent: starts a missing app and uses a zero-downtime reload for a
    # registered cluster-mode app.
    pm2 startOrReload ecosystem.config.cjs --only "${PM2_APP}" --update-env
fi
pm2 save
pm2 status

echo "Running production smoke test..."
smoke_attempt=1
smoke_passed=0
while [ "${smoke_attempt}" -le "${DEPLOY_SMOKE_RETRIES}" ]; do
    if npm run smoke:prod:parcels; then
        smoke_passed=1
        break
    fi

    if [ "${smoke_attempt}" -lt "${DEPLOY_SMOKE_RETRIES}" ]; then
        echo "Smoke test attempt ${smoke_attempt}/${DEPLOY_SMOKE_RETRIES} failed; retrying in ${DEPLOY_SMOKE_RETRY_DELAY_SECONDS}s..."
        sleep "${DEPLOY_SMOKE_RETRY_DELAY_SECONDS}"
    fi

    smoke_attempt=$((smoke_attempt + 1))
done

if [ "${smoke_passed}" -ne 1 ]; then
    echo "Production smoke test failed after ${DEPLOY_SMOKE_RETRIES} attempts." >&2
    exit 1
fi

echo "Production smoke test passed."
EOF

echo "Deployment complete!"
