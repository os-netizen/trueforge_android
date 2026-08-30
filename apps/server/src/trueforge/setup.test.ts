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
    /For an eligible problem, create one short-lived sub-agent named "vision-recovery"/,
  );
  assert.doesNotMatch(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /For a single visual question, call inspect_screen_visually/,
  );
});

test("vision is localization or property checking, never content extraction", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /do not use it to read, transcribe, summarize, or narrate screen content/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /report that limitation rather than screenshotting it/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /strictly read-only visual observer[\s\S]*never a general content reader/,
  );
});

test("visual verification is an eligible, delegated use of vision", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Vision has exactly two eligible uses, and both are delegated to a sub-agent/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /visual verification - the task states a visual property that decides/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /verify it visually before acting on it or reporting it as done/,
  );
  // Verification goes through the tool that re-checks the screen around the
  // inference, not a bare frame a verdict could outlive.
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /It uses inspect_screen_visually for both kinds of question[\s\S]*mode "verify" for a visual property/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /capture_screenshot is a last resort[\s\S]*may describe a screen that is already gone/,
  );
  // The verdict has to come back with evidence, and "unclear" must not be
  // laundered into a pass.
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /the holds=yes\/no\/unclear verdict plus one short sentence of the visible evidence/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /An "unclear" or "unavailable" verdict is a real answer - do not treat it as confirmation/,
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

test("vision sub-agents receive the exact run-bound device target", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /does not automatically inherit the run routing context/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /copy the exact opaque deviceTarget from the current run into its input/,
  );
});

test("Code Mode cannot bypass visual isolation", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Do not call inspect_screen_visually or capture_screenshot from Code Mode/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /after the first read-only discovery, classify every requested bulk operation/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /If the app exposes one genuine native bulk control, use that direct action/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /switch to Code Mode before mutating the first target: never begin a direct per-item loop and switch to a script later/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Code Mode cannot see pixels or improve, derive, or validate visual coordinates/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Do not probe ADB, shell, or host device-control access from the sandbox/,
  );
});

test("actions require verified postconditions", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /An accepted action or screenChanged only proves delivery or a UI event, not success/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /verify the exact expected postcondition/,
  );
});

test("recovery has one semantic attempt budget", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Count coordinate retries, vision retries, alternate tools, and schema mistakes toward the same maximum of three failed attempts/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /make at most one grounded coordinate attempt; if it remains, use global Back once and verify/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /If set_text fails[\s\S]*no editable node or set-text action[\s\S]*stop that step/,
  );
});

test("vision refuses unstable frames and duplicate localization", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /no more than one vision child per target, and one per verification question, on the same observed screen/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /frame is blank, transitional, stale[\s\S]*return "unavailable" or "absent"/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /never infer coordinates or a verdict from expectation, from listing text, or from an earlier frame/,
  );
});

test("tool calls use declared schemas without improvisation", () => {
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /Use only fields declared by each tool schema/,
  );
  assert.match(
    ANDROID_OPERATOR_INSTRUCTIONS,
    /never guess arguments, query syntax, nested actions, or unavailable host-control tools/,
  );
});
