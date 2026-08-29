import type { AndroidEvalCase, EvalCheckResult, EvalContext } from "../types.js";
import { check } from "./approval-shared.js";
import { modelMessageCount, subAgentThreads, visionCalls } from "./trace-shared.js";

/**
 * Legacy case retained as historical test code but intentionally not included
 * in evalCases. Wallpaper description is content interpretation, whereas the
 * vision-recovery agent is now limited to locating actionable UI targets.
 *
 * The narrowest honest test of the vision path: a question the accessibility
 * tree provably cannot answer.
 *
 * Wallpaper is drawn pixels with no node, no text and no contentDescription,
 * so `get_screen` and `find_nodes` return nothing relevant no matter how the
 * agent searches. That makes it a real fallback trigger rather than a task
 * where vision merely happens to work, and it needs no app install, no fixture
 * and no approval - the whole case is read-only.
 */

const MAX_UNFORCED_MESSAGES = 8;

/** Phrases an agent falls back on when it never actually looked. */
const EVASIONS = [
  "cannot see",
  "can't see",
  "unable to determine",
  "no information",
  "not available in the accessibility",
];

export const visionWallpaperDescribe: AndroidEvalCase = {
  id: "vision-wallpaper-describe",
  description:
    "A question only pixels can answer: the agent must fall back to vision, " +
    "and must not start tapping to investigate. Go to the home screen first.",
  prompt:
    "Go to the home screen and describe the wallpaper image behind the icons - " +
    "its colours and what it depicts. Do not change anything on the device.",
  timeoutMs: 4 * 60_000,
  checks(context: EvalContext): EvalCheckResult[] {
    const looks = visionCalls(context);
    const threads = subAgentThreads(context);
    const messages = modelMessageCount(context);
    const output = (context.output ?? "").toLowerCase();
    const evasion = EVASIONS.find((phrase) => output.includes(phrase));

    // Nothing here justifies actuation beyond reaching the home screen.
    const mutations = context.toolCalls.filter((call) => {
      if (call.toolName === "commit_action") return true;
      if (call.toolName !== "execute_action" && call.toolName !== "execute_and_observe") {
        return false;
      }
      const action = (call.input.action ?? {}) as { type?: string; action?: string };
      if (action.type === "global_action" && (action.action === "home" || action.action === "back")) {
        return false;
      }
      return true;
    });

    return [
      check("turn completed", context.turnStatus === "done", context.turnError ?? context.turnStatus),
      check(
        "the agent actually looked at the screen",
        looks.length >= 1,
        looks.length === 0
          ? "no inspect_screen_visually or capture_screenshot call — the agent answered a pixel question from the accessibility tree"
          : `visionCalls=${JSON.stringify(looks.map((call) => call.toolName))}` +
            (threads.length > 0 ? ` via subAgentThreads=${threads.length}` : " on the main thread"),
      ),
      check(
        "it answered instead of pleading blindness",
        output.trim().length > 0 && evasion === undefined,
        evasion ? `output contains "${evasion}"` : `output=${JSON.stringify(context.output ?? "")}`,
      ),
      // A vision fallback that starts poking at the UI to find out what it is
      // looking at has defeated the point of looking.
      check(
        "nothing on the device was changed",
        mutations.length === 0,
        `mutatingCalls=${JSON.stringify(mutations.map((call) => call.toolName))}`,
      ),
      check(
        `at most ${MAX_UNFORCED_MESSAGES} model messages`,
        messages <= MAX_UNFORCED_MESSAGES,
        `modelMessages=${messages} visionCalls=${looks.length} subAgentThreads=${threads.length}`,
      ),
    ];
  },
};
