/**
 * Normalized observability events (doc section 43).
 * These feed the dashboard timeline and Android task status.
 */
import { z } from "zod";

export const ObservabilityEvent = z.object({
  type: z.enum([
    "task.started",
    "model.reasoning_started",
    "mcp.tool_called",
    "device.observed",
    "device.action_requested",
    "device.action_completed",
    "device.screen_changed",
    "verification.succeeded",
    "verification.failed",
    "recovery.started",
    "vision.fallback_started",
    "vision.fallback_completed",
    "approval.required",
    "approval.allowed",
    "approval.denied",
    "sandbox.created",
    "subagent.started",
    "subagent.completed",
    "session.reconnected",
    "task.completed",
    "task.failed",
    "task.cancelled",
  ]),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  deviceId: z.string().nullable(),
  timestamp: z.number().int(),
  /** Concise operational description; never raw chain of thought. */
  message: z.string(),
  data: z.record(z.unknown()).nullable(),
});

export type ObservabilityEvent = z.infer<typeof ObservabilityEvent>;
