#!/bin/bash

# Frontend rollback script for consensus-builder.
# Restores the single backup that deploy-frontend.sh keeps (the deployment before the current one).
# The live docroot then becomes the one backup, so running this twice undoes the rollback.
# data/hmlr/ is never backed up or restored: the HMLR routing releases are published separately.

set -euo pipefail

SSH_HOST="${SSH_HOST:-prod-de}"   # ssh alias for the prod server; set SSH_HOST to override
DOCROOT='/var/www/urbangametheory.xyz'

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ssh_server() { ssh -o StrictHostKeyChecking=accept-new "$SSH_HOST" "$@"; }

echo -e "${YELLOW}🔍 Looking for the backup on $SSH_HOST...${NC}"
BACKUP=$(ssh_server "ls -d '${DOCROOT}'_backup_* 2>/dev/null | grep -E '^${DOCROOT}_backup_[0-9]{8}_[0-9]{6}\$' | sort -r | head -1" || true)
if [ -z "$BACKUP" ]; then
    echo -e "${RED}❌ No backup found (${DOCROOT}_backup_YYYYMMDD_HHMMSS).${NC}"; exit 1
fi
if ! ssh_server "test -f '$BACKUP/index.html'"; then
    echo -e "${RED}❌ $BACKUP has no index.html; refusing to restore it.${NC}"; exit 1
fi
echo -e "${GREEN}📦 Backup: $(basename "$BACKUP")${NC}"

read -r -p "$(echo -e "${YELLOW}Replace the live frontend with this backup? [y/N] ${NC}")" ANSWER
[[ "$ANSWER" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

ssh_server "DOCROOT='$DOCROOT' RESTORE='$BACKUP' bash -s" <<'REMOTE'
set -euo pipefail
# Back up the live deployment first, so the rollback itself can be undone.
CURRENT="${DOCROOT}_backup_$(date +%Y%m%d_%H%M%S)"
rsync -a --exclude='/data/hmlr/' "$DOCROOT/" "$CURRENT/"
echo "💾 Backup of the live deployment: $CURRENT"

# --checksum: a same-size file changed within the same second would otherwise be skipped.
rsync -a --delete --checksum --exclude='/data/hmlr/' "$RESTORE/" "$DOCROOT/"
chown -R www-data:www-data "$DOCROOT"; chmod -R 755 "$DOCROOT"
[ -f "$DOCROOT/index.html" ] || { echo "❌ index.html missing after restore"; exit 1; }
echo "✅ Restored $RESTORE"

# Keep only the backup just made; the restored one is live now.
ls -d "${DOCROOT}"_backup_* 2>/dev/null \
    | grep -E "^${DOCROOT}_backup_[0-9]{8}_[0-9]{6}$" \
    | grep -v -x -F "$CURRENT" | xargs -r rm -rf

if systemctl is-active --quiet nginx; then
    nginx -t && systemctl reload nginx && echo "✅ Nginx reloaded"
else
    echo "⚠️  Nginx not running — start it manually."
fi
REMOTE

echo -e "${GREEN}🎉 Rollback completed: https://urbangametheory.xyz${NC}"
