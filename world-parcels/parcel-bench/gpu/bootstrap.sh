#!/usr/bin/env bash
# ParcelBench GPU bootstrap: idempotent setup of a rented CUDA box (Ubuntu) for parcel-model training.
# Creates the venv, installs requirements, and refuses to finish unless PyTorch actually sees a GPU.
# Written 2026-10-12 on macOS and NOT yet exercised on a CUDA host: read what it prints the first time.
set -euo pipefail

ROOT="${PARCEL_ROOT:-$HOME/parcel-bench}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "root: $ROOT"
mkdir -p "$ROOT/data" "$ROOT/runs" "$ROOT/jobs"

if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  log "installing system packages"
  apt-get update -qq && apt-get install -y -qq python3-venv python3-pip git rsync tmux >/dev/null
fi

# The image's torch (with CUDA) is reused through --system-site-packages; only the rest is installed.
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  log "creating venv (system site packages so the image's CUDA torch is reused)"
  python3 -m venv --system-site-packages "$ROOT/.venv"
fi
"$ROOT/.venv/bin/pip" install -q --upgrade pip
if ! "$ROOT/.venv/bin/python" -c "import torch, torchvision" 2>/dev/null; then
  log "image has no torch; installing torch + torchvision from PyPI (CUDA wheels on Linux)"
  "$ROOT/.venv/bin/pip" install -q torch torchvision
fi
log "installing requirements"
"$ROOT/.venv/bin/pip" install -q -r "$HERE/requirements.txt"

log "GPU check"
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || log "nvidia-smi not found"
"$ROOT/.venv/bin/python" - <<'PY'
import sys, torch
ok = torch.cuda.is_available()
print(f'torch {torch.__version__} cuda_available={ok}')
if ok:
    props = torch.cuda.get_device_properties(0)
    print(f'gpu {props.name} {props.total_memory / 2**30:.1f} GiB')
sys.exit(0 if ok else 1)
PY

log "disk"; df -h "$ROOT" | tail -1
log "done; activate with: source $ROOT/.venv/bin/activate"
