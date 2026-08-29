#!/bin/sh
# Start the TrueForge standalone runtime with a sandbox-capable TMPDIR.
#
# Node 22+ is required: better-sqlite3, the AI SDK providers and openai do not
# load under the machine's Node 20 shim.
#
# Why TMPDIR matters (this is the whole point of the script):
#
# TrueForge's local sandbox fallback runs Code Mode under the Anthropic Sandbox
# Runtime (bubblewrap). SRT's egress proxy reaches the host through a pair of
# unix sockets it creates in `os.tmpdir()`, and binds them into the sandbox.
# TrueForge's filesystem policy is `denyRead: ["/"]` plus an allow-list, so
# bwrap lays a `--tmpfs /tmp` over everything after that bind — with the default
# TMPDIR the bridge sockets are shadowed and every outbound request inside the
# sandbox dies as `ProxyError('Cannot connect to proxy.')`, surfacing as
# "Sandbox initialization failed: Failed to pip install pydantic". The dirs SRT
# re-binds after the tmpfs are its default write paths, and `/tmp/claude` is one
# of them, so pointing TMPDIR there keeps the sockets reachable. It also has to
# stay short: the Code Mode socket parent (TMPDIR/tf_cms) is capped at 65 bytes.
#
# Verify with `npm run -w @trueforge-android/server smoke:sandbox` after any
# change here.
set -e

TMPDIR=${TRUEFORGE_TMPDIR:-/tmp/claude}
mkdir -p "$TMPDIR"
export TMPDIR

NODE_BIN=${TRUEFORGE_NODE_BIN:-/home/omkar/.nvm/versions/node/v22.23.2/bin}
PATH="$NODE_BIN:$PATH"
export PATH

exec npx --yes @truefoundry/trueforge "$@"
