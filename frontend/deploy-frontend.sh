#!/bin/bash

# Frontend deployment script for consensus-builder.
#
# Migrated from the old "rsync the local working tree" pattern to server-side `git pull`:
# the server (67.205.138.129) fetches origin/main over HTTPS, stamps a cache-bust build token,
# and syncs frontend/ into the nginx docroot. Deploys now ship exactly what's on origin/main
# (so: commit + push before deploying), and no longer depend on the local working-tree state.
# The Cloudflare cache purge still runs locally (uses this dir's optional .env).

set -euo pipefail

# ---- Configuration ----
SERVER='root@67.205.138.129'
SSH_KEY="$HOME/.ssh/id_ed25519"
BRANCH='main'
REPO_URL='https://github.com/Poglavar/consensus-builder.git'   # HTTPS: no server deploy key needed
REMOTE_REPO='/opt/consensus-builder'                           # server-side clone (deploy-only)
DOCROOT='/var/www/urbangametheory.xyz'                         # nginx docroot
COUNTER_FILE='/opt/.cb-frontend-deploy-counter'                # lives OUTSIDE the repo (survives reset --hard)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load optional .env for CF_ZONE_ID / CF_API_KEY (Cloudflare cache purge).
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ssh_server() { ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY" "$SERVER" "$@"; }

echo -e "${GREEN}🚀 Deploying frontend via server-side git pull...${NC}"

# Seed the server-side build counter from the local one on first run, so the deploy-N sequence
# continues rather than restarting at 1.
SEED=0
if [ -f "$SCRIPT_DIR/.deploy-build-counter" ] && grep -Eq '^[0-9]+$' "$SCRIPT_DIR/.deploy-build-counter"; then
    SEED=$(cat "$SCRIPT_DIR/.deploy-build-counter")
fi

# ---- SSH connectivity ----
echo -e "${YELLOW}🔍 Testing SSH connection...${NC}"
if ! ssh_server 'echo ok' >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: cannot SSH to $SERVER (check $SSH_KEY).${NC}"; exit 1
fi
echo -e "${GREEN}✅ SSH connection successful${NC}"

# ---- Remote deploy: clone-or-update, stamp build token, back up, sync to docroot, reload nginx ----
ssh_server "BRANCH='$BRANCH' REPO_URL='$REPO_URL' REMOTE_REPO='$REMOTE_REPO' DOCROOT='$DOCROOT' COUNTER_FILE='$COUNTER_FILE' SEED='$SEED' bash -s" <<'REMOTE'
set -euo pipefail

# Clone on first run, otherwise hard-sync to origin/BRANCH.
if [ ! -d "$REMOTE_REPO/.git" ]; then
    echo "📥 First-time clone -> $REMOTE_REPO"
    git clone --branch "$BRANCH" "$REPO_URL" "$REMOTE_REPO"
fi
cd "$REMOTE_REPO"
git remote set-url origin "$REPO_URL"
git fetch --prune origin
# Discard any local working-tree changes FIRST. Each deploy stamps a cache-bust token into
# index.html / build-info.js, leaving the tree dirty; if the incoming commit also touches those
# files, `git checkout -B` would abort with "local changes would be overwritten". Resetting to
# origin/BRANCH up front drops the stamps and moves HEAD, so the checkout below is a clean no-op.
git reset --hard "origin/$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1
git reset --hard "origin/$BRANCH"
COMMIT=$(git rev-parse --short HEAD)
echo "✅ Repo at origin/$BRANCH ($COMMIT)"

# Build token for cache busting. Counter lives outside the repo so reset --hard never wipes it;
# seed it from the local counter on first run.
current=0
if [ -f "$COUNTER_FILE" ] && grep -Eq '^[0-9]+$' "$COUNTER_FILE"; then
    current=$(cat "$COUNTER_FILE")
elif [ "${SEED:-0}" -gt 0 ] 2>/dev/null; then
    current="$SEED"
fi
counter=$((current + 1)); echo "$counter" > "$COUNTER_FILE"
BUILD_ID="deploy-$counter"; TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
python3 - "$REMOTE_REPO/frontend/js/build-info.js" "$REMOTE_REPO/frontend/index.html" "$BUILD_ID" "$counter" "$TS" <<'PY'
import sys
from pathlib import Path
paths = [Path(sys.argv[1]), Path(sys.argv[2])]
rep = {'__BUILD_ID__': sys.argv[3], '__BUILD_NUMBER__': sys.argv[4],
       '__BUILD_GENERATED_AT__': sys.argv[5], '__BUILD_CACHE_TOKEN__': sys.argv[3]}
for p in paths:
    if not p.exists():
        continue
    t = p.read_text()
    for k, v in rep.items():
        t = t.replace(k, v)
    p.write_text(t)
PY
echo "🆕 Cache-bust token: $BUILD_ID"

# Back up current docroot.
if [ -d "$DOCROOT" ] && [ -n "$(ls -A "$DOCROOT" 2>/dev/null)" ]; then
    BACKUP="${DOCROOT}_backup_$(date +%Y%m%d_%H%M%S)"
    cp -r "$DOCROOT" "$BACKUP"; echo "💾 Backup: $BACKUP"
fi

# Sync frontend/ -> docroot (server-local rsync). Keep dev/deploy artefacts out of the docroot.
mkdir -p "$DOCROOT"
rsync -a --delete \
    --exclude='.git' --exclude='.gitignore' --exclude='node_modules' --exclude='.DS_Store' \
    --exclude='deploy-frontend.sh' --exclude='rollback-frontend.sh' \
    --exclude='Dockerfile' --exclude='.env' --exclude='.deploy-build-counter' \
    "$REMOTE_REPO/frontend/" "$DOCROOT/"
chown -R www-data:www-data "$DOCROOT"; chmod -R 755 "$DOCROOT"

# Verify + reload nginx.
[ -f "$DOCROOT/index.html" ] || { echo "❌ index.html missing after sync"; exit 1; }
if systemctl is-active --quiet nginx; then
    nginx -t && systemctl reload nginx && echo "✅ Nginx reloaded"
else
    echo "⚠️  Nginx not running — start it manually."
fi
echo "DEPLOYED commit=$COMMIT build=$BUILD_ID"
REMOTE

# ---- Cloudflare cache purge (local; urbangametheory.xyz zone hosts only this site) ----
echo -e "${YELLOW}☁️  Purging Cloudflare cache...${NC}"
if [[ -n "${CF_ZONE_ID:-}" && -n "${CF_API_KEY:-}" ]]; then
    cf_result=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_KEY}" -H "Content-Type: application/json" \
        --data '{"purge_everything":true}')
    if echo "$cf_result" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
        echo -e "${GREEN}✅ Cloudflare cache purged${NC}"
    else
        echo -e "${RED}❌ Cloudflare purge failed: $cf_result${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  CF_ZONE_ID / CF_API_KEY not set in .env — skipping Cloudflare purge${NC}"
fi

echo -e "${GREEN}🎉 Frontend deployment completed.${NC}"
echo -e "${GREEN}🌐 https://urbangametheory.xyz${NC}"
