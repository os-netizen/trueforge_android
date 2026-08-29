#!/usr/bin/env bash
# Connect to the tablet over the network with as few manual steps as possible.
#
#   scripts/adb-connect.sh                     # normal case: connect on the fixed port
#   scripts/adb-connect.sh --bootstrap <port>  # after a reboot, using the rotating
#                                              # "IP address & port" from Wireless debugging
#   scripts/adb-connect.sh --pair <port> <code>  # only if the pairing was lost
#
# Override the address with TABLET_HOST=<ip> if Tailscale hands out a new one.

set -euo pipefail

ADB="${ADB:-/home/omkar/Android/Sdk/platform-tools/adb}"
HOST="${TABLET_HOST:-100.116.152.115}"
PORT="${TABLET_PORT:-5555}"

connected() {
  "$ADB" devices | grep -q "^${HOST}:${PORT}[[:space:]]*device$"
}

case "${1:-}" in
  --pair)
    "$ADB" pair "${HOST}:${2:?pairing port required}" "${3:?pairing code required}"
    echo "Paired. Now run: $0 --bootstrap <connection port>"
    ;;
  --bootstrap)
    boot_port="${2:?connection port required}"
    "$ADB" connect "${HOST}:${boot_port}"
    # Switch adbd to classic tcpip mode on a fixed port; this is what removes the
    # pairing code and the rotating port from every later session.
    "$ADB" -s "${HOST}:${boot_port}" tcpip "$PORT"
    sleep 3
    "$ADB" connect "${HOST}:${PORT}"
    ;;
  "")
    if connected; then
      echo "Already connected: ${HOST}:${PORT}"
    else
      "$ADB" connect "${HOST}:${PORT}" || true
    fi
    ;;
  *)
    echo "usage: $0 [--bootstrap <port> | --pair <port> <code>]" >&2
    exit 2
    ;;
esac

"$ADB" devices -l
if ! connected; then
  cat >&2 <<'MSG'

Not connected on the fixed port. The tablet has most likely rebooted, which resets
adbd back to Wireless debugging mode. Open Developer options -> Wireless debugging,
read the "IP address & port" line, and run:

    scripts/adb-connect.sh --bootstrap <that port>

Only if that is also refused do you need to re-pair with a code.
MSG
  exit 1
fi
