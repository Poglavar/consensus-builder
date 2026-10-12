#!/usr/bin/env bash
# job.sh: start a training job on a Linux GPU box so it outlives the SSH session and the agent's tool call,
# then check on it cheaply. The Linux counterpart of the laptop's run-job (which needs launchd).
# State lives in $PARCEL_ROOT/jobs/<name>.{log,pid,rc,sh}.
#   job.sh start <name> <command...>   job.sh status <name>   job.sh log <name> [n]   job.sh stop <name>   job.sh list
set -euo pipefail
ROOT="${PARCEL_ROOT:-$HOME/parcel-bench}"; JOBS="$ROOT/jobs"; mkdir -p "$JOBS"
cmd="${1:-}"; name="${2:-}"
case "$cmd" in
  start)
    shift 2; [ -n "$name" ] && [ $# -gt 0 ] || { echo "usage: job.sh start <name> <command...>" >&2; exit 2; }
    printf '%q ' "$@" > "$JOBS/$name.sh"; rm -f "$JOBS/$name.rc"
    # setsid + nohup detach from the terminal; the wrapper records the exit code when the command ends.
    setsid nohup bash -c "cd '$ROOT' && { $(printf '%q ' "$@"); echo \$? > '$JOBS/$name.rc'; }" \
      >> "$JOBS/$name.log" 2>&1 < /dev/null &
    echo $! > "$JOBS/$name.pid"; echo "$name started pid $(cat "$JOBS/$name.pid")" ;;
  status)
    [ -n "$name" ] || { echo "usage: job.sh status <name>" >&2; exit 2; }
    if [ -f "$JOBS/$name.rc" ]; then rc=$(cat "$JOBS/$name.rc"); [ "$rc" = 0 ] && echo "done(0)" || echo "failed($rc)"
    elif [ -f "$JOBS/$name.pid" ] && kill -0 "$(cat "$JOBS/$name.pid")" 2>/dev/null; then echo running
    elif [ -f "$JOBS/$name.pid" ]; then echo lost; else echo unknown; fi ;;
  log) tail -n "${3:-20}" "$JOBS/$name.log" ;;
  stop) [ -f "$JOBS/$name.pid" ] && pkill -TERM -s "$(cat "$JOBS/$name.pid")" && echo stopped > "$JOBS/$name.rc" ;;
  list) for f in "$JOBS"/*.sh; do [ -e "$f" ] || continue; n=$(basename "$f" .sh); echo "$n $("$0" status "$n")"; done ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
