import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReasoningEffort,
  reasoningSettings,
  REASONING_EFFORTS,
  updateReasoningSettings,
} from "./reasoning.js";

test("the operator defaults high while the narrow vision primitive stays low", () => {
  const settings = reasoningSettings();
  assert.equal(settings.agent, "high");
  assert.equal(settings.vision, "low");
});

test("only the provider's own enum parses", () => {
  for (const effort of REASONING_EFFORTS) {
    assert.equal(parseReasoningEffort(effort), effort);
  }
  // The upstream provider answers anything else with an opaque 400 mid-run,
  // which is why these are rejected at the edge instead of forwarded.
  assert.equal(parseReasoningEffort("lowish"), null);
  assert.equal(parseReasoningEffort("LOW"), null);
  assert.equal(parseReasoningEffort(3), null);
  assert.equal(parseReasoningEffort(undefined), null);
});

test("an update reports only the fields that actually moved", () => {
  updateReasoningSettings({ agent: "high", vision: "low" });
  const first = updateReasoningSettings({ agent: "xhigh" });
  assert.deepEqual(first.changed, ["agent"]);
  assert.equal(first.settings.agent, "xhigh");
  assert.equal(first.settings.vision, "low");

  // A no-op must not report a change: the caller writes the agent manifest on
  // the strength of this and should skip the round trip when nothing moved.
  const second = updateReasoningSettings({ agent: "xhigh" });
  assert.deepEqual(second.changed, []);

  const third = updateReasoningSettings({ vision: "minimal" });
  assert.deepEqual(third.changed, ["vision"]);
  updateReasoningSettings({ agent: "high", vision: "low" });
});

test("the settings object is a copy, so callers cannot mutate the store", () => {
  const settings = reasoningSettings();
  settings.agent = "max";
  assert.equal(reasoningSettings().agent, "high");
});
