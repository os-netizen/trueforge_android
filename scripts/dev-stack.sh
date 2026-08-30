#!/usr/bin/env bash
# Start the complete local TrueForge Android development stack.
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE_BIN=${TRUEFORGE_NODE_BIN:-/home/omkar/.nvm/versions/node/v22.23.2/bin}

if [[ ! -x "$NODE_BIN/node" || ! -x "$NODE_BIN/npm" ]]; then
  echo "Node 22+ was not found in $NODE_BIN (set TRUEFORGE_NODE_BIN to override)." >&2
  exit 1
fi

export PATH="$NODE_BIN:$PATH"

declare -a CHILD_PIDS=()
declare -a CHILD_NAMES=()

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if ((${#CHILD_PIDS[@]})); then
    echo
    echo "Stopping TrueForge Android stack..."
    for pid in "${CHILD_PIDS[@]}"; do
      kill -- "-$pid" 2>/dev/null || true
    done
    for pid in "${CHILD_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_component() {
  local name=$1
  shift

  "$@" &
  CHILD_PIDS+=("$!")
  CHILD_NAMES+=("$name")
  echo "Started $name (pid $!)"
}

# Give each background job its own process group so cleanup also stops npm/npx
# children spawned underneath the three top-level commands.
set -m
cd "$ROOT_DIR"

start_component "TrueForge runtime :8790" "$ROOT_DIR/scripts/trueforge-start.sh"
start_component "Android bridge/API :8791/:8792" npm run dev:server
start_component "Dashboard :5173" npm run -w dashboard dev -- --host 0.0.0.0

echo "TrueForge Android stack is starting. Press Ctrl-C to stop all components."
echo "Dashboard: http://127.0.0.1:5173"

while true; do
  for index in "${!CHILD_PIDS[@]}"; do
    pid=${CHILD_PIDS[$index]}
    if ! kill -0 "$pid" 2>/dev/null; then
      set +e
      wait "$pid"
      status=$?
      set -e
      echo "${CHILD_NAMES[$index]} exited with status $status; stopping the stack." >&2
      if ((status == 0)); then
        exit 1
      fi
      exit "$status"
    fi
  done
  sleep 1
done
