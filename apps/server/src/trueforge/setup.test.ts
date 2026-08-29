import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_OPERATOR_INSTRUCTIONS } from "./setup.js";

test("visual navigation recovery is isolated in a short-lived sub-agent", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Never call inspect_screen_visually or capture_screenshot on the main thread/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /For an eligible navigation problem, create one short-lived sub-agent named "vision-recovery"/,
  );
  assert.doesNotMatch(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /For a single visual question, call inspect_screen_visually/,
  );
});

test("vision is target localization, never content extraction", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Do not use vision to read, transcribe, summarize, describe, compare, or interpret screen content/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /report that limitation rather than using vision as OCR/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /strictly read-only UI-target locator, not a content reader/,
  );
});

test("vision sub-agents observe and report but never actuate", () => {
  assert.match(ANDROID_OPERATOR_INSTRUCTIONS, /strictly read-only/);
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /must not navigate, scroll, tap, type, launch apps, call execute_action\/execute_and_observe\/commit_action/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /If the target is not on the current screen[\s\S]*reports "absent"[\s\S]*and closes/,
  );
});

test("Code Mode cannot bypass visual isolation", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Do not call inspect_screen_visually or capture_screenshot from Code Mode/,
  );
});
