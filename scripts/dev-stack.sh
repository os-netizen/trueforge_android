#!/usr/bin/env bash
# Start the complete local TrueForge Android development stack.
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PINNED_NODE_BIN=/home/omkar/.nvm/versions/node/v22.23.2/bin

if [[ -n "${TRUEFORGE_NODE_BIN:-}" ]]; then
  if [[ ! -x "$TRUEFORGE_NODE_BIN/node" || ! -x "$TRUEFORGE_NODE_BIN/npm" ]]; then
    echo "Node and npm were not found in TRUEFORGE_NODE_BIN=$TRUEFORGE_NODE_BIN." >&2
    exit 1
  fi
  export PATH="$TRUEFORGE_NODE_BIN:$PATH"
elif [[ -x "$PINNED_NODE_BIN/node" && -x "$PINNED_NODE_BIN/npm" ]]; then
  export PATH="$PINNED_NODE_BIN:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node 22+ and npm are required (set TRUEFORGE_NODE_BIN to their bin directory)." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if ((NODE_MAJOR < 22)); then
  echo "Node 22+ is required; found $(node --version)." >&2
  exit 1
fi

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
start_component "Dashboard :5173" npm run -w dashboard dev -- --host 0.0.0.0 --port 5173 --strictPort

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
