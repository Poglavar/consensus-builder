#!/usr/bin/env bash
# Publish a committed, pushed catalogue release in its own checkout; preserve the main API checkout.
# Usage: backend/scripts/deploy-novogradnje.sh --run [commit]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${1:-}" != '--run' ]]; then
    echo 'Usage: backend/scripts/deploy-novogradnje.sh --run [pushed commit]'
    exit 0
fi
release="$(git -C "$ROOT" rev-parse "${2:-HEAD}^{commit}")"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || exit 2
ssh "${SSH_HOST:-do}" bash -s -- "$release" <<'REMOTE'
set -euo pipefail
release="$1"
main="$HOME/code/consensus-builder"
web="$HOME/code/consensus-builder-novogradnje"
git -C "$main" fetch origin colosseum-worlds-fair --quiet
git -C "$main" merge-base --is-ancestor "$release" origin/colosseum-worlds-fair
if [[ ! -e "$web" ]]; then
    git -C "$main" worktree add --detach "$web" "$release"
else
    [[ -z "$(git -C "$web" status --porcelain)" ]] || { echo 'Public checkout is dirty; refusing to overwrite it.' >&2; exit 1; }
    git -C "$web" switch --detach "$release"
fi
if [[ ! -e "$web/backend/.env" ]]; then ln -s "$main/backend/.env" "$web/backend/.env"; fi
if [[ ! -e "$web/backend/node_modules" ]] && cmp -s "$web/backend/package-lock.json" "$main/backend/package-lock.json"; then
    ln -s "$main/backend/node_modules" "$web/backend/node_modules"
elif [[ ! -L "$web/backend/node_modules" ]]; then
    (cd "$web/backend" && npm ci --omit=dev --no-audit --no-fund)
elif ! cmp -s "$web/backend/package-lock.json" "$main/backend/package-lock.json"; then
    echo 'Shared dependency lock changed; install isolated dependencies before deploying.' >&2; exit 1
fi
pm2 startOrReload "$web/backend/novogradnje/ecosystem.config.cjs" --only novogradnje-web --update-env >/dev/null
# Wait for this process to answer its actual data route, with a bounded readiness check.
for attempt in {1..20}; do
    if curl -fsS http://127.0.0.1:8490/novogradnje/api/projects > /tmp/novogradnje-deploy-catalogue.json 2>/dev/null; then break; fi
    [[ "$attempt" -lt 20 ]] || exit 1
    sleep 1
done
node -e 'const c=JSON.parse(require("fs").readFileSync("/tmp/novogradnje-deploy-catalogue.json"));if(!c.projects?.length)throw Error("Empty public catalogue");console.log(c.counts)'
install -m 644 "$web/backend/nginx/novogradnje.conf" /etc/nginx/snippets/novogradnje.conf
install -m 644 "$web/backend/nginx/novogradnje-legacy.conf" /etc/nginx/snippets/novogradnje-legacy.conf
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
for site,snippet in [('zagreb.lol','novogradnje.conf'),('urbangametheory.xyz','novogradnje-legacy.conf')]:
    path=Path('/etc/nginx/sites-available')/site
    text=path.read_text()
    include=f'    include snippets/{snippet};'
    if include in text: continue
    # Attach to the TLS server whose server_name names this site, preserving every existing route.
    import re
    matches=list(re.finditer(r'^[ \t]*server_name[ \t]+([^;]+);',text,re.M))
    matches=[m for m in matches if site in m.group(1).split() and
             '443' in text[text.rfind('server {',0,m.start()):text.find('\n}',m.end())]]
    if len(matches)!=1: raise RuntimeError(f'Expected one TLS server for {site}')
    backup=path.with_name(path.name+'.before-novogradnje-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.write_text(text)
    index=matches[0].end()
    path.write_text(text[:index]+'\n'+include+text[index:])
PY
nginx -t
systemctl reload nginx
pm2 save
echo "Novogradnje release $release"
REMOTE
curl --fail --silent --show-error https://zagreb.lol/novogradnje/api/projects | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);if(!c.projects?.length)throw Error("Empty public catalogue");console.log(c.counts)})'
