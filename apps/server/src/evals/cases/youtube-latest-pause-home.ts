import type { AndroidEvalCase, EvalCheckResult, EvalContext, ToolTraceEntry } from "../types.js";

function check(name: string, passed: boolean, detail: string): EvalCheckResult {
  return { name, passed, detail };
}

function actionOf(call: ToolTraceEntry): Record<string, unknown> | null {
  const nested = call.input.input;
  const input = nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : call.input;
  const action = input.action;
  return action && typeof action === "object" ? action as Record<string, unknown> : null;
}

function mediaStates(context: EvalContext): Array<Record<string, unknown>> {
  const observed = context.toolCalls.flatMap((call) => {
    if (call.toolName !== "get_media_state" || !call.result || typeof call.result !== "object") return [];
    return [call.result as Record<string, unknown>];
  });
  if (context.finalMediaState) observed.push(context.finalMediaState);
  return observed;
}

export const youtubeLatestPauseHome: AndroidEvalCase = {
  id: "youtube-latest-pause-home",
  description: "Open YouTube, play MrBeast's latest video, pause it, and finish on Home.",
  prompt:
    "Open YouTube, find and play MrBeast's latest uploaded video, verify that it started, " +
    "then pause it and return to the Android home screen. Use authoritative media tools " +
    "for playback control and verification.",
  timeoutMs: 8 * 60_000,
  checks(context: EvalContext): EvalCheckResult[] {
    const media = mediaStates(context);
    const sessions = media.flatMap((state) => Array.isArray(state.sessions)
      ? state.sessions as Array<Record<string, unknown>>
      : []);
    const youtubeSessions = sessions.filter((session) =>
      String(session.packageName ?? "").includes("youtube"));
    const youtube = youtubeSessions.find((session) =>
      session.playbackState === "paused" && Number(session.positionMs ?? 0) > 0,
    ) ?? youtubeSessions.at(-1);
    const foreground = String(context.finalDeviceState?.foregroundPackage ?? "");
    const actions = context.toolCalls.map(actionOf).filter(Boolean) as Record<string, unknown>[];
    const usedMediaState = context.toolCalls.some((call) => call.toolName === "get_media_state");
    const pausedThroughHarness = actions.some(
      (action) => action.type === "media_control" && action.action === "pause",
    );
    const successfulPause = context.toolCalls.some((call) => {
      const action = actionOf(call);
      const result = call.result as Record<string, unknown> | undefined;
      const nestedAction = result?.action && typeof result.action === "object"
        ? result.action as Record<string, unknown>
        : undefined;
      return action?.type === "media_control" && action.action === "pause" &&
        (result?.status === "success" || nestedAction?.status === "success");
    });
    const wentHomeThroughHarness = actions.some(
      (action) => action.type === "global_action" && action.action === "home",
    );
    const coordinateTaps = actions.filter((action) => action.type === "tap_coordinates").length;
    const androidToolNames = new Set([
      "get_operator_capabilities", "get_screen", "find_nodes", "execute_action",
      "execute_and_observe", "wait_for", "get_media_state", "get_notifications",
      "capture_screenshot", "get_device_state",
    ]);
    const androidToolCalls = context.toolCalls.filter((call) => androidToolNames.has(call.toolName)).length;
    const title = String(youtube?.title ?? "");
    const artist = String(youtube?.artist ?? "");
    const positionMs = typeof youtube?.positionMs === "number" ? youtube.positionMs : 0;

    return [
      check("turn completed", context.turnStatus === "done", context.turnError ?? context.turnStatus),
      check("home screen is foreground", /launcher/i.test(foreground), `foregroundPackage=${foreground || "missing"}`),
      check(
        "media session API available",
        media.some((state) => state.available === true),
        `observations=${media.length}`,
      ),
      check("YouTube media session exists", Boolean(youtube), `sessions=${sessions.length}`),
      check(
        "MrBeast metadata observed",
        /mr\s*beast/i.test(`${artist} ${title}`),
        `artist=${artist || "missing"} title=${title || "missing"}`,
      ),
      check("video started", positionMs > 0, `positionMs=${positionMs}`),
      check("video is paused", youtube?.playbackState === "paused", `playbackState=${String(youtube?.playbackState ?? "missing")}`),
      check("agent queried media state", usedMediaState, `toolCalls=${context.toolCalls.length}`),
      check("agent paused through media_control", pausedThroughHarness, "required action=media_control/pause"),
      check("pause action succeeded", successfulPause, "media_control/pause must return status=success"),
      check("agent went Home through harness", wentHomeThroughHarness, "required action=global_action/home"),
      check("no coordinate taps", coordinateTaps === 0, `tap_coordinates calls=${coordinateTaps}`),
      check(
        "bounded Android tool use",
        androidToolCalls <= 30,
        `androidToolCalls=${androidToolCalls} budget=30 totalHarnessCalls=${context.toolCalls.length}`,
      ),
    ];
  },
};
