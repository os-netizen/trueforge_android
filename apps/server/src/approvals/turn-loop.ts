import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

/**
 * TrueForge approval semantics (Milestone 6).
 *
 * A tool listed in an agent's `requireApprovalForTools` makes the turn end
 * *paused*: `turn.done` carries `state.status === "done"` with a null output
 * and a `tool.approval_required` entry in `state.requiredActions`. The pending
 * call's name and arguments are not on that event — they live on the
 * `model.message` whose id matches `sourceEventId`, which itself may have
 * arrived as a series of deltas.
 *
 * Resuming means creating a NEW turn on the same session whose input is one
 * `user.tool_approval` item per pending tool call (never mixed with a
 * `user.message`). This loop drives that cycle to a real completion.
 */

export interface PendingApprovalInfo {
  toolCallId: string;
  toolName: string;
  intent: string;
  action: Record<string, unknown>;
  /** Compact JSON of `action`, ready for a detail view on the phone. */
  actionJson: string;
}

export interface ApprovalOutcome {
  decision: "allow" | "deny";
  reason?: string | null;
}

export interface RecordedApproval {
  toolCallId: string;
  intent: string;
  decision: "allow" | "deny";
}

export interface PendingQuestionInfo {
  toolCallId: string;
  toolName: string;
  question: string;
  options: string[];
}

export interface QuestionOutcome {
  content: string;
}

export interface TurnLoopOptions {
  client: TrueForge;
  sessionId: string;
  prompt: string;
  /** Hard cap on approval round-trips before the loop gives up. */
  maxTurns?: number;
  /** Called for every streamed event, across every turn. */
  onEvent?(event: TrueForgeApi.TurnStreamingEvent): void;
  /** Called once a pause is observed, before the decision is sought. */
  onPending?(info: PendingApprovalInfo): void;
  /** Resolves the pause. Must fail closed — anything but "allow" blocks. */
  decide(info: PendingApprovalInfo): Promise<ApprovalOutcome>;
  onDecided?(info: PendingApprovalInfo, outcome: ApprovalOutcome): void;
  /** Presents a client-side question and returns the user's non-empty answer. */
  answer?(info: PendingQuestionInfo): Promise<QuestionOutcome>;
  onQuestionPending?(info: PendingQuestionInfo): void;
  onQuestionAnswered?(info: PendingQuestionInfo, outcome: QuestionOutcome): void;
  /** Called before each resume turn, so a transcript can mark the boundary. */
  onResume?(): void;
}

export interface TurnLoopResult {
  events: TrueForgeApi.TurnStreamingEvent[];
  output?: string;
  turnStatus: "done" | "error" | "unknown";
  turnError?: string;
  approvals: RecordedApproval[];
}

const DEFAULT_MAX_TURNS = 5;

export function safeParseJson(value: string | undefined | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function runTurnLoopWithApprovals(
  opts: TurnLoopOptions,
): Promise<TurnLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const events: TrueForgeApi.TurnStreamingEvent[] = [];
  const approvals: RecordedApproval[] = [];
  let input: TrueForgeApi.TurnInputItem[] = [
    { type: "user.message", content: opts.prompt },
  ];
  let output: string | undefined;
  let turnStatus: TurnLoopResult["turnStatus"] = "unknown";
  let turnError: string | undefined;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (turn > 0) opts.onResume?.();
    const stream = await opts.client.sessions.createTurnStream(opts.sessionId, { input });
    const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
    let requiredActions: Array<TrueForgeApi.ToolApprovalRequiredEvent |
      TrueForgeApi.ToolResponseRequiredEvent> = [];

    for await (const raw of stream) {
      const event = raw as TrueForgeApi.TurnStreamingEvent;
      events.push(event);
      opts.onEvent?.(event);

      if (isEventDelta(event)) {
        const base = messages.get(event.id);
        if (base) mergeEventDelta(base, event);
        continue;
      }
      if (event.type === "model.message") {
        messages.set(event.id, structuredClone(event));
        continue;
      }
      if (event.type !== "turn.done") continue;

      if (event.state.status === "error") {
        turnStatus = "error";
        turnError = event.state.message || "TrueForge turn failed";
        continue;
      }
      if (event.state.status === "cancelled") {
        turnStatus = "error";
        turnError = event.state.reason
          ? `TrueForge turn cancelled: ${event.state.reason}`
          : "TrueForge turn cancelled";
        continue;
      }
      if (event.state.status === "done") {
        turnStatus = "done";
        const allRequired = event.state.requiredActions ?? [];
        requiredActions = allRequired.filter(
          (action): action is TrueForgeApi.ToolApprovalRequiredEvent |
            TrueForgeApi.ToolResponseRequiredEvent =>
            action.type === "tool.approval_required" || action.type === "tool.response_required",
        );
        if (requiredActions.length !== allRequired.length) {
          turnStatus = "error";
          turnError = "TrueForge returned an unsupported required action";
        }
        const content = event.state.output?.content;
        if (!requiredActions.length && typeof content === "string") output = content;
      }
    }

    if (turnStatus === "error" || !requiredActions.length) {
      return { events, output, turnStatus, turnError, approvals };
    }

    input = [];
    for (const requiredAction of requiredActions) {
      for (const ref of requiredAction.toolCalls) {
        if (requiredAction.type === "tool.approval_required") {
          let info: PendingApprovalInfo;
          try {
            info = describePendingCall(ref, messages);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            approvals.push({
              toolCallId: ref.id,
              intent: "Malformed approval request",
              decision: "deny",
            });
            input.push({
              type: "user.tool_approval",
              threadId: requiredAction.threadId,
              toolCallId: ref.id,
              approval: { status: "deny", reason },
            });
            continue;
          }
        opts.onPending?.(info);
        const outcome = await resolveFailClosed(opts.decide, info);
        opts.onDecided?.(info, outcome);
        approvals.push({
          toolCallId: info.toolCallId,
          intent: info.intent,
          decision: outcome.decision,
        });
        input.push({
          type: "user.tool_approval",
          threadId: requiredAction.threadId,
          toolCallId: ref.id,
          approval: outcome.decision === "allow"
            ? { status: "allow" }
            : { status: "deny", reason: outcome.reason ?? "User denied the action" },
        });
        } else {
          const info = describePendingQuestion(ref, messages);
          opts.onQuestionPending?.(info);
          if (!opts.answer) throw new Error("No client-side question handler is configured");
          const outcome = await opts.answer(info);
          if (!outcome.content.trim()) throw new Error("The device returned an empty answer");
          opts.onQuestionAnswered?.(info, outcome);
          input.push({
            type: "user.tool_response",
            threadId: requiredAction.threadId,
            toolCallId: ref.id,
            content: outcome.content,
          });
        }
      }
    }
  }

  return {
    events,
    output,
    turnStatus,
    turnError: turnError ?? `approval loop exceeded ${maxTurns} turns`,
    approvals,
  };
}

function describePendingQuestion(
  ref: TrueForgeApi.ToolCallRef,
  messages: Map<string, TrueForgeApi.ModelMessageEvent>,
): PendingQuestionInfo {
  const source = messages.get(ref.sourceEventId);
  const call = source?.toolCalls?.find((entry) => entry.id === ref.id);
  const parsed = safeParseJson(call?.function.arguments);
  const args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const question = typeof args.question === "string" ? args.question.trim() : "";
  const options = Array.isArray(args.options)
    ? args.options.filter((option): option is string => typeof option === "string" && !!option.trim())
    : [];
  if (!question || options.length > 5) {
    throw new Error("TrueForge returned a malformed ask_user_question call");
  }
  return {
    toolCallId: ref.id,
    toolName: call?.function.name ?? "ask_user_question",
    question,
    options,
  };
}

function describePendingCall(
  ref: TrueForgeApi.ToolCallRef,
  messages: Map<string, TrueForgeApi.ModelMessageEvent>,
): PendingApprovalInfo {
  const source = messages.get(ref.sourceEventId);
  if (!source) throw new Error("Approval denied: source message is missing");
  const call = source?.toolCalls?.find((entry) => entry.id === ref.id);
  if (!call) throw new Error("Approval denied: referenced tool call is missing");
  const parsed = safeParseJson(call?.function.arguments);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Approval denied: tool arguments are malformed");
  }
  const raw = parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : {};

  // Some models reach MCP tools through a `call_tool` wrapper that nests the
  // real name and arguments. Unwrap it, or the human is asked to approve
  // "Execute call_tool" with no visible detail.
  const wrapped = raw.input && typeof raw.input === "object"
    ? raw.input as Record<string, unknown>
    : null;
  const args = (wrapped ?? raw) as { intent?: unknown; action?: unknown };
  const toolName = typeof raw.tool_name === "string"
    ? raw.tool_name
    : call?.function.name ?? "unknown";
  if (toolName !== "commit_action") {
    throw new Error(`Approval denied: unexpected gated tool ${toolName}`);
  }
  const action = args.action && typeof args.action === "object"
    ? args.action as Record<string, unknown>
    : {};
  const intent = typeof args.intent === "string" ? args.intent.trim() : "";
  if (!intent || typeof action.type !== "string") {
    throw new Error("Approval denied: commit_action intent or action is malformed");
  }
  return {
    toolCallId: ref.id,
    toolName,
    intent,
    action,
    actionJson: JSON.stringify(action),
  };
}

/** A decider that throws, or answers anything but "allow", denies. */
async function resolveFailClosed(
  decide: TurnLoopOptions["decide"],
  info: PendingApprovalInfo,
): Promise<ApprovalOutcome> {
  try {
    const outcome = await decide(info);
    return outcome.decision === "allow"
      ? outcome
      : { decision: "deny", reason: outcome.reason ?? null };
  } catch (error) {
    return {
      decision: "deny",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
