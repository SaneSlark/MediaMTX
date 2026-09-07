#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/recordings /var/log /app/proxy/media_cache

MEDIAMTX_CONFIG="${MEDIAMTX_CONFIG:-/config/mediamtx.yml}"

pids=()

shutdown() {
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait || true
}

trap shutdown SIGINT SIGTERM

mediamtx "$MEDIAMTX_CONFIG" &
pids+=("$!")

python3 /app/delay/camera-delay.py &
pids+=("$!")

npm --prefix /app/proxy start &
pids+=("$!")

wait -n "${pids[@]}"
exit_code="$?"

shutdown
exit "$exit_code"
