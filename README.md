# TrueForge Android Operator

A governed computer-use agent for a real Android device. You speak (or type) a
task on the phone itself — *"dismiss all my notifications except WhatsApp"* —
and a TrueForge-harnessed agent operates the physical phone through its
accessibility tree: observing, tapping, typing, recovering with vision when
the tree goes blind, and **pausing for your explicit approval on the phone
before anything consequential happens**.

Built for the [Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
(TrueForge track), August 2026.

> 🎥 **Demo video:** *link coming with submission.*
>
## Why this exists

Phone automation is the sharpest version of the computer-use safety problem:
the device holds your messages, money, and identity, and an agent that can tap
anything can spend, send, and delete anything. This project treats the harness
as the product: every capability is paired with a control, and the controls
are **structural** (enforced in code the model cannot route around), not
prose in a prompt.

## Architecture

```
┌─────────────────────────┐        WebSocket (protocol v5)
│  Samsung tablet         │◄──────────────────────────────┐
│  Kotlin operator app    │                               │
│  · accessibility svc    │                    ┌──────────┴─────────────┐
│  · approval heads-up    │                    │  Device gateway + API  │
│  · voice input (STT)    │                    │  :8792                 │
│  · task entry           │                    └──────────┬─────────────┘
│  · question surface     │                               │
└─────────────────────────┘        ┌──────────────────────┴──┐
                                   │  Android Tool Bridge    │
┌─────────────────────────┐        │  (MCP server) :8791     │
│  Dashboard (Vite/React) │        └──────────┬──────────────┘
│  :5173 — transcript,    │                   │ MCP
│  inspector, approvals,  │        ┌──────────┴──────────────┐
│  frames, analytics      │───────►│  TrueForge runtime      │
└─────────────────────────┘  :8792 │  :8790 — agent, sandbox,│
                             /api  │  sub-agents, approvals  │
                                   └─────────────────────────┘
```

- **`android/`** — Kotlin operator app: accessibility service (read + act),
  wire protocol v5 client, approval heads-up notifications, voice task entry,
  media-session control, agent-question surface.
- **`packages/protocol/`** — shared TypeScript wire types, versioned
  (`PROTOCOL_VERSION = 5`; mismatch closes the socket with code 1010).
- **`apps/server/`** — device WebSocket gateway, the Android Tool Bridge MCP
  server, TrueForge agent setup, approval turn loop, vision sub-agent path,
  frame store, eval framework.
- **`apps/dashboard/`** — live transcript with tool-call pairing, nested
  sub-agent threads, screenshot frames, token analytics, and run controls.

## TrueForge capabilities used

| Harness capability | Where it shows up here |
|---|---|
| MCP tool integration | 9-tool Android bridge (`apps/server/src/mcp/android-tools.ts`): `get_screen`, `find_nodes`, `execute_action`, `execute_and_observe`, `commit_action`, `launch_app`, `capture_screenshot`, `inspect_screen_visually`, `tap_coordinates` |
| Human approval gates | `commit_action` is gated via `requireApprovalForTools`; the **phone is the approval surface**, and every failure path (timeout, offline, malformed response) resolves to **deny** |
| Sandboxed code execution | Code Mode via TrueForge's bubblewrap `LocalSandboxProvider` for bulk device orchestration (`scripts/trueforge-start.sh` carries the TMPDIR fix that makes it work — see field notes) |
| Sub-agents | Vision recovery runs as a dynamic sub-agent; threads render as nested containers in the dashboard transcript |
| Session persistence | A dashboard "run" is a TrueForge *session*; new prompts continue it (`POST /dashboard/runs` with `runId`), and finished runs are rebuilt from TrueForge's persisted events |
| Runtime reasoning control | `GET/POST /api/dashboard/reasoning` changes agent and vision reasoning effort live (manifest write vs. per-call) |
| Analytics | Token/cost metrics from `turn.done` and per-message `inputTokensBreakdown`, aggregated at `GET /dashboard/analytics` |

## The safety model

1. **Structural gating, not prompt gating.** Consequential actions must go
   through `commit_action`, which TrueForge pauses on. The ungated
   `execute_action` / `execute_and_observe` *refuse* consequential actions in
   the bridge itself (`assertNotConsequential`) — because we proved a Code
   Mode script can issue bridged calls without a model turn, so any ungated
   tool must be safe by construction, not by instruction.
2. **Fail-closed approvals.** Timeout, offline device, transport error, or a
   crashed decider all resolve to deny.
3. **Voice never auto-sends.** Dictation lands in an editable field and the
   human taps Send — a mis-transcription must never become an action the
   human "approved" without asking for it.
4. **Prohibited flows** (banking/payments/OTP/passwords, secure-window
   bypasses) are banned in the operating policy and excluded from demos.
5. **Bounded tool output.** Screenshots never enter the transcript (frame IDs
   + `GET /api/frames/{id}`, in-memory, 60-frame cap, never persisted);
   accessibility data is paged/searched server-side.

## Evals

An eval framework drives the *real* tablet through the full harness and
asserts on the merged event trace (`apps/server/src/evals/`):

- `youtube-latest-pause-home` — multi-app navigation baseline
- `approval-allow-dismiss` / `approval-deny-dismiss` — the gate pauses, the
  phone decision is honored, and **deny means the notification survives**
- `sandbox-bulk-dismiss` — Code Mode bulk orchestration with per-target
  approval pauses (efficiency is measured net of approval-forced turns)

```sh
npm run test:eval      # offline unit tests (no device)
npm run eval:android   # hardware evals — tablet connected, fixtures posted
npm run eval:phone     # phone-initiated run pipeline (and -- --cancel)
npm run smoke:sandbox  # asserts sandbox.created + correct sandboxed answer
```

## Quickstart

Prereqs: Node ≥ 22, a paired Android device with the operator APK
(protocol v5) installed and its accessibility service enabled, `adb` for
install/fixtures.

```sh
npm install
npm run dev:stack                   # runtime :8790, bridge/API :8791/:8792, dashboard :5173
# build + install the operator app
cd android && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk   # package: dev.trueforge.operator.debug
```

The all-in-one launcher pins Node 22, preserves the runtime sandbox `TMPDIR`
setup, and stops every component together on Ctrl-C. The individual commands
remain available as `scripts/trueforge-start.sh`, `npm run dev:server`, and
`npm run -w dashboard dev` when only one component is needed.

Preflight: `curl http://127.0.0.1:8792/dashboard/status`. Note the TrueForge
runtime intentionally has no `/health`; check its root response.

## Judging criteria map

| Criterion | Where to look |
|---|---|
| Potential impact | Hands-free, governed phone operation — task entry and approval both live on the device itself |
| Creativity | Vision recovery via sub-agent + node re-binding; Code Mode bulk ops; runtime reasoning dial; voice-in/approve-on-phone loop |
| Technical excellence | Versioned wire protocol, hardware eval suite, transcript rebuild from persisted sessions, unit tests across server + Android |
| Sponsor tool integration | TrueForge table above; Qodo review evidence below |
| Control & safety | [The safety model](#the-safety-model); the Code-Mode-bypass finding and its structural fix |
| Presentation | Demo video + this implementation and verification guide |

## Qodo review evidence

All hackathon work landed through Qodo-reviewed pull requests:

| PR | Scope | Qodo review | Addressed |
|---|---|---|---|
| [#3](https://github.com/os-netizen/trueforge_android/pull/3) | Protocol v5 | [Qodo review](https://github.com/os-netizen/trueforge_android/pull/3#issuecomment-5463417271) | [Coordinated-stack findings triaged](https://github.com/os-netizen/trueforge_android/pull/3#issuecomment-5463927066) |
| [#1](https://github.com/os-netizen/trueforge_android/pull/1) | Android operator app | [Qodo review](https://github.com/os-netizen/trueforge_android/pull/1#issuecomment-5463412718) | [Safety, cancellation, prompt, and voice fixes documented](https://github.com/os-netizen/trueforge_android/pull/1#issuecomment-5463925746) |
| [#4](https://github.com/os-netizen/trueforge_android/pull/4) | Server: approvals, sandbox, vision, evals | [Qodo review](https://github.com/os-netizen/trueforge_android/pull/4#issuecomment-5463404563) | [Fail-closed and bounded-state fixes documented](https://github.com/os-netizen/trueforge_android/pull/4#issuecomment-5463914320) |
| [#2](https://github.com/os-netizen/trueforge_android/pull/2) | Dashboard | [Qodo review](https://github.com/os-netizen/trueforge_android/pull/2#issuecomment-5463438655) | [Responsive, streaming, and filter fixes documented](https://github.com/os-netizen/trueforge_android/pull/2#issuecomment-5463934109) |
| [#5](https://github.com/os-netizen/trueforge_android/pull/5) | README + project guidance | [Qodo review](https://github.com/os-netizen/trueforge_android/pull/5#issuecomment-5463968396) | No material issues found; evidence links finalized in follow-up commit |

## What we learned about the harness

Building against a young harness surfaced real findings — sub-agent tool
inheritance, a sandbox TMPDIR interaction with bubblewrap, the Code Mode
policy-bypass class, event-protocol sharp edges. They're written up honestly
in the repository's local, intentionally untracked field notes.

## License / disclosure

Personal accounts and devices only; no keys or personal data in this repo.
The agent's operating policy prohibits banking, payment, OTP, and password
flows.
