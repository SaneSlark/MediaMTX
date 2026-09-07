#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/recordings /var/log /app/proxy/media_cache

MEDIAMTX_CONFIG="${MEDIAMTX_CONFIG:-/config/mediamtx.yml}"

pids=()

shutdown() {
  trap '' SIGINT SIGTERM
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Give children a bounded grace period, then terminate any stuck child.
  for ((attempt = 0; attempt < 5; attempt++)); do
    alive=false
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    if ! $alive; then break; fi
    sleep 1
  done
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  wait || true
}

trap shutdown EXIT
trap 'exit 130' SIGINT
trap 'exit 143' SIGTERM

mediamtx "$MEDIAMTX_CONFIG" &
pids+=("$!")

python3 -u /app/delay/camera-delay.py &
pids+=("$!")

node /app/proxy/replay-proxy.js &
pids+=("$!")

exit_code=0
wait -n "${pids[@]}" || exit_code=$?
exit "$exit_code"
