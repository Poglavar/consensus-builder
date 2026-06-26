#!/usr/bin/env bash
# One-shot module extraction: carve named symbols out of proposals.js into a classic-script module,
# parse-check, wire the loader (before proposals.js), and run the fast runtime global-surface gate.
# Behavior gate (e2e) is run separately per batch. Usage: extract.sh <module> ["<header>"]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mod="$1"
header="${2:-// proposals/$mod.js — extracted from proposals.js (behavior-preserving relocation).}"
names="$ROOT/refactor/modules/$mod.names.txt"
out="$ROOT/frontend/js/proposals/$mod.js"
src="$ROOT/frontend/js/proposals.js"

[ -f "$names" ] || { echo "no names file: $names"; exit 2; }
node "$ROOT/refactor/carve.js" "$src" "$out" "$names" "$header"
node --check "$out" && node --check "$src" && echo "parse OK"

# wire loader before 'js/proposals.js' (idempotent)
node -e '
const fs=require("fs"), f="'"$ROOT"'/frontend/index.html", mod="'"$mod"'";
let s=fs.readFileSync(f,"utf8");
const entry="js/proposals/"+mod+".js";
if(!s.includes("'"'"'"+entry+"'"'"'")){
  s=s.replace(/(\n(\s*)'"'"'js\/proposals\.js'"'"',)/, "\n$2'"'"'"+entry+"'"'"',$1");
  fs.writeFileSync(f,s);
  console.log("wired "+entry+" before proposals.js");
} else console.log(entry+" already wired");
'
# fast runtime gate
curl -s -o /dev/null "http://127.0.0.1:8090/index.html" || ( cd "$ROOT" && nohup python3 -m http.server 8090 --directory frontend --bind 127.0.0.1 >/tmp/cb-refactor-serve.log 2>&1 & sleep 1 )
node "$ROOT/refactor/verify-globals.mjs"
echo "proposals.js now: $(wc -l < "$src") lines"
