#!/bin/bash

# Frontend deployment script for consensus-builder.
#
# Migrated from the old "rsync the local working tree" pattern to a server-side Git sync:
# the server fetches the selected branch (colosseum-worlds-fair, the production branch, by default),
# stamps a cache-bust build token, and syncs frontend/ into the nginx docroot. Deploys now ship exactly
# what's on that remote branch (so: commit + push before deploying), and do not depend on local
# working-tree state. The Cloudflare cache purge still runs locally (uses this dir's optional .env),
# and the deploy ends by reading the public release.json back and comparing its commit.
# rollback-frontend.sh restores the one docroot backup this script keeps.

set -euo pipefail

# ---- Configuration ----
SSH_HOST="${SSH_HOST:-prod-de}"
BRANCH="${BRANCH:-colosseum-worlds-fair}"                       # production runs this branch, not main
REPO_URL='https://github.com/Poglavar/consensus-builder.git'   # HTTPS: no server deploy key needed
REMOTE_REPO='/opt/consensus-builder'                           # server-side clone (deploy-only)
DOCROOT='/var/www/urbangametheory.xyz'                         # nginx docroot
# Laptop-generated runtime config lands here first (same filesystem as the docroot, outside it),
# so the remote block can rename it into the docroot atomically before the HTML switch.
CONFIG_INCOMING="${DOCROOT}_config_incoming"
COUNTER_FILE='/opt/.cb-frontend-deploy-counter'                # lives OUTSIDE the repo (survives reset --hard)
SITE_URL="${SITE_URL:-https://urbangametheory.xyz}"            # public origin the release check reads
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load optional .env for CF_ZONE_ID / CF_API_KEY (Cloudflare cache purge).
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ssh_server() { ssh -o StrictHostKeyChecking=accept-new "$SSH_HOST" "$@"; }

# Guard: the server deploys origin/$BRANCH, so the local HEAD must BE origin/$BRANCH. Otherwise the
# deploy silently ships something other than what was tested here (unpushed commits are left
# behind; a stale checkout ships someone else's newer push). Same guard as backend/deploy-backend.sh.
git -C "$SCRIPT_DIR" fetch --quiet origin "${BRANCH}"
LOCAL_HEAD="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$SCRIPT_DIR" rev-parse "origin/${BRANCH}")"
if [[ "${LOCAL_HEAD}" != "${REMOTE_HEAD}" ]]; then
    if git -C "$SCRIPT_DIR" merge-base --is-ancestor "${LOCAL_HEAD}" "${REMOTE_HEAD}"; then
        echo -e "${RED}❌ Local HEAD ${LOCAL_HEAD:0:9} is behind origin/${BRANCH} (${REMOTE_HEAD:0:9}) — pull first, so you deploy what you tested.${NC}" >&2
    else
        echo -e "${RED}❌ Local HEAD ${LOCAL_HEAD:0:9} is not on origin/${BRANCH} (${REMOTE_HEAD:0:9}) — push it (or set BRANCH=<the branch you are on>).${NC}" >&2
    fi
    exit 1
fi

echo -e "${GREEN}🚀 Deploying frontend via server-side git pull at ${LOCAL_HEAD:0:9} (origin/${BRANCH})...${NC}"

# Seed the server-side build counter from the local one on first run, so the deploy-N sequence
# continues rather than restarting at 1.
SEED=0
if [ -f "$SCRIPT_DIR/.deploy-build-counter" ] && grep -Eq '^[0-9]+$' "$SCRIPT_DIR/.deploy-build-counter"; then
    SEED=$(cat "$SCRIPT_DIR/.deploy-build-counter")
fi

python3 "$SCRIPT_DIR/../scripts/build-carto-config.py" --env "${CARTO_ENV_FILE:-$SCRIPT_DIR/../.env}" --out "$SCRIPT_DIR/carto-config.js"
python3 "$SCRIPT_DIR/../scripts/build-rpc-config.py" --env "${SOLANA_ENV_FILE:-$SCRIPT_DIR/../backend/.env}" --out "$SCRIPT_DIR/rpc-config.js"

# ---- SSH connectivity ----
echo -e "${YELLOW}🔍 Testing SSH connection...${NC}"
if ! ssh_server 'echo ok' >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: cannot SSH to $SSH_HOST (check your SSH configuration).${NC}"; exit 1
fi
echo -e "${GREEN}✅ SSH connection successful${NC}"

# Upload the generated config BEFORE anything changes on the server: a failed upload aborts here
# (set -e) with the live docroot untouched. The remote block moves the files in before the HTML.
ssh_server "mkdir -p '$CONFIG_INCOMING'"
scp "$SCRIPT_DIR/carto-config.js" "$SCRIPT_DIR/rpc-config.js" "$SSH_HOST:$CONFIG_INCOMING/"

# ---- Remote deploy: clone-or-update, stamp build token, back up, sync to docroot, reload nginx ----
ssh_server "BRANCH='$BRANCH' REPO_URL='$REPO_URL' REMOTE_REPO='$REMOTE_REPO' DOCROOT='$DOCROOT' CONFIG_INCOMING='$CONFIG_INCOMING' COUNTER_FILE='$COUNTER_FILE' SEED='$SEED' EXPECTED_SHA='$LOCAL_HEAD' bash -s" <<'REMOTE'
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
COMMIT=$(git rev-parse HEAD)
echo "✅ Repo at origin/$BRANCH (${COMMIT:0:7})"
if [ "$COMMIT" != "$EXPECTED_SHA" ]; then
    echo "❌ Server HEAD ${COMMIT:0:9} does not match local HEAD ${EXPECTED_SHA:0:9} (a push landed between the local check and the sync?) — aborting before the docroot changes." >&2
    exit 1
fi

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
python3 - "$REMOTE_REPO/frontend/js/build-info.js" "$REMOTE_REPO/frontend/index.html" \
    "$REMOTE_REPO/frontend/release.json" "$BUILD_ID" "$counter" "$TS" "$COMMIT" <<'PY'
import sys
from pathlib import Path
paths = [Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])]
rep = {'__BUILD_ID__': sys.argv[4], '__BUILD_NUMBER__': sys.argv[5],
       '__BUILD_GENERATED_AT__': sys.argv[6], '__BUILD_CACHE_TOKEN__': sys.argv[4],
       '__RELEASE_COMMIT__': sys.argv[7]}
for p in paths:
    if not p.exists():
        continue
    t = p.read_text()
    for k, v in rep.items():
        t = t.replace(k, v)
    p.write_text(t)
PY
echo "🆕 Cache-bust token: $BUILD_ID"

# build-static.cjs minifies every bundle with esbuild, a backend devDependency it resolves from
# backend/ upwards, and stops when it is missing. This deploy-only clone has no backend install (a full
# one is ~600 MB), so install just the version backend/package-lock.json locks into the clone's own
# node_modules (gitignored, so reset --hard keeps it), and only when the installed one differs.
ESBUILD_LOCKED=$(node -p "require('$REMOTE_REPO/backend/package-lock.json').packages['node_modules/esbuild'].version")
ESBUILD_INSTALLED=$(node -p "try { require('$REMOTE_REPO/node_modules/esbuild/package.json').version } catch (error) { '' }")
if [ "$ESBUILD_INSTALLED" != "$ESBUILD_LOCKED" ]; then
    echo "📦 Installing esbuild $ESBUILD_LOCKED for bundle minification (found: ${ESBUILD_INSTALLED:-none})"
    npm install --prefix "$REMOTE_REPO" --no-save --no-package-lock --no-audit --no-fund "esbuild@$ESBUILD_LOCKED"
fi

# Build immutable production-only classic-script bundles from the freshly reset, metadata-stamped
# source tree. The builder writes a staged copy and never mutates the checked-out frontend.
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cb-frontend-static.XXXXXX")
trap 'rm -rf "$STAGING_DIR"' EXIT
node "$REMOTE_REPO/frontend/build-static.cjs" "$STAGING_DIR" "$REMOTE_REPO/frontend"

# Keep exactly one backup: the deployment that is live right now. Copy it, then delete every
# older backup. Unbounded backups once filled the disk (222 copies, 4.4 GB by 2026-08-15).
if [ -d "$DOCROOT" ] && [ -n "$(ls -A "$DOCROOT" 2>/dev/null)" ]; then
    # Match only our own timestamped backups, never $DOCROOT itself.
    OLD_BACKUPS=$(ls -d "${DOCROOT}"_backup_* 2>/dev/null \
        | grep -E "^${DOCROOT}_backup_[0-9]{8}_[0-9]{6}$" || true)
    BACKUP="${DOCROOT}_backup_$(date +%Y%m%d_%H%M%S)"
    rsync -a "$DOCROOT/" "$BACKUP/"
    echo "💾 Backup: $BACKUP ($(du -sh "$BACKUP" | cut -f1))"
    OLD_BACKUPS=$(echo "$OLD_BACKUPS" | grep -v -x -F "$BACKUP" || true)
    if [ -n "$OLD_BACKUPS" ]; then
        echo "$OLD_BACKUPS" | xargs rm -rf
        echo "🧹 Deleted $(echo "$OLD_BACKUPS" | wc -l | tr -d ' ') older backup(s)"
    fi
fi

# Sync frontend/ -> docroot (server-local rsync). Keep dev/deploy artefacts out of the docroot.
mkdir -p "$DOCROOT"
# Two passes so HTML lands last. nginx serves ?build=deploy-N assets as immutable for a year
# (backend/nginx/urbangametheory.xyz.nginx.conf); if the new index.html went live before the new
# scripts, a visitor could fetch an OLD script under the NEW build URL and keep it for a year.
# Pass 1 adds every changed non-HTML file without deleting anything (old pages still find their
# files); pass 2 swaps in the HTML and deletes leftovers.
# carto-config.js / rpc-config.js are generated on the deploying laptop (gitignored, so absent from
# the staging tree). Both passes exclude them, which also protects the live copies from --delete.
rsync -a \
    --exclude='*.html' \
    --exclude='.git' --exclude='.gitignore' --exclude='node_modules' --exclude='.DS_Store' \
    --exclude='deploy-frontend.sh' --exclude='rollback-frontend.sh' \
    --exclude='Dockerfile' --exclude='.env' --exclude='.deploy-build-counter' \
    --exclude='/carto-config.js' --exclude='/rpc-config.js' \
    "$STAGING_DIR/" "$DOCROOT/"
# Move the uploaded config in after the scripts and before the HTML. A rename within /var/www is
# atomic, so the docroot never lacks either file.
for config_file in carto-config.js rpc-config.js; do
    [ -s "$CONFIG_INCOMING/$config_file" ] || { echo "❌ $CONFIG_INCOMING/$config_file missing — the upload failed" >&2; exit 1; }
    mv -f "$CONFIG_INCOMING/$config_file" "$DOCROOT/$config_file"
done
rsync -a --delete \
    --exclude='.git' --exclude='.gitignore' --exclude='node_modules' --exclude='.DS_Store' \
    --exclude='deploy-frontend.sh' --exclude='rollback-frontend.sh' \
    --exclude='Dockerfile' --exclude='.env' --exclude='.deploy-build-counter' \
    --exclude='/carto-config.js' --exclude='/rpc-config.js' \
    "$STAGING_DIR/" "$DOCROOT/"
# Excluded destination files survive rsync --delete. Remove exact deployment artefacts that an
# older deployment may already have copied into the public docroot.
rm -f \
    "$DOCROOT/deploy-frontend.sh" \
    "$DOCROOT/rollback-frontend.sh" \
    "$DOCROOT/deploy-to-server.sh"
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
        --data '{"purge_everything":true}' || true)   # a curl failure lands in the failure branch below, not a silent set -e exit
    if echo "$cf_result" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
        echo -e "${GREEN}✅ Cloudflare cache purged${NC}"
    else
        # Exit non-zero: the docroot is live but Cloudflare may keep serving the old assets, so the
        # deploy is NOT complete. Re-run the purge (or the whole deploy) once the cause is fixed.
        echo -e "${RED}❌ Cloudflare purge failed: $cf_result${NC}" >&2
        echo -e "${RED}❌ Frontend files are deployed, but the edge cache was not purged — deploy NOT complete.${NC}" >&2
        exit 1
    fi
else
    # Same verdict as a failed purge: without it Cloudflare may keep serving the old assets.
    echo -e "${RED}❌ CF_ZONE_ID / CF_API_KEY not set in frontend/.env — Cloudflare cache NOT purged.${NC}" >&2
    echo -e "${RED}❌ Frontend files are deployed, but the edge cache was not purged — deploy NOT complete.${NC}" >&2
    exit 1
fi

# ---- Release verification: read the public release.json back (cache-busted) ----
echo -e "${YELLOW}🔎 Verifying ${SITE_URL}/release.json...${NC}"
release_json=$(curl -fsS --max-time 20 -H 'Cache-Control: no-cache' \
    "${SITE_URL}/release.json?verify=${LOCAL_HEAD:0:9}-$(date +%s)" || true)
LIVE_COMMIT=$(printf '%s' "$release_json" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit') or '')" 2>/dev/null || true)
if [[ "$LIVE_COMMIT" != "$LOCAL_HEAD" ]]; then
    echo -e "${RED}❌ Public release.json reports commit '${LIVE_COMMIT:-<unreadable>}', expected ${LOCAL_HEAD} — deploy NOT verified.${NC}" >&2
    exit 1
fi
echo -e "${GREEN}✅ Public release.json reports ${LIVE_COMMIT:0:9}${NC}"

echo -e "${GREEN}🎉 Frontend deployment completed.${NC}"
echo -e "${GREEN}🌐 ${SITE_URL}${NC}"
