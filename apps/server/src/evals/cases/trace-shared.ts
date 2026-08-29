import type { EvalContext } from "../types.js";

/** The raw stream, narrowed to the object events every helper here reads. */
export function eventsOf(context: EvalContext): Array<Record<string, unknown>> {
  return context.events.filter(
    (event): event is Record<string, unknown> => Boolean(event) && typeof event === "object",
  );
}

/**
 * Whether the turn ran inside a TrueForge sandbox.
 *
 * `sandbox.created` is session-scoped and emitted once, so its presence is the
 * authoritative signal that Code Mode engaged rather than the agent narrating
 * that it wrote a script.
 */
export function sandboxCreated(context: EvalContext): boolean {
  return eventsOf(context).some((event) => event.type === "sandbox.created");
}

/**
 * Assistant turns taken, counting only whole `model.message` events.
 *
 * Deltas re-report the same message id, so they would inflate the count that
 * distinguishes one script from N round-trips.
 */
export function modelMessageCount(context: EvalContext): number {
  const ids = new Set<string>();
  for (const event of eventsOf(context)) {
    if (event.type === "model.message" && typeof event.id === "string") ids.add(event.id);
  }
  return ids.size;
}

/**
 * Sub-agent threads created during the run.
 *
 * `thread.created` is the harness's own record that `create_sub_agent` really
 * spawned a thread, which is stronger evidence than the model saying it
 * delegated. The main thread is not counted: these events carry the child's id.
 */
export function subAgentThreads(context: EvalContext): string[] {
  const ids = new Set<string>();
  for (const event of eventsOf(context)) {
    if (event.type === "thread.created" && typeof event.threadId === "string") {
      ids.add(event.threadId);
    }
  }
  return [...ids];
}

/**
 * Calls on either visual perception path.
 *
 * Both count as "the agent looked": `inspect_screen_visually` is the direct
 * one-shot answer and `capture_screenshot` is what a vision sub-agent uses
 * inside its own thread. Which one a task warrants is a judgement the policy
 * leaves to the agent, so an eval that demanded a specific one would be
 * grading style rather than perception.
 */
export function visionCalls(context: EvalContext): Array<{ toolName: string }> {
  return context.toolCalls.filter(
    (call) =>
      call.toolName === "inspect_screen_visually" || call.toolName === "capture_screenshot",
  );
}
