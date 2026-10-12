#!/usr/bin/env bash
# curve.sh: the learning curve on the GPU box. One train.py run per (training-set size, seed) with the v0 recipe
# (30 epochs, selection eval every 2), then an evaluate-only pass so every run has a score.py pooled.json for the
# ledger. Resumable: runs with selection-eval/pooled.json are skipped, half-trained runs resume from last.pt.
# Several lanes may run at once (one per seed): the tile cache is written atomically and shared.
#   curve.sh <pool-manifest> <dataset-dir> <runs-dir> "<sizes>" "<seeds>" [extra train.py args...]
#   e.g. gpu/job.sh start curve-s1 bash world-parcels/parcel-bench/gpu/curve.sh \
#          world-parcels/parcel-bench/manifests/zagreb-pool-v2.json data/dataset runs/curve "96 200 400 800 1600" "1"
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"                # PARCEL_ROOT on the box
TRAIN="$HERE/../layered/train.py"
PY="${PYTHON:-$ROOT/.venv/bin/python}"
pool="${1:?pool manifest}"; dataset="${2:?dataset dir}"; runs="${3:?runs dir}"; sizes="${4:?sizes}"; seeds="${5:?seeds}"
shift 5
cd "$ROOT"
for seed in $seeds; do for n in $sizes; do
  out="$runs/n${n}-s${seed}"
  if [ -f "$out/selection-eval/pooled.json" ]; then echo "skip $out: done"; continue; fi
  resume=(); [ -f "$out/last.pt" ] && resume=(--resume)
  echo "[$(date -u +%FT%TZ)] run $out (n=$n seed=$seed)"
  "$PY" "$TRAIN" --run --pool "$pool" --dataset "$dataset" --output "$out" --train-tiles "$n" --seed "$seed" \
    --epochs 30 --eval-every 2 "${resume[@]}" "$@"
  "$PY" "$TRAIN" --run --evaluate-only --split selection --pool "$pool" --dataset "$dataset" --output "$out" "$@"
done; done
echo "[$(date -u +%FT%TZ)] curve done for seeds: $seeds (sizes: $sizes)"
