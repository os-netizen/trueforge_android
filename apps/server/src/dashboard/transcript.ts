/**
 * Run transcripts for the dashboard (diagnostics view).
 *
 * The raw TrueForge stream is not directly viewable: a single assistant turn
 * arrives as one `model.message` followed by dozens of `model.message.delta`
 * fragments (reasoning a few characters at a time, tool arguments split across
 * lines), and the `tool.response` that answers a call carries only a
 * `toolCallId` — never the tool's name. Rendering those events one per row is
 * what produced the old "Tool response" wall with no tool, no arguments and no
 * pairing.
 *
 * This module folds that stream into a stable, ordered list of transcript
 * items — thinking, assistant text, tool call *with* its arguments and its
 * matching result, approvals, turn boundaries with token metrics — and emits
 * only the items that changed so a live view can patch in place.
 *
 * The same builder serves history: TrueForge persists already-merged events
 * (no deltas) per turn, so an old session replays through the identical code
 * path via `buildTranscriptFromSession`.
 */
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export type TranscriptItemKind =
  | "user"
  | "reasoning"
  | "assistant"
  | "tool"
  | "approval"
  | "system"
  | "subagent"
  | "turn";

export type TranscriptStatus = "running" | "ok" | "error" | "warning";

export interface TranscriptToolDetail {
  /** Tool the agent actually invoked, with any `call_tool` wrapper removed. */
  name: string;
  /** MCP server the tool belongs to, when the call names one. */
  server: string | null;
  /** Pretty-printed arguments; the raw fragment while a call is still streaming. */
  args: string;
  /** True while `args` is an incomplete JSON fragment from the delta stream. */
  argsPartial: boolean;
  /** Whether the tool ran behind the approval gate (`commit_action`). */
  gated: boolean;
  result: string | null;
  resultBytes: number;
  /** Result text truncated for transport; the full text stays fetchable. */
  resultTruncated: boolean;
  durationMs: number | null;
  /** Screen frame this call captured, if any; the pixels live in the frame store. */
  frame: TranscriptFrame | null;
}

/**
 * A frame the dashboard can render as an image.
 *
 * Only the id and geometry travel; `GET /api/frames/{id}` serves the bytes.
 * `sourceWidth`/`sourceHeight` are what let a viewer translate a point on the
 * image back into the native screen pixels an action would use.
 */
export interface TranscriptFrame {
  id: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * A delegated sub-agent thread, rendered as a container in the transcript.
 *
 * The events already carry everything needed to nest correctly: `thread.created`
 * names the agent, its prompt and the parent tool call that spawned it, and
 * every later item carries the `threadId` it happened on. Without this the
 * sub-agent's work reads as two anonymous "system" rows with its tool calls
 * spliced into the main thread's, which is precisely where a delegated visual
 * recovery becomes impossible to follow.
 */
export interface TranscriptSubAgentDetail {
  threadId: string;
  /** Thread this delegation was made from; `main` for a top-level sub-agent. */
  parentThreadId: string;
  /** Tool call on the parent thread that created it, when known. */
  parentToolCallId: string | null;
  name: string;
  /** Prompt the parent handed the sub-agent. */
  input: string;
  model: string | null;
  status: "running" | "done" | "error";
  /** What the sub-agent reported back, once it has finished. */
  output: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TranscriptTurnDetail {
  index: number;
  status: "running" | "done" | "error" | "paused";
  finishReason: string | null;
  metrics: TurnMetricsSummary | null;
}

export interface TranscriptItem {
  id: string;
  /** Monotonic ordering key, assigned when the item first appears. */
  seq: number;
  kind: TranscriptItemKind;
  /** 1-based turn this item belongs to. */
  turn: number;
  /** `main` for the root agent; subagent threads get their own id. */
  threadId: string;
  at: string;
  title: string;
  status: TranscriptStatus;
  text?: string;
  tool?: TranscriptToolDetail;
  subAgent?: TranscriptSubAgentDetail;
  approval?: {
    toolCallId: string;
    intent: string;
    decision: "allow" | "deny" | null;
    reason: string | null;
  };
  turnDetail?: TranscriptTurnDetail;
}

export interface TurnMetricsSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

/** Result text longer than this is clipped in the transcript payload. */
const MAX_RESULT_CHARS = 4000;

/** Tools TrueForge injects itself; the interesting name is nested inside. */
const WRAPPER_TOOLS = new Set(["call_tool"]);

export function summarizeMetrics(
  metrics: TrueForgeApi.TurnMetrics | undefined | null,
): TurnMetricsSummary | null {
  if (!metrics) return null;
  return {
    inputTokens: metrics.totalInputTokens ?? 0,
    outputTokens: metrics.totalOutputTokens ?? 0,
    totalTokens: metrics.totalTokens ?? 0,
    cacheReadTokens: metrics.totalCacheReadTokens ?? 0,
    cacheWriteTokens: metrics.totalCacheWriteTokens ?? 0,
    reasoningTokens: metrics.totalReasoningTokens ?? 0,
    costUsd: metrics.totalCostInUsd ?? null,
  };
}

export function addMetrics(
  a: TurnMetricsSummary | null,
  b: TurnMetricsSummary | null,
): TurnMetricsSummary | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd === null && b.costUsd === null
      ? null
      : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface UnwrappedToolCall {
  name: string;
  server: string | null;
  args: string;
  argsPartial: boolean;
}

/**
 * Resolves the tool a call really targets.
 *
 * Models reach MCP tools through TrueForge's `call_tool` wrapper, whose
 * arguments nest the real `tool_name`, `mcp_server` and `input`. Showing the
 * wrapper instead makes every device action read as an identical "call_tool",
 * which is exactly the information the operator needs and never had.
 */
export function unwrapToolCall(call: TrueForgeApi.ToolCall): UnwrappedToolCall {
  const rawArgs = call.function.arguments ?? "";
  const parsed = asRecord(parseJson(rawArgs));
  if (!parsed) {
    // Still streaming: show the fragment rather than an empty box, and recover
    // the tool name from it when enough characters have arrived.
    const guessed = /"tool_name"\s*:\s*"([^"]+)"/.exec(rawArgs)?.[1];
    const server = /"mcp_server"\s*:\s*"([^"]+)"/.exec(rawArgs)?.[1] ?? null;
    return {
      name: guessed ?? call.function.name ?? "unknown",
      server,
      args: rawArgs,
      argsPartial: rawArgs.length > 0,
    };
  }
  if (WRAPPER_TOOLS.has(call.function.name) || typeof parsed.tool_name === "string") {
    const inner = asRecord(parsed.input) ?? {};
    return {
      name: typeof parsed.tool_name === "string" ? parsed.tool_name : call.function.name,
      server: typeof parsed.mcp_server === "string" ? parsed.mcp_server : null,
      args: JSON.stringify(inner, null, 2),
      argsPartial: false,
    };
  }
  return {
    name: call.function.name,
    server: call.toolInfo?.type === "truefoundry-system" ? "trueforge" : null,
    args: JSON.stringify(parsed, null, 2),
    argsPartial: false,
  };
}

/** A tool result is an error when the tool reported one, not when it is empty. */
function toolResultStatus(content: string): TranscriptStatus {
  const parsed = parseJson(content);
  const record = asRecord(parsed);
  if (record) {
    if (record.error != null && record.error !== false) return "error";
    if (record.status === "error" || record.status === "failed") return "error";
    if (record.status === "stale_snapshot") return "warning";
  }
  return /^\s*(error|failed)\b/i.test(content) ? "error" : "ok";
}

/**
 * Pulls a frame reference out of a tool result.
 *
 * `capture_screenshot` and `inspect_screen_visually` both put a `frameId` and
 * the geometry in their text content (see media/frames.ts); anything else in
 * the result is left alone. Matching on the field rather than the tool name
 * means a future capturing tool renders its frame without touching this.
 */
export function extractFrame(content: string | null | undefined): TranscriptFrame | null {
  const record = asRecord(parseJson(content ?? ""));
  const source = record && typeof record.frameId === "string"
    ? record
    : asRecord((record ?? {}).frame);
  if (!source || typeof source.frameId !== "string") return null;
  const size = (key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const width = size("width");
  const height = size("height");
  return {
    id: source.frameId,
    width,
    height,
    sourceWidth: size("sourceWidth") || width,
    sourceHeight: size("sourceHeight") || height,
  };
}

function clip(content: string): { text: string; truncated: boolean } {
  return content.length <= MAX_RESULT_CHARS
    ? { text: content, truncated: false }
    : { text: `${content.slice(0, MAX_RESULT_CHARS)}…`, truncated: true };
}

/**
 * Folds a TrueForge event stream into transcript items.
 *
 * Every mutating call returns the items it touched, so a caller can stream
 * patches instead of re-sending the whole transcript on each of the hundreds
 * of deltas a single turn produces.
 */
export class TranscriptBuilder {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, TranscriptItem>();
  /** Merged `model.message` events, keyed by event id, for delta accumulation. */
  private readonly messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
  /** Tool call id -> transcript item id, so `tool.response` can find its call. */
  private readonly toolItems = new Map<string, string>();
  /** Sub-agent thread id -> its container item id, for the closing event. */
  private readonly threadItems = new Map<string, string>();
  private seq = 0;
  private turn = 0;

  items(): TranscriptItem[] {
    return this.order.map((id) => this.byId.get(id)!).filter(Boolean);
  }

  get turnCount(): number {
    return this.turn;
  }

  /** Text of the most recent assistant message, used as the run's output. */
  lastAssistantText(): string | undefined {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const item = this.byId.get(this.order[i]!);
      if (item?.kind === "assistant" && item.text?.trim()) return item.text;
    }
    return undefined;
  }

  /** Opens a turn with the prompt that started it. */
  beginTurn(prompt: string, at = new Date().toISOString()): TranscriptItem[] {
    this.turn += 1;
    if (!prompt) return [];
    return [this.upsert(`turn-${this.turn}-user`, {
      kind: "user",
      title: "User prompt",
      status: "ok",
      at,
      text: prompt,
    })];
  }

  /** Opens a turn created only to answer pending approvals. */
  beginApprovalTurn(): void {
    this.turn += 1;
  }

  push(event: TrueForgeApi.TurnStreamingEvent): TranscriptItem[] {
    if (isEventDelta(event)) {
      const base = this.messages.get(event.id);
      if (!base) return [];
      mergeEventDelta(base, event);
      return this.renderMessage(base);
    }

    switch (event.type) {
      case "model.message": {
        const clone = structuredClone(event);
        this.messages.set(event.id, clone);
        return this.renderMessage(clone);
      }
      case "tool.response":
        return this.applyToolResponse(event);
      case "mcp.initialize":
        return [this.upsert(`mcp-${event.id}`, {
          kind: "system",
          title: "Tool bridge connected",
          status: "ok",
          at: event.createdAt,
          text: describeMcpInitialize(event),
        })];
      case "thread.created":
        return this.applyThreadCreated(event);
      case "thread.done":
        return this.applyThreadDone(event);
      case "turn.done":
        return this.applyTurnDone(event);
      default:
        // sandbox.created, turn.created, mcp.auth_required, tool.response_required
        return this.applyGenericEvent(event);
    }
  }

  /** Records the pause the phone is being asked to resolve. */
  approvalPending(toolCallId: string, intent: string): TranscriptItem[] {
    return [this.upsert(`approval-${toolCallId}`, {
      kind: "approval",
      title: "Waiting for approval on the phone",
      status: "warning",
      at: new Date().toISOString(),
      approval: { toolCallId, intent, decision: null, reason: null },
    })];
  }

  approvalDecided(
    toolCallId: string,
    intent: string,
    decision: "allow" | "deny",
    reason: string | null,
  ): TranscriptItem[] {
    return [this.upsert(`approval-${toolCallId}`, {
      kind: "approval",
      title: decision === "allow" ? "Approved on the phone" : "Denied on the phone",
      status: decision === "allow" ? "ok" : "error",
      at: new Date().toISOString(),
      approval: { toolCallId, intent, decision, reason },
    })];
  }

  /** Records a failure that ended the run outside the TrueForge stream. */
  runError(message: string): TranscriptItem[] {
    return [this.upsert(`run-error-${this.order.length}`, {
      kind: "system",
      title: "Run failed",
      status: "error",
      at: new Date().toISOString(),
      text: message,
    })];
  }

  private renderMessage(message: TrueForgeApi.ModelMessageEvent): TranscriptItem[] {
    const touched: TranscriptItem[] = [];
    const at = message.createdAt ?? new Date().toISOString();
    const threadId = message.threadId;

    if (message.reasoningContent) {
      touched.push(this.upsert(`${message.id}:reasoning`, {
        kind: "reasoning",
        title: "Thinking",
        status: message.finishReason ? "ok" : "running",
        at,
        threadId,
        text: message.reasoningContent,
      }));
    }

    const text = messageText(message.content);
    if (text.trim()) {
      touched.push(this.upsert(`${message.id}:text`, {
        kind: "assistant",
        title: "Assistant",
        status: "ok",
        at,
        threadId,
        text,
      }));
    }

    for (const [index, call] of (message.toolCalls ?? []).entries()) {
      const itemId = `${message.id}:tool:${index}`;
      if (call.id) this.toolItems.set(call.id, itemId);
      const unwrapped = unwrapToolCall(call);
      const existing = this.byId.get(itemId);
      // A response may already have landed; never overwrite it with a re-render.
      const previous = existing?.tool;
      touched.push(this.upsert(itemId, {
        kind: "tool",
        title: unwrapped.name,
        status: previous?.result != null ? existing!.status : "running",
        at: existing?.at ?? at,
        threadId,
        tool: {
          name: unwrapped.name,
          server: unwrapped.server,
          args: unwrapped.args,
          argsPartial: unwrapped.argsPartial,
          gated: unwrapped.name === "commit_action",
          result: previous?.result ?? null,
          resultBytes: previous?.resultBytes ?? 0,
          resultTruncated: previous?.resultTruncated ?? false,
          durationMs: previous?.durationMs ?? null,
          frame: previous?.frame ?? null,
        },
      }));
    }
    return touched;
  }

  private applyToolResponse(event: TrueForgeApi.ToolResponseEvent): TranscriptItem[] {
    const itemId = this.toolItems.get(event.toolCallId);
    const content = event.content ?? "";
    const { text, truncated } = clip(content);
    const status = toolResultStatus(content);

    if (!itemId || !this.byId.get(itemId)) {
      // A response with no visible call (history gaps, or a call streamed on a
      // message we never saw) still belongs in the transcript.
      return [this.upsert(`orphan-${event.id}`, {
        kind: "tool",
        title: "Tool result",
        status,
        at: event.createdAt,
        threadId: event.threadId,
        tool: {
          name: "unknown",
          server: null,
          args: "",
          argsPartial: false,
          gated: false,
          result: text,
          resultBytes: content.length,
          resultTruncated: truncated,
          durationMs: null,
          frame: extractFrame(content),
        },
      })];
    }

    const item = this.byId.get(itemId)!;
    const startedAt = Date.parse(item.at);
    const endedAt = Date.parse(event.createdAt);
    return [this.upsert(itemId, {
      ...item,
      status,
      tool: {
        ...item.tool!,
        result: text,
        resultBytes: content.length,
        resultTruncated: truncated,
        durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt)
          ? Math.max(0, endedAt - startedAt)
          : null,
        frame: extractFrame(content),
      },
    })];
  }

  /**
   * Opens a sub-agent container.
   *
   * The item is placed on the *parent* thread, not the child's: it is the
   * delegation as the parent experienced it, and putting it on the child's
   * thread would make the container nest inside itself.
   */
  private applyThreadCreated(event: TrueForgeApi.ThreadCreatedEvent): TranscriptItem[] {
    const itemId = `subagent-${event.threadId}`;
    this.threadItems.set(event.threadId, itemId);
    const name = event.agentInfo?.name || event.title || "sub-agent";
    return [this.upsert(itemId, {
      kind: "subagent",
      title: name,
      status: "running",
      at: event.createdAt,
      threadId: event.parent?.threadId ?? "main",
      subAgent: {
        threadId: event.threadId,
        parentThreadId: event.parent?.threadId ?? "main",
        parentToolCallId: event.parent?.toolCallId ?? null,
        name,
        input: event.agentInfo?.input ?? "",
        model: event.agentInfo?.model ?? null,
        status: "running",
        output: null,
        startedAt: event.createdAt,
        finishedAt: null,
      },
    })];
  }

  private applyThreadDone(event: TrueForgeApi.ThreadDoneEvent): TranscriptItem[] {
    const itemId = this.threadItems.get(event.threadId) ?? `subagent-${event.threadId}`;
    const existing = this.byId.get(itemId);
    const failed = event.state.status === "error";
    // What the sub-agent reported back is the one part of its work the parent
    // acted on, so it is surfaced on the collapsed container rather than being
    // left inside as one more nested message.
    const output = event.state.status === "done"
      ? messageText(event.state.output?.content).trim() || null
      : null;
    const previous = existing?.subAgent;
    const name = previous?.name ?? event.title ?? "sub-agent";
    return [this.upsert(itemId, {
      kind: "subagent",
      title: name,
      status: failed ? "error" : "ok",
      at: existing?.at ?? event.createdAt,
      threadId: existing?.threadId ?? event.parent?.threadId ?? "main",
      subAgent: {
        threadId: event.threadId,
        parentThreadId: previous?.parentThreadId ?? event.parent?.threadId ?? "main",
        parentToolCallId: previous?.parentToolCallId ?? event.parent?.toolCallId ?? null,
        name,
        input: previous?.input ?? "",
        model: previous?.model ?? null,
        status: failed ? "error" : "done",
        output,
        startedAt: previous?.startedAt ?? event.createdAt,
        finishedAt: event.createdAt,
      },
    })];
  }

  private applyTurnDone(event: TrueForgeApi.TurnDoneEvent): TranscriptItem[] {
    const state = event.state;
    const paused = state.status === "done" &&
      (state.requiredActions?.length ?? 0) > 0;
    const status: TranscriptTurnDetail["status"] = state.status === "error" ||
      state.status === "cancelled"
      ? "error"
      : paused
        ? "paused"
        : "done";
    return [this.upsert(`turn-${this.turn}-done-${event.id}`, {
      kind: "turn",
      title: state.status === "cancelled"
        ? "Turn cancelled"
        : status === "error"
        ? "Turn failed"
        : paused
          ? state.requiredActions?.some((action) => action.type === "tool.response_required")
            ? "Turn waiting for your answer"
            : "Turn paused for approval"
          : `Turn ${this.turn} complete`,
      status: status === "error" ? "error" : paused ? "warning" : "ok",
      at: event.createdAt,
      text: state.status === "error"
        ? state.message || "TrueForge reported an error"
        : state.status === "cancelled"
          ? "Cancelled"
          : undefined,
      turnDetail: {
        index: this.turn,
        status,
        finishReason: state.status === "done"
          ? state.output?.finishReason ?? null
          : null,
        metrics: "metrics" in state ? summarizeMetrics(state.metrics) : null,
      },
    })];
  }

  private applyGenericEvent(event: TrueForgeApi.TurnStreamingEvent): TranscriptItem[] {
    const labels: Record<string, string> = {
      "sandbox.created": "Sandbox created (Code Mode)",
      "mcp.auth_required": "MCP authorization required",
      "tool.response_required": "Tool response required",
    };
    const title = labels[event.type];
    if (!title) return [];
    const { id, createdAt } = event as { id?: string; createdAt?: string };
    return [this.upsert(`sys-${id ?? this.seq}`, {
      kind: "system",
      title,
      status: event.type === "sandbox.created" ? "ok" : "warning",
      at: createdAt ?? new Date().toISOString(),
    })];
  }

  private upsert(
    id: string,
    patch: Omit<Partial<TranscriptItem>, "id" | "seq" | "turn"> & {
      kind: TranscriptItemKind;
      title: string;
      status: TranscriptStatus;
      at: string;
    },
  ): TranscriptItem {
    const existing = this.byId.get(id);
    if (!existing) {
      this.seq += 1;
      this.order.push(id);
    }
    const item: TranscriptItem = {
      ...(existing ?? { threadId: "main" }),
      ...patch,
      id,
      seq: existing?.seq ?? this.seq,
      turn: existing?.turn ?? Math.max(1, this.turn),
      threadId: patch.threadId ?? existing?.threadId ?? "main",
    } as TranscriptItem;
    this.byId.set(id, item);
    return item;
  }
}

function messageText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : ""))
      .join("");
  }
  return "";
}

function describeMcpInitialize(event: TrueForgeApi.McpInitializeEvent): string {
  const names = event.mcpServers.map((server) => server.name);
  return names.length ? names.join(", ") : "MCP server";
}

export interface SessionTranscript {
  items: TranscriptItem[];
  turns: Array<{
    id: string;
    index: number;
    prompt: string;
    createdAt: string;
    status: string;
    metrics: TurnMetricsSummary | null;
  }>;
  metrics: TurnMetricsSummary | null;
  output?: string;
}

/**
 * Rebuilds a past run's transcript from TrueForge's own history.
 *
 * TrueForge persists merged events per turn, so selecting an old run no longer
 * has to show whatever the live stream last put in browser memory.
 */
export async function buildTranscriptFromSession(
  client: TrueForge,
  sessionId: string,
): Promise<SessionTranscript> {
  const builder = new TranscriptBuilder();
  const turns: SessionTranscript["turns"] = [];
  let metrics: TurnMetricsSummary | null = null;

  const turnPage = await client.sessions.listTurns(sessionId, { limit: 25 });
  const allTurns: TrueForgeApi.Turn[] = [];
  for await (const turn of turnPage) allTurns.push(turn);
  allTurns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const [index, turn] of allTurns.entries()) {
    const prompt = turn.input
      ?.map((item) => (item.type === "user.message" && typeof item.content === "string"
        ? item.content
        : ""))
      .filter(Boolean)
      .join("\n") ?? "";
    builder.beginTurn(prompt, turn.createdAt);

    const events = await client.sessions.listTurnEvents(sessionId, turn.id, { limit: 100 });
    for await (const event of events) {
      builder.push(event as TrueForgeApi.TurnStreamingEvent);
    }

    const turnMetrics = "metrics" in turn.state
      ? summarizeMetrics(turn.state.metrics)
      : null;
    metrics = addMetrics(metrics, turnMetrics);
    turns.push({
      id: turn.id,
      index: index + 1,
      prompt,
      createdAt: turn.createdAt,
      status: turn.state.status,
      metrics: turnMetrics,
    });
  }

  return {
    items: builder.items(),
    turns,
    metrics,
    output: builder.lastAssistantText(),
  };
}
