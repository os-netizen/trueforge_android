import assert from "node:assert/strict";
import test from "node:test";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { extractFrame, TranscriptBuilder, unwrapToolCall } from "./transcript.js";

const AT = "2026-08-29T12:35:16.000Z";

function toolCall(id: string, name: string, args: string): TrueForgeApi.ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
    toolInfo: { type: "truefoundry-system", name },
  } as TrueForgeApi.ToolCall;
}

test("unwrapToolCall reports the real tool behind the call_tool wrapper", () => {
  const unwrapped = unwrapToolCall(toolCall(
    "call_1",
    "call_tool",
    JSON.stringify({
      mcp_server: "android-tool-bridge",
      tool_name: "launch_app",
      input: { packageName: "com.whatsapp" },
    }),
  ));
  assert.equal(unwrapped.name, "launch_app");
  assert.equal(unwrapped.server, "android-tool-bridge");
  assert.equal(unwrapped.argsPartial, false);
  assert.deepEqual(JSON.parse(unwrapped.args), { packageName: "com.whatsapp" });
});

test("unwrapToolCall recovers a tool name from a partial argument fragment", () => {
  const unwrapped = unwrapToolCall(toolCall(
    "call_1",
    "call_tool",
    '{"mcp_server": "android-tool-bridge", "tool_name": "get_screen", "inp',
  ));
  assert.equal(unwrapped.name, "get_screen");
  assert.equal(unwrapped.argsPartial, true);
});

test("a delta-streamed tool call is paired with its response", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Open whatsapp", AT);

  builder.push({
    type: "model.message",
    id: "msg_1",
    threadId: "main",
    createdAt: AT,
  } as TrueForgeApi.ModelMessageEvent);

  builder.push({
    type: "model.message.delta",
    id: "msg_1",
    threadId: "main",
    reasoningContent: "I should ",
  } as TrueForgeApi.ModelMessageDeltaEvent);
  builder.push({
    type: "model.message.delta",
    id: "msg_1",
    threadId: "main",
    reasoningContent: "launch it.",
  } as TrueForgeApi.ModelMessageDeltaEvent);

  builder.push({
    type: "model.message.delta",
    id: "msg_1",
    threadId: "main",
    toolCalls: [{
      index: 0,
      id: "call_1",
      type: "function",
      toolInfo: { type: "truefoundry-system", name: "call_tool" },
      function: { name: "call_tool", arguments: "" },
    }],
  } as unknown as TrueForgeApi.ModelMessageDeltaEvent);
  for (const fragment of ['{"tool_name": "launch', '_app", "input": {"packageName"', ': "com.whatsapp"}}']) {
    builder.push({
      type: "model.message.delta",
      id: "msg_1",
      threadId: "main",
      toolCalls: [{ index: 0, function: { arguments: fragment } }],
    } as unknown as TrueForgeApi.ModelMessageDeltaEvent);
  }

  builder.push({
    type: "tool.response",
    id: "resp_1",
    threadId: "main",
    toolCallId: "call_1",
    createdAt: "2026-08-29T12:35:18.500Z",
    content: '{"status":"success","screenChanged":true}',
  });

  const items = builder.items();
  const reasoning = items.find((item) => item.kind === "reasoning");
  assert.equal(reasoning?.text, "I should launch it.");

  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool?.tool?.name, "launch_app");
  assert.equal(tool?.status, "ok");
  assert.deepEqual(JSON.parse(tool!.tool!.args), { packageName: "com.whatsapp" });
  assert.match(tool!.tool!.result!, /screenChanged/);
  assert.equal(tool?.tool?.durationMs, 2500);
});

test("a tool result carrying an error marks the call failed", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Open whatsapp", AT);
  builder.push({
    type: "model.message",
    id: "msg_1",
    threadId: "main",
    createdAt: AT,
    toolCalls: [toolCall("call_1", "call_tool", JSON.stringify({
      tool_name: "get_screen",
      input: {},
    }))],
  } as TrueForgeApi.ModelMessageEvent);
  builder.push({
    type: "tool.response",
    id: "resp_1",
    threadId: "main",
    toolCallId: "call_1",
    createdAt: AT,
    content: '{"error":[{"type":"text","text":"No active window"}]}',
  });

  const tool = builder.items().find((item) => item.kind === "tool");
  assert.equal(tool?.status, "error");
});

test("follow-up prompts extend the same transcript with a new turn", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Open whatsapp", AT);
  builder.push({
    type: "turn.done",
    id: "turn_1",
    threadId: "main",
    createdAt: AT,
    state: {
      status: "done",
      completedAt: AT,
      output: null,
      requiredActions: [],
      metrics: { totalTokens: 100, totalInputTokens: 80, totalOutputTokens: 20 },
    },
  } as unknown as TrueForgeApi.TurnDoneEvent);
  builder.beginTurn("Now open settings", AT);

  const prompts = builder.items().filter((item) => item.kind === "user");
  assert.deepEqual(prompts.map((item) => item.text), ["Open whatsapp", "Now open settings"]);
  assert.equal(prompts[1]!.turn, 2);

  const turn = builder.items().find((item) => item.kind === "turn");
  assert.equal(turn?.turnDetail?.metrics?.totalTokens, 100);
});

test("an approval pause is recorded and then resolved in place", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Dismiss that notification", AT);
  builder.approvalPending("call_9", "Dismiss the EVAL-APPROVAL notification");
  builder.approvalDecided("call_9", "Dismiss the EVAL-APPROVAL notification", "deny", "User said no");

  const approvals = builder.items().filter((item) => item.kind === "approval");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.approval?.decision, "deny");
  assert.equal(approvals[0]!.status, "error");
});

test("a client-side question is labelled as waiting for an answer, not approval", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Find Tibo", AT);
  builder.push({
    type: "turn.done",
    id: "question_turn",
    threadId: "main",
    createdAt: AT,
    state: {
      status: "done",
      completedAt: AT,
      output: null,
      requiredActions: [{
        type: "tool.response_required",
        id: "question_required",
        createdAt: AT,
        threadId: "main",
        toolCalls: [{ id: "question_call", sourceEventId: "question_message" }],
      }],
    },
  } as unknown as TrueForgeApi.TurnDoneEvent);

  const turn = builder.items().find((item) => item.kind === "turn");
  assert.equal(turn?.title, "Turn waiting for your answer");
  assert.equal(turn?.status, "warning");
});

test("a captured frame becomes a reference on the tool item, never inline bytes", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Look at the screen", AT);
  builder.push({
    type: "model.message",
    id: "msg_frame",
    threadId: "main",
    createdAt: AT,
    toolCalls: [toolCall("call_shot", "capture_screenshot", "{}")],
  } as TrueForgeApi.ModelMessageEvent);

  const [item] = builder.push({
    type: "tool.response",
    id: "evt_shot",
    threadId: "main",
    toolCallId: "call_shot",
    createdAt: AT,
    content: JSON.stringify({
      frameId: "frame-1",
      width: 1024,
      height: 768,
      sourceWidth: 2000,
      sourceHeight: 1500,
      note: "Multiply any point read off this image…",
    }),
  } as TrueForgeApi.ToolResponseEvent);

  assert.deepEqual(item?.tool?.frame, {
    id: "frame-1",
    width: 1024,
    height: 768,
    sourceWidth: 2000,
    sourceHeight: 1500,
  });
});

test("a result with no frame leaves the frame reference null", () => {
  assert.equal(extractFrame(JSON.stringify({ ok: true, nodes: [] })), null);
  assert.equal(extractFrame("stale_snapshot"), null);
  assert.equal(extractFrame(null), null);
});

test("a frame that reports no source size falls back to the image size", () => {
  assert.deepEqual(extractFrame(JSON.stringify({ frameId: "f", width: 800, height: 600 })), {
    id: "f",
    width: 800,
    height: 600,
    sourceWidth: 800,
    sourceHeight: 600,
  });
});

test("a sub-agent thread becomes one container item on the parent thread", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Find the mute control", AT);

  builder.push({
    type: "thread.created",
    id: "evt_thread",
    threadId: "thread_vision",
    createdAt: AT,
    title: "vision-recovery",
    agentInfo: {
      type: "dynamic",
      name: "vision-recovery",
      input: "Look at the call screen and find the mute toggle.",
    },
    parent: { threadId: "main", toolCallId: "call_sub" },
  } as TrueForgeApi.ThreadCreatedEvent);

  const items = builder.items();
  const container = items.find((item) => item.kind === "subagent");
  assert.ok(container, "expected a subagent container item");
  // On the parent's thread: the delegation is a step of the parent's run, and
  // placing it on the child's thread would nest the container inside itself.
  assert.equal(container.threadId, "main");
  assert.equal(container.status, "running");
  assert.equal(container.subAgent?.threadId, "thread_vision");
  assert.equal(container.subAgent?.parentToolCallId, "call_sub");
  assert.equal(container.subAgent?.name, "vision-recovery");

  builder.push({
    type: "thread.done",
    id: "evt_thread_done",
    threadId: "thread_vision",
    createdAt: AT,
    title: "vision-recovery",
    parent: { threadId: "main", toolCallId: "call_sub" },
    state: {
      status: "done",
      output: { content: "Node n_412 is the mute toggle." },
    },
  } as unknown as TrueForgeApi.ThreadDoneEvent);

  const closed = builder.items().filter((item) => item.kind === "subagent");
  // One container across both events, not a start row and a finish row.
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.subAgent?.status, "done");
  assert.equal(closed[0]?.subAgent?.output, "Node n_412 is the mute toggle.");
  assert.equal(closed[0]?.subAgent?.input, "Look at the call screen and find the mute toggle.");
});

test("a failed sub-agent closes as an error and keeps its brief", () => {
  const builder = new TranscriptBuilder();
  builder.beginTurn("Find it", AT);
  builder.push({
    type: "thread.created",
    id: "evt_a",
    threadId: "t1",
    createdAt: AT,
    title: "vision-recovery",
    agentInfo: { type: "dynamic", name: "vision-recovery", input: "brief text" },
    parent: { threadId: "main", toolCallId: "call_sub" },
  } as TrueForgeApi.ThreadCreatedEvent);
  builder.push({
    type: "thread.done",
    id: "evt_b",
    threadId: "t1",
    createdAt: AT,
    title: "vision-recovery",
    state: { status: "error", message: "iteration limit" },
  } as unknown as TrueForgeApi.ThreadDoneEvent);

  const container = builder.items().find((item) => item.kind === "subagent");
  assert.equal(container?.status, "error");
  assert.equal(container?.subAgent?.status, "error");
  assert.equal(container?.subAgent?.output, null);
  assert.equal(container?.subAgent?.input, "brief text");
});
