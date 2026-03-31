#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="root@67.205.138.129"
REMOTE_DIR="/var/www/consensus-builder-api"
SSH_KEY="${HOME}/.ssh/id_ed25519"
DEPLOY_SMOKE_RETRIES="${DEPLOY_SMOKE_RETRIES:-5}"
DEPLOY_SMOKE_RETRY_DELAY_SECONDS="${DEPLOY_SMOKE_RETRY_DELAY_SECONDS:-5}"

cd "${SCRIPT_DIR}"

# Deploy files to server
echo "Deploying files to server..."
rsync -avz --exclude 'node_modules' --exclude '.DS_Store' -e "ssh -i ${SSH_KEY}" * "${REMOTE_HOST}:${REMOTE_DIR}/"

# Install dependencies, restart PM2 process, and run a public smoke check.
echo "Installing dependencies, restarting service, and running smoke tests..."
ssh -i "${SSH_KEY}" "${REMOTE_HOST}" \
  "DEPLOY_SMOKE_RETRIES='${DEPLOY_SMOKE_RETRIES}' DEPLOY_SMOKE_RETRY_DELAY_SECONDS='${DEPLOY_SMOKE_RETRY_DELAY_SECONDS}' bash -s" << 'EOF'
set -euo pipefail

cd /var/www/consensus-builder-api/

echo "Installing npm dependencies..."
npm install

echo "Restarting PM2 process..."
pm2 startOrRestart ecosystem.config.cjs --update-env

echo "Service restarted successfully!"
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
    echo "Production smoke test failed after ${DEPLOY_SMOKE_RETRIES} attempts."
    exit 1
fi

echo "Production smoke test passed."
EOF

echo "Deployment complete!"
