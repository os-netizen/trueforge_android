# TrueForge Android Computer Use Agent

## Implementation Handoff and Hackathon Technical Brief

**Status:** Pre implementation design brief  
**Prepared:** 18 August 2026  
**Hackathon:** WeMakeDevs Agent Harness Hackathon, 22 to 30 August 2026  
**Target track:** Best Use of TrueForge  
**Primary stack:** Kotlin Android client, TypeScript server, TrueForge, MCP, DeepSeek V4 Flash via OpenCode Go  

> This document is intended to be sufficient for an engineer or coding agent with zero prior context to begin implementation once the hackathon starts. It captures the product idea, architectural decisions, technical rationale, safety model, TrueForge integration strategy, demo plan, scope boundaries, milestones, and open questions.

---

## 1. Executive summary

The project is a **governed computer use agent for Android**.

A user gives the agent a natural language instruction directly from an Android app, initially as text and later optionally as voice. The agent then operates the same Android device on the user's behalf by observing the current UI, deciding what to do next, executing actions, verifying the result, and continuing until the task is complete.

The core technical idea is:

1. Use the Android Accessibility tree as the primary perception mechanism.
2. Use screenshots plus a vision capable model only as a fallback when structured accessibility information is insufficient.
3. Expose generic Android control primitives to TrueForge as MCP tools.
4. Let TrueForge own the agent execution loop, sessions, tool execution, approvals, sandbox use, subagents, and reconnect behavior.
5. Require explicit user approval before consequential or irreversible actions.
6. Keep the Android application as the local trusted device runtime and user facing product surface, while keeping the agent intelligence off device.

The product thesis is:

> **An AI agent that can operate Android applications even when those applications expose no API, while keeping execution observable, permissioned, and recoverable.**

The strongest hackathon framing is not "voice control for Android." It is:

> **A governed computer use agent for Android. If a human can operate an app, the agent can potentially operate it too, even without an API. TrueForge provides the runtime and control plane that makes this safe enough to act.**

The project should be built as a **product quality vertical slice**, not as a full SaaS product and not as a fragile one off demo.

A stranger should ideally be able to:

1. Sideload the APK.
2. Enable the required Accessibility Service.
3. Connect the phone to the local or deployed server.
4. Enter a task on the phone.
5. Watch the phone operate itself.
6. Approve consequential actions on the phone.
7. Cancel execution at any time.
8. Inspect the execution from an optional observability dashboard.

---

## 2. Hackathon context and what the project is optimizing for

The hackathon is the WeMakeDevs Agent Harness Hackathon sponsored by TrueFoundry. The Best Use of TrueForge prize is specifically intended for an agent that makes substantive use of:

- Real tools connected through MCP.
- Generated code running in a sandbox.
- Human approval before irreversible actions.
- Subagents.
- Sessions that survive reconnects.

The judges score six criteria equally:

1. Potential impact.
2. Creativity and originality.
3. Technical excellence.
4. Use of TrueForge.
5. Control and safety.
6. Presentation.

The project therefore should not optimize only for "does the Android automation work?" It should optimize for demonstrating that **TrueForge is central to why the system is reliable and governable**.

### Important hackathon rule

The project itself must be built during the hackathon period, August 22 to 30, 2026. Existing libraries, frameworks, public APIs, AI coding tools, planning documents, sketches, and architectural notes are allowed, but the project implementation should begin after kickoff.

This file is planning and design work. It should not be treated as pre built project code.

---

## 3. Product definition

### 3.1 What the product is

A user installs an Android companion application and enables its Accessibility Service. The app becomes a local trusted runtime with the ability to:

- Read a structured representation of the visible UI.
- Perform accessibility actions on UI nodes.
- Dispatch gestures when node actions are not possible.
- Navigate Back and Home.
- Launch applications where feasible.
- Capture screenshots when requested for visual recovery.
- Show task status and safety controls.
- Receive user instructions as text, and later voice.
- Display approval requests.

The actual agent intelligence lives in TrueForge and the model, not inside the Android application.

### 3.2 What the product is not

It is not:

- A collection of app specific APIs such as `send_whatsapp_message()` or `upload_to_drive()`.
- A deterministic macro recorder.
- A full production SaaS platform.
- A Play Store ready consumer product.
- A banking or payments automation tool.
- A tool designed to bypass Android, bank, payment, or secure window protections.

### 3.3 Product thesis

The agent should work with **generic computer use primitives**, not bespoke integrations for each app.

For example, it should be able to accomplish:

> Find the PDF I downloaded yesterday and send it to Akash on WhatsApp.

without having a WhatsApp API integration or a file search API specifically written for that workflow.

This distinction is important. It makes the project a computer use agent rather than a bundle of scripted app integrations.

---

## 4. Primary user experience

The **Android phone is the primary product surface**.

The user should not need to open a laptop dashboard to control their own phone.

### 4.1 Normal task flow

1. User opens the Android app.
2. User enters a command such as:

   `Send the PDF I downloaded yesterday to Akash on WhatsApp.`

3. The Android app sends the task to the TypeScript server.
4. The server creates or continues a TrueForge session.
5. TrueForge starts the agent loop.
6. The agent requests the current screen through an MCP tool.
7. The Android application returns the accessibility snapshot.
8. The agent chooses an action.
9. The action is executed on the phone.
10. The result is observed and verified.
11. The loop continues until completion, failure, cancellation, or an approval boundary.

### 4.2 While the agent is operating another app

Once the task starts, the project app will no longer necessarily be in the foreground. The user still needs control.

The Android client should therefore expose:

- A persistent task notification.
- A Stop action.
- Optionally Pause.
- Current task status.
- Approval requests.

A possible later enhancement is an Accessibility Overlay for approvals or agent status, provided it can be implemented cleanly without interfering with the target app.

### 4.3 Voice

Voice is a secondary milestone.

It should be architecturally trivial:

```text
voice
  -> speech to text
  -> same text task pipeline
```

Do not create a separate voice agent path.

Text input must work first.

---

## 5. The three killer demos

The three main demos should prove different capabilities rather than being three similar navigation tasks.

### Demo 1: PDF to WhatsApp

**Prompt**

> Find the PDF I downloaded yesterday about TrueForge and send it to Akash on WhatsApp.

**What it proves**

- Natural language grounding.
- Relative date interpretation.
- Local file discovery through UI computer use.
- Cross app navigation.
- Generic actions rather than app specific APIs.
- Consequential action approval.
- Post action verification.

**Ideal execution**

1. Open file manager or Downloads.
2. Find candidate PDFs from yesterday.
3. Identify the correct file.
4. Trigger Share.
5. Select WhatsApp.
6. Search for Akash.
7. Attach the file.
8. Pause before final Send.
9. Ask user to approve.
10. Send after approval.
11. Verify that the attachment/message appears in the conversation.

This is the clean opening demo because everybody immediately understands it.

---

### Demo 2: Photos to Drive to Slack

**Prompt**

> Take the last three photos I took, put them in a Drive folder called Site Visit, and send the folder link on Slack.

**What it proves**

- Long horizon execution.
- Multi app orchestration.
- Repetitive workflow execution.
- Session durability.
- Sandbox or Code Mode use where appropriate.
- Context management over many steps.
- Approval before sending the final external message.

**Ideal execution**

1. Open gallery or photos.
2. Select the last three photos.
3. Share or upload to Drive.
4. Create `Site Visit` folder if it does not exist.
5. Upload the files.
6. Obtain or create a shareable link.
7. Open Slack.
8. Find the target recipient or channel.
9. Prepare the message.
10. Ask for approval before sending.
11. Send and verify.

**Durable session demonstration**

During this task, deliberately disconnect the Android client or dashboard after the Drive upload, then reconnect and show that the TrueForge session can continue rather than restart the whole task.

---

### Demo 3: Conditional food delivery action

**Prompt**

> Check whether my food delivery has arrived. If it has, message the security guard to send the delivery person up.

**What it proves**

- The agent is not merely translating commands into taps.
- It inspects state and makes a conditional decision.
- It can do nothing when a condition is false.
- It can use screenshot based visual recovery when structured perception is insufficient.
- It can recover from unexpected UI states.
- It can apply approval gates before an external side effect.

**Suggested implementation**

1. Open the food delivery app.
2. Inspect the order status using accessibility.
3. If the necessary state is not represented reliably in the accessibility tree, trigger visual fallback.
4. A vision subagent inspects the screenshot and returns a structured result.
5. If the order is not at the required state, stop without messaging anyone.
6. If the order has arrived, open WhatsApp.
7. Draft the message to the guard.
8. Ask the user to approve.
9. Send and verify.

This is the best demo for showing adaptive perception and real decision making.

---

## 6. One deliberate failure should be part of the demo

At least one demo should intentionally encounter an unexpected state.

Example:

- An Android permission dialog appears during a Drive workflow.
- A target app opens an unexpected onboarding modal.
- A search result is not where the agent expected it.

The agent should not have a hard coded handler for that exact popup.

Desired behavior:

```text
expected state != observed state
        -> observe again
        -> classify unexpected state
        -> replan or ask user
        -> continue original objective
```

A successful live recovery is more impressive than ten happy path taps.

---

## 7. High level architecture

```text
                        USER
                          |
                  text first, voice later
                          |
                          v
                +-------------------+
                |    Android App    |
                |                   |
                | Product UI        |
                | AccessibilitySvc  |
                | Device Executor   |
                | Safety Controls   |
                +---------+---------+
                          |
                  WebSocket / Tailscale
                          |
                          v
                +-------------------+
                | TypeScript Server |
                |                   |
                | Device Registry   |
                | Device Bridge     |
                | MCP Tool Adapter  |
                | TrueForge SDK     |
                | Event Fanout      |
                +----+---------+----+
                     |         |
                     |         +------------------+
                     |                            |
                     v                            v
              +-------------+              +------------+
              |  TrueForge  |              | Dashboard  |
              |   Runtime   |              | Observable |
              +------+------+              | only       |
                     |                     +------------+
             +-------+-------+
             |               |
             v               v
        DeepSeek V4       MCP tools
        Flash             for Android
             |
       vision fallback may use
       a separate vision model
```

### Core separation of responsibilities

**Android owns**

- User input.
- Permission onboarding.
- Accessibility access.
- Screen serialization.
- Screenshot capture.
- Primitive action execution.
- Local task status.
- Stop and approval UI.
- Device connection and reconnect.

**TypeScript server owns**

- WebSocket connection to device.
- Request/response correlation.
- Device registry.
- MCP exposure of Android tools.
- TrueForge SDK integration.
- Session mapping.
- Streaming TrueForge events to the Android client and dashboard.
- Optional pairing and authentication later.

**TrueForge owns**

- Agent execution loop.
- Model calls.
- Session state.
- Tool calls.
- Human approval pauses.
- Sandbox lifecycle.
- Subagents.
- Context engineering.
- Reconnectable turn/session behavior.

**Dashboard owns**

- Observability.
- Tool call timeline.
- Current task state.
- Current app/device state.
- Accessibility versus vision status.
- TrueForge session events.
- Optional prompt entry for development and remote testing.

The dashboard is not required for normal use of the product.

---

## 8. What TrueForge actually is

TrueForge is an open source agent harness. It is the runtime that executes the agent loop around an LLM.

The important mental model is:

```text
user goal
   -> TrueForge
      -> model
      -> tool call
      -> tool result
      -> model
      -> approval if needed
      -> sandbox if needed
      -> subagent if useful
      -> continue until done
```

TrueForge is not merely a TypeScript library imported into the app.

It runs as a server/runtime process and exposes:

- A chat UI.
- An HTTP API.
- A TypeScript SDK.
- An embeddable UI SDK.

### Local development mode

Official TrueForge currently supports a local mode using a single process and SQLite:

```bash
npx @truefoundry/trueforge
```

This is intended for local use only. It should stay on localhost because local mode has no login by default.

The TypeScript application then talks to this TrueForge process using `@truefoundry/trueforge-sdk`.

### Hosted mode

TrueForge also supports a hosted setup backed by Postgres and Redis.

That is not required for initial hackathon development.

The project should begin with TrueForge running locally on the developer machine.

---

## 9. TrueForge TypeScript SDK role

The TypeScript SDK is a client for the TrueForge runtime.

The TypeScript server should use it for:

- Creating or retrieving agent sessions.
- Creating turns.
- Sending user messages.
- Streaming turn events.
- Receiving tool approval events.
- Resuming a paused turn with approval or denial.
- Observing subagent events.
- Recovering or reconnecting to a turn stream.

The important concepts are roughly:

```text
Agent
  -> Session
      -> Turn
          -> streamed events
```

TrueForge exposes events for model messages, MCP lifecycle, tool responses, sandbox creation, approvals, subagent threads, and turn completion.

The implementation should treat TrueForge's event stream as the canonical source of agent execution state.

---

## 10. Tools versus MCP

This distinction caused confusion and should be kept clear.

### Tool

A tool is an individual callable function available to the model, such as:

```text
get_screen()
execute_action(...)
capture_screenshot()
get_device_state()
```

### MCP

MCP is the standardized protocol through which a collection of tools is described, discovered, and invoked.

An MCP server is simply a process or endpoint that exposes one or more tools using that protocol.

For this project, do not mentally treat "MCP server" as a major microservice.

The TypeScript server can expose an MCP endpoint as one part of the same process that already manages the Android WebSocket connection.

A good conceptual name is **Android Tool Bridge**, with MCP being the TrueForge facing protocol.

```text
TrueForge
    |
    | MCP
    v
Android Tool Bridge
    |
    | WebSocket
    v
Android phone
```

There is no need for a separate MCP microservice plus a separate device gateway.

---

## 11. Proposed MCP tool surface

Keep the tool surface small and generic.

Do not expose dozens of app specific functions.

### Tool 1: `get_screen`

Purpose:

Return a structured accessibility snapshot of the current foreground UI.

Example result:

```json
{
  "deviceId": "pixel7-a81f",
  "snapshotId": "snap_184",
  "packageName": "com.whatsapp",
  "windowTitle": "WhatsApp",
  "timestamp": 1787059200000,
  "nodes": [
    {
      "id": "n17",
      "parentId": "n3",
      "className": "android.widget.TextView",
      "text": "Akash",
      "contentDescription": null,
      "viewId": null,
      "bounds": [84, 402, 521, 475],
      "clickable": true,
      "editable": false,
      "scrollable": false,
      "enabled": true,
      "actions": ["click"]
    }
  ]
}
```

### Tool 2: `execute_action`

Purpose:

Execute one generic Android action against a specific snapshot where appropriate.

Suggested actions:

- click node
- long click node
- set text
- scroll
- coordinate tap
- swipe
- Back
- Home
- launch app

Example:

```json
{
  "deviceId": "pixel7-a81f",
  "snapshotId": "snap_184",
  "action": {
    "type": "click_node",
    "nodeId": "n17"
  }
}
```

### Tool 3: `capture_screenshot`

Purpose:

Return a screenshot only when the accessibility representation is insufficient.

This should be intentionally separate from `get_screen` so the agent has to opt into the more expensive and privacy sensitive visual path.

### Tool 4: `get_device_state`

Purpose:

Return lightweight device state useful for verification and recovery, for example:

- online/offline
- foreground package
- active task state
- orientation
- accessibility service status
- last observed snapshot ID

### Optional Tool 5: `wait_for_change`

Only add this if it provides real value. A better initial design may be for `execute_action` itself to wait for an accessibility event, state change, or timeout before returning.

---

## 12. Android implementation stack

Use **native Kotlin**, not React Native, for the Android client.

Recommended stack:

- Kotlin.
- Jetpack Compose for app UI.
- `AccessibilityService` for UI inspection and action execution.
- `AccessibilityNodeInfo` for structured UI nodes.
- `performAction()` for semantic node actions.
- `dispatchGesture()` for fallback taps and swipes.
- `performGlobalAction()` for Back and Home.
- Accessibility service screenshot API where supported for visual fallback.
- Kotlin coroutines.
- OkHttp WebSocket or another reliable native WebSocket client.
- kotlinx.serialization or Moshi for wire protocol serialization.

### Why not React Native

React Native would still require a native Android `AccessibilityService`, Kotlin/Java modules, and bridging for the core capabilities. Since the hardest part of the Android application is native anyway, React Native adds complexity without meaningful cross platform benefit for this hackathon.

---

## 13. Android permissions and Accessibility Service

The service must be declared as a real Android `AccessibilityService`.

The user must explicitly enable it in Android Accessibility settings.

Important service capabilities include:

```xml
android:canRetrieveWindowContent="true"
android:canPerformGestures="true"
```

The service must be able to retrieve the active window hierarchy if the project is to read the accessibility tree.

Use `AccessibilityNodeInfo` to inspect the UI and call node actions where possible.

### Screenshot capability

If using the Accessibility Service screenshot API, confirm the minimum Android version and required service capability during implementation. Secure windows may block screenshots, and the product should respect that restriction.

### Events

Do not blindly process every accessibility event forever if it is unnecessary. `typeAllMask` can be expensive.

The implementation should eventually reduce events to those needed for:

- window changes
- content changes
- click outcomes
- focus changes where relevant
- verification after actions

During early prototyping, broader event coverage is acceptable if it accelerates learning.

---

## 14. Accessibility tree representation

Do not send raw Android objects to the model.

Serialize the current visible UI into a compact model friendly structure.

Fields worth considering:

```text
id
parentId
className
text
contentDescription
viewId
bounds
clickable
longClickable
editable
scrollable
focusable
enabled
selected
checked
actions
```

### Snapshot scoped node IDs

Node IDs must be scoped to a specific observation snapshot.

Never assume a node identifier remains valid after the UI changes.

Flow:

```text
get_screen()
 -> snapshotId = snap_184
 -> node n17 = Akash

execute_action(
  snapshotId = snap_184,
  click n17
)
```

Before executing a node action, the Android side should validate that the requested snapshot is still current enough.

If the screen changed materially, return something like:

```json
{
  "status": "stale_snapshot"
}
```

Then the agent must re observe instead of clicking stale coordinates.

This is important for reliability.

---

## 15. Action execution hierarchy

Always prefer the highest semantic level available.

### Level 1: Semantic node action

Example:

```text
AccessibilityNodeInfo.performAction(ACTION_CLICK)
```

This is preferred because it is less brittle than coordinates.

### Level 2: Gesture using known node bounds

If the node is visible but semantic click is unavailable, use its bounds to dispatch a gesture.

### Level 3: Screenshot plus vision plus coordinate action

Only when the relevant element is not represented usefully in the accessibility tree:

```text
structured UI insufficient
 -> capture screenshot
 -> vision recovery
 -> grounded target
 -> coordinate gesture
```

This hierarchy should be documented in the agent instructions.

---

## 16. Action, observe, verify loop

A critical design principle is that **the agent must not assume an action worked**.

Every meaningful step should follow:

```text
observe
 -> choose action
 -> execute
 -> wait for relevant UI change
 -> observe again
 -> verify expected effect
 -> continue or recover
```

Example:

```text
Goal: open WhatsApp

launch_app(com.whatsapp)
 -> observe
 -> verify foreground package is WhatsApp
 -> if false, recover
```

Message example:

```text
tap Send
 -> observe
 -> verify message bubble or attachment appears
 -> only then mark step successful
```

This is one of the features that separates a credible computer use agent from a scripted automation demo.

---

## 17. Avoid arbitrary sleeps

The Android side receives accessibility events and should use them to detect state changes.

Prefer:

```text
execute action
 -> wait until one of:
    window changed
    relevant content changed
    foreground package changed
    timeout reached
 -> return action result
```

rather than:

```text
click
sleep(2 seconds)
observe
```

An action result might look like:

```json
{
  "status": "success",
  "screenChanged": true,
  "foregroundPackage": "com.whatsapp",
  "latencyMs": 418
}
```

This should materially improve robustness.

---

## 18. Adaptive perception

Do not describe the system as simply having "two modes."

Use the concept **adaptive perception**.

### Primary mode: Structured perception

Use accessibility information for most decisions.

Benefits:

- Lower latency.
- Lower model cost.
- Better target precision.
- Better semantics.
- Lower image bandwidth.
- Less unnecessary visual data exposure.

### Fallback mode: Visual recovery

Use screenshots only when:

- no useful target is present in the accessibility tree
- rendered information is visual only
- canvas/custom view content is inaccessible
- OCR or image context is needed
- UI state cannot be determined reliably from nodes

The fallback path should return a structured result to the root agent, not flood the root context with unnecessary image analysis.

---

## 19. Model strategy

### Main model

Use **DeepSeek V4 Flash** through the user's OpenCode Go subscription.

Current OpenCode Go documentation exposes `deepseek-v4-flash` through an OpenAI compatible Chat Completions endpoint.

This is a reasonable main agent model because the expected workload is many relatively small tool decisions over structured state rather than a small number of giant reasoning calls.

### Vision

The main model should be treated as text first for this project unless verified otherwise during implementation.

Use a separate vision capable model for screenshot recovery if needed.

The architecture should therefore be:

```text
accessibility tree
 -> DeepSeek V4 Flash
 -> normal operation

if structured perception fails
 -> screenshot
 -> vision capable subagent/model
 -> structured target/result
 -> root agent continues
```

Do not make screenshot vision the default perception path.

### Model configurability

Do not build a user facing BYOK system for the hackathon.

Configure the project's model credentials centrally in the developer environment.

BYOK, provider selection, API key storage, key rotation, and model billing UI are productization work that does not improve the core hackathon story.

---

## 20. TrueForge sandbox strategy

The project does not need to invent a fake sandbox use case.

TrueForge supports sandbox as a tool and can provision one when the agent needs code execution or file operations.

The most credible use for this project is **Code Mode or generated orchestration for long workflows**, not sandboxing the Android device itself.

Conceptual example:

```text
User goal
  -> TrueForge root agent
  -> generate a short orchestration program
  -> execute it in TrueForge sandbox
  -> program chains Android MCP calls
  -> results return to agent
```

Potential uses:

- filtering a large accessibility result
- selecting items based on timestamps or metadata
- generating or transforming intermediate data
- chaining repetitive MCP calls programmatically
- handling a long multi app workflow without putting every intermediate value into model context

### Important limitation

The TrueForge sandbox is a separate isolated compute environment. It is **not** a sandbox around the Android phone.

The phone remains a real external system. Consequential actions on it must be governed through approvals and action policy.

### Do not force sandbox use everywhere

Simple tasks should remain:

```text
model -> MCP tool -> result
```

Use the sandbox only when it improves the implementation or clearly demonstrates TrueForge's intended harness capabilities.

---

## 21. Subagent strategy

Do not create a large multi agent system merely to say the project uses subagents.

The cleanest real subagent is a **Vision Recovery Agent**.

Flow:

```text
Root Android Agent
  -> accessibility state insufficient
  -> delegate screenshot to Vision Recovery Agent
  -> subagent returns:
       target description
       target bounds or coordinate
       confidence
       interpreted UI state
  -> root agent decides next action
```

This gives the subagent an isolated context and a focused responsibility.

A second possible subagent is a task specific planning or validation agent, but only add it if it solves an actual problem.

---

## 22. Human approval and safety model

Human approval is a first class feature, not an afterthought.

### Proposed risk classes

#### Safe read operations

Examples:

- inspect accessibility tree
- read current package
- screenshot when user has enabled the service and task is active
- scroll through visible content

Usually no approval.

#### Low risk navigation

Examples:

- open an app
- search within an app
- navigate between screens
- draft text without sending

Usually no approval.

#### Consequential external action

Examples:

- send a message
- share a file
- post content
- create a public share link
- delete a file
- change a system setting
- install or uninstall an application

Require explicit approval before commitment.

#### Prohibited actions

For the hackathon version, prohibit or refuse:

- banking and payment execution
- financial transfers
- password manager actions
- authenticator/OTP actions
- security settings that reduce device protection
- attempts to bypass secure windows or app anti automation controls

### Approval UX

Preferred approval surface is the phone itself.

Example:

```text
Approval required

Send report.pdf to Akash on WhatsApp?

[Deny]  [Allow]
```

The dashboard can mirror the approval for observability, but the phone should remain the primary control surface.

TrueForge should be the source of the approval pause and resume behavior wherever possible.

---

## 23. Banking and payment app compatibility

The Accessibility Service itself can cause some banking or payment apps to disable sensitive operations or refuse to function while a powerful third party accessibility service is enabled.

The project intentionally should **not attempt to bypass this protection**.

Document this as a known limitation and a respected security boundary.

Recommended README wording:

> Some financial and payment applications restrict functionality while powerful third party Accessibility Services are enabled. This project intentionally does not attempt to circumvent those protections. Use a secondary or test device without sensitive financial applications for development and demonstrations.

Separately, the agent's own policy should refuse to operate financial or authentication workflows.

These are two different layers:

1. Platform/app restrictions enforced by banking/payment apps.
2. Project level safety policy enforced by the agent.

---

## 24. Google Play distribution constraint

The hackathon version should be sideloaded.

Current Google Play policy prohibits general automation applications using AccessibilityService to autonomously initiate, plan, and execute actions or decisions, except qualifying accessibility tools whose core purpose is serving users with disabilities.

This project, as currently framed as a general computer use assistant, should therefore **not be presented as Play Store ready**.

For the hackathon this is not a blocker.

Treat distribution as:

```text
build APK
 -> sideload to test/demo device
 -> enable Accessibility Service manually
```

If the project later becomes a real product, Android distribution and Accessibility policy become a major strategic question.

---

## 25. Android app responsibilities

The Android application is not "dumb," but it should contain **no agent intelligence**.

It owns the trusted local runtime and user experience.

### Product UI responsibilities

- Text task input.
- Later microphone/voice input.
- Connection status.
- Accessibility Service setup status.
- Current task status.
- Approval UI.
- Stop/cancel control.
- Completion/failure summary.

### Device runtime responsibilities

- Accessibility tree extraction.
- Node serialization.
- Gesture execution.
- Node actions.
- Screenshot capture.
- Foreground app state.
- Event observation.
- Stale snapshot detection.
- Request/response execution for server commands.

### Networking responsibilities

- Connect to the server.
- Authenticate eventually.
- Reconnect automatically.
- Correlate server requests with device responses.

### Explicit non responsibilities

The Android app should not contain:

- the LLM
- planning logic
- tool selection logic
- workflow reasoning
- app specific automation scripts for demos

---

## 26. TypeScript server responsibilities

Use TypeScript because the project benefits from typed protocols and because TrueForge exposes a TypeScript SDK.

The server should be a **single application**, not a microservice fleet.

Recommended responsibilities:

### Device gateway

Maintain a persistent WebSocket connection to each connected Android device.

For the first implementation, one device is enough.

### Request correlation

MCP tool call arrives:

```text
get_screen(deviceId)
```

Server sends:

```json
{
  "requestId": "req_91",
  "type": "get_screen"
}
```

Phone returns:

```json
{
  "requestId": "req_91",
  "ok": true,
  "result": { }
}
```

Server resolves the original MCP call.

### MCP endpoint

Expose Android tools to TrueForge through MCP.

This can run in the same Node process as the WebSocket server.

### TrueForge SDK client

Accept user tasks from Android and dashboard, create/continue sessions, execute turns, stream events, and route approvals.

### Event fanout

Send relevant execution events to:

- Android app for user status.
- Dashboard for observability.

### Optional device registry

Initially an in memory mapping is sufficient:

```text
deviceId -> live WebSocket
```

Do not add Redis until there is an actual reason.

---

## 27. Recommended TypeScript libraries

Exact packages can change, so verify package names during kickoff.

Likely choices:

- Node.js or Bun runtime.
- TypeScript.
- Zod for runtime schemas.
- `@truefoundry/trueforge-sdk`.
- Official MCP TypeScript SDK.
- Fastify, Hono, Express, or raw Node HTTP for the backend.
- `ws` if the framework does not provide a preferred WebSocket implementation.
- Next.js or Vite/React for dashboard.

The official MCP TypeScript SDK currently provides server and client packages and thin adapters for common Node frameworks.

Keep the server framework boring. The core engineering challenge is the agent/device loop, not HTTP routing.

---

## 28. Shared wire protocol

Use explicit schemas for every phone/server message.

On the TypeScript side, define them with Zod.

Example conceptual schema:

```ts
const DeviceRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("get_screen"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("execute_action"),
    requestId: z.string(),
    snapshotId: z.string().optional(),
    action: DeviceAction,
  }),
  z.object({
    type: z.literal("capture_screenshot"),
    requestId: z.string(),
  }),
]);
```

Android mirrors the same JSON contract in Kotlin serialization models.

The protocol should be versioned early:

```json
{
  "protocolVersion": 1
}
```

This is cheap and avoids ambiguity later.

---

## 29. Networking strategy

### Development

Use **Tailscale**.

Recommended initial setup:

```text
Android phone
   -> Tailscale
   -> developer laptop
      -> TypeScript server
      -> TrueForge local runtime
```

This avoids deployment complexity while the device protocol is changing rapidly.

TrueForge local mode should remain bound to localhost, not exposed over the tailnet or public internet.

The TypeScript server can talk to TrueForge locally.

The Android app only needs network access to the TypeScript server.

### Why this is simpler than earlier assumptions

TrueForge itself can run locally. There is no required TrueForge cloud service for the hackathon.

Therefore the project does not need to expose a local MCP endpoint to some external TrueForge service during development.

Everything server side can initially run on the laptop.

### Final deployment

Do not decide this on day one.

Once the local closed loop is stable, decide whether to deploy:

- the TypeScript server only, while TrueForge remains local for demo, or
- a proper hosted TrueForge deployment plus TypeScript service if needed.

A deployed TypeScript server can make the project feel more product shaped because the phone does not depend on the developer laptop being present, but deploying TrueForge hosted mode adds Postgres/Redis infrastructure and is not necessary merely to demonstrate the hackathon project.

The safest default for the competition is:

> reliable local system first, deployment only if it materially improves the demo or reproducibility.

---

## 30. Dashboard scope

The dashboard is **observability first**.

It is not the primary product interface.

### Must show

- Device connected/disconnected.
- Current task.
- Current TrueForge session.
- Execution timeline.
- Tool calls.
- Tool results or summarized results.
- Current foreground app.
- Current perception method: Accessibility or Vision.
- Approval events.
- Completion/failure status.

### Nice to show

- Accessibility steps count.
- Vision fallback count.
- Task duration.
- Number of actions.
- Recovery events.
- Model calls.
- Sandbox creation/use.
- Subagent start/finish.

### Optional

- Prompt box for development and remote testing.

This prompt box must remain a secondary interface. The README and demo should present the phone as the normal task entry point.

### Do not build

- API key settings.
- Billing.
- Organization management.
- Team management.
- SaaS admin panel.
- Complex user accounts.

---

## 31. Product shaped, not product complete

The project should feel like a real product but avoid SaaS infrastructure work that does not affect judging.

### Product shaped means

- Clean install flow.
- Clear Accessibility permission onboarding.
- Real phone task input.
- Reliable agent execution.
- Safety approval.
- Stop control.
- Good error states.
- Reconnect behavior.
- Observable execution.
- Clean public repository.
- Reproducible setup.

### Product complete would imply unnecessary work such as

- billing
- subscriptions
- OAuth login
- password resets
- tenant management
- API key vault
- usage quotas
- deployment fleet management
- multiple regions
- mobile push infrastructure

Do not build these for the hackathon.

---

## 32. Evaluation and benchmark

A small benchmark will make the project look much more serious.

Create approximately 20 representative tasks covering:

- Open an app.
- Search within an app.
- Find a file.
- Send a file.
- Fill a form.
- Cross app sharing.
- Multi step navigation.
- Unexpected popup.
- Missing accessibility node.
- Screenshot fallback.
- Approval required.
- Approval denied.
- App navigation failure.
- Reconnect during a task.
- Conditional action.

Track metrics such as:

### Reliability

- Task success rate.
- Step success rate.
- Recovery success rate.
- Number of retries.

### Perception

- Percentage of decisions using accessibility only.
- Vision fallback frequency.
- Vision fallback success rate.

### Efficiency

- Median task duration.
- Mean number of agent steps.
- Mean model calls.
- Mean tool calls.

### Safety

- Consequential actions correctly intercepted for approval.
- Approval denial respected.
- Prohibited actions refused.

A sample final result could look like:

```text
20 task benchmark

Task success                17/20
Accessibility only          81% of observations
Vision fallback             19% of observations
Vision recovery success     88%
Unsafe action interception  100%
Reconnect recovery          3/3
```

Do not invent metrics. Measure them on the actual system.

---

## 33. Agent system behavior

A first system instruction should emphasize the following principles.

### Core operating policy

1. Use structured accessibility information first.
2. Use screenshots only when necessary.
3. Prefer semantic node actions over coordinates.
4. Never assume an action succeeded.
5. Re observe after important actions.
6. Verify progress against the user's goal.
7. If observed state does not match expectation, recover or replan.
8. Do not perform consequential external actions without approval.
9. Respect secure app and OS boundaries.
10. Never attempt to operate financial, banking, authenticator, or password manager workflows.
11. Keep the user informed when blocked.
12. Stop if the user cancels.

### Avoid over specific app knowledge

Do not encode demo flows like:

```text
To send a WhatsApp file always click button at X,Y.
```

General heuristics such as "look for Share" or "search for the recipient" are fine, but the agent should derive concrete actions from the observed UI.

---

## 34. Security principles

Even for a hackathon prototype, this application has unusually powerful permissions.

Use the following principles.

### Least data sent

Do not continuously stream the full accessibility tree.

Send observations when:

- requested by the agent
- needed for verification
- a material UI state change must be reported

### Screenshots are ephemeral

Preferred flow:

```text
capture
 -> send for vision
 -> use result
 -> discard
```

Do not create a screenshot archive unless there is a clear debugging opt in.

### No secrets in sandbox

Keep credentials outside generated sandbox code. MCP tools and the harness should own authenticated access boundaries.

### Device kill switch

A user must always be able to cancel the active agent locally from the phone.

### No security bypasses

Do not bypass:

- FLAG_SECURE windows
- bank/payment restrictions
- authentication challenges
- OS permission protections

---

## 35. Potential phone approval UI

Two implementation choices are reasonable.

### Option A: Persistent notification

Simplest and robust.

```text
Android Operator
Approval required
Send report.pdf to Akash?

[Deny] [Allow]
```

### Option B: Accessibility Overlay

More visually impressive because the approval appears over the current target app while preserving context.

Use only if implementation is stable and does not interfere with accessibility interaction.

### Recommendation

Start with notification or a dedicated approval Activity if necessary.

Only add overlay after the core task loop works.

---

## 36. Suggested repository structure

```text
android-operator/

  README.md
  docs/
    architecture.md
    safety.md
    evaluation.md

  apps/
    server/
      src/
        trueforge/
        mcp/
        devices/
        sessions/
        events/
        api/
      package.json

    dashboard/
      src/
      package.json

  packages/
    protocol/
      src/
        device.ts
        events.ts
        actions.ts
        snapshots.ts
      package.json

    agent/
      instructions/
      schemas/
      package.json

  android/
    app/
      src/main/java/.../
        accessibility/
        networking/
        actions/
        snapshots/
        ui/
        approvals/
        tasks/

  evals/
    tasks.json
    runner/
    results/
```

### Note on shared types

The Android application cannot consume TypeScript types directly. `packages/protocol` should therefore be the canonical JSON schema definition on the server side, while Kotlin models mirror the same protocol.

Consider generating Kotlin schema types later only if it is easy. Do not make schema code generation a prerequisite.

---

## 37. Implementation order

The hardest and most valuable thing is the closed loop between TrueForge and a physical Android phone.

Do not start with the dashboard.

### Milestone 0: Pre hackathon planning only

Before August 22:

- finalize architecture
- read TrueForge quickstart and SDK docs
- read Android AccessibilityService docs
- decide minimum Android API target
- prepare task list and demo storyboard
- prepare repo naming and diagrams
- do not implement the project code before kickoff

### Milestone 1: TrueForge local smoke test

After kickoff:

1. Run TrueForge locally.
2. Configure DeepSeek V4 Flash via OpenCode Go or another working OpenAI compatible model endpoint.
3. Use the TypeScript SDK to create a session and run a text turn.
4. Stream and print events.
5. Confirm tool call behavior with one fake test MCP tool.

**Done when:**

A typed TS script can send a user message to TrueForge and receive a real model response plus a fake tool call.

### Milestone 2: Android Accessibility prototype

1. Create native Kotlin app.
2. Implement AccessibilityService.
3. Show onboarding screen for enabling the service.
4. Serialize the current visible screen.
5. Execute a click on a selected accessibility node.
6. Implement Back.
7. Implement text input.

**Done when:**

A developer can manually inspect JSON for the current screen and send one command to click/type on the phone.

### Milestone 3: Device WebSocket

1. Android connects to the TS server over Tailscale.
2. Implement request IDs.
3. Implement `get_screen` request.
4. Implement `execute_action` request.
5. Handle reconnect.

**Done when:**

A TypeScript function on the laptop can remotely inspect the phone and execute a generic action.

### Milestone 4: MCP bridge

1. Expose `get_screen` through MCP.
2. Expose `execute_action`.
3. Connect MCP server to TrueForge.
4. Give the agent instructions for Android operation.

**Done when:**

The prompt:

`Open WhatsApp and search for Akash.`

travels through:

```text
phone/server prompt
 -> TrueForge
 -> DeepSeek
 -> MCP tool
 -> TypeScript bridge
 -> WebSocket
 -> Android
 -> accessibility event
 -> new snapshot
 -> TrueForge
```

and completes without manual control.

This is the most important milestone.

### Milestone 5: Reliability loop

Add:

- snapshot IDs
- stale snapshot response
- post action observation
- verification
- UI change wait instead of blind sleeps
- action retry policy
- cancellation

**Done when:**

Simple 5 to 10 step tasks work repeatedly rather than only once.

### Milestone 6: Approval gating

1. Define consequential actions.
2. Trigger TrueForge approval before them.
3. Render approval on Android.
4. Send allow/deny back through server to TrueForge.
5. Verify denial prevents execution.

**Done when:**

The PDF demo stops before Send and cannot send until the user approves.

### Milestone 7: Screenshot and vision recovery

1. Add explicit screenshot tool.
2. Add vision capable model/subagent.
3. Return structured visual findings.
4. Use coordinates only after structured perception fails.

**Done when:**

At least one UI state inaccessible through the tree can be completed through visual recovery.

### Milestone 8: Long horizon and session reconnect

Implement the photos to Drive to Slack flow.

Test reconnect in the middle.

**Done when:**

Task continuation does not restart from step one after reconnect.

### Milestone 9: Dashboard

Build the observability UI after the agent loop is reliable.

**Done when:**

A judge can watch the phone and understand from the laptop exactly what TrueForge is doing.

### Milestone 10: Voice and polish

Only after the three demos are stable:

- voice input
- better onboarding
- animations
- task history
- polished final screen
- nicer dashboard

---

## 38. MVP definition

If time is limited, the minimum credible hackathon submission is:

1. Kotlin Android app.
2. Accessibility Service enabled.
3. Text prompt entered from phone.
4. TypeScript server over Tailscale.
5. TrueForge running the agent.
6. DeepSeek V4 Flash or another working model.
7. Android actions exposed through MCP.
8. Accessibility first perception.
9. One cross app task working reliably.
10. Approval before final consequential action.
11. Stop control.
12. Public repo and clear technical demo.

The PDF to WhatsApp demo alone can carry the MVP if it is robust and TrueForge is visibly central.

---

## 39. Strong submission definition

A strong Best Use of TrueForge submission adds:

- Screenshot fallback.
- Vision subagent.
- Recovery from unexpected state.
- Sandbox/Code Mode used substantively.
- Reconnectable session demonstrated.
- Three varied demos.
- Evaluation metrics.
- Dashboard observability.
- Clean repo and setup instructions.
- Qodo usage if targeting Best Code Quality as an alternate track.

---

## 40. What not to spend the hackathon on

Avoid these unless the core system is already excellent:

- React Native rewrite.
- Multi tenant SaaS.
- User supplied API keys.
- OAuth account system.
- Billing.
- Teams/organizations.
- Kubernetes.
- Redis before required.
- Elaborate deployment pipeline.
- Fancy dashboard before core reliability.
- App specific custom APIs.
- More than one unnecessary subagent.
- A massive tool surface.
- Support for financial apps.
- Attempts to publish through Google Play.
- Perfect voice UX before text works.

---

## 41. Open decisions to resolve during implementation

These are intentionally not over specified yet.

### Android API level

Choose based on:

- screenshot API availability
- target demo phone OS
- notification behavior
- AccessibilityService capabilities

### Foreground service versus ordinary service usage

Determine whether a foreground service is needed for reliable WebSocket/task execution given the selected Android version and lifecycle behavior.

### Approval rendering

Start with the simplest reliable phone UI, then consider overlay.

### Exact MCP tool split

Possible version A:

```text
get_screen
execute_action
capture_screenshot
get_device_state
```

Possible version B splits low risk versus consequential execution into separate tools to make approval policy easier.

Prefer the smallest clean interface that still works well with TrueForge approval semantics.

### Vision model

Select based on:

- API availability during hackathon
- latency
- screenshot support
- cost
- ability to return grounded coordinates reliably

### Hosting

Do not solve until the local system is stable.

---

## 42. Risks and mitigations

### Risk: Accessibility trees are incomplete

**Mitigation:** screenshot based visual recovery.

### Risk: Model repeatedly misclicks

**Mitigation:** semantic node actions, snapshot scoping, verification, re observation.

### Risk: UI changes between observation and action

**Mitigation:** snapshot IDs and `stale_snapshot` response.

### Risk: Agent loops indefinitely

**Mitigation:** TrueForge iteration limits, task timeout, user Stop, retry budget.

### Risk: Long tasks consume too much context

**Mitigation:** TrueForge context management, subagents, Code Mode, compact observations.

### Risk: Accessibility tree is enormous

**Mitigation:** prune invisible/unactionable nodes, compact serialization, preserve hierarchy only where useful.

### Risk: Screenshot privacy

**Mitigation:** explicit fallback only, ephemeral handling, no archival by default.

### Risk: Financial/security apps break

**Mitigation:** test device, documented limitation, no bypass attempts.

### Risk: Play Store policy

**Mitigation:** sideload hackathon APK, no Play Store claim.

### Risk: Tailscale dependency hurts demo

**Mitigation:** ensure the demo network is stable, optionally deploy the TS server only after core reliability is achieved.

### Risk: TrueForge integration becomes superficial

**Mitigation:** make MCP, approvals, session persistence, subagent recovery, and at least one sandbox use visible and central.

---

## 43. Suggested observability events

Normalize both internal device events and TrueForge events into a dashboard timeline.

Possible event types:

```text
task.started
model.reasoning_started
mcp.tool_called
device.observed
device.action_requested
device.action_completed
device.screen_changed
verification.succeeded
verification.failed
recovery.started
vision.fallback_started
vision.fallback_completed
approval.required
approval.allowed
approval.denied
sandbox.created
subagent.started
subagent.completed
session.reconnected
task.completed
task.failed
task.cancelled
```

Do not expose private chain of thought. The dashboard should show concise operational descriptions and tool traces, not hidden model reasoning.

---

## 44. Suggested final demo presentation structure

The final video is about three minutes, so the project must explain itself quickly.

### 0:00 to 0:20: Problem and thesis

Show the phone.

Explain:

> Apps expose APIs inconsistently, but every app exposes a UI to the user. We built a governed Android computer use agent that uses the Accessibility tree first and vision only when needed.

### 0:20 to 0:50: Architecture

Show a simple diagram:

```text
Android -> TypeScript bridge -> TrueForge -> model
                       ^             |
                       +---- MCP ----+
```

Mention approvals, sessions, sandbox, and vision subagent.

### 0:50 to 1:35: PDF demo

Enter prompt on the phone.

Watch the phone operate.

Show approval before Send.

Approve.

Verify completion.

### 1:35 to 2:15: Visual recovery or failure recovery

Show a task where accessibility is insufficient or an unexpected popup appears.

Dashboard visibly changes from:

`Perception: Accessibility`

to:

`Perception: Vision fallback`

Then task recovers.

### 2:15 to 2:40: Long horizon / reconnect

Quick clip from Drive workflow showing session continuing after reconnect.

### 2:40 to 3:00: Technical proof

Show evaluation numbers and repo architecture.

End with the role of TrueForge:

> TrueForge owns the loop, MCP calls, sandbox, approvals, subagents, and durable session. Android only exposes the controlled interface to the physical device.

---

## 45. Why this project can be competitive

The project has strong hackathon characteristics:

### Clear impact

A general purpose agent can interact with software that exposes no agent friendly API.

### Strong demo value

A physical phone visibly operating itself is easy to understand and memorable.

### Technical depth

The project combines:

- Android system services
- accessibility semantics
- physical device control
- typed network protocol
- MCP
- agent runtime
- multimodal fallback
- verification and recovery
- safety gating
- session durability

### Natural TrueForge fit

TrueForge is not merely wrapping an LLM. It can own:

- MCP tool execution
- approval pauses
- session state
- subagents
- sandboxed generated code
- context engineering

### Strong safety story

The project explicitly respects:

- banking/payment restrictions
- secure window boundaries
- human approval
- local kill switch
- prohibited app categories

---

## 46. First implementation task for a coding agent

After hackathon kickoff, the first engineering task should be:

### Goal

Prove the full TrueForge tool loop with the smallest fake environment before touching Android complexity.

### Steps

1. Create monorepo shell.
2. Start local TrueForge using the official local command.
3. Configure a working OpenAI compatible model endpoint, preferably DeepSeek V4 Flash through OpenCode Go.
4. Create TypeScript server package.
5. Use `@truefoundry/trueforge-sdk` to create a session and stream a turn.
6. Create a tiny MCP server in the same TypeScript process exposing a fake tool such as:

   ```text
   get_test_screen() -> { text: "Home screen with WhatsApp icon" }
   ```

7. Configure TrueForge to see the MCP tool.
8. Give the agent a prompt that forces a tool call.
9. Confirm event streaming includes the tool lifecycle.
10. Only then replace the fake tool implementation with a WebSocket call to the Android device.

### Success criterion

A terminal log should show something equivalent to:

```text
USER: Open WhatsApp
MODEL -> calls get_test_screen
MCP RESULT -> Home screen with WhatsApp icon
MODEL -> proposes next action
TURN COMPLETE
```

This proves the framework integration before Android becomes part of the debugging surface.

---

## 47. Second implementation task for a coding agent

### Goal

Prove Android accessibility read and act locally.

### Steps

1. Create Kotlin Android app.
2. Declare AccessibilityService.
3. Create permission onboarding screen.
4. Enable `canRetrieveWindowContent` and gesture capability.
5. Traverse `rootInActiveWindow`.
6. Serialize visible nodes.
7. Display or log serialized snapshot.
8. Implement click by node path/reference.
9. Implement set text.
10. Implement Back.
11. Add snapshot ID.

### Success criterion

Developer can:

- open another app
- fetch structured UI JSON
- identify a node
- issue one local command
- see the action occur

No LLM is needed for this milestone.

---

## 48. Third implementation task for a coding agent

### Goal

Connect the physical phone to the MCP tool.

### Steps

1. Start TypeScript WebSocket endpoint.
2. Android connects via Tailscale.
3. Implement typed request/response messages.
4. `get_screen` MCP tool sends request to device.
5. Device returns snapshot.
6. `execute_action` sends action request.
7. Device executes and returns outcome.
8. TrueForge receives the tool result.

### Success criterion

The model can make a real phone perform one action based on a real accessibility observation.

This is the fundamental proof of the project.

---

## 49. Definition of done for the hackathon

The project is done enough to submit when all of the following are true:

### Core

- [ ] Android APK installs on demo phone.
- [ ] Accessibility Service setup is understandable.
- [ ] User can enter a task on the phone.
- [ ] Android connects reliably to TypeScript server.
- [ ] TrueForge runs locally or in a supported deployment.
- [ ] TrueForge uses the chosen model successfully.
- [ ] Android actions are exposed through MCP.
- [ ] Accessibility tree is the primary perception source.
- [ ] At least one cross app task completes reliably.

### Safety

- [ ] Consequential action pauses for approval.
- [ ] Approval can be denied.
- [ ] Denial prevents the action.
- [ ] User can stop the task locally.
- [ ] Financial/authentication operations are refused.
- [ ] No security bypass behavior exists.

### Agent quality

- [ ] Important actions are verified.
- [ ] Unexpected states trigger recovery rather than blind continuation.
- [ ] Screenshot fallback works for at least one real case.
- [ ] At least one useful subagent exists.
- [ ] Sandbox use is real rather than decorative.
- [ ] Reconnect/session behavior is demonstrated.

### Presentation

- [ ] Observability dashboard shows TrueForge activity.
- [ ] Three minute demo is understandable without narration overload.
- [ ] Architecture diagram is clean.
- [ ] Public repo is readable.
- [ ] Setup instructions work.
- [ ] Evaluation results are real and reproducible.

---

## 50. Official references verified on 18 August 2026

These references should be re checked during implementation because SDKs and model catalogs can change quickly.

### Hackathon

- WeMakeDevs Agent Harness Hackathon  
  https://www.wemakedevs.org/hackathons/trueforge

### TrueForge

- TrueForge GitHub repository and README  
  https://github.com/truefoundry/trueforge

- TrueForge / TrueFoundry Agent Harness documentation  
  https://www.truefoundry.com/docs/agent-platform/agent-harness/overview

- Sandbox documentation  
  https://www.truefoundry.com/docs/agent-platform/agent-harness/sandbox

- SDK runtime API reference  
  https://www.truefoundry.com/docs/agent-platform/agent-harness/sdk/runtime-api-reference

- SDK turn events reference  
  https://www.truefoundry.com/docs/agent-platform/agent-harness/sdk/turn-events-reference

- Complete TypeScript/Python event handling example  
  https://www.truefoundry.com/docs/agent-platform/agent-harness/sdk/complete-example

### MCP

- Official MCP TypeScript SDK  
  https://github.com/modelcontextprotocol/typescript-sdk

### OpenCode Go

- OpenCode Go model and API endpoint documentation  
  https://opencode.ai/docs/go/

### Android

- Android Accessibility Service guide  
  https://developer.android.com/guide/topics/ui/accessibility/service

- Google Play AccessibilityService policy  
  https://support.google.com/googleplay/android-developer/answer/10964491

---

## 51. Final architecture statement

The project should preserve this separation throughout implementation:

> **The phone is the product surface and trusted local actuator. The TypeScript server is the typed bridge. MCP is the standardized tool boundary. TrueForge is the agent runtime and governance layer. The model decides what to do, but TrueForge controls how it acts.**

That separation is the core of the project and the clearest answer to why TrueForge is necessary.

