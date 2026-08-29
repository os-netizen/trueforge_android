# TrueForge Android Development Notes

## Local stack and troubleshooting

The complete local stack has three backend services plus the dashboard. A connected tablet and a running bridge are not enough to execute dashboard runs.

- TrueForge standalone runtime: `127.0.0.1:8790`
- Android MCP bridge: `127.0.0.1:8791`
- Device WebSocket/API server: `0.0.0.0:8792`
- Vite dashboard: `0.0.0.0:5173`

Before diagnosing a failed dashboard run, check all four listeners and query `http://127.0.0.1:8792/dashboard/status`. The currently installed TrueForge runtime serves its UI at `http://127.0.0.1:8790/`, but returns `404 Route not found` for `/health`; use the root response and the 8790 listener/process to establish liveness instead of treating that 404 as a dead runtime. The tablet can display "connected" while dashboard runs fail because its WebSocket only proves that port 8792 is healthy.

Start TrueForge standalone with `scripts/trueforge-start.sh`. It pins Node 22 or newer — the current package and dependencies such as `better-sqlite3`, AI SDK providers, and `openai` do not support the machine's Node 20 shim — and sets the TMPDIR the local sandbox needs (see "Sandbox and Code Mode" below):

```sh
scripts/trueforge-start.sh
```

An immediate dashboard failure with `eventCount: 0` and `error: "fetch failed"` usually means `TRUEFORGE_BASE_URL` (`http://127.0.0.1:8790`) is unreachable. Restore the TrueForge runtime before debugging the tablet or model.

Dashboard HTTP calls must use the stable `/api` prefix. Vite dev and preview proxy `/api` to port 8792, and the bridge accepts `/api/...` directly. Do not select the API base from `window.location.port`: Tailscale hostnames can omit or change the visible port, causing status requests to return frontend HTML and leaving device-dependent controls disabled.

The Android `launch_app` action can report failure for an installed app. For example, `com.whatsapp` failed to launch directly on the SM-T505 even though WhatsApp was installed. Re-observe, open the Samsung app drawer, locate the app by accessibility label, click its current snapshot node, and verify the final foreground package. Do not infer that an app is absent from a failed package launch alone.

The dashboard's left navigation icons and Pause button are currently prototype placeholders without handlers. Refresh, Inspector/Logs tabs, run selection, prompt entry, and Send are the implemented controls.

## Tablet installation and Wireless ADB

`adb` is installed at `/home/omkar/Android/Sdk/platform-tools/adb` but may not be on the shell `PATH`. Use that absolute path for discovery, pairing, connection, and installation.

Wireless Debugging has two different ephemeral ports:

- "Pair device with pairing code" supplies the pairing port and six-digit code; run `adb pair <tablet-ip>:<pairing-port>`.
- The main Wireless debugging screen supplies a separate "IP address & port" endpoint; run `adb connect <tablet-ip>:<connection-port>` after pairing.

Pairing success does not make the tablet appear in `adb devices`; the separate connect step is mandatory. Android mDNS discovery may remain empty across Tailscale or different Wi-Fi segments even when direct pairing and connection to the tablet's Tailscale IP work. The SM-T505's Tailscale IP was `100.116.152.115` during the 2026-08-29 session, but verify it because addresses and both ADB ports can change.

USB debugging is not usable from this environment. Claude Code runs inside WSL2 with NAT networking and no USB passthrough: there is no `/dev/bus/usb`, no `lsusb`, and `usbipd` is not installed, so `adb devices` stays empty no matter what the tablet's USB setting says. Every connection is a network connection. For the same reason `adb mdns services` always returns an empty list — multicast crosses neither the WSL NAT boundary nor the Tailscale point-to-point link — so auto-discovery is never the answer.

Prefer the fixed port over Wireless debugging's rotating one. `scripts/adb-connect.sh` wraps this:

```sh
scripts/adb-connect.sh                     # normal case, no code and no port lookup
scripts/adb-connect.sh --bootstrap <port>  # after a tablet reboot
scripts/adb-connect.sh --pair <port> <code>  # only when the pairing is really gone
```

One `adb tcpip 5555` against a live Wireless-debugging connection restarts adbd in classic TCP mode on port 5555, which needs no pairing code and does not rotate. That survives until the tablet reboots or Wireless debugging is toggled; pinning it across reboots would need `persist.adb.tcp.port`, which requires root the stock SM-T505 does not have. After the switch the old rotating endpoint goes `offline` — disconnect it — and adbd is briefly unreachable, so a single `error: closed` immediately afterwards is expected rather than a failure. Note that port 5555 accepts any host that can reach the tablet, so it is safe on the tailnet but not on untrusted Wi-Fi.

Try connecting before asking for a pairing code. The pairing persists across reboots, port rotations, and failed installs, and `adb pair` against an already-paired device fails with a misleading `protocol fault (couldn't read status message): Success`. Ask only for the "IP address & port" from the main Wireless debugging screen; treat the pairing code as a last resort.

Installing the roughly 40 MB debug APK over Tailscale can take longer than a normal command yield. If `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` remains active, inspect its process and wait; do not start a competing install. Do not infer success merely because the installer process exited.

Confirm completion against the **debug** application id. `android/app/build.gradle.kts` sets `applicationIdSuffix = ".debug"`, so the installed package is `dev.trueforge.operator.debug`; `pm path dev.trueforge.operator` returns empty output for a perfectly good install and reads exactly like a failure:

```sh
adb -s <endpoint> shell pm path dev.trueforge.operator.debug
adb -s <endpoint> shell dumpsys package dev.trueforge.operator.debug | grep lastUpdateTime
```

Only the application id is suffixed — Kotlin packages, and therefore the relative class names in `AndroidManifest.xml`, stay under `dev.trueforge.operator`. To prove a specific new build is really on the device rather than a stale one, grep `dumpsys package` for a component that only exists in the new code (for example `ApprovalDecisionReceiver`).

When the wire protocol changes, build and install the matching APK before restarting the updated bridge where possible. A new server paired with an old tablet APK can disconnect on protocol-version mismatch and make an otherwise healthy stack look broken.

A streamed install can die partway through with `adb: failed to run abb_exec. Error: closed` followed by `device offline`. When that happens the tablet rotates its wireless-debugging **connection** port immediately: the old port then answers `Connection refused` even though the tablet still pings normally over Tailscale, and `adb devices` shows the stale endpoint as `offline`. The pairing survives — re-pairing returns the same `guid` and does not restore or reveal the connection port. Ask for the current "IP address & port" from the main Wireless debugging screen and reconnect with that; only re-pair (toggling Wireless debugging off and on) if a fresh connection port is also refused. Do not read a refused connect as a lost pairing.

## Sandbox and Code Mode (Milestone 7)

Start the runtime with `scripts/trueforge-start.sh`, not a bare `npx @truefoundry/trueforge`. Enabling `config.sandbox` on the agent is all it takes to turn on Code Mode; standalone TrueForge ships a bubblewrap-isolated `LocalSandboxProvider` and needs no Daytona provider, but it only engages when the host has `bwrap`, `socat`, `rg`, a shell and `python3` and the startup log says `Local sandbox fallback is available`. The probe runs once at startup, so installing a missing binary does nothing until the runtime is restarted.

That log line is necessary but not sufficient. On this machine the sandbox came up and then failed every run with `Sandbox initialization failed: Failed to pip install pydantic ... ProxyError('Cannot connect to proxy.')`. The cause is TMPDIR, not the network — pip works fine on the host and even inside a hand-rolled `srt` sandbox. The Anthropic Sandbox Runtime creates its egress-proxy bridge sockets in `os.tmpdir()` and binds them into the sandbox, but TrueForge's filesystem policy is `denyRead: ["/"]` plus an allow-list, so bwrap lays `--tmpfs /tmp` over that bind *after* it — the socket vanishes and the in-sandbox socat on port 3128 has nothing to forward to. The dirs re-bound after the tmpfs are SRT's default write paths, so pointing TMPDIR at one of them (the start script uses `/tmp/claude`) fixes it with no root and no code change. Keep the path short: the Code Mode socket parent is `TMPDIR/tf_cms` and is capped at 65 bytes, which is why the sandbox-runtime `vendor` directory — also re-bound, also writable — cannot be used.

Verify with `npm run -w @trueforge-android/server smoke:sandbox`, which asserts a `sandbox.created` event and a correct arithmetic answer. `sandboxAvailable()` in `setup.ts` mirrors the runtime's host-binary probe and gates `ensureAgent({ sandbox })`; `SANDBOX_ENABLED=0` or `=1` overrides it in either direction, and everything must keep working with the sandbox off.

Note that `turn.done` carries the final text at `state.output.content`, not `output`.

Code Mode reaches around instruction-level safety rules. A sandbox script issues bridged tool calls without a model turn per call, so an agent that ignores the operating policy can dismiss a dozen notifications through the ungated `execute_action` with nothing pausing — that is what the first `sandbox-bulk-dismiss` run actually did. `execute_action` and `execute_and_observe` therefore refuse consequential actions in the bridge itself (`assertNotConsequential` in `mcp/android-tools.ts`); treat any new ungated tool as reachable from a script and gate it structurally, not in prose.

TrueForge pauses once per gated call, not once per batch: dismissing four notifications means four approvals and four resume turns. Count that when budgeting demo time, and do not measure agent efficiency in raw model turns — the eval subtracts the approval-forced ones.

## Approval gate (Milestone 6)

Consequential steps run through the `commit_action` MCP tool, which the agent manifest gates via TrueForge's `requireApprovalForTools`; `execute_action` stays ungated for navigation. A gated call ends the turn *paused*: `turn.done` carries `state.status === "done"` with a null output and a `tool.approval_required` entry in `state.requiredActions`. The pending call's name and arguments are not on that event — they live on the `model.message` whose id matches `sourceEventId`, which may itself arrive as deltas. Resuming means creating a **new** turn whose input is one `user.tool_approval` item per pending call, never mixed with a `user.message`. That cycle lives in `apps/server/src/approvals/turn-loop.ts` and is shared by the dashboard and the eval runner.

The phone is the approval surface and the dashboard only mirrors the pause. Every failure path — timeout, offline device, transport error, malformed response, a decider that throws — must resolve to deny; fail-open here is a safety bug, not a convenience.

The two approval evals need their fixture re-posted immediately before each run, since the allow case consumes it:

```sh
/home/omkar/Android/Sdk/platform-tools/adb shell cmd notification post -S bigtext \
  -t "EVAL-APPROVAL target" evalTag "Dismiss me via commit_action"
```

## TrueForge tool-response limits

The installed TrueForge runtime's `LargeToolResponse` implementation uses an approximately 6,000-token threshold for one tool response and 10,000 tokens cumulatively, retaining only a tiny leading/trailing preview when offloading. Keep ordinary MCP responses bounded and compact, search full data server-side, and expose explicit paged/search tools instead of returning an unbounded accessibility tree.
