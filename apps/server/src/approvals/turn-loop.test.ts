import assert from "node:assert/strict";
import test from "node:test";
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { runTurnLoopWithApprovals } from "./turn-loop.js";

type Turn = { input: TrueForgeApi.TurnInputItem[] };

/**
 * Minimal stand-in for the TrueForge client: each scripted turn is a list of
 * streaming events, and every createTurnStream input is recorded so the test
 * can assert on the resume payload.
 */
function fakeClient(turns: unknown[][]): { client: TrueForge; sent: Turn[] } {
  const sent: Turn[] = [];
  let index = 0;
  const client = {
    sessions: {
      createTurnStream: async (_sessionId: string, request: Turn) => {
        sent.push({ input: request.input });
        const events = turns[index] ?? [];
        index += 1;
        return (async function* stream() {
          for (const event of events) yield event;
        })();
      },
    },
  } as unknown as TrueForge;
  return { client, sent };
}

function pausedTurn(): unknown[] {
  return [
    {
      type: "model.message",
      id: "message-1",
      threadId: "main",
      createdAt: "2026-08-29T00:00:00Z",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "commit_action",
          arguments: JSON.stringify({
            intent: "Dismiss the EVAL-APPROVAL target notification",
            action: { type: "notification_action", key: "k", action: "dismiss" },
          }),
        },
      }],
    },
    {
      type: "tool.approval_required",
      id: "approval-1",
      createdAt: "2026-08-29T00:00:01Z",
      threadId: "thread-9",
      toolCalls: [{ id: "call-1", sourceEventId: "message-1" }],
    },
    {
      type: "turn.done",
      id: "done-1",
      createdAt: "2026-08-29T00:00:02Z",
      state: {
        status: "done",
        completedAt: "2026-08-29T00:00:02Z",
        output: null,
        requiredActions: [{
          type: "tool.approval_required",
          id: "approval-1",
          createdAt: "2026-08-29T00:00:01Z",
          threadId: "thread-9",
          toolCalls: [{ id: "call-1", sourceEventId: "message-1" }],
        }],
      },
    },
  ];
}

function finishedTurn(content: string): unknown[] {
  return [{
    type: "turn.done",
    id: "done-2",
    createdAt: "2026-08-29T00:00:05Z",
    state: {
      status: "done",
      completedAt: "2026-08-29T00:00:05Z",
      output: { type: "model.message", id: "message-2", threadId: "main", createdAt: "2026-08-29T00:00:05Z", content },
      requiredActions: [],
    },
  }];
}

function questionTurn(): unknown[] {
  return [
    {
      type: "model.message",
      id: "question-message-1",
      threadId: "main",
      createdAt: "2026-08-29T00:00:00Z",
      toolCalls: [{
        toolInfo: { type: "truefoundry-system", name: "ask_user_question" },
        id: "question-call-1",
        type: "function",
        function: {
          name: "ask_user_question",
          arguments: JSON.stringify({
            question: "Which Tibo account?",
            options: ["@thsottiaux", "@tibo_maker"],
          }),
        },
      }],
    },
    {
      type: "turn.done",
      id: "question-done-1",
      createdAt: "2026-08-29T00:00:01Z",
      state: {
        status: "done",
        output: null,
        requiredActions: [{
          type: "tool.response_required",
          id: "response-1",
          createdAt: "2026-08-29T00:00:01Z",
          threadId: "main",
          toolCalls: [{ id: "question-call-1", sourceEventId: "question-message-1" }],
        }],
      },
    },
  ];
}

test("a pause resumes as a user.tool_approval turn carrying the decision", async () => {
  const { client, sent } = fakeClient([pausedTurn(), finishedTurn("Dismissed it.")]);
  const seen: string[] = [];

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    decide: async (info) => {
      seen.push(info.intent);
      return { decision: "allow" };
    },
  });

  assert.deepEqual(seen, ["Dismiss the EVAL-APPROVAL target notification"]);
  assert.deepEqual(sent[1]?.input, [{
    type: "user.tool_approval",
    threadId: "thread-9",
    toolCallId: "call-1",
    approval: { status: "allow" },
  }]);
  assert.equal(result.output, "Dismissed it.");
  assert.equal(result.turnStatus, "done");
  assert.deepEqual(result.approvals, [{
    toolCallId: "call-1",
    intent: "Dismiss the EVAL-APPROVAL target notification",
    decision: "allow",
  }]);
});

test("a denial resumes with a reason the model can report on", async () => {
  const { client, sent } = fakeClient([pausedTurn(), finishedTurn("You denied it.")]);

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    decide: async () => ({ decision: "deny", reason: "User denied on device" }),
  });

  assert.deepEqual(sent[1]?.input, [{
    type: "user.tool_approval",
    threadId: "thread-9",
    toolCallId: "call-1",
    approval: { status: "deny", reason: "User denied on device" },
  }]);
  assert.equal(result.approvals[0]?.decision, "deny");
});

test("a client-side question resumes as user.tool_response with the selected option", async () => {
  const { client, sent } = fakeClient([questionTurn(), finishedTurn("Found the tweet.")]);
  const seen: Array<{ question: string; options: string[] }> = [];

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "find Tibo",
    decide: async () => ({ decision: "deny" }),
    answer: async (info) => {
      seen.push({ question: info.question, options: info.options });
      return { content: "@tibo_maker" };
    },
  });

  assert.deepEqual(seen, [{
    question: "Which Tibo account?",
    options: ["@thsottiaux", "@tibo_maker"],
  }]);
  assert.deepEqual(sent[1]?.input, [{
    type: "user.tool_response",
    threadId: "main",
    toolCallId: "question-call-1",
    content: "@tibo_maker",
  }]);
  assert.equal(result.output, "Found the tweet.");
});

test("a decider that throws denies rather than leaking an approval", async () => {
  const { client, sent } = fakeClient([pausedTurn(), finishedTurn("Could not reach you.")]);

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    decide: async () => {
      throw new Error("device offline");
    },
  });

  const resume = sent[1]?.input[0] as TrueForgeApi.UserToolApprovalEvent;
  assert.equal(resume.approval.status, "deny");
  assert.match(
    resume.approval.status === "deny" ? resume.approval.reason ?? "" : "",
    /device offline/,
  );
  assert.equal(result.approvals[0]?.decision, "deny");
});

test("a call_tool-wrapped pause still shows the real intent and action", async () => {
  const paused = pausedTurn();
  (paused[0] as { toolCalls: Array<{ function: { name: string; arguments: string } }> })
    .toolCalls[0]!.function = {
      name: "call_tool",
      arguments: JSON.stringify({
        mcp_server: "android-tool-bridge",
        tool_name: "commit_action",
        input: {
          intent: "Dismiss the EVAL-APPROVAL target notification",
          action: { type: "notification_action", key: "k", action: "dismiss" },
        },
      }),
    };
  const { client } = fakeClient([paused, finishedTurn("Dismissed it.")]);
  const seen: Array<{ intent: string; toolName: string; actionJson: string }> = [];

  await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    decide: async (info) => {
      seen.push({ intent: info.intent, toolName: info.toolName, actionJson: info.actionJson });
      return { decision: "allow" };
    },
  });

  assert.deepEqual(seen, [{
    intent: "Dismiss the EVAL-APPROVAL target notification",
    toolName: "commit_action",
    actionJson: JSON.stringify({ type: "notification_action", key: "k", action: "dismiss" }),
  }]);
});

test("a malformed approval is denied without consulting the decider", async () => {
  const paused = pausedTurn();
  (paused[0] as { toolCalls: Array<{ function: { arguments: string } }> })
    .toolCalls[0]!.function.arguments = "{";
  const { client, sent } = fakeClient([paused, finishedTurn("Denied malformed call.")]);
  let decisions = 0;

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    decide: async () => {
      decisions += 1;
      return { decision: "allow" };
    },
  });

  assert.equal(decisions, 0);
  const resume = sent[1]?.input[0] as TrueForgeApi.UserToolApprovalEvent;
  assert.equal(resume.approval.status, "deny");
  assert.match(resume.approval.status === "deny" ? resume.approval.reason ?? "" : "", /malformed/);
  assert.equal(result.approvals[0]?.decision, "deny");
});

test("every required-action group is included in one resume turn", async () => {
  const approval = pausedTurn();
  const question = questionTurn();
  const done = approval.at(-1) as {
    state: { requiredActions: unknown[] };
  };
  done.state.requiredActions.push(
    ...(question.at(-1) as { state: { requiredActions: unknown[] } }).state.requiredActions,
  );
  const combined = [approval[0], question[0], done];
  const { client, sent } = fakeClient([combined, finishedTurn("Both resolved.")]);

  await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "do both",
    decide: async () => ({ decision: "allow" }),
    answer: async () => ({ content: "@tibo_maker" }),
  });

  assert.deepEqual(sent[1]?.input.map((item) => item.type), [
    "user.tool_approval",
    "user.tool_response",
  ]);
});

test("the loop stops after the turn cap instead of resuming forever", async () => {
  const { client, sent } = fakeClient([pausedTurn(), pausedTurn(), pausedTurn()]);

  const result = await runTurnLoopWithApprovals({
    client,
    sessionId: "session-1",
    prompt: "dismiss it",
    maxTurns: 2,
    decide: async () => ({ decision: "allow" }),
  });

  assert.equal(sent.length, 2);
  assert.match(result.turnError ?? "", /exceeded 2 turns/);
});
