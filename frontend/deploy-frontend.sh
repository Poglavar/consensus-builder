#!/bin/bash

# Frontend deployment script for consensus-builder
# Deploys to sshkrpa server

set -e  # Exit on any error

# Configuration
SSHDO='ssh root@67.205.138.129 -i ~/.ssh/id_ed25519'
REMOTE_PATH='/var/www/urbangametheory.xyz'
LOCAL_FRONTEND_PATH='.'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load optional .env for CF_ZONE_ID / CF_API_KEY (Cloudflare cache purge).
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CACHE_COUNTER_FILE='.deploy-build-counter'
BUILD_INFO_FILE='js/build-info.js'
INDEX_FILE='index.html'
RESTORE_TARGETS=()

backup_file() {
    local target="$1"
    if [ ! -f "$target" ]; then
        echo -e "${RED}❌ Error: Required file $target not found.${NC}"
        exit 1
    fi
    local backup
    backup=$(mktemp)
    cp "$target" "$backup"
    RESTORE_TARGETS+=("$target::$backup")
}

restore_modified_files() {
    if [ ${#RESTORE_TARGETS[@]} -eq 0 ]; then
        return
    fi
    for entry in "${RESTORE_TARGETS[@]}"; do
        local target="${entry%%::*}"
        local backup="${entry##*::}"
        if [ -f "$backup" ]; then
            mv "$backup" "$target"
        fi
    done
    RESTORE_TARGETS=()
}

trap restore_modified_files EXIT

prepare_build_cache_token() {
    local current=0
    if [ -f "$CACHE_COUNTER_FILE" ] && grep -Eq '^[0-9]+$' "$CACHE_COUNTER_FILE"; then
        current=$(cat "$CACHE_COUNTER_FILE")
    fi

    BUILD_COUNTER=$((current + 1))
    echo "$BUILD_COUNTER" > "$CACHE_COUNTER_FILE"
    BUILD_ID="deploy-$BUILD_COUNTER"
    BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    backup_file "$BUILD_INFO_FILE"
    backup_file "$INDEX_FILE"

    python3 - "$BUILD_INFO_FILE" "$INDEX_FILE" "$BUILD_ID" "$BUILD_COUNTER" "$BUILD_TIMESTAMP" <<'PY'
import sys
from pathlib import Path

paths = [Path(sys.argv[1]), Path(sys.argv[2])]
build_id = sys.argv[3]
build_number = sys.argv[4]
timestamp = sys.argv[5]
cache_token = build_id

replacements = {
    '__BUILD_ID__': build_id,
    '__BUILD_NUMBER__': build_number,
    '__BUILD_GENERATED_AT__': timestamp,
    '__BUILD_CACHE_TOKEN__': cache_token,
}
for path in paths:
    text = path.read_text()
    for needle, replacement in replacements.items():
        text = text.replace(needle, replacement)
    path.write_text(text)
PY

    echo -e "${YELLOW}🆕 Cache bust token: ${BUILD_ID} (build #${BUILD_COUNTER})${NC}"
}

echo -e "${GREEN}🚀 Starting frontend deployment...${NC}"

# Check if we're in the frontend directory
if [ ! -f "index.html" ]; then
    echo -e "${RED}❌ Error: index.html not found. Please run this script from the frontend directory.${NC}"
    exit 1
fi

if ! command -v python3 > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: python3 is required for cache busting metadata generation.${NC}"
    exit 1
fi

# Check if SSH key exists
if [ ! -f ~/.ssh/id_ed25519 ]; then
    echo -e "${RED}❌ Error: SSH key ~/.ssh/id_ed25519 not found.${NC}"
    exit 1
fi

# Test SSH connection
echo -e "${YELLOW}🔍 Testing SSH connection...${NC}"
if ! $SSHDO "echo 'SSH connection successful'" > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Cannot connect to server. Check your SSH key and server details.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ SSH connection successful${NC}"

# Create remote directory if it doesn't exist
echo -e "${YELLOW}📁 Ensuring remote directory exists...${NC}"
$SSHDO "mkdir -p $REMOTE_PATH"

# Create backup of current deployment
echo -e "${YELLOW}💾 Creating backup of current deployment...${NC}"
BACKUP_NAME="backup_$(date +%Y%m%d_%H%M%S)"
$SSHDO "if [ -d '$REMOTE_PATH' ] && [ \"\$(ls -A $REMOTE_PATH)\" ]; then cp -r $REMOTE_PATH ${REMOTE_PATH}_$BACKUP_NAME; echo 'Backup created: ${REMOTE_PATH}_$BACKUP_NAME'; fi"

# Prepare build metadata for cache busting
prepare_build_cache_token

# Sync files to server
echo -e "${YELLOW}📤 Syncing files to server...${NC}"
rsync -avz --delete \
    --exclude='.git' \
    --exclude='.gitignore' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    --exclude='deploy-frontend.sh' \
    --exclude='Dockerfile' \
    --exclude='.deploy-build-counter' \
    -e "ssh -i ~/.ssh/id_ed25519" \
    ./* root@67.205.138.129:$REMOTE_PATH/

# Set proper permissions
echo -e "${YELLOW}🔐 Setting proper permissions...${NC}"
$SSHDO "chown -R www-data:www-data $REMOTE_PATH && chmod -R 755 $REMOTE_PATH"

# Test if files were deployed correctly
echo -e "${YELLOW}🧪 Verifying deployment...${NC}"
if $SSHDO "test -f $REMOTE_PATH/index.html"; then
    echo -e "${GREEN}✅ index.html found on server${NC}"
else
    echo -e "${RED}❌ Error: index.html not found on server after deployment${NC}"
    exit 1
fi

# Check if nginx is running and reload if needed
echo -e "${YELLOW}🌐 Checking web server status...${NC}"
if $SSHDO "systemctl is-active --quiet nginx"; then
    echo -e "${GREEN}✅ Nginx is running${NC}"
    # Optionally reload nginx to ensure it serves the new files
    $SSHDO "nginx -t && systemctl reload nginx" && echo -e "${GREEN}✅ Nginx configuration reloaded${NC}"
else
    echo -e "${YELLOW}⚠️  Nginx is not running. You may need to start it manually.${NC}"
fi

# Restore any modified local files (build metadata placeholders)
restore_modified_files
trap - EXIT

# Purge Cloudflare cache so users see the new build immediately. The
# urbangametheory.xyz zone hosts only this site, so a full purge is fine.
echo -e "${YELLOW}☁️  Purging Cloudflare cache...${NC}"
if [[ -n "${CF_ZONE_ID:-}" && -n "${CF_API_KEY:-}" ]]; then
    cf_result=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_KEY}" \
        -H "Content-Type: application/json" \
        --data '{"purge_everything":true}')
    if echo "$cf_result" | python3 -c "import sys,json; r=json.load(sys.stdin); sys.exit(0 if r.get('success') else 1)" 2>/dev/null; then
        echo -e "${GREEN}✅ Cloudflare cache purged${NC}"
    else
        echo -e "${RED}❌ Cloudflare purge failed: $cf_result${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  CF_ZONE_ID / CF_API_KEY not set in .env — skipping Cloudflare purge${NC}"
fi

echo -e "${GREEN}🎉 Frontend deployment completed successfully!${NC}"
echo -e "${GREEN}🌐 Your site should be available at: http://urbangametheory.xyz${NC}"

# Show deployment summary
echo -e "\n${YELLOW}📊 Deployment Summary:${NC}"
echo -e "  • Remote path: $REMOTE_PATH"
echo -e "  • Backup created: ${REMOTE_PATH}_$BACKUP_NAME"
echo -e "  • Files synced: $(find . -type f -not -path './.git/*' -not -path './node_modules/*' | wc -l) files"
echo -e "  • Build token: $BUILD_ID (counter $BUILD_COUNTER)"
echo -e "  • Server: 67.205.138.129"
