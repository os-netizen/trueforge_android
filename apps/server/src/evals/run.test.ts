import assert from "node:assert/strict";
import test from "node:test";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { firstApprovalEventIndex } from "./cases/approval-shared.js";
import { modelMessageCount, sandboxCreated } from "./cases/trace-shared.js";
import { assembleToolTrace } from "./run.js";
import type { EvalContext } from "./types.js";

test("assembles direct MCP calls and decodes MCP text results", () => {
  const events = [
    {
      type: "model.message",
      id: "message-1",
      threadId: "main",
      createdAt: "2026-08-29T00:00:00Z",
      content: null,
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "get_media_state", arguments: "{}" },
      }],
    },
    {
      type: "tool.response",
      id: "response-1",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01Z",
      toolCallId: "call-1",
      content: JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ available: true, sessions: [] }) }],
      }),
    },
  ] as TrueForgeApi.TurnStreamingEvent[];

  assert.deepEqual(assembleToolTrace(events), [{
    id: "call-1",
    toolName: "get_media_state",
    input: {},
    result: { available: true, sessions: [] },
  }]);
});

test("supports the call_tool wrapper", () => {
  const events = [{
    type: "model.message",
    id: "message-1",
    threadId: "main",
    createdAt: "2026-08-29T00:00:00Z",
    content: null,
    toolCalls: [{
      id: "call-1",
      type: "function",
      function: {
        name: "call_tool",
        arguments: JSON.stringify({ tool_name: "execute_action", input: { action: { type: "global_action", action: "home" } } }),
      },
    }],
  }] as TrueForgeApi.TurnStreamingEvent[];

  assert.equal(assembleToolTrace(events)[0]?.toolName, "execute_action");
});

test("reads sandbox use and assistant-turn count off an interleaved stream", () => {
  const events = [
    { type: "turn.created", id: "turn-1" },
    { type: "sandbox.created", id: "sandbox-1", sandboxId: "v1:local:/sandboxes/a", threadId: null },
    {
      type: "model.message",
      id: "message-1",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "commit_action", arguments: JSON.stringify({ intent: "Dismiss 4 notifications" }) },
      }],
    },
    // Deltas repeat an existing message id and must not inflate the count.
    { type: "model.message.delta", id: "message-1", content: "…" },
    { type: "tool.approval_required", id: "pause-1", sourceEventId: "message-1" },
    { type: "model.message", id: "message-2", content: "Dismissed 4, kept 1." },
  ];

  const context: EvalContext = {
    prompt: "bulk dismiss",
    turnStatus: "done",
    toolCalls: assembleToolTrace(events as TrueForgeApi.TurnStreamingEvent[]),
    events,
    approvals: [{ toolCallId: "call-1", intent: "Dismiss 4 notifications", decision: "allow" }],
    finalDeviceState: null,
    finalMediaState: null,
    finalNotifications: [{ title: "EVAL-KEEP" }],
  };

  assert.equal(sandboxCreated(context), true);
  assert.equal(modelMessageCount(context), 2);
  assert.equal(firstApprovalEventIndex(context), 4);
  assert.deepEqual(context.approvals.map((approval) => approval.decision), ["allow"]);
});

test("reports no sandbox when the stream never created one", () => {
  const context: EvalContext = {
    prompt: "bulk dismiss",
    turnStatus: "done",
    toolCalls: [],
    events: [{ type: "turn.created", id: "turn-1" }, { type: "model.message", id: "message-1" }],
    approvals: [],
    finalDeviceState: null,
    finalMediaState: null,
    finalNotifications: null,
  };

  assert.equal(sandboxCreated(context), false);
  assert.equal(modelMessageCount(context), 1);
});
