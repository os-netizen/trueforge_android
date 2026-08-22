import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

/**
 * Compact operational log of a turn stream, mirroring the success criterion
 * format from the handoff doc section 46:
 *
 *   USER: ...
 *   MODEL -> calls get_test_screen
 *   MCP RESULT -> ...
 *   TURN COMPLETE
 */

export class TurnLog {
  private readonly events: TrueForgeApi.TurnStreamingEvent[] = [];

  hasToolCall(): boolean {
    return this.events.some(
      (e) =>
        e.type === "model.message" &&
        e.threadId === "main" &&
        (e.toolCalls?.length ?? 0) > 0,
    );
  }

  hasToolResult(): boolean {
    return this.events.some((e) => e.type === "tool.response");
  }

  /** Live-print notable events as they arrive. */
  ingest(event: TrueForgeApi.TurnStreamingEvent): void {
    this.events.push(event);
    switch (event.type) {
      case "tool.approval_required":
        this.emit("APPROVAL REQUIRED");
        break;
      case "sandbox.created":
        this.emit("SANDBOX CREATED");
        break;
      default:
        break;
    }
  }

  user(prompt: string): void {
    this.emit(`USER: ${prompt}`);
  }

  /** Renders the full ordered narrative once the stream has ended. */
  summarize(): void {
    const merged = new Map<string, TrueForgeApi.ModelMessageEvent>();
    const order: string[] = [];

    for (const event of this.events) {
      if (isEventDelta(event)) {
        const base = merged.get(event.id);
        if (base) {
          mergeEventDelta(base, event);
        }
        continue;
      }

      switch (event.type) {
        case "model.message": {
          merged.set(event.id, event);
          if (!order.includes(event.id)) order.push(event.id);
          break;
        }
        case "tool.response":
          this.emit(
            `MCP RESULT -> ${truncate(event.content, 240)} [thread=${event.threadId}]`,
          );
          break;
        case "tool.approval_required":
          for (const call of event.toolCalls ?? []) {
            this.emit(`  pending approval: toolCallId=${call.id}`);
          }
          break;
        case "thread.created":
          this.emit(
            `SUBAGENT STARTED thread=${event.threadId} name="${event.agentInfo?.name ?? "?"}"`,
          );
          break;
        case "thread.done":
          this.emit(
            `SUBAGENT COMPLETED thread=${event.threadId} state=${String(event.state)}`,
          );
          break;
        case "mcp.initialize":
          this.emit(`MCP INITIALIZED`);
          break;
        case "turn.done":
          this.emit("TURN COMPLETE");
          break;
        case "sandbox.created":
          break;
        default:
          break;
      }
    }

    // Emit model messages in event order, interleaved by their position among
    // the other lines already emitted is approximated by sorting on createdAt.
    const timeline = [
      ...[...merged.values()].map((m) => ({
        at: m.createdAt,
        render: () => renderModelMessage(m),
      })),
      ...this.events
        .filter(
          (e): e is Extract<TrueForgeApi.TurnStreamingEvent, { type: "tool.response" }> =>
            e.type === "tool.response",
        )
        .map((e) => ({
          at: e.createdAt,
          render: () =>
            `MCP RESULT -> ${truncate(e.content, 240)} [thread=${e.threadId}]`,
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    this.emit("--- execution trace ---");
    for (const item of timeline) {
      this.emit(item.render());
    }
  }

  private emit(text: string): void {
    console.log(text);
  }
}

function renderModelMessage(message: TrueForgeApi.ModelMessageEvent): string {
  const parts: string[] = [];
  const text = messageText(message);
  if (message.threadId !== "main") parts.push(`[sub:${message.threadId}]`);
  if (text) parts.push(`MODEL: ${truncate(text, 400)}`);
  for (const call of message.toolCalls ?? []) {
    parts.push(
      `MODEL -> calls ${call.function.name}${call.function.arguments ? `(${truncate(call.function.arguments, 200)})` : "()"}`,
    );
  }
  return parts.join(" ") || "(empty model message)";
}

function messageText(message: TrueForgeApi.ModelMessageEvent): string | null {
  const content = message.content;
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }
  if (typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return null;
}

export function toolCallName(call: TrueForgeApi.ToolCall): string {
  return call.function.name;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
