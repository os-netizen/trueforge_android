import assert from "node:assert/strict";
import test from "node:test";
import { youtubeLatestPauseHome } from "./youtube-latest-pause-home.js";
import type { EvalContext } from "../types.js";

/** This case predates approvals and never pauses. */
const TURN_DEFAULTS = {
  events: [],
  approvals: [],
  finalNotifications: null,
} satisfies Pick<EvalContext, "events" | "approvals" | "finalNotifications">;

function finalState(): Pick<EvalContext, "finalDeviceState" | "finalMediaState"> {
  return {
    finalDeviceState: { foregroundPackage: "com.sec.android.app.launcher" },
    finalMediaState: {
      available: true,
      permissionRequired: false,
      sessions: [{
        packageName: "com.google.android.youtube",
        title: "Escape 100 Cops, Win $500,000",
        artist: "MrBeast",
        playbackState: "paused",
        positionMs: 12_000,
      }],
    },
  };
}

test("passes an attributed media-session execution", () => {
  const context: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [
      { id: "media-state", toolName: "get_media_state", input: { input: {} } },
      {
        id: "pause",
        toolName: "execute_action",
        input: { input: { action: { type: "media_control", action: "pause" } } },
        result: { status: "success" },
      },
      {
        id: "home",
        toolName: "execute_action",
        input: { input: { action: { type: "global_action", action: "home" } } },
      },
    ],
    ...finalState(),
  };
  const failures = youtubeLatestPauseHome.checks(context).filter((result) => !result.passed);
  assert.deepEqual(failures, []);
});

test("passes from intermediate media evidence after YouTube releases its session on Home", () => {
  const context: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [
      {
        id: "media-state",
        toolName: "get_media_state",
        input: {},
        result: finalState().finalMediaState,
      },
      {
        id: "pause",
        toolName: "execute_action",
        input: { action: { type: "media_control", action: "pause" } },
        result: { status: "success" },
      },
      {
        id: "home",
        toolName: "execute_action",
        input: { action: { type: "global_action", action: "home" } },
      },
    ],
    finalDeviceState: { foregroundPackage: "com.sec.android.app.launcher" },
    finalMediaState: { available: true, permissionRequired: false, sessions: [] },
  };
  const failures = youtubeLatestPauseHome.checks(context).filter((result) => !result.passed);
  assert.deepEqual(failures, []);
});

test("accepts successful pause through execute_and_observe", () => {
  const state = finalState();
  const context: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [
      { id: "media-state", toolName: "get_media_state", input: {}, result: state.finalMediaState },
      {
        id: "pause",
        toolName: "execute_and_observe",
        input: { input: { action: { type: "media_control", action: "pause" } } },
        result: { action: { status: "success" }, screen: { packageName: "com.google.android.youtube" } },
      },
      {
        id: "home",
        toolName: "execute_and_observe",
        input: { input: { action: { type: "global_action", action: "home" } } },
        result: { action: { status: "success" }, screen: { packageName: "com.sec.android.app.launcher" } },
      },
    ],
    ...state,
  };
  const failures = youtubeLatestPauseHome.checks(context).filter((result) => !result.passed);
  assert.deepEqual(failures, []);
});

test("fails a manually-produced final state with no harness attribution", () => {
  const context: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [],
    ...finalState(),
  };
  const failures = youtubeLatestPauseHome.checks(context)
    .filter((result) => !result.passed)
    .map((result) => result.name);
  assert.deepEqual(failures, [
    "agent queried media state",
    "agent paused through media_control",
    "pause action succeeded",
    "agent went Home through harness",
  ]);
});

test("fails coordinate-based playback control", () => {
  const context: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [
      { id: "media-state", toolName: "get_media_state", input: { input: {} } },
      {
        id: "tap",
        toolName: "execute_action",
        input: { input: { action: { type: "tap_coordinates", x: 42, y: 700 } } },
      },
      {
        id: "home",
        toolName: "execute_action",
        input: { input: { action: { type: "global_action", action: "home" } } },
      },
    ],
    ...finalState(),
  };
  const failures = youtubeLatestPauseHome.checks(context)
    .filter((result) => !result.passed)
    .map((result) => result.name);
  assert.ok(failures.includes("agent paused through media_control"));
  assert.ok(failures.includes("no coordinate taps"));
});

test("does not charge TrueForge discovery calls against the Android interaction budget", () => {
  const base: EvalContext = {
    prompt: youtubeLatestPauseHome.prompt,
    turnStatus: "done",
    ...TURN_DEFAULTS,
    toolCalls: [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `meta-${index}`,
        toolName: "get_tool_info",
        input: {},
      })),
      { id: "media-state", toolName: "get_media_state", input: {}, result: finalState().finalMediaState },
      { id: "pause", toolName: "execute_action", input: { action: { type: "media_control", action: "pause" } }, result: { status: "success" } },
      { id: "home", toolName: "execute_action", input: { action: { type: "global_action", action: "home" } } },
    ],
    ...finalState(),
  };
  const bounded = youtubeLatestPauseHome.checks(base).find((result) =>
    result.name === "bounded Android tool use");
  assert.equal(bounded?.passed, true);
  assert.match(bounded?.detail ?? "", /androidToolCalls=3/);
});
