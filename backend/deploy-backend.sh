#!/usr/bin/env bash
# Deploy the consensus-builder backend to the `do` server: the server pulls the
# latest commit from GitHub, reinstalls deps, and restarts the PM2 process, then
# a public smoke test confirms the API is healthy. (Migrated from the old
# rsync-based flow to git-pull; the repo is cloned at $DEPLOY_DIR on the server.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${SSH_HOST:-do}"
DEPLOY_DIR="${DEPLOY_DIR:-/root/code/consensus-builder/backend}"
PM2_APP="${PM2_APP:-consensus-builder-api}"
DEPLOY_SMOKE_RETRIES="${DEPLOY_SMOKE_RETRIES:-5}"
DEPLOY_SMOKE_RETRY_DELAY_SECONDS="${DEPLOY_SMOKE_RETRY_DELAY_SECONDS:-5}"

# Guard: a git-pull deploy only ships committed-and-pushed work. Scoped to the
# backend dir so unrelated uncommitted frontend work doesn't block API deploys.
if ! git -C "$SCRIPT_DIR" diff --quiet -- "$SCRIPT_DIR" \
   || ! git -C "$SCRIPT_DIR" diff --cached --quiet -- "$SCRIPT_DIR"; then
    echo "⚠️  Uncommitted backend changes — commit and push before deploying." >&2
    exit 1
fi

echo "Deploying ${PM2_APP} to ${SSH_HOST} (${DEPLOY_DIR})..."
ssh "${SSH_HOST}" \
  "DEPLOY_DIR='${DEPLOY_DIR}' PM2_APP='${PM2_APP}' \
   DEPLOY_SMOKE_RETRIES='${DEPLOY_SMOKE_RETRIES}' \
   DEPLOY_SMOKE_RETRY_DELAY_SECONDS='${DEPLOY_SMOKE_RETRY_DELAY_SECONDS}' bash -s" << 'EOF'
set -euo pipefail

cd "${DEPLOY_DIR}"

echo "Pulling latest commit..."
git pull --ff-only

echo "Installing dependencies (npm ci)..."
npm ci

echo "Restarting PM2 process..."
mkdir -p logs
# Restart FROM THE ECOSYSTEM FILE, not by process name. `pm2 restart <name>` reuses the config PM2
# saved when the app was first started, so a change to `env:` in ecosystem.config.cjs is silently
# ignored — the deploy reports success and the process keeps the old environment. (That is exactly
# how PUBLIC_API_BASE_URL stayed unset after being added: deploy "succeeded", env unchanged.)
# Passing the file makes PM2 re-read it, and --update-env applies the result.
# Idempotent: `pm2 restart <file>` starts the app if it is not running yet.
pm2 restart ecosystem.config.cjs --only "${PM2_APP}" --update-env
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
