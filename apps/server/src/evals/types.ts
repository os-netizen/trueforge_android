export interface EvalContext {
  prompt: string;
  output?: string;
  turnStatus: "done" | "error" | "unknown";
  turnError?: string;
  toolCalls: ToolTraceEntry[];
  /** Raw TurnStreamingEvent[] across every turn, in order, for ordering checks. */
  events: unknown[];
  approvals: Array<{ toolCallId: string; intent: string; decision: "allow" | "deny" }>;
  finalDeviceState: Record<string, unknown> | null;
  finalMediaState: Record<string, unknown> | null;
  /** Authoritative post-run notification list, or null when unavailable. */
  finalNotifications: Array<Record<string, unknown>> | null;
}

export interface ToolTraceEntry {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: unknown;
}

export interface EvalCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AndroidEvalCase {
  id: string;
  description: string;
  prompt: string;
  timeoutMs: number;
  /**
   * Stands in for the human at an approval pause so evals run unattended.
   * Omitted means deny: an unexpected pause should fail the case, not sail
   * through it.
   */
  approvalDecision?: (info: {
    intent: string;
    toolName: string;
    action: Record<string, unknown>;
  }) => "allow" | "deny";
  checks(context: EvalContext): EvalCheckResult[];
}
